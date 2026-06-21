import * as fs from "node:fs";
import * as path from "node:path";

function validateField(
  obj: Record<string, unknown>,
  field: string,
  type: string,
  required: boolean,
  context: string,
  errors: string[],
  warnings: string[]
): void {
  const val = obj[field];
  if (val === undefined || val === null) {
    if (required) errors.push(`${context}: missing required field "${field}"`);
    return;
  }
  if (typeof val !== type) {
    (required ? errors : warnings).push(
      `${context}: "${field}" should be ${type}, got ${typeof val}`
    );
  }
}

function checkData(
  data: unknown,
  baseDir: string
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Array.isArray(data)) {
    errors.push(`playlist data must be an array, got ${typeof data}`);
    return { errors, warnings };
  }

  if (data.length === 0) {
    warnings.push("playlist data is empty (no playlists)");
    return { errors, warnings };
  }

  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    const ctx = `playlist[${i}]`;
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${ctx}: must be an object`);
      continue;
    }
    const e = entry as Record<string, unknown>;

    // validate playlist header
    if (typeof e["playlist"] !== "object" || e["playlist"] === null) {
      errors.push(`${ctx}: missing "playlist" object`);
    } else {
      const p = e["playlist"] as Record<string, unknown>;
      const pc = `${ctx}.playlist`;
      validateField(p, "id",          "string", true,  pc, errors, warnings);
      validateField(p, "title",       "string", true,  pc, errors, warnings);
      validateField(p, "rev",         "number", false, pc, errors, warnings);
      validateField(p, "description", "string", false, pc, errors, warnings);

      // check playlist cover image
      if (p["imageExtension"]) {
        const imgPath = path.join(baseDir, "data", `playlist-cover${p["imageExtension"]}`);
        if (!fs.existsSync(imgPath)) {
          warnings.push(`${pc}: cover image not found: data/playlist-cover${p["imageExtension"]}`);
        }
      }
    }

    // validate songs
    if (!Array.isArray(e["songs"])) {
      errors.push(`${ctx}: "songs" must be an array`);
      continue;
    }

    if (e["songs"].length === 0) {
      warnings.push(`${ctx}: no songs`);
    }

    for (let j = 0; j < e["songs"].length; j++) {
      const song = e["songs"][j];
      const sc = `${ctx}.songs[${j}]`;
      if (typeof song !== "object" || song === null) {
        errors.push(`${sc}: must be an object`);
        continue;
      }
      const s = song as Record<string, unknown>;
      validateField(s, "id",               "string", true,  sc, errors, warnings);
      validateField(s, "title",            "string", true,  sc, errors, warnings);
      validateField(s, "artist",           "string", true,  sc, errors, warnings);
      validateField(s, "album",            "string", true,  sc, errors, warnings);
      validateField(s, "duration",         "number", true,  sc, errors, warnings);
      validateField(s, "originalFilename", "string", true,  sc, errors, warnings);
      validateField(s, "fileSize",         "number", true,  sc, errors, warnings);
      validateField(s, "sha",              "string", false, sc, errors, warnings);

      // check audio file (skip http/https)
      const filename = (s["safeFilename"] ?? s["originalFilename"]) as string | undefined;
      if (filename && !filename.startsWith("http://") && !filename.startsWith("https://")) {
        const audioPath = path.join(baseDir, "data", filename);
        if (!fs.existsSync(audioPath)) {
          errors.push(`${sc}: audio file not found: data/${filename}`);
        }
      }

      // check song cover image
      if (s["imageExtension"] && typeof s["safeFilename"] === "string") {
        const baseName = s["safeFilename"].replace(/\.[^.]+$/, "");
        const imgFile = `${baseName}-cover${s["imageExtension"]}`;
        if (!fs.existsSync(path.join(baseDir, "data", imgFile))) {
          warnings.push(`${sc}: cover image not found: data/${imgFile}`);
        }
      }
    }
  }

  return { errors, warnings };
}

export function checkFile(filePath: string): void {
  const resolved = path.resolve(filePath);
  const baseDir = path.dirname(resolved);

  if (!fs.existsSync(resolved)) {
    console.error(`file not found: ${resolved}`);
    process.exit(1);
  }

  let data: unknown;
  try {
    const src = fs.readFileSync(resolved, "utf-8");
    const attrMatch = src.match(/setAttribute\s*\(\s*'data-playlistz'\s*,\s*("(?:[^"\\]|\\.)*")\s*\)/);
    if (!attrMatch) {
      console.error(`${filePath} does not set the data-playlistz attribute`);
      process.exit(1);
    }
    data = JSON.parse(JSON.parse(attrMatch[1]!));
  } catch (err) {
    console.error(`failed to parse ${filePath}:`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (data === undefined) {
    console.error(`${filePath} does not contain playlist data`);
    process.exit(1);
  }

  const { errors, warnings } = checkData(data, baseDir);

  if (warnings.length > 0) {
    warnings.forEach((w) => console.warn(`  warn  ${w}`));
  }
  if (errors.length > 0) {
    errors.forEach((e) => console.error(`  error ${e}`));
    console.error(`\n${errors.length} error(s) - ${filePath} is invalid`);
    process.exit(1);
  }

  const playlists = data as Array<{ songs: unknown[] }>;
  const totalSongs = playlists.reduce((n, p) => n + p.songs.length, 0);
  console.log(`ok  ${playlists.length} playlist(s), ${totalSongs} song(s)${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ""}`);
}
