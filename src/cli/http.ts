import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".mp3":  "audio/mpeg",
  ".m4a":  "audio/mp4",
  ".wav":  "audio/wav",
  ".flac": "audio/flac",
  ".ogg":  "audio/ogg",
  ".webm": "audio/webm",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".map":  "application/json",
};

function mimeFor(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function serveHttp(dir: string): void {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) {
    console.error(`directory not found: ${root}`);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    const rawPath = req.url?.split("?")[0] ?? "/";
    const urlPath = decodeURIComponent(rawPath);
    const filePath = path.join(root, urlPath === "/" ? "index.html" : urlPath);

    // prevent path traversal
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const stat = fs.statSync(filePath);
    const total = stat.size;
    const mime = mimeFor(filePath);
    const rangeHeader = req.headers["range"];

    if (rangeHeader) {
      const [, rangeStr] = rangeHeader.split("=");
      const [startStr, endStr] = (rangeStr ?? "").split("-");
      const start = parseInt(startStr ?? "0", 10);
      const end = endStr ? parseInt(endStr, 10) : total - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": mime,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": total,
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });

  const port = parseInt(process.env["PORT"] ?? "8080", 10);
  server.listen(port, () => {
    console.log(`serving ${root}`);
    console.log(`http://localhost:${port}`);
    console.log("ctrl+c to stop");
  });
}
