import { Show, createEffect, createSignal } from "solid-js";

import {
  PlaylistzProvider,
  usePlaylistzManager,
  usePlaylistzSongs,
  usePlaylistzUI,
  usePlaylistzDragDrop,
  usePlaylistzImageModal,
} from "../context/PlaylistzContext.js";

import { PlaylistContainer } from "./playlist/index.js";
import { log } from "../utils/log.js";
function PlaylistzInner() {
  // context hooks
  const playlistManager = usePlaylistzManager();
  const songState = usePlaylistzSongs();
  const uiState = usePlaylistzUI();
  const dragAndDrop = usePlaylistzDragDrop();
  const imageModal = usePlaylistzImageModal();

  const {
    playlists,
    selectedPlaylist,
    isInitialized,
    error: managerError,
    backgroundImageUrl,
    selectPlaylist,
  } = playlistManager;

  const { showDeleteConfirm, setShowDeleteConfirm, handleDeletePlaylist } =
    playlistManager;

  const { editingPlaylist: _editingPlaylist, error: songError } = songState;

  const { isMobile } = uiState;

  const {
    isDragOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleFileDrop,
    setIsDragOver,
    error: dragError,
  } = dragAndDrop;

  const {
    showImageModal,
    closeImageModal,
    handleNextImage,
    handlePrevImage,
    getCurrentImageUrl,
    getCurrentImageTitle,
    getImageCount,
    getCurrentImageNumber,
    hasMultipleImages,
  } = imageModal;

  // 1 error 2 rule 'em all!
  const error = () => managerError() || songError() || dragError();

  // derived bg filter string from selected playlist settings
  const bgFilter = () => {
    const p = selectedPlaylist();
    if (!p) return "blur(3px) contrast(3) brightness(0.4)";
    if (p.bgFilterEnabled === false) return "none";
    const blur = p.bgFilterBlur ?? 3;
    const contrast = p.bgFilterContrast ?? 3;
    const brightness = p.bgFilterBrightness ?? 0.4;
    return `blur(${blur}px) contrast(${contrast}) brightness(${brightness})`;
  };

  // create a wrapper that provides the necessary options to handleFileDrop
  const handleFileDropWrapper = async (e: DragEvent) => {
    await handleFileDrop(e, {
      selectedPlaylist: selectedPlaylist(),
      playlists: playlists(),
      onPlaylistCreated: () => {
        // hmm, i guess playlist will be automatically added via reactive query...
      },
      onPlaylistSelected: (playlist) => {
        selectPlaylist(playlist);
      },
    });
  };

  // open a #share/ link once the app has initialized. the shared playlist
  // appears in the docIndex live query; select it + start playback when found.
  // the playlist may not be in the reactive list immediately (doc sync takes a
  // moment), so we track the pending docId and auto-select it reactively.
  let shareFragmentHandled = false;
  const [pendingShareDocId, setPendingShareDocId] = createSignal<string | null>(
    null
  );

  createEffect(() => {
    if (!isInitialized() || shareFragmentHandled) return;
    if (!window.location.hash.startsWith("#share/")) return;
    shareFragmentHandled = true;
    void (async () => {
      try {
        const { handleShareFragment } = await import(
          "../services/sharingService.js"
        );
        const docId = await handleShareFragment();
        if (docId) {
          const found = playlists().find((p) => p.id === docId);
          if (found) {
            selectPlaylist(found);
            // start playback if nothing is currently playing
            const { playPlaylist, audioState } = await import(
              "../services/audioService.js"
            );
            if (!audioState.isPlaying()) void playPlaylist(found);
          } else {
            // playlist not synced yet - watch for it reactively
            setPendingShareDocId(docId);
          }
        }
      } catch (err) {
        log.warn("share.fragment", "share link open failed:", err);
      }
    })();
  });

  // once the pending share playlist appears in the list, select + play it
  createEffect(() => {
    const docId = pendingShareDocId();
    if (!docId) return;
    const found = playlists().find((p) => p.id === docId);
    if (!found) return;
    setPendingShareDocId(null);
    selectPlaylist(found);
    void (async () => {
      const { playPlaylist, audioState } = await import(
        "../services/audioService.js"
      );
      if (!audioState.isPlaying()) void playPlaylist(found);
    })();
  });

  // resume p2p on boot for users who have already enabled it
  let sharingResumed = false;
  createEffect(() => {
    if (!isInitialized() || sharingResumed) return;
    sharingResumed = true;
    void (async () => {
      try {
        const { resumeSharingIfEnabled } = await import(
          "../services/sharingService.js"
        );
        await resumeSharingIfEnabled();
      } catch (err) {
        log.warn("p2p.resume", "p2p resume failed:", err);
      }
    })();
  });

  return (
    <div
      class="relative bg-black text-white h-screen overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleFileDropWrapper}
    >
      {/* background image cover */}
      <Show when={backgroundImageUrl()}>
        <div
          class="absolute inset-0 bg-cover bg-top bg-no-repeat transition-opacity duration-1000 ease-out"
          style={{
            "background-image": `url(${backgroundImageUrl()})`,
            filter: bgFilter(),
            "z-index": "0",
          }}
        />
        <div class="absolute inset-0 bg-black/20" style={{ "z-index": "1" }} />
      </Show>

      {/* background pattern (when no song playing) */}
      <Show when={!backgroundImageUrl()}>
        <div
          class="absolute inset-0 opacity-5"
          style={{
            "background-image":
              "radial-gradient(circle at 25% 25%, #ff00ff 2px, transparent 2px)",
            "background-size": "50px 50px",
            "z-index": "0",
          }}
        />
      </Show>

      {/* main app content */}
      <Show
        when={isInitialized()}
        fallback={
          <div class="flex items-center justify-center h-full">
            <div class="text-center">
              <div class="inline-block animate-spin rounded-full h-8 w-8" />
              <p class="text-lg">loading playlistz...</p>
            </div>
          </div>
        }
      >
        {/* visually hidden landmark for e2e/accessibility - always present once app loads */}
        <h1 class="sr-only" data-testid="app-ready">
          playlistz
        </h1>
        {/* full-width playlist content */}
        <div class="relative flex h-full" style={{ "z-index": "2" }}>
          <div class="flex-1 flex flex-col min-h-0">
            <Show
              when={selectedPlaylist()}
              fallback={
                // no playlist selected (e.g. fresh install with no playlists yet).
                // show a create button since the hamburger isn't available here.
                <EmptyState />
              }
            >
              {(playlist) => <PlaylistContainer playlist={playlist} />}
            </Show>
          </div>
        </div>
      </Show>

      {/* drag'n'drop overlay */}
      <Show when={isDragOver()}>
        <div
          onClick={() => {
            setIsDragOver(false);
          }}
          class="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 backdrop-blur-sm"
        >
          <div class="text-center">
            <div class="text-4xl mb-6 font-bold">drop zone</div>
            <h2 class="text-4xl font-light mb-4 text-magenta-400">
              drop your filez here
            </h2>
            <p class="text-xl text-gray-300">
              release to add filez to{" "}
              {selectedPlaylist()?.title || "a new playlist"}
            </p>
          </div>
        </div>
      </Show>

      {/* error notifications */}
      <Show when={error()}>
        <div class="fixed bottom-4 right-4 z-50 max-w-sm">
          <div class="bg-red-900 bg-opacity-90 border border-red-500 p-4 shadow-lg">
            <div class="text-red-200 text-sm">{error()}</div>
          </div>
        </div>
      </Show>

      {/* delete confirmation modal */}
      <Show when={showDeleteConfirm()}>
        <div class="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div class="bg-gray-900 border border-gray-600 p-6 max-w-md w-full mx-4">
            <h3 class="text-lg font-semibold text-white mb-4">
              delete playlist?
            </h3>
            <p class="text-gray-300 mb-6">
              are you sure you want to delete "{selectedPlaylist()?.title}"?
              this action cannot be undone.
            </p>
            <div class="flex gap-3 justify-end">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                class="px-4 py-2 text-gray-300 hover:text-white bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                cancel
              </button>
              <button
                onClick={handleDeletePlaylist}
                class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
              >
                delete
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* image modal */}
      <Show when={showImageModal()}>
        <div class="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-50">
          <button
            onClick={closeImageModal}
            class="absolute top-4 right-4 text-white hover:text-magenta-400 transition-colors z-10 p-2 bg-black bg-opacity-50 rounded"
            title="close (esc)"
          >
            <svg
              class="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>

          <Show when={getCurrentImageUrl()}>
            <div class="relative w-full h-full flex items-center justify-center p-4">
              <img
                src={getCurrentImageUrl()!}
                onClick={handleNextImage}
                onContextMenu={isMobile() ? handlePrevImage : undefined}
                alt={getCurrentImageTitle() || "song image"}
                class="max-w-full max-h-full object-contain"
              />

              {/* navigation arrows (currently disabled 🤷) */}
              <Show when={hasMultipleImages()}>
                {/*<button
                  onClick={handlePrevImage}
                  class="absolute left-4 top-1/2 transform -translate-y-1/2 text-white hover:text-magenta-400 transition-colors p-2 bg-black bg-opacity-50 rounded"
                  title="previous image (←)"
                >
                  <svg
                    class="w-8 h-8"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M15 19l-7-7 7-7"
                    />
                  </svg>
                </button>
                <button
                  onClick={handleNextImage}
                  class="absolute right-4 top-1/2 transform -translate-y-1/2 text-white hover:text-magenta-400 transition-colors p-2 bg-black bg-opacity-50 rounded"
                  title="next image (→)"
                >
                  <svg
                    class="w-8 h-8"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </button>*/}

                {/* image counter */}
                <div class="absolute bottom-4 left-1/2 transform -translate-x-1/2 text-white bg-black bg-opacity-50 px-3 py-1">
                  {/* image title */}
                  <Show when={getCurrentImageTitle()}>
                    {getCurrentImageTitle()}{" "}
                  </Show>
                  <span class="text-xs">
                    {getCurrentImageNumber()}/{getImageCount()}
                  </span>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// shown when no playlist exists or none is selected
function EmptyState() {
  const { createNewPlaylist, selectPlaylist } = usePlaylistzManager();
  const [creating, setCreating] = createSignal(false);

  const handleCreate = async () => {
    if (creating()) return;
    setCreating(true);
    try {
      const p = await createNewPlaylist("new playlist");
      if (p) selectPlaylist(p);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div class="flex items-center justify-center h-full text-gray-400 text-sm">
      <div class="text-center">
        <p class="mb-6 text-gray-500" data-testid="empty-playlists">
          no playlistz yet
        </p>
        <button
          data-testid="btn-new-playlist"
          onClick={handleCreate}
          disabled={creating()}
          class="flex items-center gap-2 px-4 py-2 bg-magenta-500 hover:bg-magenta-600 disabled:opacity-60 text-white text-sm font-medium transition-colors mx-auto"
        >
          <Show
            when={!creating()}
            fallback={
              <div class="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
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
                d="M12 4v16m8-8H4"
              />
            </svg>
          </Show>
          <span>{creating() ? "creating..." : "new playlist"}</span>
        </button>
      </div>
    </div>
  );
}

export function Playlistz() {
  return (
    <PlaylistzProvider>
      <PlaylistzInner />
    </PlaylistzProvider>
  );
}
