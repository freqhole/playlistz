import { describe, it, expect, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

// each test gets a fresh idb instance to prevent data leaks
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

// reset the db cache so setupDB re-opens after the idb reset
vi.mock("./indexedDBService.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./indexedDBService.js")>();
  return mod;
});

import {
  resetDBCache,
  savePlaybackPosition,
  loadAllPlaybackPositions,
  deletePlaybackPosition,
  saveLastPlayed,
  loadLastPlayed,
  saveSetting,
  loadSetting,
} from "./indexedDBService.js";

describe("indexedDBService integration tests", () => {
  beforeEach(() => {
    resetDBCache();
  });

  describe("playback positions", () => {
    it("persists a position and reads it back", async () => {
      await savePlaybackPosition("song-a", 55.5);
      const positions = await loadAllPlaybackPositions();
      expect(positions.get("song-a")).toBe(55.5);
    });

    it("overwrites an existing position", async () => {
      await savePlaybackPosition("song-b", 10);
      await savePlaybackPosition("song-b", 20);
      const positions = await loadAllPlaybackPositions();
      expect(positions.get("song-b")).toBe(20);
    });

    it("deletes a position", async () => {
      await savePlaybackPosition("song-c", 30);
      await deletePlaybackPosition("song-c");
      const positions = await loadAllPlaybackPositions();
      expect(positions.has("song-c")).toBe(false);
    });

    it("returns an empty map when no positions exist", async () => {
      const positions = await loadAllPlaybackPositions();
      expect(positions.size).toBe(0);
    });
  });

  describe("last played", () => {
    it("saves and loads the last-played song id", async () => {
      await saveLastPlayed("pl-1", "song-xyz");
      const result = await loadLastPlayed("pl-1");
      expect(result).toBe("song-xyz");
    });

    it("returns null when nothing has been played", async () => {
      const result = await loadLastPlayed("pl-none");
      expect(result).toBeNull();
    });

    it("overwrites the previous last-played entry", async () => {
      await saveLastPlayed("pl-1", "song-1");
      await saveLastPlayed("pl-1", "song-2");
      const result = await loadLastPlayed("pl-1");
      expect(result).toBe("song-2");
    });
  });

  describe("settings", () => {
    it("saves and loads a string setting", async () => {
      await saveSetting("theme", "dark");
      const result = await loadSetting("theme");
      expect(result).toBe("dark");
    });

    it("saves and loads a numeric setting", async () => {
      await saveSetting("volume", 0.75);
      const result = await loadSetting("volume");
      expect(result).toBe(0.75);
    });

    it("returns null for an unknown setting", async () => {
      const result = await loadSetting("nonexistent");
      expect(result).toBeNull();
    });

    it("overwrites an existing setting", async () => {
      await saveSetting("volume", 0.5);
      await saveSetting("volume", 0.9);
      const result = await loadSetting("volume");
      expect(result).toBe(0.9);
    });
  });
});
