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
import { AudioPlayer } from "../AudioPlayer.js";
import { SongRow } from "../SongRow.js";
import { PlaylistEditPanel } from "../PlaylistEditPanel.js";
import { SongEditPanel } from "../SongEditPanel.js";

export function PlaylistContainer(props: { playlist: Accessor<Playlist> }) {
  const playlistManager = usePlaylistzManager();
  const songState = usePlaylistzSongs();
  const uiState = usePlaylistzUI();
  const imageModal = usePlaylistzImageModal();

  const {
    playlistSongs,
    setShowDeleteConfirm,
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

  const { isMobile } = uiState;

  const { openImageModal } = imageModal;

  // true when any edit panel is open. the memo is critical: editingSong()
  // changes identity while a panel is open (default-song effect, panel
  // navigation), but effects keyed on isEditing must only re-run when the
  // boolean actually flips - otherwise their cleanups cancel the pending
  // rowsGone timeout and the panel never mounts
  const isEditing = createMemo(
    () => editingSong() !== null || editingPlaylist()
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
    if (editingPlaylist()) return "rowFlyDown";
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

  // escape key closes the edit panels
  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isEditing()) {
        handleCloseEdit();
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
      console.log("[trace] rowsGone effect", { editing, prevEditing });
      if (editing && !prevEditing) {
        setRowsGone(false);
        // collapse layout and show panel after the first few rows have started
        // exiting - remaining row animations complete behind the panel
        const totalMs = rowExitDelayMs(2) + FLYOUT_MS;
        const t = setTimeout(() => {
          console.log("[trace] rowsGone -> true");
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

  // header collapses completely (out of layout) when editing a song.
  // stays visible in playlist edit mode (where the song panel is secondary).
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

  return (
    <div
      class={`flex-1 flex flex-col overflow-x-hidden ${isMobile() ? "p-2" : "h-full p-6"}`}
    >
      {/* playlist header - animates up/out when editing a specific song */}
      <div
        style={headerStyle()}
        class={`flex items-center justify-between ${isMobile() ? "p-2 flex-col" : "p-6"}`}
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
                type="text"
                value={props.playlist().title}
                onInput={(e) => {
                  handlePlaylistUpdate({
                    title: e.currentTarget.value,
                  });
                }}
                class="text-3xl font-bold text-white bg-transparent border-none outline-none focus:bg-gray-800 px-2 py-1 rounded w-full"
                placeholder="playlist title"
              />
            </div>
            <div class={`bg-black bg-opacity-80`}>
              <input
                type="text"
                value={props.playlist().description || ""}
                placeholder="add description..."
                onInput={(e) => {
                  handlePlaylistUpdate({
                    description: e.currentTarget.value,
                  });
                }}
                class="text-white bg-transparent border-none focus:bg-gray-800 px-2 py-1 rounded w-full"
              />
            </div>

            {/* 2x2 grid layout with AudioPlayer spanning left side */}
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
                <span class="bg-black bg-opacity-80 p-2">
                  {props.playlist().songIds?.length || 0} song
                  {(props.playlist().songIds?.length || 0) !== 1 ? "z" : ""}
                </span>
                <span class="bg-black bg-opacity-80 p-2">
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
                {/* save offline button */}
                <Show
                  when={
                    window.STANDALONE_MODE &&
                    window.location.protocol !== "file:"
                  }
                >
                  <Show when={!allSongsCached()}>
                    <button
                      onClick={handleCachePlaylist}
                      disabled={isCaching() || playlistSongs().length === 0}
                      class="p-2 text-gray-400 hover:text-magenta-400 hover:bg-gray-700 transition-colors bg-black bg-opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
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

                {/* edit playlist button - toggles edit panel */}
                <button
                  onClick={() => {
                    console.log(
                      "[trace] edit button click, editingPlaylist =",
                      editingPlaylist(),
                      "rowsGone =",
                      rowsGone()
                    );
                    editingPlaylist()
                      ? handleCloseEdit()
                      : handleEditPlaylist();
                  }}
                  class={`p-2 hover:text-white hover:bg-gray-700 transition-colors bg-black bg-opacity-80 ${editingPlaylist() ? "text-magenta-400" : "text-gray-400"}`}
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

                {/* download playlist .zip button */}
                <Show when={window.location.protocol !== "file:"}>
                  <button
                    onClick={handleDownloadPlaylist}
                    disabled={isDownloading()}
                    class="p-2 text-gray-400 hover:text-green-400 hover:bg-gray-700 transition-colors bg-black bg-opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
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

                {/* delete playlist button */}
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  class="p-2 text-gray-400 hover:text-red-400 hover:bg-gray-700 transition-colors bg-black bg-opacity-80"
                  title="delete playlist"
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
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* playlist cover image */}
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
      </div>

      {/* songz list and edit panels */}
      <div
        ref={scrollContainerRef}
        class={`${isMobile() ? "flex-1" : "flex-1 overflow-y-auto"}`}
      >
        {/* inline playlist edit panel - only renders once rows have animated out.
            keyed on playlist id so the form remounts with fresh data when
            switching playlists via the sidebar */}
        <Show
          when={editingPlaylist() && rowsGone() ? props.playlist().id : null}
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
              onSave={(updated) => playlistManager.selectPlaylist(updated)}
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
            <div class="text-center py-16">
              <div class="text-gray-400 text-xl mb-4">no songz yet</div>
              <p class="text-gray-400 mb-4">
                drag and drop audio filez (or a .zip file!) here to add them to
                this playlist
              </p>
              <div class="text-xs text-gray-500 space-y-1">
                <div>playlist id: {props.playlist().id}</div>
                <div>supported formatz: mp3, wav, flac, aiff, ogg, mp4</div>
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
                    style={rowOuterStyle()}
                    class={isActiveRow() ? "sticky top-0 bottom-0 z-100" : ""}
                  >
                    <div style={rowInnerStyle(index())}>
                      <SongRow
                        songId={songId}
                        index={index()}
                        showRemoveButton={true}
                        onRemove={handleRemoveSong}
                        onPlay={handlePlaySongWithPlaylist}
                        onPause={handlePauseSong}
                        onEdit={handleEditSong}
                        onReorder={handleReorderSongs}
                      />
                    </div>
                  </div>
                </Show>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
