import { Zip, ZipPassThrough } from "fflate";
import type {
  BlobFetcher,
  PlaylistZipEntry,
  PlaylistZipOptions,
} from "./types.js";
import {
  sanitizeFilename,
  createSafeTitle,
  getFileExtension,
} from "./utils.js";
import { generateM3UContent } from "./m3u.js";
import {
  generateIndexHtml,
  generatePlaylistzJs,
} from "../utils/standaloneTemplates.js";
import { generateSwJs } from "../utils/swTemplate.js";

// derive a MIME type from a file path extension.
// used as a fallback when the caller didn't supply an explicit imageType.
function mimeFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
  };
  return ext && map[ext] ? map[ext]! : "image/jpeg";
}

const TEXT_ENC = new TextEncoder();

// creates a streaming zip builder.
//
// in browsers (OPFS available): each file is written to an OPFS temp file
// as its bytes are pushed. awaiting addFile() between files lets the OS
// flush the write queue, so the prior file's bytes become eligible for GC
// before the next file is fetched. this keeps peak memory at ~1 song at a time.
//
// in node/cli (no OPFS): chunks are accumulated in memory. for the cli path
// playlists are usually small so this is acceptable.
async function createStreamingZip(): Promise<{
  addFile: (path: string, bytes: Uint8Array) => Promise<void>;
  finish: () => Promise<Blob>;
  tempName?: string;
}> {
  const opfsAvailable =
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    // tauri webviews expose navigator.storage but lack FileSystemWritableFileStream;
    // skip the OPFS attempt entirely and use the in-memory path + tauri IPC instead.
    !(typeof window !== "undefined" && "__TAURI_INTERNALS__" in window);

  if (opfsAvailable) {
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      const tempName = `playlistz-dl-${Date.now()}.zip`;
      const tempHandle = await opfsRoot.getFileHandle(tempName, {
        create: true,
      });
      const writable = await tempHandle.createWritable();

      // chain writes so they execute in order and we can await the tail
      let pendingWrite: Promise<unknown> = Promise.resolve();
      let resolveFinished!: () => void;
      let rejectFinished!: (err: unknown) => void;
      const finished = new Promise<void>((res, rej) => {
        resolveFinished = res;
        rejectFinished = rej;
      });

      const zip = new Zip((err, data, final) => {
        if (err) {
          rejectFinished(err);
          return;
        }
        pendingWrite = pendingWrite.then(() => writable.write(data));
        if (final) {
          pendingWrite
            .then(() => writable.close())
            .then(resolveFinished, rejectFinished);
        }
      });

      return {
        tempName,
        async addFile(path, bytes) {
          const entry = new ZipPassThrough(path);
          zip.add(entry);
          entry.push(bytes, true);
          // await the write tail so OPFS has consumed the bytes before the
          // caller fetches the next file. this lets the prior ArrayBuffer GC.
          await pendingWrite;
        },
        async finish() {
          zip.end();
          await finished;
          return tempHandle.getFile();
        },
      };
    } catch {
      // OPFS unavailable or createWritable not supported (e.g. Tauri WKWebView) -
      // fall through to the in-memory path below
    }
  }

  // in-memory fallback (node/cli or when OPFS write is unavailable)
  const chunks: Uint8Array[] = [];
  let resolveDone!: () => void;
  let rejectDone!: (err: unknown) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const zip = new Zip((err, data, final) => {
    if (err) {
      rejectDone(err);
      return;
    }
    chunks.push(data);
    if (final) resolveDone();
  });

  return {
    async addFile(path, bytes) {
      const entry = new ZipPassThrough(path);
      zip.add(entry);
      entry.push(bytes, true);
    },
    async finish() {
      zip.end();
      await done;
      const total = chunks.reduce((acc, c) => acc + c.length, 0);
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.length;
      }
      return new Blob([buf], { type: "application/zip" });
    },
  };
}

// builds a self-contained playlist zip as a Blob.
// each file is fetched and streamed into the zip one at a time so that
// prior audio bytes can be GC'd before the next song is fetched.
export async function buildPlaylistZip(
  entry: PlaylistZipEntry,
  fetchBlob: BlobFetcher,
  options: PlaylistZipOptions = {}
): Promise<Blob> {
  const {
    includeImages = true,
    generateM3U = true,
    includeHTML = true,
    appBundleUrl,
  } = options;

  const rootName = createSafeTitle(entry.playlist.title) || "playlist";
  const builder = await createStreamingZip();

  // ---- playlist cover image ----
  let playlistImagePath: string | undefined;
  if (includeImages && entry.playlist.imageSha) {
    const bytes = await fetchBlob(entry.playlist.imageSha);
    if (bytes) {
      const ext = getFileExtension(entry.playlist.imageType ?? "image/jpeg");
      const filename = `playlist-cover${ext}`;
      playlistImagePath = `data/${filename}`;
      await builder.addFile(
        `${rootName}/${playlistImagePath}`,
        new Uint8Array(bytes)
      );
      // bytes GC-eligible after addFile resolves
    }
  }

  // ---- songs: fetch, stream, and discard bytes one at a time ----
  // resolvedSongs holds only metadata (no byte buffers) so it stays small.
  const resolvedSongs: Array<{
    song: PlaylistZipEntry["songs"][number];
    audioPath: string;
    imagePath?: string;
    safeFilename: string;
    fileSize: number;
  }> = [];

  for (const song of entry.songs) {
    const safeFilename = song.originalFilename
      ? sanitizeFilename(song.originalFilename)
      : sanitizeFilename(
          `${song.title}.${getFileExtension(song.mimeType).slice(1)}`
        );
    const safeBase = safeFilename.replace(/\.[^.]+$/, "");
    const audioPath = `data/${safeFilename}`;
    let fileSize = song.fileSize ?? 0;

    // fetch audio and stream it immediately
    if (song.sha) {
      const audioBytes = await fetchBlob(song.sha);
      if (audioBytes) {
        fileSize = audioBytes.byteLength;
        await builder.addFile(
          `${rootName}/${audioPath}`,
          new Uint8Array(audioBytes)
        );
        // audioBytes GC-eligible after addFile resolves
      }
    }

    // fetch cover image and stream it immediately
    let imagePath: string | undefined;
    if (includeImages && song.imageSha) {
      const imageBytes = await fetchBlob(song.imageSha);
      if (imageBytes) {
        const ext = getFileExtension(song.imageType ?? "image/jpeg");
        const imageFilename = `${safeBase}-cover${ext}`;
        imagePath = `data/${imageFilename}`;
        await builder.addFile(
          `${rootName}/${imagePath}`,
          new Uint8Array(imageBytes)
        );
        // imageBytes GC-eligible after addFile resolves
      }
    }

    resolvedSongs.push({ song, audioPath, imagePath, safeFilename, fileSize });
  }

  // ---- playlistz.js data file ----
  const playlistzData = [
    {
      playlist: {
        id: entry.playlist.id,
        title: entry.playlist.title,
        description: entry.playlist.description,
        rev: entry.playlist.rev,
        imageMimeType:
          entry.playlist.imageType ??
          (playlistImagePath ? mimeFromPath(playlistImagePath) : undefined),
        imageFilePath: playlistImagePath,
        safeFilename: rootName,
        bgFilterEnabled: entry.playlist.bgFilterEnabled,
        bgFilterBlur: entry.playlist.bgFilterBlur,
        bgFilterContrast: entry.playlist.bgFilterContrast,
        bgFilterBrightness: entry.playlist.bgFilterBrightness,
        coverFilterEnabled: entry.playlist.coverFilterEnabled,
        coverFilterBlur: entry.playlist.coverFilterBlur,
      },
      songs: resolvedSongs.map((r) => ({
        id: r.song.id,
        title: r.song.title,
        artist: r.song.artist ?? "",
        album: r.song.album ?? "",
        duration: r.song.duration,
        originalFilename: r.song.originalFilename,
        filePath: r.audioPath,
        safeFilename: r.safeFilename,
        fileSize: r.fileSize,
        mimeType: r.song.mimeType,
        sha: r.song.sha,
        imageMimeType:
          r.song.imageType ??
          (r.imagePath ? mimeFromPath(r.imagePath) : undefined),
        imageFilePath: r.imagePath,
      })),
    },
  ];
  await builder.addFile(
    `${rootName}/playlistz.js`,
    TEXT_ENC.encode(generatePlaylistzJs(playlistzData))
  );

  // ---- m3u8 file ----
  if (generateM3U) {
    const m3uContent = generateM3UContent(
      {
        id: entry.playlist.id,
        title: entry.playlist.title,
        description: entry.playlist.description,
        rev: entry.playlist.rev,
        imagePath: playlistImagePath,
      },
      resolvedSongs.map((r) => ({
        title: r.song.title,
        artist: r.song.artist ?? "",
        album: r.song.album ?? "",
        duration: r.song.duration,
        audioPath: r.audioPath,
        imagePath: r.imagePath,
      }))
    );
    await builder.addFile(
      `${rootName}/data/${rootName}.m3u8`,
      TEXT_ENC.encode(m3uContent)
    );
  }

  // ---- static shell files ----
  if (includeHTML) {
    await builder.addFile(
      `${rootName}/index.html`,
      TEXT_ENC.encode(generateIndexHtml())
    );
    await builder.addFile(`${rootName}/sw.js`, TEXT_ENC.encode(generateSwJs()));

    const bundleUrl =
      appBundleUrl !== undefined
        ? appBundleUrl
        : typeof window !== "undefined"
          ? `${window.location.origin}/freqhole-playlistz.js`
          : null;

    if (bundleUrl) {
      try {
        const res = await fetch(bundleUrl);
        if (res.ok) {
          const text = await res.text();
          // vite dev server (and other html-first servers) return the app's
          // index.html for unknown routes. detect and skip to avoid embedding
          // html as the js bundle. users should run `npm run build:standalone`
          // first so dist/freqhole-playlistz.js exists for the dev server to serve.
          if (text.trimStart().startsWith("<!")) {
            console.warn(
              "freqhole-playlistz.js fetch returned HTML (vite dev mode?). " +
                "run `npm run build:standalone` first, then retry the zip download."
            );
          } else {
            await builder.addFile(
              `${rootName}/freqhole-playlistz.js`,
              TEXT_ENC.encode(text)
            );
          }
        } else {
          console.warn(
            "could not fetch freqhole-playlistz.js for zip bundle:",
            res.status
          );
        }
      } catch (err) {
        console.warn("could not include freqhole-playlistz.js in zip:", err);
      }
    }
    // note: no separate cli mjs needed - the cli is gated inside freqhole-playlistz.js
  }

  return builder.finish();
}

// delete an OPFS temp file created by buildPlaylistZip.
// call this after the browser download or tauri save is complete.
export async function cleanupOpfsTempFile(filename: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(filename);
  } catch {
    // file may have already been removed or never existed - ignore
  }
}
