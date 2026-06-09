import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as vm from "node:vm";
import { FreqholePlaylistzSchema, type FreqholePlaylist, type FreqholePlaylistz } from "../utils/standaloneTemplates.js";
import { parseM3U, serializeM3U } from "../utils/m3u.js";

// deterministic uuid v5 from a string (dns namespace)
function uuidv5(name: string): string {
  const ns = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
  const hash = crypto.createHash("sha1").update(Buffer.concat([ns, Buffer.from(name)])).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = hash.toString("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

function extOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function mimeForExt(ext: string): string {
  const map: Record<string, string> = {
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
    ".flac": "audio/flac", ".ogg": "audio/ogg", ".webm": "audio/webm",
  };
  return map[ext] ?? "audio/mpeg";
}

// load existing playlistz.js if present, return parsed array or empty
function loadExistingPlaylistz(playlistzPath: string): FreqholePlaylistz {
  if (!fs.existsSync(playlistzPath)) return [];
  try {
    const src = fs.readFileSync(playlistzPath, "utf-8");
    const ctx = vm.createContext({ window: {} as Record<string, unknown> });
    vm.runInContext(src, ctx);
    const raw = (ctx["window"] as Record<string, unknown>)["__PLAYLISTZ__"];
    const parsed = FreqholePlaylistzSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    console.warn("existing playlistz.js failed schema validation - treating as empty");
    return [];
  } catch {
    console.warn("could not parse existing playlistz.js - treating as empty");
    return [];
  }
}

export function generateData(dir: string): void {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    console.error(`directory not found: ${resolved}`);
    process.exit(1);
  }

  // find .m3u8 files in dir or data/ subdir
  const candidates = [
    ...fs.readdirSync(resolved).filter((f) => f.endsWith(".m3u8")).map((f) => path.join(resolved, f)),
    ...(fs.existsSync(path.join(resolved, "data"))
      ? fs.readdirSync(path.join(resolved, "data")).filter((f) => f.endsWith(".m3u8")).map((f) => path.join(resolved, "data", f))
      : []),
  ];

  if (candidates.length === 0) {
    console.error(`no .m3u8 files found in ${resolved} or ${resolved}/data/`);
    process.exit(1);
  }

  const playlistzPath = path.join(resolved, "playlistz.js");
  const existing = loadExistingPlaylistz(playlistzPath);

  let updated = 0;

  for (const m3uPath of candidates) {
    console.log(`processing: ${path.relative(resolved, m3uPath)}`);

    const content = fs.readFileSync(m3uPath, "utf-8");
    const parsed = parseM3U(content);
    const m3uDir = path.dirname(m3uPath);

    if (!parsed.title) {
      console.warn(`  skipping: no # Playlist: header found`);
      continue;
    }

    // assign stable id from title if not present
    const isNew = !parsed.id;
    if (isNew) {
      parsed.id = uuidv5(parsed.title);
      parsed.rev = 0;
      console.log(`  new playlist - assigned id: ${parsed.id}`);
    } else {
      // increment rev on each generate run to signal standaloneService to re-check
      parsed.rev = (parsed.rev ?? 0) + 1;
      console.log(`  existing playlist - id: ${parsed.id}, rev: ${parsed.rev}`);
    }

    // write id + rev back to m3u8
    fs.writeFileSync(m3uPath, serializeM3U(parsed), "utf-8");
    console.log(`  updated: ${path.relative(resolved, m3uPath)}`);

    // resolve playlist cover image metadata
    const coverExt = parsed.playlistImageFile ? extOf(parsed.playlistImageFile) : undefined;
    const coverMime = coverExt === ".gif" ? "image/gif"
      : coverExt === ".png" ? "image/png"
      : coverExt === ".webp" ? "image/webp"
      : coverExt ? "image/jpeg"
      : undefined;

    // build songs array
    const songs = parsed.songs.map((s, i) => {
      // audio file path is relative to the m3u8 dir, e.g. "data/01-song.mp3"
      const audioFilename = path.basename(s.audioFile);
      const audioExt = extOf(audioFilename);

      // image: strip "data/" prefix and figure out extension
      const imageBasename = s.imageFile ? path.basename(s.imageFile) : undefined;
      const imageExt = imageBasename ? extOf(imageBasename) : undefined;
      const imageMime = !imageExt ? undefined
        : imageExt === ".gif" ? "image/gif"
        : imageExt === ".png" ? "image/png"
        : imageExt === ".webp" ? "image/webp"
        : "image/jpeg";

      // check file exists on disk
      const audioPath = path.join(m3uDir, audioFilename);
      if (!fs.existsSync(audioPath)) {
        console.warn(`  warn: audio file not found: ${audioFilename}`);
      }

      return {
        id: uuidv5(`${parsed.id}:${i}:${audioFilename}`),
        title: s.title || audioFilename,
        artist: s.artist || "",
        album: s.album || "",
        duration: s.duration,
        originalFilename: audioFilename,
        safeFilename: audioFilename,
        fileSize: fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0,
        mimeType: mimeForExt(audioExt),
        imageExtension: imageExt ?? undefined,
        imageMimeType: imageMime,
      };
    });

    const entry: FreqholePlaylist = {
      playlist: {
        id: parsed.id,
        title: parsed.title,
        description: parsed.description || undefined,
        rev: parsed.rev,
        imageExtension: coverExt ?? undefined,
        imageMimeType: coverMime,
      },
      songs,
    };

    // upsert into existing data: replace by id or append
    const idx = existing.findIndex((e) => e.playlist.id === parsed.id);
    if (idx >= 0) {
      existing[idx] = entry;
      console.log(`  updated entry in playlistz.js`);
    } else {
      existing.push(entry);
      console.log(`  added new entry to playlistz.js`);
    }

    updated++;
  }

  if (updated === 0) {
    console.log("no playlists were updated");
    return;
  }

  // write playlistz.js
  const output = `window.__PLAYLISTZ__ = ${JSON.stringify(existing, null, 2)};\n`;
  fs.writeFileSync(playlistzPath, output, "utf-8");
  console.log(`\nwrote: ${playlistzPath}`);
  console.log(`  ${existing.length} playlist(s) total`);
}
