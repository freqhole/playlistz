/* @jsxImportSource solid-js */
import { createSignal, Show, onMount } from "solid-js";
import {
  processPlaylistCover,
  validateImageFile,
  createImageUrlFromData,
  getImageUrlForContext,
} from "../services/imageService.js";
import type { Song } from "../types/playlist.js";
import { usePlaylistzManager } from "../context/PlaylistzContext.jsx";
import { formatDuration } from "../utils/timeUtils.js";

interface SongEditPanelProps {
  song: Song;
  index: number;
  onClose: () => void;
  onSave: (updatedSong: Song) => void;
}

export function SongEditPanel(props: SongEditPanelProps) {
  const [title, setTitle] = createSignal("");
  const [artist, setArtist] = createSignal("");
  const [album, setAlbum] = createSignal("");
  const [imageData, setImageData] = createSignal<ArrayBuffer | undefined>();
  const [thumbnailData, setThumbnailData] = createSignal<
    ArrayBuffer | undefined
  >();
  const [imageType, setImageType] = createSignal<string | undefined>();
  const [imageUrl, setImageUrl] = createSignal<string | undefined>();
  const [isLoading, setIsLoading] = createSignal(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const playlistManager = usePlaylistzManager();
  const { handleRemoveSong } = playlistManager;

  onMount(() => {
    setTitle(props.song.title);
    setArtist(props.song.artist || "");
    setAlbum(props.song.album || "");

    if (
      (props.song.imageData || props.song.thumbnailData) &&
      props.song.imageType
    ) {
      setImageData(props.song.imageData);
      setThumbnailData(props.song.thumbnailData);
      setImageType(props.song.imageType);
      const displayData = props.song.imageData || props.song.thumbnailData;
      if (displayData) {
        setImageUrl(createImageUrlFromData(displayData, props.song.imageType));
      }
    } else if (props.song.imageFilePath) {
      setImageType(props.song.imageType);
      setImageUrl(props.song.imageFilePath);
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
      if (result.success && result.imageData && result.thumbnailData) {
        const prevUrl = imageUrl();
        if (prevUrl) URL.revokeObjectURL(prevUrl);

        setImageData(result.imageData);
        setThumbnailData(result.thumbnailData);
        setImageType(file.type);
        setImageUrl(createImageUrlFromData(result.imageData, file.type));
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

  const handleSave = async () => {
    if (!title().trim()) {
      setError("title is required");
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const updatedSong: Song = {
        ...props.song,
        title: title().trim(),
        artist: artist().trim() || "unknown artist",
        album: album().trim() || "unknown album",
        imageData: imageData(),
        thumbnailData: thumbnailData(),
        imageType: imageType(),
        updatedAt: Date.now(),
      };

      // onSave handler (handleSongSaved in useSongState) persists to IDB
      await props.onSave(updatedSong);
      props.onClose();
    } catch (err) {
      setError("failed to save");
      console.error("save error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    const url = imageUrl();
    if (url) URL.revokeObjectURL(url);
    setError(null);
    props.onClose();
  };

  const handleRemoveImage = () => {
    const url = imageUrl();
    if (url) URL.revokeObjectURL(url);
    setImageData(undefined);
    setThumbnailData(undefined);
    setImageType(undefined);
    setImageUrl(undefined);
  };

  // preview thumbnail: shows current imageUrl (form state) or falls back to stored path
  const previewImageUrl = () =>
    imageUrl() ?? getImageUrlForContext(props.song, "thumbnail") ?? undefined;

  return (
    <div class="bg-black/40 border border-gray-700 overflow-hidden min-w-0 w-full">
      {/* read-only song row preview - updates live as user edits */}
      <div class="flex items-center gap-2 px-3 py-3 bg-black border-b border-gray-700 select-none min-w-0">
        {/* track number - matches SongRow format */}
        <span class="text-gray-500 text-sm w-8 text-right flex-shrink-0 font-mono">
          {props.index.toString().padStart(3, "0")}
        </span>

        {/* thumbnail */}
        <div class="w-10 h-10 flex-shrink-0 bg-gray-700 overflow-hidden">
          <Show
            when={previewImageUrl()}
            fallback={
              <div class="w-full h-full flex items-center justify-center">
                <svg
                  class="w-5 h-5 text-gray-500"
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
              src={previewImageUrl()}
              alt={title()}
              class="w-full h-full object-cover"
            />
          </Show>
        </div>

        {/* song metadata - live from form state */}
        <div class="flex-1 min-w-0">
          <div class="text-white text-sm font-medium truncate">
            {title() || "(no title)"}
          </div>
          <div class="text-gray-400 text-xs truncate">
            {artist() || ""}
            {artist() && album() ? " - " : ""}
            {album() || ""}
          </div>
        </div>

        {/* duration */}
        <span class="text-gray-400 text-sm flex-shrink-0">
          {formatDuration(props.song.duration)}
        </span>
      </div>

      {/* edit form: 2-col grid on wider viewports */}
      <div class="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* col 1: album art + image buttons */}
        <div class="flex flex-col gap-2">
          <div class="w-full aspect-square overflow-hidden bg-gray-700 flex items-center justify-center">
            <Show
              when={imageUrl()}
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
                src={imageUrl()}
                alt="album art"
                class="w-full h-full object-cover"
              />
            </Show>
          </div>
          <input
            type="file"
            accept="image/*"
            onChange={handleImageUpload}
            disabled={isLoading()}
            class="hidden"
            id="song-image-upload-panel"
          />
          <label
            for="song-image-upload-panel"
            class="block w-full px-3 py-1.5 bg-magenta-500 hover:bg-magenta-600 text-white cursor-pointer text-sm font-medium transition-colors text-center"
          >
            choose image
          </label>
          <Show when={imageData()}>
            <button
              onClick={handleRemoveImage}
              disabled={isLoading()}
              class="block w-full px-3 py-1.5 bg-red-700 hover:bg-red-800 text-white text-sm font-medium transition-colors text-center"
            >
              remove image
            </button>
          </Show>
        </div>

        {/* col 2: text fields + file info */}
        <div class="flex flex-col gap-3">
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">
              title
            </label>
            <input
              type="text"
              value={title()}
              onInput={(e) => setTitle(e.currentTarget.value)}
              disabled={isLoading()}
              class="w-full bg-black text-white px-3 py-2 border border-gray-600 focus:border-magenta-500 focus:ring-1 focus:ring-magenta-500 focus:outline-none transition-colors text-sm"
              placeholder="song title"
            />
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">
              artist
            </label>
            <input
              type="text"
              value={artist()}
              onInput={(e) => setArtist(e.currentTarget.value)}
              disabled={isLoading()}
              class="w-full bg-black text-white px-3 py-2 border border-gray-600 focus:border-magenta-500 focus:ring-1 focus:ring-magenta-500 focus:outline-none transition-colors text-sm"
              placeholder="artist name"
            />
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">
              album
            </label>
            <input
              type="text"
              value={album()}
              onInput={(e) => setAlbum(e.currentTarget.value)}
              disabled={isLoading()}
              class="w-full bg-black text-white px-3 py-2 border border-gray-600 focus:border-magenta-500 focus:ring-1 focus:ring-magenta-500 focus:outline-none transition-colors text-sm"
              placeholder="album name"
            />
          </div>
          <div class="bg-black p-3 text-xs text-gray-400 space-y-1 mt-auto">
            <div>filename: {props.song.originalFilename || "unknown"}</div>
            <Show when={props.song.fileSize}>
              <div>
                size:{" "}
                {Math.round((props.song.fileSize! / 1024 / 1024) * 100) / 100}{" "}
                mb
              </div>
            </Show>
            <div>duration: {formatDuration(props.song.duration)}</div>
            <Show when={props.song.sha}>
              <div class="break-all">sha: {props.song.sha}</div>
            </Show>
          </div>
        </div>

        {/* error - full width */}
        <Show when={error()}>
          <div class="sm:col-span-2 bg-red-900/30 border border-red-500 p-3">
            <div class="text-red-400 text-sm">{error()}</div>
          </div>
        </Show>
      </div>

      {/* footer: delete on left, cancel+save on right */}
      <Show
        when={showDeleteConfirm()}
        fallback={
          <div class="flex items-center gap-3 px-4 py-3 border-t border-gray-700">
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={isLoading()}
              class="px-3 py-2 bg-red-700 hover:bg-red-800 disabled:bg-red-400 text-white text-sm font-medium transition-colors flex items-center gap-2"
              title="delete song"
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
            <div class="flex-1" />
            <button
              onClick={handleCancel}
              disabled={isLoading()}
              class="px-4 py-2 text-gray-400 hover:text-white disabled:text-gray-600 font-medium transition-colors"
            >
              cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isLoading()}
              class="px-6 py-2 bg-magenta-500 hover:bg-magenta-600 disabled:bg-magenta-400 text-white font-medium transition-colors flex items-center gap-2"
            >
              <Show
                when={!isLoading()}
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
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </Show>
              save
            </button>
          </div>
        }
      >
        <div class="bg-red-900/30 border-t border-red-500 px-4 py-3 space-y-2">
          <p class="text-white text-sm">delete this song? cannot be undone.</p>
          <div class="flex gap-2">
            <button
              onClick={() => handleRemoveSong(props.song.id, props.onClose)}
              disabled={isLoading()}
              class="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white text-sm font-medium transition-colors"
            >
              yes, delete
            </button>
            <button
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isLoading()}
              class="flex-1 px-4 py-2 bg-gray-600 hover:bg-gray-700 disabled:bg-gray-400 text-white text-sm font-medium transition-colors"
            >
              cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
