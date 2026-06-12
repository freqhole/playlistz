/* @jsxImportSource solid-js */
import {
  createSignal,
  createEffect,
  createMemo,
  on,
  onMount,
  onCleanup,
  untrack,
} from "solid-js";
import type { Playlist, Song } from "../types/playlist.js";
import { createDocIndexQuery } from "./createDocIndexQuery.js";
import {
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  addSongToPlaylist,
  deleteSong,
  reorderSongsInDoc,
  getSongsForPlaylist,
  docToPlaylistAsync,
} from "../services/playlistDocService.js";
import { findPlaylistDoc } from "../services/automergeRepo.js";
import { parsePlaylistDoc } from "freqhole-api-client/playlistz";
import {
  refreshPlaylistQueue,
  audioState,
  stop,
} from "../services/audioService.js";
import { filterAudioFiles } from "../services/fileProcessingService.js";
import { log } from "../utils/log.js";
import {
  parsePlaylistZip,
  downloadPlaylistAsZip,
} from "../services/playlistDownloadService.js";
import {
  cacheAudioFile,
  initializeOfflineSupport,
  updatePWAManifest,
} from "../services/offlineService.js";
import {
  initializeAllStandalonePlaylists,
  clearStandaloneLoadingProgress,
} from "../services/standaloneService.js";
import { getImageUrlForContext } from "../services/imageService.js";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { DocIndexEntry } from "../services/indexedDBService.js";

export function usePlaylistManager() {
  const [playlists, setPlaylists] = createSignal<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = createSignal<Playlist | null>(
    null
  );
  const [playlistSongs, setPlaylistSongs] = createSignal<Song[]>([]);
  const [isInitialized, setIsInitialized] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // modal and UI state
  const [showImageModal, setShowImageModal] = createSignal(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
  const [modalImageIndex, setModalImageIndex] = createSignal(0);

  // loading and operation state
  const [isDownloading, setIsDownloading] = createSignal(false);
  const [isCaching, setIsCaching] = createSignal(false);
  const [allSongsCached, setAllSongsCached] = createSignal(false);

  const [backgroundImageUrl, setBackgroundImageUrl] = createSignal<
    string | null
  >(null);
  const [imageUrlCache] = createSignal(new Map<string, string>());

  const [backgroundOverride, setBackgroundOverride] = createSignal<
    Song | "cover" | null
  >(null);

  const [backgroundSource, setBackgroundSource] = createSignal<string | null>(
    null
  );

  // live docIndex query - drives sidebar
  const docIndexEntries = createDocIndexQuery();

  // unsubscribe fn for the selected playlist's doc change listener
  let docStoreCleanup: (() => void) | null = null;

  // convert docIndex entries to Playlist view objects and update signal
  let _syncCalls = 0;
  async function syncPlaylistsFromDocIndex(
    entries: DocIndexEntry[]
  ): Promise<void> {
    _syncCalls++;
    const syncId = _syncCalls;
    log.debug("playlist.sync", "syncPlaylists #", String(syncId), "entries:", String(entries.length));
    try {
      const resolved = await Promise.all(
        entries.map(async (entry) => {
          try {
            const handle = await findPlaylistDoc(
              entry.docId as AutomergeUrl
            );
            const raw = handle.doc();
            const doc = parsePlaylistDoc(raw ?? {});
            return await docToPlaylistAsync(entry.docId, doc);
          } catch {
            // doc not yet available - use entry metadata as placeholder
            return {
              id: entry.docId,
              title: entry.title,
              description: undefined,
              createdAt: entry.addedAt,
              updatedAt: entry.addedAt,
              songIds: [],
            } as Playlist;
          }
        })
      );

      log.debug("playlist.sync", "syncPlaylists #", String(syncId), "resolved", String(resolved.length));
      setPlaylists(resolved);

      // keep selected playlist in sync
      const current = selectedPlaylist();
      if (current) {
        const updated = resolved.find((p) => p.id === current.id);
        if (updated) {
          setSelectedPlaylist(updated);
        } else if (resolved.length > 0) {
          setSelectedPlaylist(resolved[0]!);
        } else {
          setSelectedPlaylist(null);
        }
      } else if (resolved.length > 0) {
        // nothing selected but playlists exist - auto-select first
        setSelectedPlaylist(resolved[0]!);
      }
    } catch (err) {
      log.error("playlist.sync", "error syncing playlists from doc index:", err);
    }
  }

  // update songs when selected playlist changes
  async function loadSongsForSelected(playlist: Playlist | null): Promise<void> {
    if (!playlist) {
      setPlaylistSongs([]);
      return;
    }
    try {
      const songs = await getSongsForPlaylist(playlist.id);
      setPlaylistSongs(songs);
    } catch (err) {
      log.error("playlist.songs", "error loading songs for playlist:", err);
      setPlaylistSongs([]);
    }
  }

  const initialize = async () => {
    try {
      setError(null);

      // check to init standalone mode
      if (window.STANDALONE_MODE) {
        await initializeOfflineSupport();
        await updatePWAManifest("Playlistz", undefined);

        const deferredData = window.DEFERRED_PLAYLIST_DATA;
        if (deferredData && deferredData.length > 0) {
          try {
            await initializeAllStandalonePlaylists(deferredData, {
              setSelectedPlaylist,
              setPlaylistSongs,
              setSidebarCollapsed: () => {},
              setError,
            });
            delete window.DEFERRED_PLAYLIST_DATA;
          } catch (err) {
            log.error("playlist.init", "error initializing deferred playlist:", err);
            setError("failed to initialize playlist!");
          }
        }

        clearStandaloneLoadingProgress();
      }

      try {
        await initializeOfflineSupport();
      } catch (offlineError) {
        log.warn("playlist.init", "offline support initialization failed:", offlineError);
      }

      setIsInitialized(true);
    } catch (err) {
      log.error("playlist.init", "error initializing playlist manager:", err);
      setError("failed to initialize playlist");
    }
  };

  const createNewPlaylist = async (title: string = "new playlist") => {
    try {
      setError(null);
      const playlist = await createPlaylist({ title, description: "" });
      return playlist;
    } catch (err) {
      log.error("playlist.create", "error creating playlist:", err);
      setError("failed to create new playlist!");
      return null;
    }
  };

  const handleFileDrop = async (files: FileList, targetPlaylistId?: string) => {
    try {
      setError(null);

      if (files.length === 1 && files[0]?.name.toLowerCase().endsWith(".zip")) {
        const zipFile = files[0];
        const result = await parsePlaylistZip(zipFile);
        return result.playlist;
      }

      const audioFiles = filterAudioFiles(Array.from(files));
      if (audioFiles.length === 0) {
        setError("no audio filez found!");
        return null;
      }

      let playlistId = targetPlaylistId;
      if (!playlistId) {
        const newPlaylist = await createNewPlaylist("dropped filez");
        if (!newPlaylist) return null;
        playlistId = newPlaylist.id;
      }

      for (const audioFile of audioFiles) {
        await addSongToPlaylist(playlistId, audioFile);
      }

      // reload songs for selected playlist if this is it
      const sel = selectedPlaylist();
      if (sel && sel.id === playlistId) {
        await loadSongsForSelected(sel);
      }

      return playlistId;
    } catch (err) {
      log.error("playlist.drop", "error handling file drop:", err);
      setError("failed to process dropped files");
      return null;
    }
  };

  // reactive effect: when docIndex changes, refresh the playlists list
  createEffect(() => {
    const entries = docIndexEntries();
    log.debug("playlist.docindex", "docIndex effect fired, entries:", String(entries.length));
    void syncPlaylistsFromDocIndex(entries);
  });

  // reactive effect (keyed by playlist id): when the selection changes,
  // subscribe to the doc handle so any mutation (adding songs, edits,
  // remote sync) refreshes the songs list and the playlist view object.
  // the memo is critical: selectedPlaylist() gets a new object identity on
  // every doc refresh, but the effect must only re-run when the id changes,
  // otherwise refresh -> setSelectedPlaylist -> effect would loop forever.
  const selectedPlaylistId = createMemo(() => selectedPlaylist()?.id ?? null);

  createEffect(
    on(
      selectedPlaylistId,
      (playlistId) => {
        log.debug("playlist.select", "selection effect fired:", playlistId ?? "null");
        if (docStoreCleanup) {
          docStoreCleanup();
          docStoreCleanup = null;
        }

        if (!playlistId) {
          setPlaylistSongs([]);
          return;
        }

        let disposed = false;

        let _refreshCount = 0;
        const refresh = async (
          handle: Awaited<ReturnType<typeof findPlaylistDoc>>
        ) => {
          _refreshCount++;
          log.debug("playlist.select", "selected-doc refresh #", String(_refreshCount), playlistId);
          try {
            const raw = handle.doc();
            const doc = parsePlaylistDoc(raw ?? {});
            const updated = await docToPlaylistAsync(playlistId, doc);

            setPlaylists((prev) =>
              prev.map((p) => (p.id === playlistId ? updated : p))
            );
            const current = untrack(selectedPlaylist);
            if (current?.id === playlistId) {
              setSelectedPlaylist(updated);
            }

            const songs = await getSongsForPlaylist(playlistId);
            if (!disposed) {
              setPlaylistSongs(songs);
            }
          } catch (err) {
            log.error("playlist.select", "error refreshing selected playlist doc:", err);
          }
        };

        void (async () => {
          try {
            const handle = await findPlaylistDoc(playlistId as AutomergeUrl);
            if (disposed) return;

            const onChange = () => {
              log.debug("playlist.select", "selected-doc change event -> refresh", playlistId);
              void refresh(handle);
            };
            handle.on("change", onChange);
            docStoreCleanup = () => handle.off("change", onChange);

            await refresh(handle);
          } catch (err) {
            log.error("playlist.select", "error subscribing to playlist doc:", err);
            if (!disposed) {
              setPlaylistSongs([]);
            }
          }
        })();

        onCleanup(() => {
          disposed = true;
        });
      }
    )
  );

  // update background image based on override, currently playing song, or selected playlist
  createEffect(() => {
    const override = backgroundOverride();
    const currentSong = audioState.currentSong();
    const currentPlaylist = audioState.currentPlaylist();
    const selectedPl = selectedPlaylist();
    const cache = imageUrlCache();

    let newImageUrl: string | null = null;
    let cacheKey: string | null = null;

    if (override && override !== "cover" && override.imageType) {
      cacheKey = `song-${override.id}`;
      if (cache.has(cacheKey)) {
        newImageUrl = cache.get(cacheKey)!;
      } else {
        newImageUrl = getImageUrlForContext(override, "background");
        if (newImageUrl) {
          cache.set(cacheKey, newImageUrl);
        }
      }
    } else if (override === "cover" && selectedPl?.imageType) {
      cacheKey = `playlist-${selectedPl.id}`;
      if (cache.has(cacheKey)) {
        newImageUrl = cache.get(cacheKey)!;
      } else {
        newImageUrl = getImageUrlForContext(selectedPl, "background");
        if (newImageUrl) {
          cache.set(cacheKey, newImageUrl);
        }
      }
    } else if (currentSong?.imageType) {
      cacheKey = `song-${currentSong.id}`;
      if (cache.has(cacheKey)) {
        newImageUrl = cache.get(cacheKey)!;
      } else {
        newImageUrl = getImageUrlForContext(currentSong, "background");
        if (newImageUrl) {
          cache.set(cacheKey, newImageUrl);
        }
      }
    } else if (currentSong && currentPlaylist?.imageType) {
      cacheKey = `playlist-${currentPlaylist.id}`;
      if (cache.has(cacheKey)) {
        newImageUrl = cache.get(cacheKey)!;
      } else {
        newImageUrl = getImageUrlForContext(currentPlaylist, "background");
        if (newImageUrl) {
          cache.set(cacheKey, newImageUrl);
        }
      }
    } else if (selectedPl?.imageType) {
      cacheKey = `playlist-${selectedPl.id}`;
      if (cache.has(cacheKey)) {
        newImageUrl = cache.get(cacheKey)!;
      } else {
        newImageUrl = getImageUrlForContext(selectedPl, "background");
        if (newImageUrl) {
          cache.set(cacheKey, newImageUrl);
        }
      }
    }

    const prevUrl = backgroundImageUrl();
    if (prevUrl !== newImageUrl) {
      setBackgroundImageUrl(newImageUrl);
    }
    setBackgroundSource(cacheKey);
  });

  // update PWA manifest when playlist changes
  createEffect(() => {
    const playlist = selectedPlaylist();
    if (playlist) {
      log.debug("playlist.manifest", "PWA manifest effect fired", playlist.id);
      updatePWAManifest(playlist.title, playlist);
    }
  });

  const getPlaylistById = (id: string): Playlist | undefined => {
    return playlists().find((p) => p.id === id);
  };

  const playlistExists = (id: string): boolean => {
    return playlists().some((p) => p.id === id);
  };

  const getPlaylistCount = (): number => {
    return playlists().length;
  };

  const searchPlaylists = (query: string): Playlist[] => {
    if (!query.trim()) return playlists();
    const lowercaseQuery = query.toLowerCase();
    return playlists().filter(
      (playlist) =>
        playlist.title.toLowerCase().includes(lowercaseQuery) ||
        (playlist.description || "").toLowerCase().includes(lowercaseQuery)
    );
  };

  const selectPlaylist = (playlist: Playlist | null) => {
    setSelectedPlaylist(playlist);
  };

  const handlePlaylistUpdate = async (updates: Partial<Playlist>) => {
    const playlist = selectedPlaylist();
    if (!playlist) return;

    log.debug("playlist.update", "handlePlaylistUpdate", playlist.id, JSON.stringify(updates));
    try {
      setError(null);
      await updatePlaylist(playlist.id, {
        title: updates.title,
        description: updates.description,
      });
      // reactive query will refresh from docIndex
    } catch (err) {
      log.error("playlist.update", "error updating playlist:", err);
      setError("failed to update playlist!");
    }
  };

  const handleDeletePlaylist = async () => {
    const playlist = selectedPlaylist();
    if (!playlist) return;

    try {
      setError(null);

      const currentSong = audioState.currentSong();
      if (currentSong && currentSong.playlistId === playlist.id) {
        stop();
      }

      await deletePlaylist(playlist.id);
      setSelectedPlaylist(null);
      setShowDeleteConfirm(false);
    } catch (err) {
      log.error("playlist.delete", "error deleting playlist:", err);
      setError("failed to delete playlist!");
    }
  };

  const handleDownloadPlaylist = async () => {
    const playlist = selectedPlaylist();
    if (!playlist) return;

    setIsDownloading(true);
    try {
      setError(null);
      await downloadPlaylistAsZip(playlist, {
        includeMetadata: true,
        includeImages: true,
        generateM3U: true,
        includeHTML: true,
      });
    } catch (err) {
      log.error("playlist.download", "error downloading playlist:", err);
      setError("failed to download playlist!");
    } finally {
      setIsDownloading(false);
    }
  };

  const handleRemoveSong = async (songId: string, onClose?: () => void) => {
    const playlist = selectedPlaylist();
    if (!playlist) return;

    try {
      setError(null);

      const currentSong = audioState.currentSong();
      if (currentSong && currentSong.id === songId) {
        stop();
      }

      await deleteSong(playlist.id, songId);
      await loadSongsForSelected(playlist);

      if (onClose) {
        onClose();
      }
    } catch (err) {
      log.error("playlist.songs", "error removing song from playlist:", err);
      setError("failed to remove song from playlist!");
    }
  };

  const handleReorderSongs = async (oldIndex: number, newIndex: number) => {
    const playlist = selectedPlaylist();
    if (!playlist) return;

    try {
      setError(null);
      await reorderSongsInDoc(playlist.id, oldIndex, newIndex);

      // reload songs to reflect new order
      await loadSongsForSelected(playlist);

      // refresh audio queue if this playlist is currently playing
      const currentPlaylist = audioState.currentPlaylist();
      if (currentPlaylist && currentPlaylist.id === playlist.id) {
        const updated = selectedPlaylist();
        if (updated) {
          await refreshPlaylistQueue(updated);
        }
      }
    } catch (err) {
      log.error("playlist.songs", "error reordering songz:", err);
      setError("failed to reorder songz");
    }
  };

  const handleCachePlaylist = async () => {
    const songs = playlistSongs();
    if (songs.length === 0) return;

    setIsCaching(true);
    try {
      setError(null);

      for (const song of songs) {
        // songs are now blob-store backed; use blobUrl if available
        const url = song.blobUrl;
        if (url && song.id) {
          try {
            await cacheAudioFile(url, song.title || "unknown song");
          } catch {
            // ignore individual caching failures
          }
        }
      }

      setAllSongsCached(true);
    } catch (err) {
      log.error("playlist.cache", "error caching playlist:", err);
      setError("failed to cache playlist for offline use!");
    } finally {
      setIsCaching(false);
    }
  };

  onMount(initialize);

  onCleanup(() => {
    if (docStoreCleanup) {
      docStoreCleanup();
      docStoreCleanup = null;
    }

    const cache = imageUrlCache();
    cache.forEach((url) => {
      if (url.startsWith("blob:")) {
        URL.revokeObjectURL(url);
      }
    });
    cache.clear();
  });

  // auto clear error after some time
  createEffect(() => {
    const errorMsg = error();
    if (errorMsg) {
      const timeoutId = setTimeout(() => {
        setError(null);
      }, 10_000);

      onCleanup(() => clearTimeout(timeoutId));
    }
  });

  return {
    playlists,
    selectedPlaylist,
    playlistSongs,
    isInitialized,
    error,
    backgroundImageUrl,
    backgroundSource,
    imageUrlCache,

    // modal and UI state
    showImageModal,
    showDeleteConfirm,
    modalImageIndex,
    isDownloading,
    isCaching,
    allSongsCached,

    // setterz
    setSelectedPlaylist,
    setPlaylistSongs,
    setShowImageModal,
    setShowDeleteConfirm,
    setModalImageIndex,
    setBackgroundOverride,

    // actionz
    initialize,
    createNewPlaylist,
    handleFileDrop,
    selectPlaylist,
    handlePlaylistUpdate,
    handleDeletePlaylist,
    handleDownloadPlaylist,
    handleRemoveSong,
    handleReorderSongs,
    handleCachePlaylist,

    // utilz
    getPlaylistById,
    playlistExists,
    getPlaylistCount,
    searchPlaylists,
  };
}
