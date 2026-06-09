import { serveHttp } from "./http.js";
import { checkFile } from "./check.js";
import { initDir } from "./init.js";
import { generateData } from "./generate.js";

const HELP = `
freqhole-playlistz cli

usage:
  freqhole-playlistz --http [dir]            serve dir over http with range requests (default: ./data)
  freqhole-playlistz --check [file]          validate playlistz.js structure + check files on disk (default: ./playlistz.js)
  freqhole-playlistz --init <dir>            write index.html + sw.js to dir
  freqhole-playlistz --generate-data <dir>   parse .m3u8 file(s) in dir, generate/update playlistz.js
  freqhole-playlistz --help                  show this help

env:
  PORT                                       port for --http server (default: 8080)
`.trim();

export function runCli(argv: string[]): void {
  const args = argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  if (cmd === "--http") {
    serveHttp(args[1] ?? "./data");
    return;
  }

  if (cmd === "--check") {
    checkFile(args[1] ?? "./playlistz.js");
    return;
  }

  if (cmd === "--init") {
    const dir = args[1];
    if (!dir) {
      console.error("usage: freqhole-playlistz --init <dir>");
      process.exit(1);
    }
    initDir(dir);
    return;
  }

  if (cmd === "--generate-data") {
    const dir = args[1];
    if (!dir) {
      console.error("usage: freqhole-playlistz --generate-data <dir>");
      process.exit(1);
    }
    generateData(dir);
    return;
  }

  console.error(`unknown command: ${cmd}`);
  console.error("run with --help for usage");
  process.exit(1);
}

// self-executing entrypoint when run directly via node
runCli(process.argv);
