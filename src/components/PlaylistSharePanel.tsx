/* @jsxImportSource solid-js */
// inline share panel: p2p status, share link for the current playlist,
// receive a shared playlist, endpoint settings, and knock inbox.
// rendered inside the playlist view (not as a floating modal).
import {
  createSignal,
  createEffect,
  onCleanup,
  Show,
  For,
  type Accessor,
} from "solid-js";
import {
  getShareSettings,
  saveShareSettings,
  buildShareLink,
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
import {
  sharingReady,
  endpointEnabled,
  toggleEndpoint,
  hasP2pIdentity,
} from "../services/sharingState.js";
import type { KnockRecord } from "../services/indexedDBService.js";
import type { Playlist } from "../types/playlist.js";

interface PlaylistSharePanelProps {
  playlist: Accessor<Playlist>;
  playlists: Playlist[];
  onClose: () => void;
  onPlaylistAdded?: (docId: string) => void;
}

export function PlaylistSharePanel(props: PlaylistSharePanelProps) {
  const [settings, setSettings] = createSignal<ShareSettings>({
    name: "",
    mode: "knock",
  });
  const [nodeId, setNodeId] = createSignal<string>("");
  const [leader, setLeader] = createSignal(false);
  // use sharingReady() from sharingState as the source of truth for whether
  // the p2p node is running, falling back to local state for the "starting" phase
  const [starting, setStarting] = createSignal(false);
  const p2pEnabled = () => sharingReady();
  const [connSummary, setConnSummary] = createSignal({
    connected: 0,
    reconnecting: 0,
    failed: 0,
  });
  const [shareLink, setShareLink] = createSignal("");
  const [copied, setCopied] = createSignal(false);
  const [pasteValue, setPasteValue] = createSignal("");
  const [pasteStatus, setPasteStatus] = createSignal<string | null>(null);
  const [knocks, setKnocks] = createSignal<KnockRecord[]>([]);
  const [grantSelection, setGrantSelection] = createSignal<
    Record<string, Set<string>>
  >({});
  const [error, setError] = createSignal<string | null>(null);
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

  async function rebuildShareLink() {
    try {
      const result = await buildShareLink(
        props.playlist().id,
        props.playlist().title
      );
      setShareLink(result.url);
    } catch (err) {
      console.warn("[share panel] could not build share link:", err);
    }
  }

  // initialise on mount: load settings, check if p2p already enabled
  createEffect(() => {
    void (async () => {
      setSettings(await getShareSettings());
      await refreshKnocks();
      const identity = getIdentity();
      if (identity?.node_id) {
        setNodeId(identity.node_id);
        await rebuildShareLink();
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

  // rebuild share link when p2p becomes enabled or the playlist changes
  createEffect(() => {
    const enabled = p2pEnabled();
    const playlistId = props.playlist().id;
    if (enabled && playlistId) {
      void rebuildShareLink();
    }
  });

  const handleEnableP2P = async () => {
    setStarting(true);
    setError(null);
    try {
      // route through toggleEndpoint so endpointEnabled stays in sync
      await toggleEndpoint();
      const identity = getIdentity();
      if (identity?.node_id) setNodeId(identity.node_id);
      setLeader(isLeader());
      await rebuildShareLink();
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

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareLink());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable in this context
    }
  };

  const handleOpenLink = async () => {
    const input = pasteValue().trim();
    if (!input) return;
    setPasteStatus("opening...");
    setError(null);
    try {
      const docId = await openShareLink(input);
      setPasteStatus("playlist added!");
      setPasteValue("");
      props.onPlaylistAdded?.(docId);
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
    setBrowseStatus("sending knock...");
    setError(null);
    try {
      await knockOnPeer(target);
      setBrowseStatus("knock sent");
      setTimeout(() => setBrowseStatus(null), 2000);
    } catch (err) {
      setBrowseStatus(null);
      setError(err instanceof Error ? err.message : "could not knock");
    }
  };

  function toggleGrantDoc(knockId: string, docId: string) {
    setGrantSelection((prev) => {
      const updated = { ...prev };
      const set = new Set(updated[knockId] ?? []);
      if (set.has(docId)) set.delete(docId);
      else set.add(docId);
      updated[knockId] = set;
      return updated;
    });
  }

  const handleAccept = async (knock: KnockRecord) => {
    const docIds = [...(grantSelection()[knock.id] ?? [])];
    await acceptKnock(knock.id, docIds.length > 0 ? docIds : []);
    await refreshKnocks();
  };

  const handleDeny = async (knock: KnockRecord) => {
    await denyKnock(knock.id);
    await refreshKnocks();
  };

  const pendingKnocks = () => knocks().filter((k) => k.status === "pending");

  return (
    <div class="px-4 pb-6 pt-2 space-y-5 font-mono text-white">
      <Show when={error()}>
        <div class="p-2 border border-red-500 text-red-400 text-sm">
          {error()}
        </div>
      </Show>

      {/* p2p node status */}
      <div>
        <Show when={!hasP2pIdentity()}>
          <button
            onClick={() => void handleEnableP2P()}
            disabled={starting()}
            class="w-full px-4 py-3 bg-magenta-500 hover:bg-magenta-600 disabled:bg-magenta-400 text-white font-medium"
          >
            {starting() ? "starting p2p node..." : "enable p2p sharing"}
          </button>
        </Show>
        <Show when={hasP2pIdentity() && p2pEnabled()}>
          <div class="flex items-center gap-2 text-sm">
            <span
              class={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${leader() ? "bg-green-500" : "bg-yellow-500"}`}
              title={
                leader()
                  ? "this tab runs the p2p node"
                  : "another tab holds the p2p node"
              }
            />
            <span class="bg-black px-1 text-gray-300">online</span>
            <span class="bg-black px-1 text-gray-500 text-xs ml-auto">
              {connSummary().connected} connected
              <Show when={connSummary().reconnecting > 0}>
                , {connSummary().reconnecting} reconnecting
              </Show>
              <Show when={connSummary().failed > 0}>
                , {connSummary().failed} failed
              </Show>
            </span>
          </div>
        </Show>
        {/* endpoint on/off toggle - persists across page loads */}
        <div class="flex items-center justify-between mt-2">
          <span class="bg-black px-1 text-xs text-gray-500">endpoint</span>
          <button
            onClick={() => hasP2pIdentity() && void toggleEndpoint()}
            disabled={!hasP2pIdentity()}
            class={`px-3 py-1 text-xs border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
              endpointEnabled()
                ? "border-magenta-500 text-magenta-400 hover:bg-magenta-500/20"
                : "border-gray-600 text-gray-500 hover:bg-gray-800"
            }`}
            title={endpointEnabled() ? "disable endpoint" : "enable endpoint"}
          >
            {endpointEnabled() ? "on" : "off"}
          </button>
        </div>
      </div>

      {/* share link for this playlist */}
      <Show when={p2pEnabled()}>
        <div>
          <label class="block text-xs mb-1">
            <span class="bg-black px-1 text-gray-400">share this playlist</span>
          </label>
          <Show
            when={shareLink()}
            fallback={<div class="text-xs text-gray-600">building link...</div>}
          >
            <div class="flex gap-2">
              <input
                type="text"
                readOnly
                value={shareLink()}
                title="copy p2p share link"
                onFocus={(e) => e.currentTarget.select()}
                class="flex-1 bg-black text-white px-3 py-2 text-xs border border-magenta-200 focus:outline-none truncate min-w-0"
              />
              <button
                onClick={() => void handleCopyLink()}
                title="copy share link"
                class="px-4 py-2 bg-magenta-500 hover:bg-magenta-600 text-white text-sm whitespace-nowrap flex-shrink-0"
              >
                {copied() ? "copied!" : "copy"}
              </button>
            </div>
          </Show>
        </div>
      </Show>

      {/* receive a shared playlist */}
      <div>
        <label class="block text-xs mb-1">
          <span class="bg-black px-1 text-gray-400">open a share link</span>
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
          <button
            onClick={() => void handleOpenLink()}
            class="w-full px-4 py-2 bg-magenta-500 hover:bg-magenta-600 text-white text-sm"
          >
            open
          </button>
        </div>
        <Show when={pasteStatus()}>
          <div class="mt-1 text-xs text-magenta-400">{pasteStatus()}</div>
        </Show>
      </div>

      {/* endpoint settings */}
      <div class="space-y-3">
        <div>
          <label class="block text-xs mb-1">
            <span class="bg-black px-1 text-gray-400">display name</span>
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
          <label class="block text-xs mb-1">
            <span class="bg-black px-1 text-gray-400">
              who can browse my playlistz?
            </span>
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
        <Show when={nodeId()}>
          <div class="flex items-center gap-2">
            <span class="text-xs text-gray-500 flex-shrink-0">node id:</span>
            <code class="text-xs text-magenta-400 truncate">{nodeId()}</code>
          </div>
        </Show>
      </div>

      {/* browse a peer */}
      <div>
        <label class="block text-xs mb-1">
          <span class="bg-black px-1 text-gray-400">
            browse a peer's playlistz
          </span>
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
                              const docId = await openShareLink(
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
                              props.onPlaylistAdded?.(docId);
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
        <label class="block text-xs mb-1">
          <span class="bg-black px-1 text-gray-400">
            knock inbox
            <Show when={pendingKnocks().length > 0}>
              <span class="ml-2 text-magenta-400">
                ({pendingKnocks().length} pending)
              </span>
            </Show>
          </span>
        </label>
        <Show
          when={pendingKnocks().length > 0}
          fallback={<div class="text-gray-600 text-xs">no pending knockz</div>}
        >
          <For each={pendingKnocks()}>
            {(knock) => (
              <div class="border border-gray-700 p-3 mb-2 text-sm">
                <div class="mb-1">
                  <span class="text-white">{knock.name || "anonymous"}</span>
                  <span class="text-gray-500 text-xs ml-2">
                    {knock.nodeId.slice(0, 16)}...
                  </span>
                </div>
                <Show when={knock.message}>
                  <div class="text-gray-400 text-xs mb-2">
                    "{knock.message}"
                  </div>
                </Show>
                <div class="text-xs text-gray-500 mb-2">grant access to:</div>
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
  );
}
