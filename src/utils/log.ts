// lightweight logger with level + tag filtering.
// level order: debug < info < warn < error
//
// build-time config (vite env vars):
//   VITE_LOG_LEVEL  - "debug" | "info" | "warn" | "error"  (default: "debug" in dev, "warn" in prod)
//   VITE_LOG_FILTER - comma-separated tag prefixes, e.g. "p2p,audio"  (default: all tags)
//
// runtime override via devtools (no rebuild needed):
//   localStorage.logLevel = "debug";
//   localStorage.logFilter = "p2p.transfer,idb";
//   location.reload();
//
// tags use dotted namespaces, e.g. "p2p.transfer", "audio.player", "idb.service".
// filter prefix matching: "p2p" matches "p2p", "p2p.transfer", "p2p.knock", etc.
//
// usage:
//   import { log } from "../utils/log.js";
//   log.warn("share.panel", "could not build share link:", err);
//   log.debug("playlist.sync", "syncPlaylists #", syncId, "entries:", entries.length);

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_NUM: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveLevel(): number {
  const override =
    typeof localStorage !== "undefined"
      ? (localStorage.getItem("logLevel") as LogLevel | null)
      : null;
  // VITE_LOG_LEVEL is injected at build time; fall back to debug in dev, warn in prod
  const env = import.meta.env.VITE_LOG_LEVEL as LogLevel | undefined;
  const raw = override ?? env ?? (import.meta.env.DEV ? "debug" : "warn");
  return LEVEL_NUM[raw as LogLevel] ?? LEVEL_NUM.warn;
}

function resolveFilter(): string[] {
  const override =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("logFilter")
      : null;
  const env = import.meta.env.VITE_LOG_FILTER as string | undefined;
  const raw = override ?? env ?? "";
  return raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function allowed(tag: string): boolean {
  const filter = resolveFilter();
  if (filter.length === 0) return true;
  return filter.some(
    (prefix) => tag === prefix || tag.startsWith(prefix + ".")
  );
}

function emit(
  level: LogLevel,
  tag: string,
  msg: string,
  ...args: unknown[]
): void {
  if (LEVEL_NUM[level] < resolveLevel()) return;
  if (!allowed(tag)) return;
  const prefix = `[${tag}]`;
  if (level === "error") console.error(prefix, msg, ...args);
  else if (level === "warn") console.warn(prefix, msg, ...args);
  else console.log(prefix, msg, ...args);
}

export const log = {
  debug: (tag: string, msg: string, ...args: unknown[]): void =>
    emit("debug", tag, msg, ...args),
  info: (tag: string, msg: string, ...args: unknown[]): void =>
    emit("info", tag, msg, ...args),
  warn: (tag: string, msg: string, ...args: unknown[]): void =>
    emit("warn", tag, msg, ...args),
  error: (tag: string, msg: string, ...args: unknown[]): void =>
    emit("error", tag, msg, ...args),
};
