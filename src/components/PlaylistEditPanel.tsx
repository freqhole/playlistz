import { createSignal, createEffect, Show, onMount } from "solid-js";
import {
  updatePlaylist,
  deletePlaylist,
  setPlaylistCoverImage,
  clearPlaylistCoverImage,
  forkPlaylist,
} from "../services/playlistDocService.js";
import {
  processPlaylistCover,
  validateImageFile,
  createImageUrlFromData,
} from "../services/imageService.js";
import { ensureSharingReady } from "../services/sharingService.js";
import { initSharingState } from "../services/sharingState.js";
import { downloadPlaylistAsZip } from "../services/playlistDownloadService.js";
import { usePlaylistzManager } from "../context/PlaylistzContext.js";
import type { Playlist, Song } from "../types/playlist.js";

interface PlaylistEditPanelProps {
  playlist: Playlist;
  playlistSongs: Song[];
  onClose: () => void;
  onSave: (updatedPlaylist: Playlist) => void;
  onDelete?: () => void;
  onFork?: (newDocId: string) => void;
}

export function PlaylistEditPanel(props: PlaylistEditPanelProps) {
  const { backgroundSource, setBackgroundOverride } = usePlaylistzManager();

  const [selectedImageUrl, setSelectedImageUrl] = createSignal<
    string | undefined
  >();
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [isDownloading, setIsDownloading] = createSignal(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);

  onMount(() => {
    initSharingState();
  });

  // update the displayed cover whenever the playlist's image resolves from
  // the blob store. docToPlaylistAsync sets imageFilePath asynchronously after
  // the initial sync, so onMount alone would miss it on a fresh page load.
  createEffect(() => {
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
        await setPlaylistCoverImage(
          props.playlist.id,
          result.imageData,
          file.type
        );
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
      await clearPlaylistCoverImage(props.playlist.id);
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

  // fork/collaborate state (only relevant for subscribed remote playlists)
  const [isForkingOrCollab, setIsForkingOrCollab] = createSignal(false);
  const [forkCollabStatus, setForkCollabStatus] = createSignal<string | null>(
    null
  );
  const [collabMessage, setCollabMessage] = createSignal("");

  const isSubscribed = () =>
    !!props.playlist.remoteNodeId && !props.playlist.isForked;

  const handleFork = async () => {
    try {
      setIsForkingOrCollab(true);
      setForkCollabStatus(null);
      const forked = await forkPlaylist(props.playlist.id);
      props.onFork?.(forked.id);
      props.onClose();
    } catch (err) {
      setForkCollabStatus("fork failed");
      console.error("fork error:", err);
    } finally {
      setIsForkingOrCollab(false);
    }
  };

  const handleRequestCollaboration = async () => {
    const nodeId = props.playlist.remoteNodeId;
    if (!nodeId) return;
    try {
      setIsForkingOrCollab(true);
      setForkCollabStatus(null);
      await ensureSharingReady();
      const { knockForDocAccess } = await import(
        "../services/sharingService.js"
      );
      const result = await knockForDocAccess(
        nodeId,
        props.playlist.id,
        collabMessage() ||
          "requesting collaboration access to: " +
            (props.playlist.title || "playlist"),
        props.playlist.title
      );
      if (result.status === "accepted") {
        setForkCollabStatus("access granted - you can now collaborate");
      } else if (result.status === "pending") {
        setForkCollabStatus("knock sent - waiting for owner to accept");
      } else {
        setForkCollabStatus("request denied by owner");
      }
    } catch (err) {
      setForkCollabStatus("knock failed");
      console.error("collab knock error:", err);
    } finally {
      setIsForkingOrCollab(false);
    }
  };

  const songsWithArt = () =>
    props.playlistSongs.filter((s) => s.imageType || s.imageFilePath);

  // filter settings - initialise from playlist props
  const [bgEnabled, setBgEnabled] = createSignal(
    props.playlist.bgFilterEnabled ?? true
  );
  const [bgBlur, setBgBlur] = createSignal(props.playlist.bgFilterBlur ?? 3);
  const [bgContrast, setBgContrast] = createSignal(
    props.playlist.bgFilterContrast ?? 3
  );
  const [bgBrightness, setBgBrightness] = createSignal(
    props.playlist.bgFilterBrightness ?? 0.4
  );
  const [coverEnabled, setCoverEnabled] = createSignal(
    props.playlist.coverFilterEnabled ?? true
  );
  const [coverBlur, setCoverBlur] = createSignal(
    props.playlist.coverFilterBlur ?? 3
  );

  // background image layout settings
  const [bgSize, setBgSize] = createSignal(props.playlist.bgSize ?? "cover");
  const [bgPosition, setBgPosition] = createSignal(
    props.playlist.bgPosition ?? "top"
  );
  const [bgRepeat, setBgRepeat] = createSignal(
    props.playlist.bgRepeat ?? "no-repeat"
  );

  const BG_SIZE_OPTIONS = [
    "cover",
    "contain",
    "auto",
    "100% 100%",
    "50%",
  ] as const;
  const BG_POSITION_OPTIONS = [
    "top",
    "center",
    "bottom",
    "left",
    "right",
    "left top",
    "right top",
  ] as const;
  const BG_REPEAT_OPTIONS = [
    "no-repeat",
    "repeat",
    "repeat-x",
    "repeat-y",
  ] as const;

  const saveFilterUpdates = async (updates: Partial<typeof props.playlist>) => {
    try {
      await updatePlaylist(props.playlist.id, {
        bgFilterEnabled: updates.bgFilterEnabled,
        bgFilterBlur: updates.bgFilterBlur,
        bgFilterContrast: updates.bgFilterContrast,
        bgFilterBrightness: updates.bgFilterBrightness,
        coverFilterEnabled: updates.coverFilterEnabled,
        coverFilterBlur: updates.coverFilterBlur,
        bgSize: updates.bgSize,
        bgPosition: updates.bgPosition,
        bgRepeat: updates.bgRepeat,
      });
    } catch (err) {
      setError("failed to save filter settings");
      console.error("filter save error:", err);
    }
  };

  // updates the live preview immediately (no IDB write)
  const previewFilter = (updates: Partial<typeof props.playlist>) => {
    const { image: _image, ...rest } =
      props.playlist as typeof props.playlist & { image?: unknown };
    props.onSave({ ...rest, ...updates, updatedAt: Date.now() });
  };

  const resetBgFilter = () => {
    setBgEnabled(true);
    setBgBlur(3);
    setBgContrast(3);
    setBgBrightness(0.4);
    const defaults = {
      bgFilterEnabled: true,
      bgFilterBlur: 3,
      bgFilterContrast: 3,
      bgFilterBrightness: 0.4,
    };
    previewFilter(defaults);
    saveFilterUpdates(defaults);
  };

  const resetCoverFilter = () => {
    setCoverEnabled(true);
    setCoverBlur(3);
    const defaults = { coverFilterEnabled: true, coverFilterBlur: 3 };
    previewFilter(defaults);
    saveFilterUpdates(defaults);
  };

  return (
    <div data-testid="edit-panel" class="bg-black/40 overflow-hidden min-w-0">
      {/* on sm+: form controls left (clamped to 500px), image right.
          justify-between pushes the columns apart so spare width sits in the
          middle. order utilities keep the image on top for the mobile column.
          on lg+ a third share column appears on the right; below lg the share
          section spans the full width under the other two columns */}
      <div class="p-4 border-none grid grid-cols-1 min-w-0 sm:grid-cols-[minmax(0,500px)_min(40%,24rem)] sm:justify-between gap-6">
        {/* image + upload buttons */}
        <div class="flex flex-col gap-3 min-w-0 sm:order-2">
          {/* image sizes naturally at its own aspect ratio (no gray bars);
              the gray square only shows as the no-image fallback */}
          <Show
            when={selectedImageUrl()}
            fallback={
              <div class="w-full aspect-square bg-gray-700 flex items-center justify-center">
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
              </div>
            }
          >
            {/* hovering reveals a bottom strip; clicking anywhere on the image
                sets the page background to this cover (only when the background
                is currently something else, e.g. the song being edited) */}
            <Show
              when={
                props.playlist.imageType &&
                backgroundSource() !== `playlist-${props.playlist.id}`
              }
              fallback={
                <img
                  src={selectedImageUrl()}
                  alt="playlist cover"
                  class="w-full h-auto"
                />
              }
            >
              <button
                data-testid="btn-set-bg-cover"
                onClick={() => setBackgroundOverride("cover")}
                class="relative block w-full group cursor-pointer"
                title="set the page background to this playlist's cover image"
              >
                <img
                  src={selectedImageUrl()}
                  alt="playlist cover"
                  class="w-full h-auto"
                />
                <span class="absolute bottom-0 inset-x-0 px-3 py-2 bg-black/70 text-white text-sm font-medium text-center opacity-0 group-hover:opacity-100 transition-opacity">
                  show cover background preview
                </span>
              </button>
            </Show>
          </Show>

          <input
            type="file"
            accept="image/*"
            onChange={handleImageUpload}
            disabled={isLoading()}
            class="hidden"
            id="cover-upload-panel"
          />
          {/* mt-auto pushes the buttons to the column bottom so both columns
              end at the same height regardless of image aspect ratio */}
          <label
            for="cover-upload-panel"
            class="mt-auto block w-full px-3 py-1.5 bg-magenta-500 hover:bg-magenta-600 text-white cursor-pointer text-sm font-medium transition-colors text-center"
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

        {/* filter controls + playlist info */}
        <div class="flex flex-col gap-5 min-w-0 sm:order-1">
          {/* subscribed playlist: fork or request collaboration */}
          <Show when={isSubscribed()}>
            <div class="space-y-2 border border-gray-700 p-3">
              <p class="text-xs text-gray-400">
                this is a subscribed playlist from{" "}
                <span class="text-gray-200">
                  {props.playlist.remoteName ||
                    props.playlist.remoteNodeId?.slice(0, 8) + "..."}
                </span>
                . you can make your own editable copy or request edit access
                from the owner.
              </p>
              <div class="flex gap-2">
                <button
                  data-testid="btn-fork-playlist"
                  onClick={() => void handleFork()}
                  disabled={isForkingOrCollab()}
                  class="flex-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm transition-colors"
                >
                  make my own copy
                </button>
                <button
                  data-testid="btn-request-collaboration"
                  onClick={() => void handleRequestCollaboration()}
                  disabled={isForkingOrCollab()}
                  class="flex-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm transition-colors"
                >
                  request collaboration
                </button>
              </div>
              <textarea
                data-testid="input-collab-message"
                value={collabMessage()}
                onInput={(e) => setCollabMessage(e.currentTarget.value)}
                placeholder="optional message to the owner..."
                rows="2"
                disabled={isForkingOrCollab()}
                class="w-full bg-black text-white text-xs border border-gray-700 px-2 py-1.5 focus:outline-none focus:border-magenta-500 resize-none disabled:opacity-50"
              />
              <Show when={forkCollabStatus()}>
                <p class="text-xs text-gray-400">{forkCollabStatus()}</p>
              </Show>
            </div>
          </Show>

          {/* background image filter */}
          <div class="space-y-3">
            <div class="flex items-center gap-2">
              <label class="text-sm font-medium text-gray-300">
                background filter
              </label>
              <input
                type="checkbox"
                checked={bgEnabled()}
                onChange={(e) => {
                  const v = e.currentTarget.checked;
                  setBgEnabled(v);
                  previewFilter({ bgFilterEnabled: v });
                  saveFilterUpdates({ bgFilterEnabled: v });
                }}
                class="accent-magenta-500"
              />
              <button
                onClick={resetBgFilter}
                class="ml-auto px-2 py-0.5 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 transition-colors"
              >
                reset
              </button>
            </div>
            <div
              class={`space-y-2 ${bgEnabled() ? "" : "opacity-40 pointer-events-none"}`}
            >
              <div class="grid grid-cols-[5rem_1fr_3rem] items-center gap-2">
                <label class="text-xs text-gray-400">blur</label>
                <input
                  type="range"
                  min="0"
                  max="20"
                  step="0.5"
                  value={bgBlur()}
                  onInput={(e) => {
                    const v = Number(e.currentTarget.value);
                    setBgBlur(v);
                    previewFilter({
                      bgFilterBlur: v,
                      bgFilterEnabled: bgEnabled(),
                      bgFilterContrast: bgContrast(),
                      bgFilterBrightness: bgBrightness(),
                    });
                  }}
                  onChange={(e) =>
                    saveFilterUpdates({
                      bgFilterBlur: Number(e.currentTarget.value),
                    })
                  }
                  class="accent-magenta-500"
                />
                <span class="text-xs text-gray-400 tabular-nums">
                  {bgBlur()}px
                </span>
              </div>
              <div class="grid grid-cols-[5rem_1fr_3rem] items-center gap-2">
                <label class="text-xs text-gray-400">contrast</label>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.1"
                  value={bgContrast()}
                  onInput={(e) => {
                    const v = Number(e.currentTarget.value);
                    setBgContrast(v);
                    previewFilter({
                      bgFilterContrast: v,
                      bgFilterEnabled: bgEnabled(),
                      bgFilterBlur: bgBlur(),
                      bgFilterBrightness: bgBrightness(),
                    });
                  }}
                  onChange={(e) =>
                    saveFilterUpdates({
                      bgFilterContrast: Number(e.currentTarget.value),
                    })
                  }
                  class="accent-magenta-500"
                />
                <span class="text-xs text-gray-400 tabular-nums">
                  {bgContrast().toFixed(1)}
                </span>
              </div>
              <div class="grid grid-cols-[5rem_1fr_3rem] items-center gap-2">
                <label class="text-xs text-gray-400">brightness</label>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={bgBrightness()}
                  onInput={(e) => {
                    const v = Number(e.currentTarget.value);
                    setBgBrightness(v);
                    previewFilter({
                      bgFilterBrightness: v,
                      bgFilterEnabled: bgEnabled(),
                      bgFilterBlur: bgBlur(),
                      bgFilterContrast: bgContrast(),
                    });
                  }}
                  onChange={(e) =>
                    saveFilterUpdates({
                      bgFilterBrightness: Number(e.currentTarget.value),
                    })
                  }
                  class="accent-magenta-500"
                />
                <span class="text-xs text-gray-400 tabular-nums">
                  {bgBrightness().toFixed(2)}
                </span>
              </div>
            </div>
          </div>

          {/* cover image filter */}
          <div class="space-y-3">
            <div class="flex items-center gap-2">
              <label class="text-sm font-medium text-gray-300">
                cover blur
              </label>
              <input
                type="checkbox"
                checked={coverEnabled()}
                onChange={(e) => {
                  const v = e.currentTarget.checked;
                  setCoverEnabled(v);
                  previewFilter({ coverFilterEnabled: v });
                  saveFilterUpdates({ coverFilterEnabled: v });
                }}
                class="accent-magenta-500"
              />
              <button
                onClick={resetCoverFilter}
                class="ml-auto px-2 py-0.5 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 transition-colors"
              >
                reset
              </button>
            </div>
            <div
              class={`grid grid-cols-[5rem_1fr_3rem] items-center gap-2 ${coverEnabled() ? "" : "opacity-40 pointer-events-none"}`}
            >
              <label class="text-xs text-gray-400">blur</label>
              <input
                type="range"
                min="0"
                max="20"
                step="0.5"
                value={coverBlur()}
                onInput={(e) => {
                  const v = Number(e.currentTarget.value);
                  setCoverBlur(v);
                  previewFilter({
                    coverFilterBlur: v,
                    coverFilterEnabled: coverEnabled(),
                  });
                }}
                onChange={(e) =>
                  saveFilterUpdates({
                    coverFilterBlur: Number(e.currentTarget.value),
                  })
                }
                class="accent-magenta-500"
              />
              <span class="text-xs text-gray-400 tabular-nums">
                {coverBlur()}px
              </span>
            </div>
          </div>

          {/* background image layout */}
          <div class="space-y-3">
            <div class="flex items-center gap-2">
              <label class="text-sm font-medium text-gray-300">
                background image
              </label>
              <button
                onClick={() => {
                  setBgSize("cover");
                  setBgPosition("top");
                  setBgRepeat("no-repeat");
                  const defaults = {
                    bgSize: "cover",
                    bgPosition: "top",
                    bgRepeat: "no-repeat",
                  };
                  previewFilter(defaults);
                  void saveFilterUpdates(defaults);
                }}
                class="ml-auto px-2 py-0.5 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 transition-colors"
              >
                reset
              </button>
            </div>
            <div class="grid grid-cols-[5rem_1fr] items-center gap-2">
              <label class="text-xs text-gray-400">size</label>
              <select
                value={bgSize()}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setBgSize(v);
                  previewFilter({ bgSize: v });
                  void saveFilterUpdates({ bgSize: v });
                }}
                class="bg-black text-white text-xs border border-gray-700 px-2 py-1 focus:outline-none focus:border-magenta-500"
              >
                {BG_SIZE_OPTIONS.map((o) => (
                  <option value={o}>{o}</option>
                ))}
              </select>
            </div>
            <div class="grid grid-cols-[5rem_1fr] items-center gap-2">
              <label class="text-xs text-gray-400">position</label>
              <select
                value={bgPosition()}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setBgPosition(v);
                  previewFilter({ bgPosition: v });
                  void saveFilterUpdates({ bgPosition: v });
                }}
                class="bg-black text-white text-xs border border-gray-700 px-2 py-1 focus:outline-none focus:border-magenta-500"
              >
                {BG_POSITION_OPTIONS.map((o) => (
                  <option value={o}>{o}</option>
                ))}
              </select>
            </div>
            <div class="grid grid-cols-[5rem_1fr] items-center gap-2">
              <label class="text-xs text-gray-400">repeat</label>
              <select
                value={bgRepeat()}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setBgRepeat(v);
                  previewFilter({ bgRepeat: v });
                  void saveFilterUpdates({ bgRepeat: v });
                }}
                class="bg-black text-white text-xs border border-gray-700 px-2 py-1 focus:outline-none focus:border-magenta-500"
              >
                {BG_REPEAT_OPTIONS.map((o) => (
                  <option value={o}>{o}</option>
                ))}
              </select>
            </div>
          </div>

          {/* playlist info - mt-auto pushes this (and everything after) to the
              bottom so the column stretches to match the image column height */}
          <div class="bg-black p-3 text-xs text-gray-400 space-y-1 mt-auto">
            <div>title: {props.playlist.title}</div>
            <div>id: {props.playlist.id}</div>
            <div>rev: {props.playlist.rev || 0}</div>
            <div>songz: {props.playlist.songIds.length}</div>
            <div>with album art: {songsWithArt().length}</div>
          </div>

          {/* actions: download + delete */}
          <div class="flex flex-col gap-2">
            <Show when={window.location.protocol !== "file:"}>
              <button
                onClick={handleDownloadPlaylist}
                disabled={isDownloading() || isLoading()}
                class="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-400 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2"
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
                {isDownloading() ? "downloading..." : "download playlist"}
              </button>
            </Show>

            <Show
              when={!showDeleteConfirm()}
              fallback={
                <div class="bg-red-900/30 border border-red-500 p-2 space-y-2">
                  <p class="text-white text-sm">delete this playlist?</p>
                  <div class="flex gap-2">
                    <button
                      onClick={handleDeletePlaylist}
                      disabled={isLoading()}
                      class="flex-1 px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white text-sm font-medium transition-colors"
                    >
                      yes, delete
                    </button>
                    <button
                      onClick={() => setShowDeleteConfirm(false)}
                      disabled={isLoading()}
                      class="flex-1 px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-sm font-medium transition-colors"
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
                class="w-full px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2"
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
                delete playlist
              </button>
            </Show>
          </div>

          <Show when={error()}>
            <div class="bg-red-900/30 border border-red-500 p-3">
              <div class="text-red-400 text-sm">{error()}</div>
            </div>
          </Show>
        </div>

        {/* p2p share column removed - use the share panel (sidebar) instead */}
      </div>
    </div>
  );
}
