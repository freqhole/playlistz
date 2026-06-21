// inline all-playlists panel. replaces song rows when the hamburger is pressed.
//
// - the currently selected playlist is NOT shown (it's in the header above)
// - each row: thumbnail, title+description marquee, total time, song count,
//   action buttons (edit, share, download zip)
// - "new playlist" sticky row at the bottom
// - title/description text wrapped in tight bg-black spans for legibility
//   over the transparent/blurred playlist background

import { For, Show, createSignal, onMount } from "solid-js";
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
import { getSongsForPlaylist } from "../services/playlistDocService.js";
import {
  openShareLink,
  queryPeerPlaylists,
  ensureSharingReady,
  knockOnPeer,
  type PeerPlaylistListing,
} from "../services/sharingService.js";
import { decodeShareToken } from "@freqhole/api-client/playlistz";
import { ShareLinkKnockPanel } from "./ShareLinkKnockPanel.js";

interface Props {
  onClose: () => void;
  // select a different playlist + open edit mode
  onEdit: (p: Playlist) => void;
  // select a different playlist + open share panel
  onShare: (p: Playlist) => void;
  // called when a share link is successfully opened from the search bar
  onPlaylistAdded?: (docId: string) => void;
  // pre-fill search with a peer nodeId and trigger peer browse on open
  initialQuery?: string;
}

export function AllPlaylistsPanel(props: Props) {
  const {
    playlists,
    selectedPlaylist,
    selectPlaylist,
    selectById,
    createNewPlaylist,
  } = usePlaylistzManager();

  const [isCreating, setIsCreating] = createSignal(false);
  const [allSongs, setAllSongs] = createSignal<Record<string, Song[]>>({});
  const [query, setQuery] = createSignal(props.initialQuery ?? "");
  const [searchStatus, setSearchStatus] = createSignal<string | null>(null);
  const [peerListing, setPeerListing] =
    createSignal<PeerPlaylistListing | null>(null);

  // knock modal state for knock-gated share links pasted into the search bar
  const [searchKnockRequired, setSearchKnockRequired] = createSignal<{
    ownerNodeId: string;
    docId: string;
    title?: string;
    ownerName?: string;
  } | null>(null);

  // knock-with-message state (shown when knockRequired)
  const [knockMessage, setKnockMessage] = createSignal("");
  const [isKnocking, setIsKnocking] = createSignal(false);
  const [knockStatus, setKnockStatus] = createSignal<string | null>(null);

  // detect if a string is a hex iroh node id (64 lowercase hex chars)
  const isNodeId = (s: string) => /^[0-9a-f]{64}$/i.test(s.trim());

  // detect share links via decodeShareToken
  const isShareLink = (s: string) => decodeShareToken(s.trim()) !== null;

  // exclude the currently selected playlist - it stays in the header above
  const otherPlaylists = () => {
    const sel = selectedPlaylist();
    const all = sel ? playlists().filter((p) => p.id !== sel.id) : playlists();
    const q = query().trim().toLowerCase();
    // when in peer browse mode or empty query, show all; otherwise filter
    if (!q || peerListing()) return all;
    return all.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q)
    );
  };

  const handleSearchInput = async (value: string) => {
    setQuery(value);
    setSearchStatus(null);
    setPeerListing(null);

    const trimmed = value.trim();
    if (!trimmed) return;

    if (isShareLink(trimmed)) {
      setSearchStatus("opening...");
      try {
        const result = await openShareLink(trimmed);
        if (result.status === "knock_required") {
          setSearchStatus(null);
          setQuery("");
          setSearchKnockRequired(result);
          return;
        }
        setQuery("");
        setSearchStatus(null);
        selectById(result.docId);
        props.onPlaylistAdded?.(result.docId);
        props.onClose();
      } catch (err) {
        setSearchStatus(
          err instanceof Error ? err.message : "could not open share link"
        );
      }
      return;
    }

    if (isNodeId(trimmed)) {
      setSearchStatus("connecting to peer...");
      try {
        await ensureSharingReady();
        const listing = await queryPeerPlaylists(trimmed);
        setPeerListing(listing);
        setSearchStatus(null);
      } catch (err) {
        setSearchStatus(
          err instanceof Error ? err.message : "could not reach peer"
        );
      }
    }
  };

  onMount(() => {
    // if a peer nodeId was provided, trigger the peer browse immediately
    if (props.initialQuery) {
      void handleSearchInput(props.initialQuery);
    }

    const visible = otherPlaylists();
    void Promise.allSettled(
      visible.map(async (p) => {
        const songs = await getSongsForPlaylist(p.id);
        setAllSongs((prev) => ({ ...prev, [p.id]: songs }));
      })
    );
  });

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
      {/* knock modal for knock-gated share links pasted into search */}
      <Show when={searchKnockRequired()}>
        <ShareLinkKnockPanel
          ownerNodeId={searchKnockRequired()!.ownerNodeId}
          docId={searchKnockRequired()!.docId}
          title={searchKnockRequired()!.title}
          ownerName={searchKnockRequired()!.ownerName}
          onAccepted={(docId) => {
            setSearchKnockRequired(null);
            selectById(docId);
            props.onPlaylistAdded?.(docId);
            props.onClose();
          }}
          onDismiss={() => setSearchKnockRequired(null)}
        />
      </Show>
      {/* always-visible search input */}
      <div class="px-3 pt-2 pb-1 flex-shrink-0">
        <input
          data-testid="input-search-playlists"
          type="text"
          value={query()}
          placeholder="search, paste share link, or node id..."
          onInput={(e) => void handleSearchInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              setPeerListing(null);
              setSearchStatus(null);
            }
          }}
          class="w-full bg-black/60 text-white px-3 py-2 text-xs border border-white/10 hover:border-white/30 focus:border-magenta-500 focus:outline-none placeholder-gray-600 transition-colors"
        />
        <Show when={searchStatus()}>
          <div class="mt-1 text-xs text-magenta-400 px-1">
            <span class="bg-black/80 px-1">{searchStatus()}</span>
          </div>
        </Show>
        <Show when={peerListing()?.knockRequired}>
          <div class="mt-2 px-3 space-y-1.5">
            <p class="text-xs text-yellow-500 bg-black/80 px-1">
              this peer requires a knock to view their playlistz
            </p>
            <textarea
              data-testid="input-knock-message"
              value={knockMessage()}
              onInput={(e) => setKnockMessage(e.currentTarget.value)}
              placeholder="say who you are and why you're knocking..."
              rows={2}
              class="w-full bg-black/60 text-white px-2 py-1.5 text-xs border border-white/10 focus:border-magenta-500 focus:outline-none placeholder-gray-600 resize-none"
            />
            <button
              data-testid="btn-send-knock"
              onClick={async () => {
                const nodeId = query().trim();
                if (!nodeId || isKnocking()) return;
                setIsKnocking(true);
                setKnockStatus(null);
                try {
                  await ensureSharingReady();
                  await knockOnPeer(nodeId, knockMessage() || undefined);
                  setKnockStatus("knock sent - waiting for owner to accept");
                } catch (err) {
                  setKnockStatus(
                    err instanceof Error ? err.message : "knock failed"
                  );
                } finally {
                  setIsKnocking(false);
                }
              }}
              disabled={isKnocking()}
              class="w-full px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-xs transition-colors border border-white/10"
            >
              {isKnocking() ? "knocking..." : "send knock"}
            </button>
            <Show when={knockStatus()}>
              <p class="text-xs text-magenta-400 bg-black/80 px-1">
                {knockStatus()}
              </p>
            </Show>
          </div>
        </Show>
      </div>

      <div class="flex-1 overflow-y-auto">
        {/* peer browse mode: show remote playlists */}
        <Show
          when={peerListing()}
          fallback={
            <>
              <Show when={otherPlaylists().length > 0}>
                <For each={otherPlaylists()}>
                  {(p) => (
                    <PlaylistRow
                      playlist={p}
                      songs={allSongs()[p.id]}
                      onSelect={handleSelect}
                      onPlay={handlePlay}
                      onEdit={props.onEdit}
                      onShare={props.onShare}
                      onBrowsePeer={(nodeId) => {
                        setQuery(nodeId);
                        void handleSearchInput(nodeId);
                      }}
                    />
                  )}
                </For>
              </Show>
            </>
          }
        >
          {(listing) => (
            <Show
              when={listing().items.length > 0}
              fallback={
                <div class="px-4 py-3 text-xs text-gray-500">
                  <span class="bg-black/80 px-1">
                    no playlistz shared by this peer
                  </span>
                </div>
              }
            >
              <div class="px-3 pt-1 pb-0.5 text-xs text-gray-500">
                <span class="bg-black/80 px-1">
                  {listing().name
                    ? `${listing().name}'s playlistz`
                    : "peer's playlistz"}
                </span>
              </div>
              <For each={listing().items}>
                {(item) => (
                  <PeerPlaylistRow
                    item={item}
                    nodeId={listing().nodeId}
                    onAdd={async (docId) => {
                      selectById(docId);
                      props.onPlaylistAdded?.(docId);
                      props.onClose();
                    }}
                    onError={(msg) => setSearchStatus(msg)}
                  />
                )}
              </For>
            </Show>
          )}
        </Show>

        {/* sticky new-playlist row */}
        <div class="sticky bottom-0">
          <button
            data-testid="btn-new-playlist"
            onClick={handleCreate}
            disabled={isCreating()}
            class="w-full flex items-center gap-3 px-4 py-3 text-gray-500 hover:text-white hover:bg-magenta-500/75 disabled:opacity-50 transition-colors border-t border-white/10 bg-black/40 text-sm"
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
            <span class="px-1 py-0.5 bg-black text-white">
              {isCreating() ? "creating..." : "new playlist"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function PeerPlaylistRow(props: {
  item: PeerPlaylistListing["items"][number];
  nodeId: string;
  onAdd: (docId: string) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [adding, setAdding] = createSignal(false);

  const handleAdd = async () => {
    if (adding()) return;
    setAdding(true);
    try {
      const token = btoa(
        JSON.stringify({
          v: 1,
          n: props.nodeId,
          d: props.item.docId,
          t: props.item.title,
        })
      )
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
      const result = await openShareLink(`#share/${token}`);
      if (result.status === "synced") await props.onAdd(result.docId);
    } catch (err) {
      props.onError(
        err instanceof Error ? err.message : "failed to add playlist"
      );
    } finally {
      setAdding(false);
    }
  };

  return (
    <div class="group flex items-center gap-3 px-4 py-3 hover:bg-magenta-500/75 transition-colors">
      {/* placeholder thumbnail */}
      <div class="flex-shrink-0 w-10 h-10 bg-black/40 flex items-center justify-center">
        <svg width="20" height="20" viewBox="0 0 100 100" fill="none">
          <path d="M50 81L25 31L75 31L60.7222 68.1429L50 81Z" fill="#FF00FF" />
        </svg>
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-white truncate">
          <span class="bg-black px-1">{props.item.title}</span>
        </div>
        <div class="text-xs text-gray-500 mt-0.5">
          <span class="bg-black px-1">
            {props.item.songCount === 1
              ? "1 song"
              : `${props.item.songCount} songz`}
          </span>
        </div>
      </div>
      <button
        class="flex-shrink-0 px-3 py-1 text-xs border border-magenta-500 text-magenta-400 hover:bg-magenta-500/20 disabled:opacity-50 transition-colors"
        onClick={() => void handleAdd()}
        disabled={adding()}
      >
        {adding() ? "adding..." : "add"}
      </button>
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
  // called when user clicks the sharer identity pill
  onBrowsePeer?: (nodeId: string) => void;
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
            data-testid="row-playing-indicator"
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
          <span
            data-testid="row-song-count"
            class="text-xs text-gray-500 px-1 bg-black"
          >
            {songCount()}
          </span>
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
          <Show when={props.playlist.remoteNodeId}>
            <span class="text-xs text-gray-700 bg-black px-0.5">·</span>
            <button
              data-testid="btn-browse-sharer"
              class="flex items-center gap-0.5 text-xs text-gray-500 px-1 bg-black hover:text-magenta-400 transition-colors"
              title={`browse ${props.playlist.remoteName || props.playlist.remoteNodeId?.slice(0, 16)}'s playlistz`}
              onClick={(e) => {
                e.stopPropagation();
                if (props.playlist.remoteNodeId)
                  props.onBrowsePeer?.(props.playlist.remoteNodeId);
              }}
            >
              <Show
                when={props.playlist.remoteAvatarDataUrl}
                fallback={
                  <span class="inline-flex items-center justify-center w-3 h-3 bg-magenta-700/60 text-white text-[7px] font-bold rounded-full overflow-hidden">
                    {(
                      props.playlist.remoteName ||
                      props.playlist.remoteNodeId ||
                      ""
                    )
                      .slice(0, 1)
                      .toUpperCase()}
                  </span>
                }
              >
                <img
                  src={props.playlist.remoteAvatarDataUrl}
                  alt={props.playlist.remoteName || "peer"}
                  class="w-3 h-3 rounded-full object-cover"
                />
              </Show>
              <span>
                {props.playlist.remoteName ||
                  props.playlist.remoteNodeId?.slice(0, 8)}
              </span>
            </button>
          </Show>
        </div>
      </div>

      {/* action buttons - fade in on hover, solid black bg for legibility */}
      <div
        class={`flex-shrink-0 flex items-center bg-black transition-opacity ${
          isHovered() ? "opacity-100" : "opacity-0"
        }`}
      >
        <button
          data-testid="btn-play-playlist-row"
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
          data-testid="btn-edit-playlist-row"
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
          data-testid="btn-share-playlist-row"
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
            data-testid="btn-download-zip-row"
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
