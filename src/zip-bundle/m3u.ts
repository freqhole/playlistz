// m3u8 generator for the zip bundle.
// takes pre-computed file paths rather than raw song/playlist types,
// so it works in both playlistz and spume contexts.

export interface M3UZipSong {
  title: string;
  artist: string;
  album: string;
  duration: number;
  audioPath: string;   // relative path written into the m3u8, e.g. "data/song.mp3"
  imagePath?: string;  // relative path for cover, e.g. "data/song-cover.jpg"
}

export interface M3UZipPlaylist {
  id: string;
  title: string;
  description?: string;
  rev?: number;
  imagePath?: string;  // relative path for playlist cover
}

export function generateM3UContent(
  playlist: M3UZipPlaylist,
  songs: M3UZipSong[],
): string {
  let out = "#EXTM3U\n";
  out += `# Playlist: ${playlist.title}\n`;
  out += `# PlaylistId: ${playlist.id}\n`;
  out += `# PlaylistRev: ${playlist.rev ?? 0}\n`;
  if (playlist.description) out += `# Description: ${playlist.description}\n`;
  if (playlist.imagePath)   out += `# PlaylistImage: ${playlist.imagePath}\n`;
  out += "\n";

  for (const song of songs) {
    const duration = Math.round(song.duration);
    out += `#EXTINF:${duration}, ${song.artist} - ${song.title}\n`;
    out += `# Title: ${song.title}\n`;
    out += `# Artist: ${song.artist}\n`;
    out += `# Album: ${song.album}\n`;
    if (song.imagePath) out += `# Image: ${song.imagePath}\n`;
    out += `${song.audioPath}\n\n`;
  }

  return out;
}
