// shared filename/mime utilities used by both the zip builder
// and the m3u generator. no external dependencies.

export function sanitizeFilename(name: string): string {
  return (
    name
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\s+/g, "_")
      .substring(0, 200)
  );
}

export function createSafeTitle(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "_")
    .toLowerCase()
    .substring(0, 100);
}

export function getFileExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/flac": ".flac",
    "audio/ogg": ".ogg",
    "audio/webm": ".webm",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  return map[mimeType] ?? ".bin";
}
