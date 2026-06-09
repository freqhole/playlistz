import { z } from "zod";

// schema for a single song entry in a freqhole playlist
const FreqholePlaylistSongSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  duration: z.number(),
  originalFilename: z.string(),
  fileSize: z.number(),
  sha: z.string().optional(),
  imageExtension: z.string().optional(),
  imageMimeType: z.string().optional(),
  safeFilename: z.string().optional(),
  mimeType: z.string().optional(),
});

// schema for the playlist metadata header in a freqhole playlist entry
const FreqholePlaylistHeaderSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  rev: z.number().optional(),
  imageExtension: z.string().optional(),
  imageMimeType: z.string().optional(),
  safeFilename: z.string().optional(),
});

// schema for a single { playlist, songs } entry - matches StandaloneData shape
export const FreqholePlaylistSchema = z.object({
  playlist: FreqholePlaylistHeaderSchema,
  songs: z.array(FreqholePlaylistSongSchema),
});

// schema for the full window.__PLAYLISTZ__ value (one or more playlists)
export const FreqholePlaylistzSchema = z.array(FreqholePlaylistSchema);

export type FreqholePlaylistSong = z.infer<typeof FreqholePlaylistSongSchema>;
export type FreqholePlaylistHeader = z.infer<typeof FreqholePlaylistHeaderSchema>;
export type FreqholePlaylist = z.infer<typeof FreqholePlaylistSchema>;
export type FreqholePlaylistz = z.infer<typeof FreqholePlaylistzSchema>;

// generates the playlistz.js data file content for one or more playlists
export function generatePlaylistzJs(playlists: FreqholePlaylistz): string {
  return `window.__PLAYLISTZ__ = ${JSON.stringify(playlists)};\n`;
}

// generates the minimal static index.html shell - no playlist data embedded
export function generateIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>playlistz</title>
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#000000">
</head>
<body>
  <script src="playlistz.js"></script>
  <script src="freqhole-playlistz.js"></script>
  <freqhole-playlistz></freqhole-playlistz>
</body>
</html>
`;
}
