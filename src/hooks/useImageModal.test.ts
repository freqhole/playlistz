import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Playlist, Song } from "../types/playlist.js";

// mock getImageUrlForContext so tests don't need real blob URLs
vi.mock("../services/imageService.js", () => ({
  getImageUrlForContext: vi.fn((item: Playlist | Song) => {
    if ("imageFilePath" in item && item.imageFilePath) return item.imageFilePath;
    if ("imageData" in item && item.imageData) return "blob:mock-url";
    if ("thumbnailData" in item && item.thumbnailData) return "blob:mock-thumb";
    return null;
  }),
}));

import { useImageModal } from "./useImageModal.js";

const makePlaylist = (overrides: Partial<Playlist> = {}): Playlist => ({
  id: "pl-1",
  title: "test playlist",
  songIds: [],
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

const makeSong = (overrides: Partial<Song> = {}): Song => ({
  id: "song-1",
  title: "test song",
  artist: "artist",
  album: "album",
  duration: 180,
  position: 0,
  mimeType: "audio/mpeg",
  originalFilename: "test.mp3",
  playlistId: "pl-1",
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

describe("useImageModal", () => {
  let modal: ReturnType<typeof useImageModal>;

  beforeEach(() => {
    modal = useImageModal();
  });

  describe("generateImageList / openImageModal (standalone mode - imageFilePath only)", () => {
    it("includes playlist cover when only imageFilePath is set (no buffer data)", () => {
      const playlist = makePlaylist({ imageFilePath: "data/playlist-cover.jpg", imageType: "image/jpeg" });
      modal.openImageModal(playlist, []);
      expect(modal.showImageModal()).toBe(true);
      expect(modal.getImageCount()).toBe(1);
      expect(modal.getCurrentImageMetadata()?.type).toBe("playlist");
      expect(modal.getCurrentImageUrl()).toBe("data/playlist-cover.jpg");
    });

    it("includes playlist cover when imageFilePath present but imageType absent", () => {
      const playlist = makePlaylist({ imageFilePath: "data/playlist-cover.jpg" });
      modal.openImageModal(playlist, []);
      expect(modal.showImageModal()).toBe(true);
      expect(modal.getImageCount()).toBe(1);
    });

    it("includes song images when only imageFilePath is set (no buffer data)", () => {
      const playlist = makePlaylist();
      const song = makeSong({ imageFilePath: "data/01-track-cover.jpg", imageType: "image/jpeg" });
      modal.openImageModal(playlist, [song]);
      expect(modal.getImageCount()).toBe(1);
      expect(modal.getCurrentImageMetadata()?.type).toBe("song");
      expect(modal.getCurrentImageUrl()).toBe("data/01-track-cover.jpg");
    });

    it("includes songs with imageFilePath but no imageType", () => {
      const playlist = makePlaylist();
      const song = makeSong({ imageFilePath: "data/cover.png" });
      modal.openImageModal(playlist, [song]);
      expect(modal.getImageCount()).toBe(1);
    });

    it("collects all songs with imageFilePath into the carousel", () => {
      const playlist = makePlaylist({ imageFilePath: "data/playlist-cover.jpg" });
      const songs = [
        makeSong({ id: "s1", imageFilePath: "data/s1-cover.jpg" }),
        makeSong({ id: "s2", imageFilePath: "data/s2-cover.jpg" }),
        makeSong({ id: "s3" }), // no image - should be excluded
      ];
      modal.openImageModal(playlist, songs);
      // playlist cover + 2 songs with images
      expect(modal.getImageCount()).toBe(3);
    });
  });

  describe("generateImageList / openImageModal (in-memory buffer mode)", () => {
    it("includes playlist cover when imageData buffer is present", () => {
      const playlist = makePlaylist({
        imageType: "image/jpeg",
        imageData: new ArrayBuffer(8),
      });
      modal.openImageModal(playlist, []);
      expect(modal.getImageCount()).toBe(1);
      expect(modal.getCurrentImageMetadata()?.type).toBe("playlist");
    });

    it("includes song when imageData buffer is present", () => {
      const playlist = makePlaylist();
      const song = makeSong({ imageType: "image/jpeg", imageData: new ArrayBuffer(8) });
      modal.openImageModal(playlist, [song]);
      expect(modal.getImageCount()).toBe(1);
      expect(modal.getCurrentImageMetadata()?.type).toBe("song");
    });

    it("excludes song with no image data and no imageFilePath", () => {
      const playlist = makePlaylist();
      const song = makeSong(); // no image fields
      modal.openImageModal(playlist, [song]);
      expect(modal.showImageModal()).toBe(false);
      expect(modal.getImageCount()).toBe(0);
    });
  });

  describe("openImageModal does not open when no images exist", () => {
    it("does not open when playlist has no image and songs have no images", () => {
      const playlist = makePlaylist();
      modal.openImageModal(playlist, [makeSong()]);
      expect(modal.showImageModal()).toBe(false);
    });

    it("does not open with null playlist and no songs", () => {
      modal.openImageModal(null, []);
      expect(modal.showImageModal()).toBe(false);
    });
  });

  describe("navigation", () => {
    beforeEach(() => {
      const playlist = makePlaylist({ imageFilePath: "data/playlist-cover.jpg" });
      const songs = [
        makeSong({ id: "s1", imageFilePath: "data/s1-cover.jpg" }),
        makeSong({ id: "s2", imageFilePath: "data/s2-cover.jpg" }),
      ];
      modal.openImageModal(playlist, songs);
    });

    it("starts at requested index", () => {
      const playlist = makePlaylist({ imageFilePath: "data/playlist-cover.jpg" });
      modal.openImageModal(playlist, []);
      expect(modal.getCurrentImageMetadata()?.type).toBe("playlist");
    });

    it("handleNextImage advances index", () => {
      expect(modal.getCurrentImageMetadata()?.id).toBe("pl-1");
      modal.handleNextImage();
      expect(modal.getCurrentImageMetadata()?.id).toBe("s1");
    });

    it("handleNextImage wraps around to first", () => {
      modal.handleNextImage();
      modal.handleNextImage();
      modal.handleNextImage(); // wraps
      expect(modal.getCurrentImageMetadata()?.id).toBe("pl-1");
    });

    it("handlePrevImage wraps to last image", () => {
      modal.handlePrevImage();
      expect(modal.getCurrentImageMetadata()?.id).toBe("s2");
    });

    it("closeImageModal clears state", () => {
      modal.closeImageModal();
      expect(modal.showImageModal()).toBe(false);
      expect(modal.getImageCount()).toBe(0);
    });
  });
});
