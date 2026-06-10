/* @jsxImportSource solid-js */
import { createSignal, Show, onMount, For } from "solid-js";
import {
  updatePlaylist,
  deletePlaylist,
} from "../services/indexedDBService.js";
import {
  processPlaylistCover,
  validateImageFile,
  createImageUrlFromData,
  getImageUrlForContext,
} from "../services/imageService.js";
import { downloadPlaylistAsZip } from "../services/playlistDownloadService.js";
import type { Playlist, Song } from "../types/playlist.js";

interface PlaylistEditPanelProps {
  playlist: Playlist;
  playlistSongs: Song[];
  onClose: () => void;
  onSave: (updatedPlaylist: Playlist) => void;
  onDelete?: () => void;
}

export function PlaylistEditPanel(props: PlaylistEditPanelProps) {
  const [selectedImageUrl, setSelectedImageUrl] = createSignal<
    string | undefined
  >();
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [isDownloading, setIsDownloading] = createSignal(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);

  onMount(() => {
    if (props.playlist.imageData && props.playlist.imageType) {
      const displayData =
        props.playlist.thumbnailData || props.playlist.imageData;
      setSelectedImageUrl(
        createImageUrlFromData(displayData, props.playlist.imageType)
      );
    } else if (props.playlist.imageFilePath) {
      setSelectedImageUrl(props.playlist.imageFilePath);
    }
  });

  const handleImageUpload = async (event: Event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const validation = validateImageFile(file);
    if (!validation.valid) {
      setError(validation.error || "invalid image file");
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const result = await processPlaylistCover(file);

      if (result.success && result.thumbnailData && result.imageData) {
        const prevUrl = selectedImageUrl();
        if (prevUrl) URL.revokeObjectURL(prevUrl);

        setSelectedImageUrl(
          createImageUrlFromData(result.thumbnailData, file.type)
        );

        // immediately persist - no save button needed
        const updates = {
          imageData: result.imageData,
          thumbnailData: result.thumbnailData,
          imageType: file.type,
          updatedAt: Date.now(),
        };
        await updatePlaylist(props.playlist.id, updates);
        const { image: _image, ...rest } = props.playlist as Playlist & {
          image?: unknown;
        };
        props.onSave({ ...rest, ...updates });
      } else {
        setError(result.error || "failed to process image");
      }
    } catch (err) {
      setError("error uploading image");
      console.error("image upload error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveImage = async () => {
    const url = selectedImageUrl();
    if (url) URL.revokeObjectURL(url);
    setSelectedImageUrl(undefined);

    try {
      setIsLoading(true);
      setError(null);
      const updates = {
        imageData: undefined,
        thumbnailData: undefined,
        imageType: undefined,
        updatedAt: Date.now(),
      };
      await updatePlaylist(props.playlist.id, updates);
      const { image: _image, ...rest } = props.playlist as Playlist & {
        image?: unknown;
      };
      props.onSave({ ...rest, ...updates });
    } catch (err) {
      setError("failed to remove image");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadPlaylist = async () => {
    setIsDownloading(true);
    try {
      await downloadPlaylistAsZip(props.playlist, {
        includeMetadata: true,
        includeImages: true,
        generateM3U: true,
        includeHTML: true,
      });
    } catch (err) {
      setError("failed to download playlist");
      console.error("download error:", err);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleDeletePlaylist = async () => {
    try {
      setIsLoading(true);
      setError(null);
      await deletePlaylist(props.playlist.id);
      setShowDeleteConfirm(false);
      props.onDelete?.();
      props.onClose();
    } catch (err) {
      setError("failed to delete playlist");
      console.error("delete error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const songsWithArt = () =>
    props.playlistSongs.filter((s) => s.imageType || s.imageFilePath);

  return (
    <div class="bg-black/40 border border-gray-700 overflow-hidden">
      {/* content */}
      <div class="p-6 space-y-6">
        {/* cover image - larger preview, smaller buttons */}
        <div class="flex items-start gap-4">
          <div class="w-48 h-48 overflow-hidden bg-gray-700 flex items-center justify-center flex-shrink-0">
            <Show
              when={selectedImageUrl()}
              fallback={
                <svg
                  class="w-8 h-8 text-gray-400"
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
              }
            >
              <img
                src={selectedImageUrl()}
                alt="playlist cover"
                class="w-full h-full object-cover"
              />
            </Show>
          </div>

          <div class="w-44 space-y-2">
            <input
              type="file"
              accept="image/*"
              onChange={handleImageUpload}
              disabled={isLoading()}
              class="hidden"
              id="cover-upload-panel"
            />
            <label
              for="cover-upload-panel"
              class="block w-full px-3 py-1.5 bg-magenta-500 hover:bg-magenta-600 text-white cursor-pointer text-sm font-medium transition-colors text-center"
            >
              upload image
            </label>

            <Show when={selectedImageUrl()}>
              <button
                onClick={handleRemoveImage}
                disabled={isLoading()}
                class="block w-full px-3 py-1.5 bg-red-700 hover:bg-red-800 text-white text-sm font-medium transition-colors text-center"
              >
                remove cover image
              </button>
            </Show>
          </div>
        </div>

        {/* actions: download + delete in a row on wider screens */}
        <div class="flex flex-col sm:flex-row gap-2 max-w-xs">
          <Show when={window.location.protocol !== "file:"}>
            <button
              onClick={handleDownloadPlaylist}
              disabled={isDownloading() || isLoading()}
              class="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-400 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2"
            >
              <Show
                when={!isDownloading()}
                fallback={
                  <div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                }
              >
                <svg
                  class="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
              </Show>
              {isDownloading() ? "downloading..." : "download"}
            </button>
          </Show>

          <Show
            when={!showDeleteConfirm()}
            fallback={
              <div class="flex-1 bg-red-900/30 border border-red-500 p-2 space-y-2">
                <p class="text-white text-sm whitespace-nowrap">
                  delete this playlist?
                </p>
                <div class="flex gap-2">
                  <button
                    onClick={handleDeletePlaylist}
                    disabled={isLoading()}
                    class="flex-1 px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white text-sm font-medium transition-colors whitespace-nowrap"
                  >
                    yes, delete
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    disabled={isLoading()}
                    class="flex-1 px-3 py-1.5 bg-gray-600 hover:bg-gray-700 disabled:bg-gray-400 text-white text-sm font-medium transition-colors"
                  >
                    cancel
                  </button>
                </div>
              </div>
            }
          >
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={isLoading()}
              class="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2"
            >
              <svg
                class="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
              delete
            </button>
          </Show>
        </div>

        {/* playlist info */}
        <div class="bg-black p-4">
          <h3 class="text-sm font-medium text-gray-300 mb-2">
            playlist information
          </h3>
          <div class="text-sm text-gray-400 space-y-1">
            <div>title: {props.playlist.title}</div>
            <div>id: {props.playlist.id}</div>
            <div>rev: {props.playlist.rev || 0}</div>
            <div>songz: {props.playlist.songIds.length}</div>
            <div>with album art: {songsWithArt().length}</div>
          </div>
        </div>

        {/* songz with album art preview */}
        <Show when={songsWithArt().length > 0}>
          <div class="grid grid-cols-4 gap-3">
            <For each={songsWithArt()}>
              {(song) => (
                <div
                  class="aspect-square overflow-hidden bg-gray-700"
                  title={`${song.title} - ${song.artist}`}
                >
                  <Show
                    when={song.imageType || song.imageFilePath}
                    fallback={
                      <div class="w-full h-full flex items-center justify-center">
                        <svg
                          class="w-6 h-6 text-gray-400"
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
                      src={getImageUrlForContext(song, "thumbnail") ?? ""}
                      alt={song.title}
                      class="w-full h-full object-cover"
                    />
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* error message */}
        <Show when={error()}>
          <div class="bg-red-900/30 border border-red-500 p-3">
            <div class="text-red-400 text-sm">{error()}</div>
          </div>
        </Show>
      </div>
    </div>
  );
}
