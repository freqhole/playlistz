// test utilities for creating properly typed mock data

import type { Playlist, Song } from "../types/playlist.js";
import type {
  StandaloneData,
  StandaloneSongData,
} from "../services/standaloneService.js";

// create a minimal but valid song object for testing
export function createMockSong(overrides: Partial<Song> = {}): Song {
  const now = Date.now();
  return {
    id: "test-song-id",
    mimeType: "audio/mp3",
    originalFilename: "test-song.mp3",
    title: "Test Song",
    artist: "Test Artist",
    album: "Test Album",
    duration: 180,
    position: 0,
    createdAt: now,
    updatedAt: now,
    playlistId: "test-playlist-id",
    ...overrides,
  };
}

// create a minimal but valid playlist object for testing
export function createMockPlaylist(
  overrides: Partial<Playlist> = {}
): Playlist {
  const now = Date.now();
  return {
    id: "test-playlist-id",
    title: "Test Playlist",
    songIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// create a song with audio data for testing
export function createMockSongWithAudio(overrides: Partial<Song> = {}): Song {
  const audioData = new ArrayBuffer(1024); // mock audio data
  return createMockSong({
    audioData,
    fileSize: audioData.byteLength,
    ...overrides,
  });
}

// create a song with image data for testing
export function createMockSongWithImage(overrides: Partial<Song> = {}): Song {
  const imageData = new ArrayBuffer(2048); // mock image data
  const thumbnailData = new ArrayBuffer(512); // mock thumbnail data
  return createMockSong({
    imageData,
    thumbnailData,
    imageType: "image/jpeg",
    ...overrides,
  });
}

// create a playlist with image data for testing
export function createMockPlaylistWithImage(
  overrides: Partial<Playlist> = {}
): Playlist {
  const imageData = new ArrayBuffer(2048);
  const thumbnailData = new ArrayBuffer(512);
  return createMockPlaylist({
    imageData,
    thumbnailData,
    imageType: "image/jpeg",
    ...overrides,
  });
}

// create mock standalone song data
export function createMockStandaloneSongData(
  overrides: Partial<StandaloneSongData> = {}
): StandaloneSongData {
  return {
    id: "test-song-id",
    title: "Test Song",
    artist: "Test Artist",
    album: "Test Album",
    duration: 180,
    originalFilename: "test-song.mp3",
    fileSize: 1024,
    sha: "mock-sha-hash",
    ...overrides,
  };
}

// create mock standalone data
export function createMockStandaloneData(
  overrides: Partial<StandaloneData> = {}
): StandaloneData {
  return {
    playlist: {
      id: "test-playlist-id",
      title: "test playlist",
      description: "test description",
      rev: 1,
    },
    songs: [createMockStandaloneSongData()],
    ...overrides,
  };
}

// create a complete playlist with songs for testing
export function createMockPlaylistWithSongs(songCount = 3): {
  playlist: Playlist;
  songs: Song[];
} {
  const songs = Array.from({ length: songCount }, (_, i) =>
    createMockSong({
      id: `song-${i}`,
      title: `song ${i + 1}`,
      position: i,
    })
  );

  const playlist = createMockPlaylist({
    songIds: songs.map((song) => song.id),
  });

  return { playlist, songs };
}

// helper to create arraybuffer with specific content for testing
export function createMockArrayBuffer(
  size: number,
  fillByte = 42
): ArrayBuffer {
  const buffer = new ArrayBuffer(size);
  const view = new Uint8Array(buffer);
  view.fill(fillByte);
  return buffer;
}

// mock file object for upload tests
export function createMockFile(
  name = "test.mp3",
  type = "audio/mp3",
  size = 1024
): File {
  const content = new ArrayBuffer(size);
  return new File([content], name, { type });
}

// create minimal objects for testing (when full objects aren't needed)
export const mockIds = {
  playlist: "test-playlist-id",
  song: "test-song-id",
  user: "test-user-id",
} as const;

// common test data
export const mockTimestamp = 1640995200000; // fixed timestamp for consistent tests
export const mockSha =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const mockMimeTypes = {
  audio: "audio/mp3",
  image: "image/jpeg",
  video: "video/mp4",
} as const;
