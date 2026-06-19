import { describe, it, expect } from "vitest";
import {
  FreqholePlaylistSchema,
  FreqholePlaylistzSchema,
  generatePlaylistzJs,
  generateIndexHtml,
  type FreqholePlaylist,
} from "./standaloneTemplates.js";

// ---- helpers ----

function makePlaylist(overrides: Partial<FreqholePlaylist["playlist"]> = {}): FreqholePlaylist {
  return {
    playlist: {
      id: "test-id",
      title: "test playlist",
      description: "a description",
      rev: 1,
      imageExtension: ".jpg",
      imageMimeType: "image/jpeg",
      ...overrides,
    },
    songs: [
      {
        id: "song-1",
        title: "song one",
        artist: "artist a",
        album: "album x",
        duration: 180,
        originalFilename: "01-song one.mp3",
        fileSize: 4000000,
        mimeType: "audio/mpeg",
        safeFilename: "01-song one.mp3",
        imageExtension: ".jpg",
        imageMimeType: "image/jpeg",
      },
    ],
  };
}

// ---- FreqholePlaylistSchema ----

describe("FreqholePlaylistSchema", () => {
  it("parses a valid playlist entry", () => {
    const result = FreqholePlaylistSchema.safeParse(makePlaylist());
    expect(result.success).toBe(true);
  });

  it("parses with optional fields absent", () => {
    const result = FreqholePlaylistSchema.safeParse({
      playlist: { id: "abc", title: "minimal" },
      songs: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.playlist.description).toBeUndefined();
      expect(result.data.playlist.rev).toBeUndefined();
    }
  });

  it("rejects missing required playlist id", () => {
    const bad = { playlist: { title: "no id" }, songs: [] };
    expect(FreqholePlaylistSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects missing required playlist title", () => {
    const bad = { playlist: { id: "x" }, songs: [] };
    expect(FreqholePlaylistSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-array songs field", () => {
    const bad = { playlist: { id: "x", title: "y" }, songs: "not an array" };
    expect(FreqholePlaylistSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects song with missing required fields", () => {
    const bad = {
      playlist: { id: "x", title: "y" },
      songs: [{ title: "no id" }],
    };
    expect(FreqholePlaylistSchema.safeParse(bad).success).toBe(false);
  });

  it("parses song with only required fields", () => {
    const result = FreqholePlaylistSchema.safeParse({
      playlist: { id: "x", title: "y" },
      songs: [
        {
          id: "s1",
          title: "t",
          artist: "a",
          album: "b",
          duration: 60,
          originalFilename: "f.mp3",
          fileSize: 1000,
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// ---- FreqholePlaylistzSchema ----

describe("FreqholePlaylistzSchema", () => {
  it("parses an empty array", () => {
    expect(FreqholePlaylistzSchema.safeParse([]).success).toBe(true);
  });

  it("parses multiple playlists", () => {
    const p1 = makePlaylist({ id: "id-1", title: "playlist 1" });
    const p2 = makePlaylist({ id: "id-2", title: "playlist 2" });
    const result = FreqholePlaylistzSchema.safeParse([p1, p2]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(2);
  });

  it("rejects a non-array", () => {
    expect(FreqholePlaylistzSchema.safeParse({ playlist: {} }).success).toBe(false);
  });
});

// ---- generatePlaylistzJs ----

describe("generatePlaylistzJs", () => {
  it("sets data-playlistz attribute on the web component element", () => {
    const out = generatePlaylistzJs([makePlaylist()]);
    expect(out).toContain("setAttribute('data-playlistz'");
    expect(out).toContain("freqhole-playlistz");
  });

  it("round-trips through JSON correctly", () => {
    const input = [makePlaylist()];
    const out = generatePlaylistzJs(input);
    // extract the inner JSON string from the setAttribute call
    const match = out.match(/setAttribute\('data-playlistz',\s*("(?:[^"\\]|\\.)*")\)/);
    expect(match).not.toBeNull();
    const innerJson = JSON.parse(match![1]!);
    const parsed = JSON.parse(innerJson);
    expect(parsed[0].playlist.id).toBe("test-id");
    expect(parsed[0].songs[0].title).toBe("song one");
  });

  it("generates valid output for empty array", () => {
    const out = generatePlaylistzJs([]);
    expect(out).toContain("setAttribute('data-playlistz'");
    // the embedded JSON should be an empty array
    const match = out.match(/setAttribute\('data-playlistz',\s*("(?:[^"\\]|\\.)*")\)/);
    expect(match).not.toBeNull();
    const innerJson = JSON.parse(match![1]!);
    expect(JSON.parse(innerJson)).toEqual([]);
  });
});

// ---- generateIndexHtml ----

describe("generateIndexHtml", () => {
  it("includes script tag for playlistz.js (no type=module)", () => {
    const html = generateIndexHtml();
    expect(html).toContain('<script src="playlistz.js">');
    expect(html).not.toContain('type="module"');
  });

  it("includes script tag for freqhole-playlistz.js", () => {
    expect(generateIndexHtml()).toContain('<script src="freqhole-playlistz.js">');
  });

  it("includes freqhole-playlistz custom element", () => {
    expect(generateIndexHtml()).toContain("<freqhole-playlistz>");
  });

  it("is valid html with doctype", () => {
    expect(generateIndexHtml()).toMatch(/^<!DOCTYPE html>/);
  });
});
