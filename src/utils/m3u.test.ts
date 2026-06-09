import { describe, it, expect } from "vitest";
import { parseM3U, serializeM3U, generateM3UContent } from "./m3u.js";
import type { Playlist, Song } from "../types/playlist.js";

// ---- helpers ----

const BASIC_M3U = `#EXTM3U
# Playlist: test mix
# Description: some songs
# PlaylistImage: data/playlist-cover.jpg

#EXTINF:180, artist a - song one
# Title: song one
# Artist: artist a
# Album: album x
# Image: data/01-song one-cover.jpg
data/01-song one.mp3

#EXTINF:240, artist b - song two
# Title: song two
# Artist: artist b
# Album: album y
data/02-song two.m4a
`;

// ---- parseM3U ----

describe("parseM3U", () => {
  it("parses playlist header fields", () => {
    const p = parseM3U(BASIC_M3U);
    expect(p.title).toBe("test mix");
    expect(p.description).toBe("some songs");
    expect(p.playlistImageFile).toBe("data/playlist-cover.jpg");
  });

  it("id and rev are null when absent", () => {
    const p = parseM3U(BASIC_M3U);
    expect(p.id).toBeNull();
    expect(p.rev).toBeNull();
  });

  it("parses PlaylistId and PlaylistRev when present", () => {
    const src = `#EXTM3U\n# Playlist: x\n# PlaylistId: abc-123\n# PlaylistRev: 7\n`;
    const p = parseM3U(src);
    expect(p.id).toBe("abc-123");
    expect(p.rev).toBe(7);
  });

  it("parses song count correctly", () => {
    expect(parseM3U(BASIC_M3U).songs).toHaveLength(2);
  });

  it("parses first song fields", () => {
    const s = parseM3U(BASIC_M3U).songs[0]!;
    expect(s.title).toBe("song one");
    expect(s.artist).toBe("artist a");
    expect(s.album).toBe("album x");
    expect(s.duration).toBe(180);
    expect(s.audioFile).toBe("data/01-song one.mp3");
    expect(s.imageFile).toBe("data/01-song one-cover.jpg");
  });

  it("parses song with no image as empty imageFile", () => {
    const s = parseM3U(BASIC_M3U).songs[1]!;
    expect(s.imageFile).toBe("");
  });

  it("preserves rawLines for write-back", () => {
    const p = parseM3U(BASIC_M3U);
    expect(p.rawLines.length).toBeGreaterThan(0);
    expect(p.rawLines[0]).toBe("#EXTM3U");
  });

  it("parses empty string without throwing", () => {
    const p = parseM3U("");
    expect(p.songs).toHaveLength(0);
    expect(p.title).toBe("");
  });
});

// ---- serializeM3U ----

describe("serializeM3U", () => {
  it("inserts PlaylistId and PlaylistRev when absent", () => {
    const p = parseM3U(BASIC_M3U);
    p.id = "new-id";
    p.rev = 0;
    const out = serializeM3U(p);
    expect(out).toContain("# PlaylistId: new-id");
    expect(out).toContain("# PlaylistRev: 0");
  });

  it("updates existing PlaylistId in place", () => {
    const src = `#EXTM3U\n# Playlist: x\n# PlaylistId: old-id\n# PlaylistRev: 1\n`;
    const p = parseM3U(src);
    p.id = "updated-id";
    p.rev = 2;
    const out = serializeM3U(p);
    expect(out).toContain("# PlaylistId: updated-id");
    expect(out).not.toContain("# PlaylistId: old-id");
    expect(out).toContain("# PlaylistRev: 2");
    // should not duplicate
    expect(out.split("# PlaylistId:").length - 1).toBe(1);
  });

  it("round-trips all songs unchanged", () => {
    const p = parseM3U(BASIC_M3U);
    p.id = "x";
    p.rev = 0;
    const out = serializeM3U(p);
    expect(out).toContain("data/01-song one.mp3");
    expect(out).toContain("data/02-song two.m4a");
  });
});

// ---- generateM3UContent ----

describe("generateM3UContent", () => {
  const getExt = (mime: string) => {
    const map: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" };
    return map[mime] ?? ".jpg";
  };

  const playlist = {
    id: "pl-1",
    title: "my playlist",
    description: "cool songs",
    rev: 3,
    imageData: new ArrayBuffer(1),
    imageType: "image/jpeg",
  } as unknown as Playlist;

  const songs = [
    {
      title: "tune",
      artist: "dj",
      album: "ep",
      duration: 120,
      originalFilename: "01-tune.mp3",
      imageData: new ArrayBuffer(1),
      imageType: "image/jpeg",
    } as unknown as Song,
  ];

  it("starts with #EXTM3U", () => {
    const out = generateM3UContent(playlist, songs, ["01-tune.mp3"], getExt);
    expect(out).toMatch(/^#EXTM3U\n/);
  });

  it("includes PlaylistId and PlaylistRev", () => {
    const out = generateM3UContent(playlist, songs, ["01-tune.mp3"], getExt);
    expect(out).toContain("# PlaylistId: pl-1");
    expect(out).toContain("# PlaylistRev: 3");
  });

  it("includes playlist title and description", () => {
    const out = generateM3UContent(playlist, songs, ["01-tune.mp3"], getExt);
    expect(out).toContain("# Playlist: my playlist");
    expect(out).toContain("# Description: cool songs");
  });

  it("includes EXTINF with correct duration and audio path", () => {
    const out = generateM3UContent(playlist, songs, ["01-tune.mp3"], getExt);
    expect(out).toContain("#EXTINF:120, dj - tune");
    expect(out).toContain("data/01-tune.mp3");
  });

  it("skips songs with no filename", () => {
    const out = generateM3UContent(playlist, songs, [undefined as unknown as string], getExt);
    expect(out).not.toContain("#EXTINF");
  });
});
