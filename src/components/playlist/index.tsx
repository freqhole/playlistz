import {
  Accessor,
  Show,
  For,
  createSignal,
  createEffect,
  createMemo,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import type { Playlist, Song } from "../../types/playlist.js";
import {
  usePlaylistzManager,
  usePlaylistzSongs,
  usePlaylistzUI,
  usePlaylistzImageModal,
} from "../../context/PlaylistzContext.js";
import { getImageUrlForContext } from "../../services/imageService.js";
import { audioState } from "../../services/audioService.js";
import {
  initSharingState,
  sharingReady,
  pendingKnockCount,
  outboundPendingCount,
  connectedPeerCount,
  isTransferring,
} from "../../services/sharingState.js";
import {
  savePlaylistOffline,
  playlistHasMissingBlobs,
  type OfflineProgress,
} from "../../services/blobTransferService.js";
import { AudioPlayer } from "../AudioPlayer.js";
import { SongRow } from "../SongRow.js";
import { PlaylistEditPanel } from "../PlaylistEditPanel.js";
import { SongEditPanel } from "../SongEditPanel.js";
import { PlaylistSharePanel } from "../PlaylistSharePanel.js";
import { AllPlaylistsPanel } from "../AllPlaylistsPanel.js";
import { forkPlaylist } from "../../services/playlistDocService.js";

import { log } from "../../utils/log.js";

export function PlaylistContainer(props: { playlist: Accessor<Playlist> }) {
  const playlistManager = usePlaylistzManager();
  const songState = usePlaylistzSongs();
  const uiState = usePlaylistzUI();
  const imageModal = usePlaylistzImageModal();

  onMount(() => initSharingState());

  const {
    playlists,
    playlistSongs,
    isDownloading,
    isCaching,
    allSongsCached,
    handlePlaylistUpdate,
    handleDownloadPlaylist,
    handleCachePlaylist,
    handleRemoveSong,
    handleReorderSongs,
    setBackgroundOverride,
  } = playlistManager;

  // read-only mode: playlist is subscribed from a remote peer and not yet forked
  const isSubscribed = () =>
    !!props.playlist().remoteNodeId && !props.playlist().isForked;

  const {
    handleEditSong,
    handleEditPlaylist,
    handlePlaySong,
    handlePauseSong,
    editingSong,
    editingPlaylist,
    setEditingSong,
    handleCloseEdit,
    handleSongSaved,
  } = songState;

  // create a wrapper that passes the playlist context
  const handlePlaySongWithPlaylist = async (song: Song) => {
    await handlePlaySong(song, props.playlist());
  };

  // p2p save offline: fetch all missing blobs from the doc's peers
  const [p2pSaveProgress, setP2pSaveProgress] =
    createSignal<OfflineProgress | null>(null);
  // hide the save-offline button once every referenced blob is local
  const [p2pHasMissing, setP2pHasMissing] = createSignal(false);
  createEffect(
    on(
      // re-check whenever the song list changes OR after a save-offline run
      // completes (p2pSaveProgress transitions back to null)
      () =>
        [
          props.playlist().id,
          playlistSongs().length,
          p2pSaveProgress() === null,
        ] as const,
      () => {
        void playlistHasMissingBlobs(props.playlist())
          .then(setP2pHasMissing)
          .catch(() => setP2pHasMissing(false));
      }
    )
  );
  const handleP2pSaveOffline = async () => {
    if (p2pSaveProgress()) return;
    setP2pSaveProgress({ done: 0, total: 0, currentTitle: "", fraction: 0 });
    try {
      await savePlaylistOffline(props.playlist(), (p) => setP2pSaveProgress(p));
      setP2pHasMissing(
        await playlistHasMissingBlobs(props.playlist()).catch(() => false)
      );
    } catch (err) {
      log.warn("p2p.save", "p2p save offline failed:", err);
    } finally {
      setP2pSaveProgress(null);
    }
  };

  const { isMobile } = uiState;

  const { openImageModal } = imageModal;

  // share panel state - declared before isEditing so the memo can reference it
  const [showingShare, setShowingShare] = createSignal(false);
  const [showAllPlaylists, setShowAllPlaylists] = createSignal(false);
  // when set, AllPlaylistsPanel opens with this peer nodeId pre-searched
  const [allPlaylistsPeerQuery, setAllPlaylistsPeerQuery] = createSignal<
    string | undefined
  >(undefined);

  const closeShare = () => {
    setShowingShare(false);
  };

  // true when any edit panel, share panel, or all-playlists view is open.
  const isEditing = createMemo(
    () =>
      editingSong() !== null ||
      editingPlaylist() ||
      showingShare() ||
      showAllPlaylists()
  );

  // index of the song being edited (for directional row animation)
  const editingSongIndex = () => {
    const song = editingSong();
    if (!song) return -1;
    return props.playlist().songIds.indexOf(song.id);
  };

  // neighbouring song relative to the one being edited (for panel navigation)
  const songAtOffset = (offset: number): Song | undefined => {
    const idx = editingSongIndex();
    if (idx < 0) return undefined;
    const targetId = props.playlist().songIds[idx + offset];
    if (!targetId) return undefined;
    return playlistSongs().find((s) => s.id === targetId);
  };

  const FLYOUT_MS = 100;

  // stagger delay per row during exit (in ms)
  const rowExitDelayMs = (index: number): number =>
    index < 5 ? index * 20 : 50 + (index - 5) * 5;

  // which CSS keyframe to use for a row's exit
  const rowExitKeyframe = (rowIndex: number): string => {
    if (editingPlaylist() || showAllPlaylists()) return "rowFlyDown";
    const editIdx = editingSongIndex();
    if (editIdx >= 0) {
      return rowIndex < editIdx ? "rowFlyUp" : "rowFlyDown";
    }
    return "rowFlyDown";
  };

  // phase signal: tracks whether rows have completed their exit animation.
  // "gone" = rows are done animating and should be collapsed out of layout.
  const [rowsGone, setRowsGone] = createSignal(false);

  // scroll container ref - reset scroll when an edit panel opens so the
  // panel top is never cut off (e.g. when editing songs at the end of a long playlist)
  let scrollContainerRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (isEditing()) {
      scrollContainerRef?.scrollTo({ top: 0 });
    }
  });

  // in playlist edit mode, a song edit panel is shown below the playlist
  // panel. default it to the first song, and re-sync when switching
  // playlists (the previous playlist's song may not exist here)
  createEffect(() => {
    if (!editingPlaylist()) return;
    const ids = props.playlist().songIds || [];
    const current = editingSong();
    if (current && ids.includes(current.id)) return;
    const first = ids.length
      ? playlistSongs().find((s) => s.id === ids[0])
      : undefined;
    setEditingSong(first ?? null);
  });

  // while in playlist edit mode, the page background follows the song being
  // edited (if it has an image) so the filter sliders are easier to tune.
  // the "use cover" button in the edit panel can override this until the
  // editing song changes again. cleared when leaving edit mode
  createEffect(
    on([editingPlaylist, editingSong], ([inPlaylistEdit, song]) => {
      if (inPlaylistEdit && song?.imageType) {
        setBackgroundOverride(song);
      } else {
        setBackgroundOverride(null);
      }
    })
  );

  onCleanup(() => setBackgroundOverride(null));

  // escape key closes the edit panels or share panel
  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showAllPlaylists()) {
          setShowAllPlaylists(false);
          return;
        }
        if (showingShare()) {
          closeShare();
          return;
        }
        if (isEditing()) handleCloseEdit();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  // only animate rows on the closed -> open transition. navigating between
  // song edit panels keeps isEditing() true, so rowsGone stays true and the
  // hidden rows don't flash back in between panels
  createEffect(
    on(isEditing, (editing, prevEditing) => {
      log.debug(
        "playlist.rows",
        "rowsGone effect",
        JSON.stringify({ editing, prevEditing })
      );
      if (editing && !prevEditing) {
        setRowsGone(false);
        // collapse layout and show panel after the first few rows have started
        // exiting - remaining row animations complete behind the panel
        const totalMs = rowExitDelayMs(2) + FLYOUT_MS;
        const t = setTimeout(() => {
          log.debug("playlist.rows", "rowsGone -> true");
          setRowsGone(true);
        }, totalMs);
        onCleanup(() => clearTimeout(t));
      } else if (!editing) {
        setRowsGone(false);
      }
    })
  );

  // outer wrapper: collapses to 0 height ONLY after animation completes.
  // no overflow:hidden here so inner transforms can fly freely.
  const rowOuterStyle = () =>
    rowsGone()
      ? { "max-height": "0px", overflow: "hidden" as const }
      : { "max-height": "400px" };

  // inner wrapper: CSS keyframe animation.
  // animation-name changes trigger a fresh animation on every edit mode transition.
  const rowInnerStyle = (rowIndex: number) => {
    if (isEditing() && !rowsGone()) {
      const delay = rowExitDelayMs(rowIndex);
      return {
        animation: `${rowExitKeyframe(rowIndex)} ${FLYOUT_MS}ms ease ${delay}ms both`,
      };
    }
    if (!isEditing()) {
      // fly back in when returning from edit mode (all rows together, subtle)
      return { animation: `rowFlyIn ${FLYOUT_MS}ms ease both` };
    }
    return {};
  };

  // header collapses out of layout only when editing a specific song (and not
  // in playlist edit mode). stays visible for share, all-playlists, and
  // playlist edit mode.
  // overflow:hidden only applied while collapsing so it doesn't clip mobile content.
  const headerStyle = () =>
    editingSong() && !editingPlaylist()
      ? {
          transition: "max-height 350ms ease, opacity 300ms ease",
          "max-height": "0px",
          overflow: "hidden" as const,
          opacity: "0",
          "pointer-events": "none" as const,
        }
      : {
          transition: "max-height 350ms ease, opacity 300ms ease",
          "max-height": "1200px",
          opacity: "1",
          "pointer-events": "auto" as const,
        };

  // panel slides in immediately after rows have collapsed (panel only mounts when rowsGone())
  const panelEntryStyle = () =>
    ({ animation: "slideDown 150ms ease both" }) as const;

  // height of the mobile sticky controls bar - active song rows stick just
  // below it instead of hiding underneath
  let stickyBarRef: HTMLDivElement | undefined;
  const [stickyBarHeight, setStickyBarHeight] = createSignal(0);
  createEffect(() => {
    if (!isMobile()) {
      setStickyBarHeight(0);
      return;
    }
    const el = stickyBarRef;
    if (!el) return;
    setStickyBarHeight(el.offsetHeight);
    const ro = new ResizeObserver(() => setStickyBarHeight(el.offsetHeight));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div
      class={`flex-1 flex flex-col min-h-0 [overflow-x:clip] ${isMobile() ? "p-2" : "p-6"}`}
    >
      {(() => {
        // playlist header - animates up/out only when editing a specific song
        // (not in playlist edit mode). stays visible for share, all-playlists,
        // and playlist edit mode. on mobile it renders inside the scroll
        // container so the cover image + title scroll with content, while the
        // player controls bar stays sticky at the top
        const headerSection = () => (
          <div
            style={headerStyle()}
            class={`flex items-center justify-between ${isMobile() ? "flex-col" : "p-6"}`}
          >
            {/* playlist cover image for mobile - hidden in edit mode (edit panel has its own) */}
            <div class={`${isMobile() && !isEditing() ? "" : "hidden"}`}>
              <button
                onClick={() => {
                  openImageModal(props.playlist(), playlistSongs(), 0);
                }}
                class="w-full h-full overflow-hidden hover:bg-gray-900 flex items-center justify-center transition-colors group"
                title="view playlist images"
              >
                <Show
                  when={props.playlist().imageType}
                  fallback={
                    <div class="text-center">
                      <svg
                        width="100"
                        height="100"
                        viewBox="0 0 100 100"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path
                          d="M50 81L25 31L75 31L60.7222 68.1429L50 81Z"
                          fill="#FF00FF"
                        />
                      </svg>
                    </div>
                  }
                >
                  {(() => {
                    const imageUrl = getImageUrlForContext(
                      props.playlist(),
                      "modal"
                    );
                    return (
                      <>
                        {imageUrl ? (
                          <img
                            src={imageUrl}
                            alt="playlist cover"
                            class="w-full h-full object-cover"
                          />
                        ) : (
                          <div class="text-center">
                            <svg
                              width="100"
                              height="100"
                              viewBox="0 0 100 100"
                              fill="none"
                              xmlns="http://www.w3.org/2000/svg"
                            >
                              <path
                                d="M50 81L25 31L75 31L60.7222 68.1429L50 81Z"
                                fill="#FF00FF"
                              />
                            </svg>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </Show>
              </button>
            </div>

            <div class="flex items-center gap-4 w-full">
              <div class="flex-1">
                <div class={`bg-black bg-opacity-80`}>
                  <input
                    data-testid="input-playlist-title"
                    type="text"
                    value={props.playlist().title}
                    onInput={(e) => {
                      handlePlaylistUpdate({
                        title: e.currentTarget.value,
                      });
                    }}
                    disabled={isSubscribed()}
                    class="text-3xl font-bold text-white bg-transparent border-none outline-none focus:bg-gray-800 px-2 py-1 rounded w-full disabled:opacity-60 disabled:cursor-not-allowed"
                    placeholder="playlist title"
                  />
                </div>
                <div class={`bg-black bg-opacity-80`}>
                  <input
                    data-testid="input-playlist-description"
                    type="text"
                    value={props.playlist().description || ""}
                    placeholder="add description..."
                    onInput={(e) => {
                      handlePlaylistUpdate({
                        description: e.currentTarget.value,
                      });
                    }}
                    disabled={isSubscribed()}
                    class="text-white bg-transparent border-none focus:bg-gray-800 px-2 py-1 rounded w-full disabled:opacity-60 disabled:cursor-not-allowed"
                  />
                </div>

                {/* read-only banner for subscribed playlists */}
                <Show when={isSubscribed()}>
                  <SubscribedBanner
                    playlist={props.playlist()}
                    onFork={(newDocId) => {
                      playlistManager.selectById(newDocId);
                    }}
                    onOpenEditPanel={() => handleEditPlaylist()}
                  />
                </Show>

                {/* player + action buttons grid - inline here on desktop, a
                sticky bar inside the scroll container on mobile */}
                <Show when={!isMobile()}>{playerControls()}</Show>
              </div>
            </div>

            {/* playlist cover image (desktop) */}
            {coverImage()}
          </div>
        );

        // hoisted function declarations so headerSection (above) and the
        // mobile sticky bar (below) can both render these
        function playerControls() {
          // 2x2 grid layout with AudioPlayer spanning left side
          return (
            <div
              class="grid gap-3"
              style={{
                "grid-template-columns": "auto 1fr",
                "grid-template-areas": "'player info' 'player buttons'",
              }}
            >
              {/* AudioPlayer spans 2 rows on the left */}
              <div
                class="flex items-center justify-center"
                style={{ "grid-area": "player" }}
              >
                <AudioPlayer playlist={props.playlist()} size="w-12 h-12" />
              </div>

              {/* top right song info stuff */}
              <div
                id="song-info"
                class="flex items-center justify-end text-sm gap-0"
                style={{ "grid-area": "info" }}
              >
                {/* sharer identity pill - shown when playlist is subscribed from a remote peer */}
                <Show when={props.playlist().remoteNodeId}>
                  <button
                    data-testid="btn-browse-sharer"
                    class="flex items-center gap-1 bg-black/80 px-1.5 py-2 text-xs text-gray-400 hover:text-magenta-300 hover:bg-black transition-colors"
                    title={`browse ${props.playlist().remoteName || props.playlist().remoteNodeId?.slice(0, 16)}'s playlistz`}
                    onClick={() => {
                      if (showingShare()) closeShare();
                      if (editingPlaylist() || editingSong()) handleCloseEdit();
                      setAllPlaylistsPeerQuery(props.playlist().remoteNodeId);
                      setShowAllPlaylists(true);
                    }}
                  >
                    <Show
                      when={props.playlist().remoteAvatarDataUrl}
                      fallback={
                        <span class="inline-flex items-center justify-center w-4 h-4 bg-magenta-700/60 text-white text-[9px] font-bold shrink-0 overflow-hidden rounded-full">
                          {(
                            props.playlist().remoteName ||
                            props.playlist().remoteNodeId ||
                            ""
                          )
                            .slice(0, 1)
                            .toUpperCase()}
                        </span>
                      }
                    >
                      <img
                        src={props.playlist().remoteAvatarDataUrl}
                        alt={props.playlist().remoteName || "peer"}
                        class="w-4 h-4 rounded-full object-cover shrink-0"
                      />
                    </Show>
                    <span class="truncate max-w-[6rem]">
                      {props.playlist().remoteName ||
                        props.playlist().remoteNodeId?.slice(0, 8)}
                    </span>
                  </button>
                </Show>
                <span
                  data-testid="playlist-song-count"
                  class="bg-black bg-opacity-80 p-2"
                >
                  {props.playlist().songIds?.length || 0} song
                  {(props.playlist().songIds?.length || 0) !== 1 ? "z" : ""}
                </span>
                <span
                  data-testid="playlist-total-time"
                  class="bg-black bg-opacity-80 p-2"
                >
                  {(() => {
                    const totalSeconds = playlistSongs().reduce(
                      (total, song) => total + (song.duration || 0),
                      0
                    );
                    const hours = Math.floor(totalSeconds / 3600);
                    const minutes = Math.floor((totalSeconds % 3600) / 60);
                    const seconds = Math.floor(totalSeconds % 60);
                    return hours > 0
                      ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
                      : `${minutes}:${seconds.toString().padStart(2, "0")}`;
                  })()}
                </span>
              </div>

              {/* bottom right: action buttonz */}
              <div
                class="flex items-center justify-end gap-2"
                style={{ "grid-area": "buttons" }}
              >
                {/* hamburger: open all-playlists overlay */}
                <button
                  data-testid="btn-all-playlists"
                  aria-expanded={showAllPlaylists()}
                  onClick={() => {
                    if (showingShare()) closeShare();
                    if (editingPlaylist() || editingSong()) handleCloseEdit();
                    setShowAllPlaylists((v) => !v);
                  }}
                  class={`p-2 hover:text-white hover:bg-gray-700 transition-colors bg-black/90 border ${
                    showAllPlaylists()
                      ? "text-magenta-400 border-magenta-500"
                      : "text-gray-400 border-transparent"
                  }`}
                  title="all playlistz"
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
                      d="M4 6h16M4 12h16M4 18h16"
                    />
                  </svg>
                </button>

                {/* edit playlist button - toggles edit panel */}
                <button
                  data-testid="btn-edit-playlist"
                  aria-expanded={editingPlaylist()}
                  onClick={() => {
                    if (showAllPlaylists()) setShowAllPlaylists(false);
                    if (showingShare()) closeShare();
                    editingPlaylist()
                      ? handleCloseEdit()
                      : handleEditPlaylist();
                  }}
                  class={`p-2 hover:text-white hover:bg-gray-700 transition-colors bg-black/90 border ${editingPlaylist() ? "text-magenta-400 border-magenta-500" : "text-gray-400 border-transparent"}`}
                  title={
                    editingPlaylist() ? "close edit panel" : "edit playlist"
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
                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    />
                  </svg>
                </button>

                {/* share playlist button: icon nodes fill based on connected
                    peer count (1/2/3+), pulse when transfers are active */}
                <button
                  data-testid="btn-share-playlist"
                  aria-expanded={showingShare()}
                  onClick={() => {
                    if (showingShare()) {
                      closeShare();
                    } else {
                      if (showAllPlaylists()) setShowAllPlaylists(false);
                      if (editingPlaylist()) handleCloseEdit();
                      setShowingShare(true);
                    }
                  }}
                  class={`relative p-2 hover:text-white hover:bg-gray-700 transition-colors bg-black/90 border ${
                    showingShare()
                      ? "text-magenta-400 border-magenta-500"
                      : sharingReady()
                        ? "text-magenta-400 border-transparent"
                        : "text-gray-400 border-transparent"
                  }`}
                  title="share playlist"
                >
                  <svg
                    class="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    {/* connection lines */}
                    <line
                      x1="7"
                      y1="11.5"
                      x2="17"
                      y2="5.5"
                      stroke-width="1.5"
                    />
                    <line
                      x1="7"
                      y1="12.5"
                      x2="17"
                      y2="18.5"
                      stroke-width="1.5"
                    />
                    {/* left node - fills when 1+ connected */}
                    <circle
                      cx="5"
                      cy="12"
                      r="2.5"
                      stroke-width="1.5"
                      fill={connectedPeerCount() >= 1 ? "currentColor" : "none"}
                      class={
                        connectedPeerCount() >= 1 && isTransferring()
                          ? "animate-pulse"
                          : ""
                      }
                    />
                    {/* top-right node - fills when 2+ connected */}
                    <circle
                      cx="19"
                      cy="5"
                      r="2.5"
                      stroke-width="1.5"
                      fill={connectedPeerCount() >= 2 ? "currentColor" : "none"}
                      class={
                        connectedPeerCount() >= 2 && isTransferring()
                          ? "animate-pulse"
                          : ""
                      }
                    />
                    {/* bottom-right node - fills when 3+ connected */}
                    <circle
                      cx="19"
                      cy="19"
                      r="2.5"
                      stroke-width="1.5"
                      fill={connectedPeerCount() >= 3 ? "currentColor" : "none"}
                      class={
                        connectedPeerCount() >= 3 && isTransferring()
                          ? "animate-pulse"
                          : ""
                      }
                    />
                  </svg>
                  <Show
                    when={pendingKnockCount() > 0 || outboundPendingCount() > 0}
                  >
                    <span class="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-magenta-500 text-white text-[9px] leading-[14px] text-center font-bold">
                      {pendingKnockCount() + outboundPendingCount()}
                    </span>
                  </Show>
                </button>

                {/* save offline button */}
                <Show
                  when={
                    window.STANDALONE_MODE &&
                    window.location.protocol !== "file:"
                  }
                >
                  <Show when={!allSongsCached()}>
                    <button
                      data-testid="btn-cache-offline"
                      onClick={handleCachePlaylist}
                      disabled={isCaching() || playlistSongs().length === 0}
                      class="p-2 text-gray-400 hover:text-magenta-400 hover:bg-gray-700 transition-colors bg-black/90 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="download songz for offline use"
                    >
                      <Show
                        when={!isCaching()}
                        fallback={
                          <svg
                            class="w-4 h-4 animate-spin"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              stroke-width="2"
                              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                            />
                          </svg>
                        }
                      >
                        SAVE OFFLINE
                      </Show>
                    </button>
                  </Show>
                </Show>

                {/* share playlist (p2p) moved to the edit panel's share
                    column - no header share button */}

                {/* p2p save offline button (fetch missing blobs from peers);
                    hidden once everything is already cached locally */}
                <Show
                  when={
                    !window.STANDALONE_MODE && sharingReady() && p2pHasMissing()
                  }
                >
                  <button
                    data-testid="btn-p2p-save-offline"
                    onClick={() => void handleP2pSaveOffline()}
                    disabled={p2pSaveProgress() !== null}
                    class="p-2 text-gray-400 hover:text-magenta-400 hover:bg-gray-700 transition-colors bg-black/90 disabled:opacity-50"
                    title={
                      p2pSaveProgress()
                        ? `fetching ${p2pSaveProgress()!.currentTitle} (${p2pSaveProgress()!.done}/${p2pSaveProgress()!.total})`
                        : "save offline (fetch from peerz)"
                    }
                  >
                    <Show
                      when={!p2pSaveProgress()}
                      fallback={
                        <svg
                          class="w-4 h-4 animate-spin"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                          />
                        </svg>
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
                          d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                        />
                      </svg>
                    </Show>
                  </button>
                </Show>

                {/* download playlist .zip button */}
                <Show when={window.location.protocol !== "file:"}>
                  <button
                    data-testid="btn-download-zip"
                    onClick={handleDownloadPlaylist}
                    disabled={isDownloading()}
                    class="p-2 text-gray-400 hover:text-green-400 hover:bg-gray-700 transition-colors bg-black/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="download playlist as zip"
                  >
                    <Show
                      when={!isDownloading()}
                      fallback={
                        <svg
                          class="w-4 h-4 animate-spin"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                          />
                        </svg>
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
                  </button>
                </Show>
              </div>
            </div>
          );
        }

        // desktop cover image (right side of the header)
        function coverImage() {
          return (
            <div class={`${isMobile() ? "hidden" : "ml-4"}`}>
              <button
                onClick={() => {
                  openImageModal(props.playlist(), playlistSongs(), 0);
                }}
                class="w-39 h-39 overflow-hidden hover:bg-gray-900 flex items-center justify-center transition-colors group"
                style={{
                  filter: (() => {
                    const p = props.playlist();
                    if (p.coverFilterEnabled === false) return "none";
                    const blur = p.coverFilterBlur ?? 3;
                    return `blur(${blur}px) contrast(3) brightness(0.4)`;
                  })(),
                }}
                onMouseEnter={(e) => (e.currentTarget.style.filter = "none")}
                onMouseLeave={(e) => {
                  const p = props.playlist();
                  if (p.coverFilterEnabled === false) {
                    e.currentTarget.style.filter = "none";
                  } else {
                    const blur = p.coverFilterBlur ?? 3;
                    e.currentTarget.style.filter = `blur(${blur}px) contrast(3) brightness(0.4)`;
                  }
                }}
                title="view playlist imagez"
              >
                <Show
                  when={props.playlist().imageType}
                  fallback={
                    <div class="text-center">
                      <svg
                        width="100"
                        height="100"
                        viewBox="0 0 100 100"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path
                          d="M50 81L25 31L75 31L60.7222 68.1429L50 81Z"
                          fill="#FF00FF"
                        />
                      </svg>
                    </div>
                  }
                >
                  {(() => {
                    const imageUrl = getImageUrlForContext(
                      props.playlist(),
                      "modal"
                    );
                    return (
                      <>
                        {imageUrl ? (
                          <img
                            src={imageUrl}
                            alt="playlist cover"
                            class="w-full h-full object-cover"
                          />
                        ) : (
                          <div class="text-center">
                            <svg
                              width="100"
                              height="100"
                              viewBox="0 0 100 100"
                              fill="none"
                              xmlns="http://www.w3.org/2000/svg"
                            >
                              <path
                                d="M50 81L25 31L75 31L60.7222 68.1429L50 81Z"
                                fill="#FF00FF"
                              />
                            </svg>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </Show>
              </button>
            </div>
          );
        }

        return (
          <>
            <Show when={!isMobile()}>{headerSection()}</Show>

            {/* songz list and edit panels. on mobile the playlist header scrolls
          away with the content while the player controls bar stays sticky */}
            <div
              ref={scrollContainerRef}
              class="flex-1 overflow-y-auto min-h-0"
            >
              <Show when={isMobile()}>
                {headerSection()}
                <div
                  ref={stickyBarRef}
                  style={headerStyle()}
                  class="sticky top-0 z-[110] bg-black py-1"
                >
                  {playerControls()}
                </div>
              </Show>
              {/* inline share panel - renders once rows have animated out.
            keyed on playlist id so it remounts when switching playlists */}
              <Show
                when={showingShare() && rowsGone() ? props.playlist().id : null}
                keyed
              >
                <div style={panelEntryStyle()}>
                  <PlaylistSharePanel
                    playlist={props.playlist}
                    playlists={playlists()}
                    onClose={closeShare}
                    onPlaylistAdded={(docId) => {
                      playlistManager.selectById(docId);
                      closeShare();
                    }}
                  />
                </div>
              </Show>

              {/* inline all-playlists panel - same row-exit animation as edit mode.
            the selected playlist row is not shown (it's the header above).
            edit/share on other rows selects that playlist first. */}
              <Show when={showAllPlaylists() && rowsGone()}>
                <div style={panelEntryStyle()}>
                  <AllPlaylistsPanel
                    onClose={() => {
                      setShowAllPlaylists(false);
                      setAllPlaylistsPeerQuery(undefined);
                    }}
                    onEdit={(p) => {
                      playlistManager.selectPlaylist(p);
                      setShowAllPlaylists(false);
                      setAllPlaylistsPeerQuery(undefined);
                      setTimeout(() => handleEditPlaylist(), 0);
                    }}
                    onShare={(p) => {
                      playlistManager.selectPlaylist(p);
                      setShowAllPlaylists(false);
                      setAllPlaylistsPeerQuery(undefined);
                      setTimeout(() => setShowingShare(true), 0);
                    }}
                    onPlaylistAdded={(docId) => {
                      playlistManager.selectById(docId);
                      setShowAllPlaylists(false);
                      setAllPlaylistsPeerQuery(undefined);
                    }}
                    initialQuery={allPlaylistsPeerQuery()}
                  />
                </div>
              </Show>

              {/* inline playlist edit panel - only renders once rows have animated out.
            keyed on playlist id so the form remounts with fresh data when
            switching playlists via the sidebar */}
              <Show
                when={
                  editingPlaylist() && rowsGone() ? props.playlist().id : null
                }
                keyed
              >
                <div
                  style={panelEntryStyle()}
                  class={isMobile() ? "p-2" : "px-6 pt-2 pb-4"}
                >
                  <PlaylistEditPanel
                    playlist={props.playlist()}
                    playlistSongs={playlistSongs()}
                    onClose={handleCloseEdit}
                    onSave={(updated) =>
                      playlistManager.selectPlaylist(updated)
                    }
                    onFork={(newDocId) => {
                      playlistManager.selectById(newDocId);
                      handleCloseEdit();
                    }}
                  />
                </div>
              </Show>

              {/* inline song edit panel - only renders once rows have animated out.
            keyed on song id so the form remounts when navigating between songs */}
              <Show
                when={editingSong() && rowsGone() ? editingSong()!.id : null}
                keyed
              >
                <div
                  style={panelEntryStyle()}
                  class={isMobile() ? "" : "px-6 pt-2 pb-4"}
                >
                  <SongEditPanel
                    song={editingSong()!}
                    index={editingSongIndex()}
                    onClose={handleCloseEdit}
                    onSave={handleSongSaved}
                    prevSong={songAtOffset(-1)}
                    nextSong={songAtOffset(1)}
                    onNavigate={handleEditSong}
                  />
                </div>
              </Show>

              {/* rows container - no overflow:hidden here; scroll container clips instead.
            fully removed from layout once rows are gone so leftover padding +
            space-y margins don't add phantom height below the edit panel */}
              <div
                class={`${isMobile() ? "space-y-1" : "p-6 space-y-2"}`}
                style={rowsGone() ? { display: "none" } : {}}
              >
                {/* empty playlist message - hidden during edit mode */}
                <Show
                  when={
                    !isEditing() &&
                    (!props.playlist().songIds ||
                      props.playlist().songIds.length === 0)
                  }
                >
                  <div
                    data-testid="empty-songs"
                    class={`${isMobile() ? "" : "ml-42 mr-42"} text-center p-8 bg-black/75`}
                  >
                    <div class="text-gray-400 text-xl mb-4">no songz yet</div>
                    <p class="text-gray-400 mb-4">
                      drag and drop audio filez (or a .zip file!) here to add
                      them to this playlist
                    </p>
                    <div class="text-xs text-gray-500 space-y-1">
                      <div>playlist id: {props.playlist().id}</div>
                      <div>
                        supported formatz: mp3, wav, flac, aiff, ogg, mp4
                      </div>
                    </div>
                  </div>
                </Show>

                {/* animated song rows: outer wrapper collapses height after animation,
              inner wrapper runs the CSS keyframe flyout/flyin animation */}
                <For each={props.playlist().songIds}>
                  {(songId, index) => {
                    const isBeingEdited = () => editingSong()?.id === songId;
                    // sticky has to live on this outer wrapper: the row itself is
                    // boxed in by the animation wrappers, so position: sticky on it
                    // can't escape and never actually sticks
                    const isActiveRow = () =>
                      audioState.selectedSongId() === songId ||
                      (audioState.currentSong()?.id === songId &&
                        audioState.isPlaying());
                    return (
                      <Show when={!isBeingEdited()}>
                        <div
                          style={{
                            ...rowOuterStyle(),
                            ...(isActiveRow()
                              ? { top: `${stickyBarHeight()}px` }
                              : {}),
                          }}
                          class={isActiveRow() ? "sticky bottom-0 z-100" : ""}
                        >
                          <div style={rowInnerStyle(index())}>
                            <SongRow
                              songId={songId}
                              index={index()}
                              showRemoveButton={!isSubscribed()}
                              onRemove={handleRemoveSong}
                              onPlay={handlePlaySongWithPlaylist}
                              onPause={handlePauseSong}
                              onEdit={handleEditSong}
                              onReorder={
                                isSubscribed() ? undefined : handleReorderSongs
                              }
                            />
                          </div>
                        </div>
                      </Show>
                    );
                  }}
                </For>
              </div>
            </div>
          </>
        );
      })()}
    </div>
  );
}

// compact read-only banner shown below the title/description for subscribed playlists.
// provides quick access to fork (local copy) and the full edit panel (for collab request).
function SubscribedBanner(props: {
  playlist: Playlist;
  onFork: (newDocId: string) => void;
  onOpenEditPanel: () => void;
}) {
  const [forking, setForking] = createSignal(false);
  const [forkError, setForkError] = createSignal<string | null>(null);

  const handleFork = async () => {
    if (forking()) return;
    setForking(true);
    setForkError(null);
    try {
      const forked = await forkPlaylist(props.playlist.id);
      props.onFork(forked.id);
    } catch (err) {
      setForkError("fork failed");
      console.error("fork error:", err);
    } finally {
      setForking(false);
    }
  };

  const displayName = () =>
    props.playlist.remoteName ||
    props.playlist.remoteNodeId?.slice(0, 16) ||
    "peer";

  return (
    <div
      data-testid="subscribed-banner"
      class="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 bg-black/70 border-t border-gray-800 text-xs"
    >
      <span class="text-yellow-500/80 font-medium">read only</span>
      <span class="text-gray-600">·</span>
      <Show
        when={props.playlist.remoteAvatarDataUrl}
        fallback={
          <span class="inline-flex items-center justify-center w-3.5 h-3.5 bg-magenta-700/60 text-white text-[8px] font-bold rounded-full overflow-hidden">
            {(props.playlist.remoteName || props.playlist.remoteNodeId || "")
              .slice(0, 1)
              .toUpperCase()}
          </span>
        }
      >
        <img
          src={props.playlist.remoteAvatarDataUrl}
          alt={props.playlist.remoteName || "peer"}
          class="w-3.5 h-3.5 rounded-full object-cover"
        />
      </Show>
      <span class="text-gray-500">from {displayName()}</span>
      <div class="flex items-center gap-2 ml-auto">
        <button
          data-testid="btn-fork-playlist-banner"
          class="px-2 py-0.5 text-gray-300 hover:text-white border border-gray-700 hover:border-gray-500 disabled:opacity-50 transition-colors"
          onClick={() => void handleFork()}
          disabled={forking()}
        >
          {forking() ? "forking..." : "fork my copy"}
        </button>
        <button
          data-testid="btn-request-edit-banner"
          class="px-2 py-0.5 text-gray-300 hover:text-white border border-gray-700 hover:border-gray-500 transition-colors"
          onClick={() => props.onOpenEditPanel()}
          title="request collaboration access"
        >
          request edit
        </button>
      </div>
      <Show when={forkError()}>
        <span class="w-full text-red-400">{forkError()}</span>
      </Show>
    </div>
  );
}
