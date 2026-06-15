// p2p sharing panel: endpoint setup, node status, share link paste,
// and the knock inbox. opened from the sidebar header.
import { createSignal, createEffect, onCleanup, Show, For } from "solid-js";
import {
  getShareSettings,
  saveShareSettings,
  ensureSharingReady,
  openShareLink,
  getInboundKnocks,
  acceptKnock,
  denyKnock,
  onKnocksChanged,
  queryPeerPlaylists,
  knockOnPeer,
  type ShareSettings,
  type PeerPlaylistListing,
} from "../services/sharingService.js";
import {
  getIdentity,
  isLeader,
  onLeadershipChange,
  onIdentityChange,
} from "../services/p2pService.js";
import { getIrohAdapter } from "../services/automergeRepo.js";
import type { KnockRecord } from "../services/indexedDBService.js";
import type { Playlist } from "../types/playlist.js";

interface SharePanelProps {
  isOpen: boolean;
  onClose: () => void;
  playlists: Playlist[];
  onPlaylistAdded?: (docId: string) => void;
}

export function SharePanel(props: SharePanelProps) {
  const [settings, setSettings] = createSignal<ShareSettings>({
    name: "",
    mode: "knock",
  });
  const [nodeId, setNodeId] = createSignal<string>("");
  const [leader, setLeader] = createSignal(false);
  const [p2pEnabled, setP2pEnabled] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  const [connSummary, setConnSummary] = createSignal({
    connected: 0,
    reconnecting: 0,
    failed: 0,
  });
  const [pasteValue, setPasteValue] = createSignal("");
  const [pasteStatus, setPasteStatus] = createSignal<string | null>(null);
  const [knocks, setKnocks] = createSignal<KnockRecord[]>([]);
  const [grantSelection, setGrantSelection] = createSignal<
    Record<string, Set<string>>
  >({});
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  // browse a remote peer
  const [browseNodeId, setBrowseNodeId] = createSignal("");
  const [browseResult, setBrowseResult] =
    createSignal<PeerPlaylistListing | null>(null);
  const [browseStatus, setBrowseStatus] = createSignal<string | null>(null);

  let unsubKnocks: (() => void) | null = null;
  let unsubLeader: (() => void) | null = null;
  let unsubIdentity: (() => void) | null = null;
  let connTimer: ReturnType<typeof setInterval> | null = null;

  async function refreshKnocks() {
    setKnocks(await getInboundKnocks());
  }

  function refreshConnSummary() {
    try {
      setConnSummary(getIrohAdapter().getConnectionSummary());
    } catch {
      // repo not constructed yet
    }
  }

  createEffect(() => {
    if (!props.isOpen) return;

    void (async () => {
      setSettings(await getShareSettings());
      await refreshKnocks();
      const identity = getIdentity();
      if (identity?.node_id) {
        setNodeId(identity.node_id);
        setP2pEnabled(true);
      }
      setLeader(isLeader());
      refreshConnSummary();
    })();

    unsubKnocks = onKnocksChanged(() => void refreshKnocks());
    unsubLeader = onLeadershipChange((l) => setLeader(l));
    unsubIdentity = onIdentityChange((identity) => {
      if (identity?.node_id) setNodeId(identity.node_id);
    });
    connTimer = setInterval(refreshConnSummary, 3000);

    onCleanup(() => {
      unsubKnocks?.();
      unsubLeader?.();
      unsubIdentity?.();
      if (connTimer) clearInterval(connTimer);
    });
  });

  const handleEnableP2P = async () => {
    setStarting(true);
    setError(null);
    try {
      await ensureSharingReady();
      setP2pEnabled(true);
      const identity = getIdentity();
      if (identity?.node_id) setNodeId(identity.node_id);
      setLeader(isLeader());
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to start p2p");
    } finally {
      setStarting(false);
    }
  };

  const handleSaveSettings = async (update: Partial<ShareSettings>) => {
    const next = { ...settings(), ...update };
    setSettings(next);
    await saveShareSettings(next);
  };

  const handleCopyNodeId = async () => {
    try {
      await navigator.clipboard.writeText(nodeId());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  const handleOpenLink = async () => {
    const input = pasteValue().trim();
    if (!input) return;
    setPasteStatus("opening...");
    setError(null);
    try {
      const result = await openShareLink(input);
      if (result.status === "knock_required") {
        setPasteStatus(
          "this playlist requires a knock - the owner has enabled 'knock first' mode"
        );
        return;
      }
      setPasteStatus("playlist added!");
      setPasteValue("");
      props.onPlaylistAdded?.(result.docId);
      setTimeout(() => setPasteStatus(null), 2000);
    } catch (err) {
      setPasteStatus(null);
      setError(
        err instanceof Error ? err.message : "could not open share link"
      );
    }
  };

  const handleBrowsePeer = async () => {
    const target = browseNodeId().trim();
    if (!target) return;
    setBrowseStatus("connecting...");
    setBrowseResult(null);
    setError(null);
    try {
      const listing = await queryPeerPlaylists(target);
      setBrowseResult(listing);
      setBrowseStatus(null);
    } catch (err) {
      setBrowseStatus(null);
      setError(err instanceof Error ? err.message : "could not reach peer");
    }
  };

  const handleKnock = async () => {
    const target = browseNodeId().trim();
    if (!target) return;
    setBrowseStatus("knocking...");
    setError(null);
    try {
      const result = await knockOnPeer(target);
      if (result.status === "accepted") {
        setBrowseStatus(`accepted! ${result.docIds.length} playlistz shared`);
        if (result.docIds.length > 0) {
          props.onPlaylistAdded?.(result.docIds[0]!);
        }
      } else if (result.status === "pending") {
        setBrowseStatus("knock sent - waiting for them to accept");
      } else {
        setBrowseStatus("knock denied");
      }
    } catch (err) {
      setBrowseStatus(null);
      setError(err instanceof Error ? err.message : "knock failed");
    }
  };

  const toggleGrantDoc = (knockId: string, docId: string) => {
    setGrantSelection((prev) => {
      const next = { ...prev };
      const set = new Set(next[knockId] ?? []);
      if (set.has(docId)) {
        set.delete(docId);
      } else {
        set.add(docId);
      }
      next[knockId] = set;
      return next;
    });
  };

  const handleAccept = async (knock: KnockRecord) => {
    const selected = grantSelection()[knock.id];
    const docIds =
      selected && selected.size > 0
        ? Array.from(selected)
        : props.playlists.map((p) => p.id);
    setError(null);
    try {
      await acceptKnock(knock.id, docIds);
      await refreshKnocks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "accept failed");
    }
  };

  const handleDeny = async (knock: KnockRecord) => {
    await denyKnock(knock.id);
    await refreshKnocks();
  };

  const pendingKnocks = () => knocks().filter((k) => k.status === "pending");

  return (
    <Show when={props.isOpen}>
      <div
        class="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
      >
        <div class="bg-black border border-magenta-500 w-full max-w-lg max-h-[85vh] overflow-y-auto p-6 font-mono text-white">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-xl font-bold">
              share<span class="text-magenta-500">z</span>
            </h2>
            <button
              onClick={props.onClose}
              title="close share panel"
              class="text-gray-400 hover:text-white"
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
          </div>

          <Show when={error()}>
            <div class="mb-4 p-2 border border-red-500 text-red-400 text-sm">
              {error()}
            </div>
          </Show>

          {/* p2p node status */}
          <div class="mb-6">
            <Show
              when={p2pEnabled()}
              fallback={
                <button
                  onClick={handleEnableP2P}
                  disabled={starting()}
                  class="w-full px-4 py-3 bg-magenta-500 hover:bg-magenta-600 disabled:bg-magenta-400 text-white font-medium"
                >
                  {starting() ? "starting p2p node..." : "enable p2p sharing"}
                </button>
              }
            >
              <div class="text-sm space-y-2">
                <div
                  class="flex items-center gap-2"
                  title={
                    leader()
                      ? "this tab runs the p2p node"
                      : "another tab holds the p2p node"
                  }
                >
                  <span
                    class={`inline-block w-2 h-2 rounded-full ${leader() ? "bg-green-500" : "bg-yellow-500"}`}
                  />
                  <span class="text-gray-300">online</span>
                </div>
                <Show when={nodeId()}>
                  <div class="flex items-center gap-2">
                    <span class="text-gray-500">node id:</span>
                    <code class="text-xs text-magenta-400 truncate flex-1">
                      {nodeId()}
                    </code>
                    <button
                      onClick={handleCopyNodeId}
                      title="copy node id"
                      class="text-gray-400 hover:text-white text-xs border border-gray-600 px-2 py-1"
                    >
                      {copied() ? "copied!" : "copy"}
                    </button>
                  </div>
                </Show>
                <div class="text-gray-500 text-xs">
                  peers: {connSummary().connected} connected
                  <Show when={connSummary().reconnecting > 0}>
                    , {connSummary().reconnecting} reconnecting
                  </Show>
                  <Show when={connSummary().failed > 0}>
                    , {connSummary().failed} failed
                  </Show>
                </div>
              </div>
            </Show>
          </div>

          {/* endpoint settings */}
          <div class="mb-6 space-y-3">
            <div>
              <label class="block text-sm text-gray-400 mb-1">
                display name
              </label>
              <input
                type="text"
                value={settings().name}
                placeholder="anonymous"
                onChange={(e) =>
                  void handleSaveSettings({ name: e.currentTarget.value })
                }
                class="w-full bg-black text-white px-3 py-2 text-sm border border-magenta-200 focus:border-magenta-500 focus:outline-none"
              />
            </div>
            <div>
              <label class="block text-sm text-gray-400 mb-1">
                who can browse my playlistz?
              </label>
              <div class="flex gap-2">
                <button
                  onClick={() => void handleSaveSettings({ mode: "public" })}
                  class={`flex-1 px-3 py-2 text-sm border ${settings().mode === "public" ? "border-magenta-500 bg-magenta-500/20 text-white" : "border-gray-600 text-gray-400"}`}
                >
                  anyone (public)
                </button>
                <button
                  onClick={() => void handleSaveSettings({ mode: "knock" })}
                  class={`flex-1 px-3 py-2 text-sm border ${settings().mode === "knock" ? "border-magenta-500 bg-magenta-500/20 text-white" : "border-gray-600 text-gray-400"}`}
                >
                  knock first
                </button>
              </div>
            </div>
          </div>

          {/* open a share link */}
          <div class="mb-6">
            <label class="block text-sm text-gray-400 mb-1">
              open a share link
            </label>
            <div class="flex flex-col gap-2">
              <input
                type="text"
                value={pasteValue()}
                placeholder="paste share link or token..."
                onInput={(e) => setPasteValue(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleOpenLink();
                }}
                class="w-full bg-black text-white px-3 py-2 text-sm border border-magenta-200 focus:border-magenta-500 focus:outline-none"
              />
              <div class="flex gap-2">
                <button
                  onClick={() => void handleOpenLink()}
                  class="flex-1 px-4 py-2 bg-magenta-500 hover:bg-magenta-600 text-white text-sm"
                >
                  open
                </button>
              </div>
            </div>
            <Show when={pasteStatus()}>
              <div class="mt-1 text-xs text-magenta-400">{pasteStatus()}</div>
            </Show>
          </div>

          {/* browse a peer */}
          <div class="mb-6">
            <label class="block text-sm text-gray-400 mb-1">
              browse a peer's playlistz
            </label>
            <div class="flex flex-col gap-2">
              <input
                type="text"
                value={browseNodeId()}
                placeholder="peer node id..."
                onInput={(e) => setBrowseNodeId(e.currentTarget.value)}
                class="w-full bg-black text-white px-3 py-2 text-sm border border-magenta-200 focus:border-magenta-500 focus:outline-none"
              />
              <div class="flex gap-2">
                <button
                  onClick={() => void handleBrowsePeer()}
                  class="flex-1 px-3 py-2 border border-magenta-500 text-magenta-400 hover:bg-magenta-500/20 text-sm"
                >
                  browse
                </button>
                <button
                  onClick={() => void handleKnock()}
                  class="flex-1 px-3 py-2 border border-gray-600 text-gray-300 hover:bg-gray-800 text-sm"
                  title="ask this peer for access"
                >
                  knock
                </button>
              </div>
            </div>
            <Show when={browseStatus()}>
              <div class="mt-1 text-xs text-magenta-400">{browseStatus()}</div>
            </Show>
            <Show when={browseResult()}>
              {(listing) => (
                <div class="mt-2 text-sm">
                  <Show
                    when={listing().items.length > 0}
                    fallback={
                      <div class="text-gray-500 text-xs">
                        {listing().knockRequired
                          ? "this peer requires a knock"
                          : "no playlistz shared"}
                      </div>
                    }
                  >
                    <For each={listing().items}>
                      {(item) => (
                        <div class="flex items-center justify-between py-1 border-b border-gray-800">
                          <span>
                            {item.title}{" "}
                            <span class="text-gray-500 text-xs">
                              ({item.songCount} songz)
                            </span>
                          </span>
                          <button
                            onClick={() =>
                              void (async () => {
                                try {
                                  const result = await openShareLink(
                                    // build a minimal token from the listing
                                    `#share/${btoa(
                                      JSON.stringify({
                                        v: 1,
                                        n: listing().nodeId,
                                        d: item.docId,
                                        t: item.title,
                                      })
                                    )
                                      .replace(/\+/g, "-")
                                      .replace(/\//g, "_")
                                      .replace(/=/g, "")}`
                                  );
                                  if (result.status === "synced") {
                                    props.onPlaylistAdded?.(result.docId);
                                  }
                                } catch (err) {
                                  setError(
                                    err instanceof Error
                                      ? err.message
                                      : "failed to add playlist"
                                  );
                                }
                              })()
                            }
                            class="text-xs text-magenta-400 hover:text-magenta-300 border border-magenta-500 px-2 py-1"
                          >
                            add
                          </button>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              )}
            </Show>
          </div>

          {/* knock inbox */}
          <div>
            <label class="block text-sm text-gray-400 mb-1">
              knock inbox
              <Show when={pendingKnocks().length > 0}>
                <span class="ml-2 text-magenta-400">
                  ({pendingKnocks().length} pending)
                </span>
              </Show>
            </label>
            <Show
              when={pendingKnocks().length > 0}
              fallback={
                <div class="text-gray-600 text-xs">no pending knockz</div>
              }
            >
              <For each={pendingKnocks()}>
                {(knock) => (
                  <div class="border border-gray-700 p-3 mb-2 text-sm">
                    <div class="mb-1">
                      <span class="text-white">
                        {knock.name || "anonymous"}
                      </span>
                      <span class="text-gray-500 text-xs ml-2">
                        {knock.nodeId.slice(0, 16)}...
                      </span>
                    </div>
                    <Show when={knock.message}>
                      <div class="text-gray-400 text-xs mb-2">
                        "{knock.message}"
                      </div>
                    </Show>
                    <div class="text-xs text-gray-500 mb-2">
                      grant access to:
                    </div>
                    <div class="max-h-24 overflow-y-auto mb-2">
                      <For each={props.playlists}>
                        {(pl) => (
                          <label class="flex items-center gap-2 text-xs text-gray-300 py-0.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={
                                grantSelection()[knock.id]?.has(pl.id) ?? false
                              }
                              onChange={() => toggleGrantDoc(knock.id, pl.id)}
                            />
                            {pl.title}
                          </label>
                        )}
                      </For>
                    </div>
                    <div class="flex gap-2">
                      <button
                        onClick={() => void handleAccept(knock)}
                        class="flex-1 px-3 py-1 bg-magenta-500 hover:bg-magenta-600 text-white text-xs"
                        title={
                          (grantSelection()[knock.id]?.size ?? 0) > 0
                            ? "grant selected playlistz"
                            : "grant all playlistz"
                        }
                      >
                        accept
                        {(grantSelection()[knock.id]?.size ?? 0) > 0
                          ? ` (${grantSelection()[knock.id]!.size})`
                          : " (all)"}
                      </button>
                      <button
                        onClick={() => void handleDeny(knock)}
                        class="flex-1 px-3 py-1 border border-gray-600 text-gray-300 hover:bg-gray-800 text-xs"
                      >
                        deny
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
