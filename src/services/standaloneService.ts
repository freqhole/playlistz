// standalone playlist ingestion and caching service.
// ingests FreqholePlaylist data (embedded via window.__PLAYLISTZ__) into
// automerge docs and the blob store. designed for standalone zip export playback.

import { createSignal } from "solid-js";
import { saveSetting, loadSetting } from "./indexedDBService.js";
import { createPlaylistDoc, findPlaylistDoc } from "./automergeRepo.js";
import {
  emptyPlaylistDoc,
  upsertSong,
  setMetadata,
  parsePlaylistDoc,
  type SongEntry,
} from "freqhole-api-client/playlistz";
import { getBlobMetadata } from "freqhole-api-client/storage";
import { addDocIndexEntry } from "./docIndexService.js";
import {
  docToPlaylist,
  setSongCoverImage,
  setPlaylistCoverImage,
  getSongsForPlaylist,
  getSongById,
} from "./playlistDocService.js";
import { downloadSongIfNeeded } from "./streamingAudioService.js";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { Playlist, Song } from "../types/playlist.js";
import type {
  FreqholePlaylist,
  FreqholePlaylistSong,
} from "../utils/standaloneTemplates.js";

// backwards-compatible alias for FreqholePlaylist
export type StandaloneData = FreqholePlaylist;

// interface for callback functions
interface StandaloneCallbacks {
  setSelectedPlaylist: (playlist: Playlist) => void;
  setPlaylistSongs: (songs: Song[]) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setError: (error: string) => void;
}

// loading progress signal
const [standaloneLoadingProgress, setStandaloneLoadingProgress] = createSignal<{
  current: number;
  total: number;
  currentSong: string;
  phase: "initializing" | "checking" | "updating" | "complete" | "reloading";
} | null>(null);

export { standaloneLoadingProgress, setStandaloneLoadingProgress };

// module-level registry: songId -> standaloneFilePath
// populated during initializeStandalonePlaylist, used by loadStandaloneSongAudioData
const standalonePathRegistry = new Map<string, string>();

// for testing: register a standalone path for a song
export function registerStandalonePath(songId: string, path: string): void {
  standalonePathRegistry.set(songId, path);
}

// for testing: clear all registered paths between test runs
export function clearStandaloneRegistry(): void {
  standalonePathRegistry.clear();
}

// shape stored in settings store for idempotency tracking
interface StandaloneRecord {
  rev: number;
  docId: string;
}

// resolve the data file path for a standalone song entry
function resolveStandalonePath(songData: FreqholePlaylistSong): string {
  return `data/${songData.safeFilename ?? songData.originalFilename}`;
}

// create an automerge doc from standalone playlist data.
// audio bytes are not fetched upfront - sha from embedded data is stored in the doc.
async function createStandaloneDoc(
  playlistData: StandaloneData
): Promise<string> {
  const { docId, handle } = createPlaylistDoc(
    emptyPlaylistDoc({
      title: playlistData.playlist.title,
      description: playlistData.playlist.description ?? "",
    })
  );

  handle.change((doc) => {
    for (const songData of playlistData.songs) {
      const entry: SongEntry = {
        id: songData.id,
        title: songData.title,
        artist: songData.artist,
        album: songData.album,
        duration: songData.duration,
        mimeType: songData.mimeType ?? "audio/mpeg",
        fileSize: songData.fileSize,
        sha256: songData.sha ?? "",
        images: [],
        urls: [],
      };
      upsertSong(doc, entry);
    }
  });

  await addDocIndexEntry({
    docId,
    title: playlistData.playlist.title,
    addedAt: Date.now(),
    source: "local",
  });

  return docId;
}

// update an existing standalone doc with new revision data.
async function updateStandaloneDoc(
  docId: string,
  playlistData: StandaloneData
): Promise<void> {
  const handle = await findPlaylistDoc(docId as AutomergeUrl);
  handle.change((doc) => {
    setMetadata(doc, {
      title: playlistData.playlist.title,
      description: playlistData.playlist.description ?? "",
    });
    for (const songData of playlistData.songs) {
      const entry: SongEntry = {
        id: songData.id,
        title: songData.title,
        artist: songData.artist,
        album: songData.album,
        duration: songData.duration,
        mimeType: songData.mimeType ?? "audio/mpeg",
        fileSize: songData.fileSize,
        sha256: songData.sha ?? "",
        images: [],
        urls: [],
      };
      upsertSong(doc, entry);
    }
  });
}

// build Song view objects for the callbacks.
// populates standaloneFilePath and imageFilePath from embedded standalone metadata
// and registers paths in standalonePathRegistry for later audio loading.
function buildStandaloneSongs(
  playlistData: StandaloneData,
  docId: string
): Song[] {
  return playlistData.songs.map((songData, i) => {
    const standaloneFilePath = resolveStandalonePath(songData);
    standalonePathRegistry.set(songData.id, standaloneFilePath);

    const imageFilePath =
      songData.imageFilePath ??
      (songData.imageExtension
        ? `data/${(songData.safeFilename ?? songData.originalFilename).replace(/\.[^.]+$/, "")}-cover${songData.imageExtension}`
        : undefined);

    const song: Song = {
      id: songData.id,
      title: songData.title,
      artist: songData.artist,
      album: songData.album,
      duration: songData.duration,
      mimeType: songData.mimeType ?? "audio/mpeg",
      fileSize: songData.fileSize,
      originalFilename: songData.originalFilename,
      position: i,
      createdAt: 0,
      updatedAt: 0,
      playlistId: docId,
      sha: songData.sha,
      sha256: songData.sha,
      standaloneFilePath,
      needsImageLoad: !!imageFilePath,
      imageFilePath,
      imageType: songData.imageMimeType,
      images: [],
    };

    return song;
  });
}

// build the Playlist view object for standalone callbacks.
function buildStandalonePlaylist(
  playlistData: StandaloneData,
  docId: string
): Playlist {
  const imageFilePath =
    playlistData.playlist.imageFilePath ??
    (playlistData.playlist.imageExtension
      ? `data/playlist-cover${playlistData.playlist.imageExtension}`
      : undefined);

  return {
    id: docId,
    title: playlistData.playlist.title,
    description: playlistData.playlist.description,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    songIds: playlistData.songs.map((s) => s.id),
    rev: playlistData.playlist.rev,
    needsImageLoad: !!imageFilePath,
    imageFilePath,
    imageType: playlistData.playlist.imageMimeType,
    bgFilterEnabled: playlistData.playlist.bgFilterEnabled,
    bgFilterBlur: playlistData.playlist.bgFilterBlur,
    bgFilterContrast: playlistData.playlist.bgFilterContrast,
    bgFilterBrightness: playlistData.playlist.bgFilterBrightness,
    coverFilterEnabled: playlistData.playlist.coverFilterEnabled,
    coverFilterBlur: playlistData.playlist.coverFilterBlur,
  };
}

// fetch images from standalone file paths, store in the blob store,
// update the doc with image refs, and refresh callbacks.
// skipped for file:// protocol since components read images directly from paths.
async function loadStandaloneImages(
  _playlistData: StandaloneData,
  docId: string,
  playlist: Playlist,
  songs: Song[],
  callbacks: StandaloneCallbacks
): Promise<void> {
  if (window.location.protocol === "file:") {
    return;
  }

  try {
    let anyChanged = false;

    // load playlist cover image
    if (playlist.imageFilePath) {
      try {
        const response = await fetch(playlist.imageFilePath);
        if (response.ok) {
          const imageData = await response.arrayBuffer();
          const mimeType = playlist.imageType ?? "image/jpeg";
          await setPlaylistCoverImage(docId, imageData, mimeType);
          anyChanged = true;
        }
      } catch (err) {
        console.warn(
          `could not load playlist cover from ${playlist.imageFilePath}:`,
          err
        );
      }
    }

    // load song cover images
    for (const song of songs) {
      if (!song.imageFilePath) continue;
      try {
        const response = await fetch(song.imageFilePath);
        if (response.ok) {
          const imageData = await response.arrayBuffer();
          const mimeType = song.imageType ?? "image/jpeg";
          await setSongCoverImage(docId, song.id, imageData, mimeType);
          anyChanged = true;
        }
      } catch (err) {
        console.warn(
          `could not load song image from ${song.imageFilePath}:`,
          err
        );
      }
    }

    if (anyChanged) {
      // refresh songs from doc (now has image refs) and re-add standalone paths
      const updatedDocSongs = await getSongsForPlaylist(docId);
      const updatedSongs = updatedDocSongs.map((s) => ({
        ...s,
        standaloneFilePath: standalonePathRegistry.get(s.id),
      }));
      callbacks.setPlaylistSongs(updatedSongs);

      // refresh playlist from doc
      const handle = await findPlaylistDoc(docId as AutomergeUrl);
      const raw = handle.doc();
      const doc = parsePlaylistDoc(raw ?? {});
      callbacks.setSelectedPlaylist(docToPlaylist(docId, doc));
    }
  } catch (err) {
    console.warn("error loading standalone images:", err);
  }
}

// initialize a standalone playlist from embedded data.
// idempotency: stored in settings as "standalone:<playlistId>" -> { rev, docId }.
// same rev -> use existing doc; higher rev -> update existing doc; no record -> create.
export async function initializeStandalonePlaylist(
  playlistData: StandaloneData,
  callbacks: StandaloneCallbacks
): Promise<void> {
  try {
    if (!playlistData?.playlist || !playlistData?.songs) {
      console.error(
        "error initializing standalone playlist: invalid playlist data"
      );
      callbacks.setError("invalid playlist data provided");
      return;
    }

    if (!callbacks.setError || typeof callbacks.setError !== "function") {
      throw new Error("callbacks.setError is not a function");
    }
    if (
      !callbacks.setPlaylistSongs ||
      typeof callbacks.setPlaylistSongs !== "function"
    ) {
      throw new Error("callbacks.setPlaylistSongs is not a function");
    }

    setStandaloneLoadingProgress({
      current: 0,
      total: playlistData.songs.length,
      currentSong: "initializing...",
      phase: "initializing",
    });

    const settingKey = `standalone:${playlistData.playlist.id}`;
    const existing = await loadSetting<StandaloneRecord>(settingKey);
    const incomingRev = playlistData.playlist.rev ?? 0;

    let docId: string;

    if (!existing) {
      setStandaloneLoadingProgress({
        current: 0,
        total: playlistData.songs.length,
        currentSong: "creating playlist...",
        phase: "initializing",
      });
      docId = await createStandaloneDoc(playlistData);
      await saveSetting(settingKey, { rev: incomingRev, docId });
    } else if (incomingRev > existing.rev) {
      setStandaloneLoadingProgress({
        current: 0,
        total: playlistData.songs.length,
        currentSong: "updating playlist revision...",
        phase: "reloading",
      });
      docId = existing.docId;
      await updateStandaloneDoc(docId, playlistData);
      await saveSetting(settingKey, { rev: incomingRev, docId });
    } else {
      docId = existing.docId;
      setStandaloneLoadingProgress({
        current: 0,
        total: playlistData.songs.length,
        currentSong: "loading playlist...",
        phase: "checking",
      });
    }

    // populate docService song registry for getSongById lookups during audio loading
    await getSongsForPlaylist(docId);

    // build view objects with standalone-specific fields
    const songs = buildStandaloneSongs(playlistData, docId);
    const playlist = buildStandalonePlaylist(playlistData, docId);

    callbacks.setSelectedPlaylist(playlist);
    callbacks.setPlaylistSongs(songs);

    setTimeout(() => setStandaloneLoadingProgress(null), 500);

    // background: fetch images from file paths and store in blob store
    setTimeout(
      () =>
        loadStandaloneImages(
          playlistData,
          docId,
          playlist,
          songs,
          callbacks
        ),
      1000
    );
  } catch (err) {
    console.error("error initializing standalone playlist:", err);
    callbacks.setError("failed to load standalone playlist");
    setStandaloneLoadingProgress(null);
  }
}

// load and cache a standalone song's audio bytes into the blob store.
// delegates to downloadSongIfNeeded from streamingAudioService.
// returns true if audio is available (already cached, file:// protocol, or downloaded).
export async function loadStandaloneSongAudioData(
  songId: string
): Promise<boolean> {
  try {
    if (window.location.protocol === "file:") {
      return true;
    }

    const standaloneFilePath = standalonePathRegistry.get(songId);
    if (!standaloneFilePath) {
      console.error(`no registered standalone path for song ${songId}`);
      return false;
    }

    // use doc registry entry for sha-based dedup check inside downloadSongIfNeeded
    const song = await getSongById(songId);
    const songForDownload: Song = song ?? {
      id: songId,
      title: songId,
      artist: "",
      album: "",
      duration: 0,
      mimeType: "audio/mpeg",
      originalFilename: standaloneFilePath.split("/").pop() ?? songId,
      position: 0,
      createdAt: 0,
      updatedAt: 0,
      playlistId: "",
    };

    return await downloadSongIfNeeded(songForDownload, standaloneFilePath);
  } catch (error) {
    console.error(
      `error loading standalone song audio data for ${songId}:`,
      error
    );
    return false;
  }
}

// check whether a song's audio needs to be cached.
// returns false for file:// protocol (audio served directly from disk) and
// for songs already present in the blob store keyed by sha.
export async function songNeedsAudioData(song: Song): Promise<boolean> {
  if (window.location.protocol === "file:") {
    return false;
  }

  const sha = song.sha ?? song.sha256;
  if (!sha) {
    return true;
  }

  try {
    const existing = await getBlobMetadata(sha);
    return !existing;
  } catch (error) {
    console.error(
      `error checking song audio data status for ${song.id}:`,
      error
    );
    return true;
  }
}

// clear loading progress (for cleanup or programmatic use)
export function clearStandaloneLoadingProgress(): void {
  setStandaloneLoadingProgress(null);
}

// initialize multiple standalone playlists in sequence
export async function initializeAllStandalonePlaylists(
  playlists: FreqholePlaylist[],
  callbacks: StandaloneCallbacks
): Promise<void> {
  for (const playlistData of playlists) {
    await initializeStandalonePlaylist(playlistData, callbacks);
  }
}
