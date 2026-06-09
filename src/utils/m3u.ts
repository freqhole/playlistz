// shared m3u8 format utilities: parser + generator.
// browser-compatible and node-compatible (no fs/path imports).

import type { Playlist, Song } from "../types/playlist.js";

// ---- types ----

export interface M3USong {
  duration: number;
  title: string;
  artist: string;
  album: string;
  imageFile: string;   // e.g. "data/01-song-cover.jpg" as written in m3u8
  audioFile: string;   // e.g. "data/01-song.mp3" as written in m3u8
}

export interface M3UPlaylist {
  title: string;
  description: string;
  playlistImageFile: string;  // e.g. "data/playlist-cover.jpg"
  id: string | null;
  rev: number | null;
  songs: M3USong[];
  rawLines: string[];         // original lines, preserved for write-back
}

// ---- parser ----

export function parseM3U(content: string): M3UPlaylist {
  const lines = content.split("\n");
  const result: M3UPlaylist = {
    title: "",
    description: "",
    playlistImageFile: "",
    id: null,
    rev: null,
    songs: [],
    rawLines: lines,
  };

  let pendingExtinf: { duration: number } | null = null;
  let pendingTitle = "";
  let pendingArtist = "";
  let pendingAlbum = "";
  let pendingImage = "";

  for (const line of lines) {
    const t = line.trim();

    if (t.startsWith("# Playlist:"))       result.title             = t.slice("# Playlist:".length).trim();
    else if (t.startsWith("# Description:"))result.description       = t.slice("# Description:".length).trim();
    else if (t.startsWith("# PlaylistImage:"))result.playlistImageFile = t.slice("# PlaylistImage:".length).trim();
    else if (t.startsWith("# PlaylistId:")) result.id                = t.slice("# PlaylistId:".length).trim();
    else if (t.startsWith("# PlaylistRev:"))result.rev               = parseInt(t.slice("# PlaylistRev:".length).trim(), 10);
    else if (t.startsWith("#EXTINF:")) {
      const durationStr = t.slice("#EXTINF:".length).split(",")[0] ?? "0";
      pendingExtinf = { duration: parseInt(durationStr, 10) };
      pendingTitle = pendingArtist = pendingAlbum = pendingImage = "";
    } else if (t.startsWith("# Title:"))   pendingTitle  = t.slice("# Title:".length).trim();
    else if (t.startsWith("# Artist:"))    pendingArtist = t.slice("# Artist:".length).trim();
    else if (t.startsWith("# Album:"))     pendingAlbum  = t.slice("# Album:".length).trim();
    else if (t.startsWith("# Image:"))     pendingImage  = t.slice("# Image:".length).trim();
    else if (t && !t.startsWith("#") && pendingExtinf) {
      result.songs.push({
        duration: pendingExtinf.duration,
        title: pendingTitle,
        artist: pendingArtist,
        album: pendingAlbum,
        imageFile: pendingImage,
        audioFile: t,
      });
      pendingExtinf = null;
    }
  }

  return result;
}

// ---- write-back: insert/update PlaylistId + PlaylistRev in raw lines ----

export function serializeM3U(parsed: M3UPlaylist): string {
  const lines = [...parsed.rawLines];

  const upsertAfter = (marker: string, tag: string, value: string) => {
    const existing = lines.findIndex((l) => l.trim().startsWith(tag));
    if (existing >= 0) {
      lines[existing] = `${tag} ${value}`;
    } else {
      const after = lines.findIndex((l) => l.trim().startsWith(marker));
      if (after >= 0) lines.splice(after + 1, 0, `${tag} ${value}`);
    }
  };

  upsertAfter("# Playlist:", "# PlaylistId:", parsed.id ?? "");
  upsertAfter("# PlaylistId:", "# PlaylistRev:", String(parsed.rev ?? 0));

  return lines.join("\n");
}

// ---- generator (used by playlistDownloadService) ----

export function generateM3UContent(
  playlist: Playlist,
  songs: Song[],
  fileNames: string[],
  getFileExtension: (mimeType: string) => string
): string {
  let out = "#EXTM3U\n";
  out += `# Playlist: ${playlist.title}\n`;
  if (playlist.id)    out += `# PlaylistId: ${playlist.id}\n`;
  out += `# PlaylistRev: ${playlist.rev ?? 0}\n`;
  if (playlist.description) out += `# Description: ${playlist.description}\n`;
  if (playlist.imageData) {
    const ext = getFileExtension(playlist.imageType ?? "image/jpeg");
    out += `# PlaylistImage: data/playlist-cover${ext}\n`;
  }
  out += "\n";

  songs.forEach((song, i) => {
    const fileName = fileNames[i];
    if (!fileName) return;
    const duration = Math.round(song.duration ?? 0);
    out += `#EXTINF:${duration}, ${song.artist} - ${song.title}\n`;
    out += `# Title: ${song.title}\n`;
    out += `# Artist: ${song.artist}\n`;
    out += `# Album: ${song.album}\n`;
    if (song.imageData && song.originalFilename) {
      const baseName = song.originalFilename.replace(/\.[^.]+$/, "");
      const ext = getFileExtension(song.imageType ?? "image/jpeg");
      out += `# Image: data/${baseName}-cover${ext}\n`;
    }
    out += `data/${fileName}\n\n`;
  });

  return out;
}
