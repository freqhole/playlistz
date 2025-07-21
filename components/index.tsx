/* @jsxImportSource solid-js */
import {
  createSignal,
  createEffect,
  onMount,
  onCleanup,
  Show,
  For,
} from "solid-js";
import {
  setupDB,
  createPlaylist,
  createPlaylistsQuery,
  updatePlaylist,
} from "../services/indexedDBService.js";
import { cleanup as cleanupAudio } from "../services/audioService.js";
import {
  filterAudioFiles,
  processAudioFiles,
} from "../services/fileProcessingService.js";
import { addSongToPlaylist } from "../services/indexedDBService.js";
import { cleanupTimeUtils } from "../utils/timeUtils.js";
import { PlaylistSidebar } from "./PlaylistSidebar.js";
import { SongRow } from "./SongRow.js";
import { SongEditModal } from "./SongEditModal.js";
import { PlaylistCoverModal } from "./PlaylistCoverModal.js";
import {
  removeSongFromPlaylist,
  getAllSongs,
} from "../services/indexedDBService.js";

import type { Playlist } from "../types/playlist.js";

export function Playlistz() {
  // State
  const [selectedPlaylist, setSelectedPlaylist] = createSignal<Playlist | null>(
    null
  );
  const [isDragOver, setIsDragOver] = createSignal(false);
  const [isInitialized, setIsInitialized] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [currentPlayingSong, setCurrentPlayingSong] = createSignal<
    string | null
  >(null);
  const [audioElement, setAudioElement] = createSignal<HTMLAudioElement | null>(
    null
  );
  const [editingSong, setEditingSong] = createSignal<any | null>(null);
  const [showPlaylistCover, setShowPlaylistCover] = createSignal(false);
  const [playlistSongs, setPlaylistSongs] = createSignal<any[]>([]);

  // Direct signal subscription approach (bypass hook)
  const [playlists, setPlaylists] = createSignal<Playlist[]>([]);

  // Create and subscribe to query directly in component
  onMount(() => {
    const playlistQuery = createPlaylistsQuery();
    const unsubscribe = playlistQuery.subscribe((value) => {
      console.log(`🔄 Direct subscription: ${value.length} playlists`);
      setPlaylists([...value]); // Force new array reference

      // Update selected playlist if it exists in the new data
      const current = selectedPlaylist();
      if (current) {
        const updated = value.find((p) => p.id === current.id);
        if (
          updated &&
          JSON.stringify(updated.songIds) !== JSON.stringify(current.songIds)
        ) {
          console.log(
            `🔄 Updating selected playlist songs: ${updated.songIds.length} songs`
          );
          setSelectedPlaylist(updated);
        }
      }
    });

    onCleanup(unsubscribe);
  });

  // Load playlist songs when selected playlist changes
  createEffect(async () => {
    const playlist = selectedPlaylist();
    if (playlist && playlist.songIds.length > 0) {
      try {
        const allSongs = await getAllSongs();
        const songs = allSongs.filter((song) =>
          playlist.songIds.includes(song.id)
        );
        setPlaylistSongs(songs);
      } catch (err) {
        console.error("Error loading playlist songs:", err);
      }
    } else {
      setPlaylistSongs([]);
    }
  });

  // Auto-clear errors after 5 seconds
  createEffect(() => {
    const errorMessage = error();
    if (errorMessage) {
      const timer = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(timer);
    }
    return undefined;
  });

  // Initialize database
  onMount(async () => {
    try {
      await setupDB();
      setIsInitialized(true);
      console.log("✅ Playlistz initialized with IndexedDB");
    } catch (err) {
      console.error("❌ Failed to initialize Playlistz:", err);
      setError(err instanceof Error ? err.message : "failed to initialize");
    }
  });

  // Cleanup on unmount
  onCleanup(() => {
    cleanupAudio();
    cleanupTimeUtils();
  });

  // Global drag and drop handlers
  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const items = e.dataTransfer?.items;
    if (items) {
      const hasAudioFiles = Array.from(items).some(
        (item) => item.kind === "file" && item.type.startsWith("audio/")
      );
      if (hasAudioFiles) {
        setIsDragOver(true);
      }
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Only hide overlay if leaving the root element
    if (e.target === e.currentTarget) {
      setIsDragOver(false);
    }
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = e.dataTransfer?.files;
    if (!files) return;

    const audioFiles = filterAudioFiles(files);
    if (audioFiles.length === 0) {
      setError("no audio files found in the dropped items");
      setTimeout(() => setError(null), 3000);
      return;
    }

    try {
      let targetPlaylist = selectedPlaylist();

      // If no playlist is selected, create a new one
      if (!targetPlaylist) {
        targetPlaylist = await createPlaylist({
          title: "new playlist",
          description: `created from ${audioFiles.length} dropped file${audioFiles.length > 1 ? "s" : ""}`,
          songIds: [],
        });
        setSelectedPlaylist(targetPlaylist);
      }

      // Process files and add to playlist
      const results = await processAudioFiles(audioFiles);
      const successfulFiles = results.filter((r) => r.success);

      // Actually add the songs to the playlist in IndexedDB
      for (const result of successfulFiles) {
        if (result.song) {
          await addSongToPlaylist(targetPlaylist.id, result.song.file, {
            title: result.song.title,
            artist: result.song.artist,
            album: result.song.album,
            duration: result.song.duration,
            image: result.song.image,
          });
        }
      }

      console.log(
        `✅ Added ${successfulFiles.length}/${audioFiles.length} files to playlist`
      );

      // Force refresh the selected playlist from database to get updated songIds
      const updatedPlaylists = playlists();
      const refreshedPlaylist = updatedPlaylists.find(
        (p) => p.id === targetPlaylist.id
      );
      if (refreshedPlaylist) {
        setSelectedPlaylist(refreshedPlaylist);
        console.log(
          `🔄 Refreshed playlist with ${refreshedPlaylist.songIds.length} songs`
        );
      }

      if (results.some((r) => !r.success)) {
        const errorCount = results.filter((r) => !r.success).length;
        setError(
          `${errorCount} file${errorCount > 1 ? "s" : ""} could not be processed`
        );
      }
    } catch (err) {
      console.error("Error handling dropped files:", err);
      setError("failed to process dropped files");
    }
  };

  // Set up global drag and drop listeners
  createEffect(() => {
    if (!isInitialized()) return;

    const root = document.documentElement;

    root.addEventListener("dragenter", handleDragEnter);
    root.addEventListener("dragover", handleDragOver);
    root.addEventListener("dragleave", handleDragLeave);
    root.addEventListener("drop", handleDrop);

    onCleanup(() => {
      root.removeEventListener("dragenter", handleDragEnter);
      root.removeEventListener("dragover", handleDragOver);
      root.removeEventListener("dragleave", handleDragLeave);
      root.removeEventListener("drop", handleDrop);
    });
  });

  // Handle creating new playlist
  const handleCreatePlaylist = async () => {
    try {
      console.log("🔨 Creating new playlist...");
      const newPlaylist = await createPlaylist({
        title: "new playlist",
        description: "",
        songIds: [],
      });
      console.log("✅ Created playlist:", newPlaylist);
      setSelectedPlaylist(newPlaylist);
      console.log("🎯 Set selected playlist to:", newPlaylist);
    } catch (err) {
      console.error("❌ Error creating playlist:", err);
      setError(
        err instanceof Error ? err.message : "failed to create playlist"
      );
    }
  };

  // Handle playlist title/description updates with debouncing
  let saveTimeout: number | undefined;
  const handlePlaylistUpdate = async (updates: Partial<Playlist>) => {
    const current = selectedPlaylist();
    if (!current) return;

    // Update local state immediately for responsive UI
    const updated = { ...current, ...updates };
    setSelectedPlaylist(updated);

    // Debounce database saves
    clearTimeout(saveTimeout);
    saveTimeout = window.setTimeout(async () => {
      try {
        await updatePlaylist(current.id, updates);
        console.log("💾 Saved playlist changes");
      } catch (err) {
        console.error("❌ Failed to save playlist:", err);
        setError("failed to save changes");
      }
    }, 1000);
  };

  // Audio player functions
  const handlePlaySong = async (song: any) => {
    try {
      const audio = audioElement() || new Audio();
      if (!audioElement()) {
        setAudioElement(audio);
      }

      // Stop current song if playing
      if (currentPlayingSong()) {
        audio.pause();
      }

      // Set new source and play
      if (song.blobUrl) {
        audio.src = song.blobUrl;
        audio.currentTime = 0;
        await audio.play();
        setCurrentPlayingSong(song.id);
        console.log(`🎵 Playing: ${song.title}`);
      } else {
        setError("unable to play song - no audio source");
      }
    } catch (err) {
      console.error("❌ Error playing song:", err);
      setError("failed to play song");
    }
  };

  const handleRemoveSong = async (songId: string) => {
    const playlist = selectedPlaylist();
    if (!playlist) return;

    try {
      await removeSongFromPlaylist(playlist.id, songId);
      console.log(`🗑️ Removed song ${songId} from playlist`);
    } catch (err) {
      console.error("❌ Error removing song:", err);
      setError("failed to remove song");
    }
  };

  const handleEditSong = async (song: any) => {
    setEditingSong(song);
  };

  const handleSongSaved = (updatedSong: any) => {
    // Update local playlist songs state
    setPlaylistSongs((prev) =>
      prev.map((song) => (song.id === updatedSong.id ? updatedSong : song))
    );
  };

  const handlePlaylistCoverSaved = (updatedPlaylist: any) => {
    setSelectedPlaylist(updatedPlaylist);
  };

  const handlePauseSong = () => {
    const audio = audioElement();
    if (audio) {
      audio.pause();
      setCurrentPlayingSong(null);
      console.log("⏸️ Paused playback");
    }
  };

  return (
    <div class="relative h-screen bg-black text-white overflow-hidden">
      {/* Background pattern */}
      <div
        class="absolute inset-0 opacity-5"
        style={{
          "background-image":
            "radial-gradient(circle at 25% 25%, #ff00ff 2px, transparent 2px)",
          "background-size": "50px 50px",
        }}
      />

      {/* Loading state or main content */}
      <Show
        when={isInitialized()}
        fallback={
          <div class="flex items-center justify-center h-full">
            <div class="text-center">
              <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-magenta-500 mb-4"></div>
              <p class="text-lg">loading playlistz...</p>
              <p class="text-sm mt-2">
                debug: isInitialized = {String(isInitialized())}
              </p>
            </div>
          </div>
        }
      >
        {/* Main content with sidebar layout */}
        <div class="relative flex h-full">
          {/* Left Sidebar */}
          <PlaylistSidebar
            playlists={playlists()}
            selectedPlaylist={selectedPlaylist()}
            onPlaylistSelect={(playlist) => setSelectedPlaylist(playlist)}
            onCreatePlaylist={handleCreatePlaylist}
            isLoading={false}
          />

          {/* Main Content Area */}
          <div class="flex-1 flex flex-col">
            <Show
              when={selectedPlaylist()}
              fallback={
                <div class="flex-1 flex items-center justify-center">
                  <div class="text-center text-gray-400">
                    <div class="text-4xl mb-6">🎵</div>
                    <h2 class="text-2xl font-light mb-2">select a playlist</h2>
                    <p class="text-lg mb-4">
                      choose a playlist from the sidebar or create a new one
                    </p>
                    <div class="text-sm text-magenta-300">
                      {playlists().length > 0
                        ? `${playlists().length} playlist${playlists().length !== 1 ? "s" : ""} available`
                        : "no playlists yet"}
                    </div>
                  </div>
                </div>
              }
            >
              {(playlist) => (
                <div class="flex-1 flex flex-col p-6">
                  {/* Playlist Header */}
                  <div class="flex items-center justify-between mb-6 border-b border-gray-700 pb-6">
                    <div class="flex items-center gap-4">
                      {/* Playlist Cover */}
                      <button
                        onClick={() => setShowPlaylistCover(true)}
                        class="w-16 h-16 rounded-lg overflow-hidden bg-gray-700 hover:bg-gray-600 flex items-center justify-center transition-colors group"
                        title="Change playlist cover"
                      >
                        <Show
                          when={playlist().image}
                          fallback={
                            <div class="text-center">
                              <svg
                                class="w-6 h-6 text-gray-400 group-hover:text-gray-300"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  stroke-linecap="round"
                                  stroke-linejoin="round"
                                  stroke-width="2"
                                  d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
                                />
                              </svg>
                            </div>
                          }
                        >
                          <img
                            src={playlist().image}
                            alt="Playlist cover"
                            class="w-full h-full object-cover"
                          />
                        </Show>
                      </button>

                      <div class="flex-1">
                        <input
                          type="text"
                          value={playlist().title}
                          onInput={(e) => {
                            handlePlaylistUpdate({
                              title: e.currentTarget.value,
                            });
                          }}
                          class="text-3xl font-bold text-white bg-transparent border-none outline-none focus:bg-gray-800 px-2 py-1 rounded w-full"
                          placeholder="playlist title"
                        />
                        <div class="mt-2">
                          <input
                            type="text"
                            value={playlist().description || ""}
                            placeholder="add description..."
                            onInput={(e) => {
                              handlePlaylistUpdate({
                                description: e.currentTarget.value,
                              });
                            }}
                            class="text-gray-400 bg-transparent border-none outline-none focus:bg-gray-800 px-2 py-1 rounded w-full"
                          />
                        </div>
                      </div>
                    </div>

                    <div class="ml-4 text-right text-sm text-gray-400">
                      <div>
                        {playlist().songIds?.length || 0} song
                        {(playlist().songIds?.length || 0) !== 1 ? "s" : ""}
                      </div>
                    </div>
                  </div>

                  {/* Songs List */}
                  <div class="flex-1 overflow-y-auto">
                    <Show
                      when={playlist().songIds && playlist().songIds.length > 0}
                      fallback={
                        <div class="text-center py-16">
                          <div class="text-6xl mb-6">🎶</div>
                          <div class="text-gray-400 text-xl mb-4">
                            no songs yet
                          </div>
                          <p class="text-gray-400 mb-4">
                            drag and drop audio files here to add them to this
                            playlist
                          </p>
                          <div class="text-xs text-gray-500 space-y-1">
                            <div>playlist id: {playlist().id}</div>
                            <div>supported formats: MP3, WAV, FLAC, AIFF</div>
                          </div>
                        </div>
                      }
                    >
                      <div class="space-y-3">
                        <div class="flex items-center justify-between mb-4">
                          <h2 class="text-lg font-medium text-gray-300">
                            {playlist().songIds.length} song
                            {playlist().songIds.length !== 1 ? "s" : ""}
                          </h2>
                          <div class="text-xs text-gray-500">
                            drag to reorder • click to play
                          </div>
                        </div>

                        <For each={playlist().songIds}>
                          {(songId) => (
                            <SongRow
                              songId={songId}
                              isPlaying={currentPlayingSong() === songId}
                              showRemoveButton={true}
                              onRemove={handleRemoveSong}
                              onPlay={handlePlaySong}
                              onPause={handlePauseSong}
                              onEdit={handleEditSong}
                            />
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </div>
      </Show>

      {/* Global drag overlay */}
      <Show when={isDragOver()}>
        <div class="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 backdrop-blur-sm">
          <div class="text-center">
            <div class="text-4xl mb-6 font-bold">drop zone</div>
            <h2 class="text-4xl font-light mb-4 text-magenta-400">
              drop your music here
            </h2>
            <p class="text-xl text-gray-300">
              release to add files to{" "}
              {selectedPlaylist()?.title || "a new playlist"}
            </p>
            <div class="mt-6 flex justify-center">
              <div class="px-4 py-2 bg-magenta-500 bg-opacity-20 border-2 border-magenta-500 border-dashed rounded-lg">
                <p class="text-magenta-300">
                  supports MP3, WAV, FLAC, AIFF, and more
                </p>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* Error notification */}
      <Show when={error()}>
        <div class="fixed top-4 right-4 z-50">
          <div class="bg-red-500 text-white px-6 py-3 rounded-lg shadow-lg max-w-sm">
            <div class="flex items-center">
              <div class="flex-shrink-0">
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fill-rule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                    clip-rule="evenodd"
                  />
                </svg>
              </div>
              <div class="ml-3">
                <p class="text-sm font-medium">{error()}</p>
              </div>
              <div class="ml-4 flex-shrink-0">
                <button
                  onClick={() => setError(null)}
                  class="text-white hover:text-gray-200 focus:outline-none"
                >
                  ×
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* Modals */}
      <Show when={editingSong()}>
        <SongEditModal
          song={editingSong()!}
          isOpen={!!editingSong()}
          onClose={() => setEditingSong(null)}
          onSave={handleSongSaved}
        />
      </Show>

      <Show when={showPlaylistCover()}>
        <PlaylistCoverModal
          playlist={selectedPlaylist()!}
          playlistSongs={playlistSongs()}
          isOpen={showPlaylistCover()}
          onClose={() => setShowPlaylistCover(false)}
          onSave={handlePlaylistCoverSaved}
        />
      </Show>
    </div>
  );
}
