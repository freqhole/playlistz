import JSZip from "jszip";
import type { BlobFetcher, PlaylistZipEntry, PlaylistZipOptions } from "./types.js";
import { sanitizeFilename, createSafeTitle, getFileExtension } from "./utils.js";
import { generateM3UContent } from "./m3u.js";
import { generateIndexHtml, generatePlaylistzJs } from "../utils/standaloneTemplates.js";
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
  return (ext && map[ext]) ? map[ext]! : "image/jpeg";
}

// builds a self-contained playlist zip as a Blob.
// does not trigger a browser download - callers handle delivery.
// does not touch DOM, window, or document (except optionally fetching
// the app bundle via appBundleUrl).
export async function buildPlaylistZip(
  entry: PlaylistZipEntry,
  fetchBlob: BlobFetcher,
  options: PlaylistZipOptions = {},
): Promise<Blob> {
  const {
    includeImages = true,
    generateM3U = true,
    includeHTML = true,
    appBundleUrl,
  } = options;

  const zip = new JSZip();
  const rootName = createSafeTitle(entry.playlist.title) || "playlist";
  const root = zip.folder(rootName)!;
  const data = root.folder("data")!;

  // ---- playlist cover image ----
  let playlistImagePath: string | undefined;
  if (includeImages && entry.playlist.imageSha) {
    const bytes = await fetchBlob(entry.playlist.imageSha);
    if (bytes) {
      const ext = getFileExtension(entry.playlist.imageType ?? "image/jpeg");
      const filename = `playlist-cover${ext}`;
      data.file(filename, bytes);
      playlistImagePath = `data/${filename}`;
    }
  }

  // ---- songs: fetch audio + cover bytes ----
  const resolvedSongs: Array<{
    song: PlaylistZipEntry["songs"][number];
    audioBytes?: ArrayBuffer;
    imageBytes?: ArrayBuffer;
    audioPath: string;
    imagePath?: string;
    safeFilename: string;
  }> = await Promise.all(
    entry.songs.map(async (song) => {
      const safeFilename = song.originalFilename
        ? sanitizeFilename(song.originalFilename)
        : sanitizeFilename(`${song.title}.${getFileExtension(song.mimeType).slice(1)}`);
      const safeBase = safeFilename.replace(/\.[^.]+$/, "");

      const audioBytes = song.sha ? await fetchBlob(song.sha) : undefined;

      let imageBytes: ArrayBuffer | undefined;
      let imagePath: string | undefined;
      if (includeImages && song.imageSha) {
        imageBytes = await fetchBlob(song.imageSha);
        if (imageBytes) {
          const ext = getFileExtension(song.imageType ?? "image/jpeg");
          imagePath = `data/${safeBase}-cover${ext}`;
        }
      }

      return {
        song,
        audioBytes,
        imageBytes,
        audioPath: `data/${safeFilename}`,
        imagePath,
        safeFilename,
      };
    }),
  );

  // ---- add audio + image files to data/ ----
  for (const r of resolvedSongs) {
    if (r.audioBytes) {
      data.file(r.safeFilename, r.audioBytes);
    }
    if (r.imageBytes && r.imagePath) {
      const imgFilename = r.imagePath.replace("data/", "");
      data.file(imgFilename, r.imageBytes);
    }
  }

  // ---- playlistz.js data file ----
  const playlistzData = [
    {
      playlist: {
        id: entry.playlist.id,
        title: entry.playlist.title,
        description: entry.playlist.description,
        rev: entry.playlist.rev,
        imageMimeType: entry.playlist.imageType ?? (playlistImagePath ? mimeFromPath(playlistImagePath) : undefined),
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
        fileSize: r.song.fileSize ?? r.audioBytes?.byteLength ?? 0,
        mimeType: r.song.mimeType,
        sha: r.song.sha,
        imageMimeType: r.song.imageType ?? (r.imagePath ? mimeFromPath(r.imagePath) : undefined),
        imageFilePath: r.imagePath,
      })),
    },
  ];
  root.file("playlistz.js", generatePlaylistzJs(playlistzData));

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
      })),
    );
    data.file(`${rootName}.m3u8`, m3uContent);
  }

  // ---- static shell files ----
  if (includeHTML) {
    root.file("index.html", generateIndexHtml());
    root.file("sw.js", generateSwJs());

    // resolve where to fetch the app bundle from
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
          root.file("freqhole-playlistz.js", await res.arrayBuffer());
        } else {
          console.warn("could not fetch freqhole-playlistz.js for zip bundle:", res.status);
        }
      } catch (err) {
        console.warn("could not include freqhole-playlistz.js in zip:", err);
      }
    }

    // try fetching the cli bundle from the same origin if in a browser
    const cliUrl =
      typeof window !== "undefined"
        ? `${window.location.origin}/freqhole-playlistz-cli.mjs`
        : null;
    if (cliUrl) {
      try {
        const res = await fetch(cliUrl);
        if (res.ok) {
          root.file("freqhole-playlistz-cli.mjs", await res.arrayBuffer());
        } else {
          console.warn("could not fetch freqhole-playlistz-cli.mjs:", res.status);
        }
      } catch (err) {
        console.warn("could not include freqhole-playlistz-cli.mjs in zip:", err);
      }
    }
  }

  return zip.generateAsync({ type: "blob" });
}
