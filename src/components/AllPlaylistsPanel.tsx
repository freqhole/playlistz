// inline all-playlists panel. replaces song rows when the hamburger is pressed.
//
// - the currently selected playlist is NOT shown (it's in the header above)
// - each row: thumbnail, title+description marquee, total time, song count,
//   action buttons (edit, share, download zip)
// - "new playlist" sticky row at the bottom
// - title/description text wrapped in tight bg-black spans for legibility
//   over the transparent/blurred playlist background

import { For, Show, createSignal } from "solid-js";
import {
  createRelativeTimeSignal,
  formatDuration,
} from "../utils/timeUtils.js";
import { getImageUrlForContext } from "../services/imageService.js";
import { audioState, playPlaylist } from "../services/audioService.js";
import { downloadPlaylistAsZip } from "../services/playlistDownloadService.js";
import type { Playlist, Song } from "../types/playlist.js";
import { usePlaylistzManager } from "../context/PlaylistzContext.js";
import { MarqueeText } from "./MarqueeText.js";

interface Props {
  // songs for all playlists keyed by playlist id - for total-time display
  allSongs?: Record<string, Song[]>;
  onClose: () => void;
  // select a different playlist + open edit mode
  onEdit: (p: Playlist) => void;
  // select a different playlist + open share panel
  onShare: (p: Playlist) => void;
}

export function AllPlaylistsPanel(props: Props) {
  const { playlists, selectedPlaylist, selectPlaylist, createNewPlaylist } =
    usePlaylistzManager();

  const [isCreating, setIsCreating] = createSignal(false);

  // exclude the currently selected playlist - it stays in the header above
  const otherPlaylists = () => {
    const sel = selectedPlaylist();
    return sel ? playlists().filter((p) => p.id !== sel.id) : playlists();
  };

  const handleSelect = (p: Playlist) => {
    selectPlaylist(p);
    props.onClose();
  };

  const handlePlay = (p: Playlist) => {
    selectPlaylist(p);
    props.onClose();
    void playPlaylist(p);
  };

  const handleCreate = async () => {
    if (isCreating()) return;
    setIsCreating(true);
    try {
      const created = await createNewPlaylist("new playlist");
      if (created) {
        selectPlaylist(created);
        props.onClose();
      }
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div class="flex flex-col h-full" data-testid="all-playlists-panel">
      <div class="flex-1 overflow-y-auto">
        <Show when={otherPlaylists().length > 0}>
          <For each={otherPlaylists()}>
            {(p) => (
              <PlaylistRow
                playlist={p}
                songs={props.allSongs?.[p.id]}
                onSelect={handleSelect}
                onPlay={handlePlay}
                onEdit={props.onEdit}
                onShare={props.onShare}
              />
            )}
          </For>
        </Show>

        {/* sticky new-playlist row */}
        <div class="sticky bottom-0">
          <button
            onClick={handleCreate}
            disabled={isCreating()}
            class="w-full flex items-center gap-3 px-4 py-3 text-gray-500 hover:text-magenta-400 hover:bg-black/60 disabled:opacity-50 transition-colors border-t border-white/10 bg-black/40 text-sm"
          >
            <div class="flex-shrink-0 w-10 h-10 flex items-center justify-center border border-dashed border-gray-600">
              <Show
                when={!isCreating()}
                fallback={
                  <div class="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
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
            </div>
            <span class="px-1 py-0.5 bg-black">
              {isCreating() ? "creating..." : "new playlist"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function PlaylistRow(props: {
  playlist: Playlist;
  songs?: Song[];
  onSelect: (p: Playlist) => void;
  onPlay: (p: Playlist) => void;
  onEdit: (p: Playlist) => void;
  onShare: (p: Playlist) => void;
}) {
  const isPlaying = () =>
    audioState.isPlaying() &&
    audioState.currentPlaylist()?.id === props.playlist.id;

  const relativeTime = createRelativeTimeSignal(props.playlist.updatedAt);

  const songCount = () => {
    const n = props.playlist.songIds?.length ?? 0;
    return n === 1 ? "1 song" : `${n} songz`;
  };

  const totalTime = () => {
    const songs = props.songs;
    if (!songs || songs.length === 0) return null;
    const secs = songs.reduce((t, s) => t + (s.duration || 0), 0);
    if (secs === 0) return null;
    return formatDuration(secs);
  };

  const imageUrl = () => getImageUrlForContext(props.playlist, "thumbnail");

  const [isHovered, setIsHovered] = createSignal(false);
  const [downloading, setDownloading] = createSignal(false);

  const handleDownload = async (e: MouseEvent) => {
    e.stopPropagation();
    if (downloading()) return;
    setDownloading(true);
    try {
      await downloadPlaylistAsZip(props.playlist, {
        includeMetadata: true,
        includeImages: true,
        generateM3U: true,
        includeHTML: true,
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      class="group relative flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-magenta-500/75"
      onClick={() => props.onSelect(props.playlist)}
      onDblClick={(e) => {
        e.stopPropagation();
        props.onPlay(props.playlist);
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* thumbnail */}
      <div class="relative flex-shrink-0 w-10 h-10 overflow-hidden bg-black/40">
        <Show when={isPlaying()}>
          <div
            class="absolute inset-0 z-10 flex items-center justify-center bg-black/50"
            title="playing"
          >
            <svg
              class="w-4 h-4 text-magenta-400 animate-pulse"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path d="M6.3 4.06a1 1 0 011.02.04l7 4.5a1 1 0 010 1.7l-7 4.5A1 1 0 016 14V5a1 1 0 01.3-.94z" />
            </svg>
          </div>
        </Show>
        <Show
          when={imageUrl()}
          fallback={
            <div class="w-full h-full flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 100 100" fill="none">
                <path
                  d="M50 81L25 31L75 31L60.7222 68.1429L50 81Z"
                  fill="#FF00FF"
                />
              </svg>
            </div>
          }
        >
          <img
            src={imageUrl()!}
            alt={props.playlist.title}
            class="w-full h-full object-cover"
          />
        </Show>
      </div>

      {/* text block */}
      <div class="flex-1 min-w-0 overflow-hidden">
        <MarqueeText
          text={props.playlist.title}
          isHovering={isHovered}
          class="text-sm font-medium text-white [&>span]:px-1 [&>span]:bg-black"
        />
        <Show when={props.playlist.description}>
          <MarqueeText
            text={props.playlist.description!}
            isHovering={isHovered}
            class="text-xs text-gray-400 mt-0.5 [&>span]:px-1 [&>span]:bg-black"
          />
        </Show>
        <div class="flex items-center gap-1 mt-0.5 flex-wrap">
          <span class="text-xs text-gray-500 px-1 bg-black">{songCount()}</span>
          <Show when={totalTime()}>
            <span class="text-xs text-gray-700 bg-black px-0.5">·</span>
            <span class="text-xs text-gray-500 px-1 bg-black">
              {totalTime()}
            </span>
          </Show>
          <span class="text-xs text-gray-700 bg-black px-0.5">·</span>
          <span class="text-xs text-gray-500 px-1 bg-black">
            {relativeTime.signal()}
          </span>
        </div>
      </div>

      {/* action buttons - fade in on hover, solid black bg for legibility */}
      <div
        class={`flex-shrink-0 flex items-center bg-black transition-opacity ${
          isHovered() ? "opacity-100" : "opacity-0"
        }`}
      >
        <button
          class="p-3 text-gray-500 hover:text-magenta-400 transition-colors"
          title={`play ${props.playlist.title}`}
          onClick={(e) => {
            e.stopPropagation();
            props.onPlay(props.playlist);
          }}
        >
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path d="M6.3 4.06a1 1 0 011.02.04l7 4.5a1 1 0 010 1.7l-7 4.5A1 1 0 016 14V5a1 1 0 01.3-.94z" />
          </svg>
        </button>
        <button
          class="p-3 text-gray-500 hover:text-white transition-colors"
          title="edit playlist"
          onClick={(e) => {
            e.stopPropagation();
            props.onEdit(props.playlist);
          }}
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
        <button
          class="p-3 text-gray-500 hover:text-magenta-400 transition-colors"
          title="share playlist"
          onClick={(e) => {
            e.stopPropagation();
            props.onShare(props.playlist);
          }}
        >
          <svg
            class="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <line x1="7" y1="11.5" x2="17" y2="5.5" stroke-width="1.5" />
            <line x1="7" y1="12.5" x2="17" y2="18.5" stroke-width="1.5" />
            <circle cx="5" cy="12" r="2.5" stroke-width="1.5" />
            <circle cx="19" cy="5" r="2.5" stroke-width="1.5" />
            <circle cx="19" cy="19" r="2.5" stroke-width="1.5" />
          </svg>
        </button>
        <Show when={window.location.protocol !== "file:"}>
          <button
            class="p-3 text-gray-500 hover:text-green-400 transition-colors disabled:opacity-40"
            title="download playlist as zip"
            disabled={downloading()}
            onClick={handleDownload}
          >
            <Show
              when={!downloading()}
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
