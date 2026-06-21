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
  getInboundKnocks,
  getOutboundKnocks,
  acceptKnock,
  denyKnock,
  knockOnPeer,
  knockForDocAccess,
  onKnocksChanged,
  type ShareSettings,
} from "../services/sharingService.js";
import { findPlaylistDoc, flushDoc } from "../services/automergeRepo.js";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import {
  getIdentity,
  isLeader,
  onLeadershipChange,
  onIdentityChange,
} from "../services/p2pService.js";
import { getIrohAdapter } from "../services/automergeRepo.js";
import {
  sharingReady,
  toggleEndpoint,
  hasP2pIdentity,
  endpointEnabled,
  connectedPeerCount,
} from "../services/sharingState.js";
import type {
  KnockRecord,
  AccessGrantRecord,
} from "../services/indexedDBService.js";
import {
  getAllAccessGrants,
  upsertAccessGrant,
  deleteAccessGrant,
} from "../services/docIndexService.js";
import type { Playlist } from "../types/playlist.js";
import { log } from "../utils/log.js";

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
  const [knocks, setKnocks] = createSignal<KnockRecord[]>([]);
  const [outboundKnocks, setOutboundKnocks] = createSignal<KnockRecord[]>([]);
  const [acceptingKnockId, setAcceptingKnockId] = createSignal<string | null>(
    null
  );
  const [grants, setGrants] = createSignal<AccessGrantRecord[]>([]);
  const [grantSelection, setGrantSelection] = createSignal<
    Record<string, Set<string>>
  >({});
  const [retryingKnockId, setRetryingKnockId] = createSignal<string | null>(
    null
  );
  const [retryStatusMap, setRetryStatusMap] = createSignal<
    Record<string, string>
  >({});
  const [editingGrantId, setEditingGrantId] = createSignal<string | null>(null);
  const [grantEditSelection, setGrantEditSelection] = createSignal<
    Record<string, Set<string>>
  >({});
  const [error, setError] = createSignal<string | null>(null);
  const [editingName, setEditingName] = createSignal(false);
  // per-playlist collaborative editing flag (stored in the automerge doc)
  const [collaborative, setCollaborative] = createSignal(false);
  // whether this playlist is subscribed from a remote peer (not our own / not forked)
  const isSubscribed = () =>
    !!props.playlist().remoteNodeId && !props.playlist().isForked;
  // collab access request state (only relevant when isSubscribed())
  const [collabRequestMessage, setCollabRequestMessage] = createSignal("");
  const [collabRequestStatus, setCollabRequestStatus] = createSignal<
    string | null
  >(null);
  const [requestingCollab, setRequestingCollab] = createSignal(false);

  // reactive flag for per-peer online status in the granted peers list.
  // we mirror connSummary() changes by re-reading the adapter each time.
  const isPeerOnline = (nodeId: string): boolean => {
    // reading connSummary() creates a reactive dependency so this updates
    // whenever connection state changes
    void connSummary();
    try {
      return getIrohAdapter().isConnected(nodeId);
    } catch {
      return false;
    }
  };
  let avatarFileInput!: HTMLInputElement;

  let unsubKnocks: (() => void) | null = null;
  let unsubLeader: (() => void) | null = null;
  let unsubIdentity: (() => void) | null = null;
  let connTimer: ReturnType<typeof setInterval> | null = null;

  // avatar: hash name to a color for the fallback initial circle
  const AVATAR_COLORS = [
    "#e91e8c",
    "#7c3aed",
    "#0ea5e9",
    "#10b981",
    "#f59e0b",
    "#ef4444",
  ];
  const avatarColor = (name: string) => {
    const sum = name.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return AVATAR_COLORS[sum % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
  };

  const handleAvatarUpload = (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        void handleSaveSettings({ avatarDataUrl: reader.result });
      }
    };
    reader.readAsDataURL(file);
  };

  async function refreshKnocks() {
    const loaded = await getInboundKnocks();
    setKnocks(loaded);
    setOutboundKnocks(await getOutboundKnocks());
    setGrants(await getAllAccessGrants());
    // pre-select the requested doc for doc_access knocks that have no selection yet
    setGrantSelection((prev) => {
      const updated = { ...prev };
      for (const knock of loaded) {
        if (
          knock.status === "pending" &&
          knock.knockType === "doc_access" &&
          knock.requestedDocId &&
          !updated[knock.id]
        ) {
          updated[knock.id] = new Set([knock.requestedDocId]);
        }
      }
      return updated;
    });
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
      log.warn("share.panel", "could not build share link:", err);
    }
  }

  // initialise on mount: load settings, check if p2p already enabled
  createEffect(() => {
    void (async () => {
      const globalSettings = await getShareSettings();
      // override mode from the playlist's own doc if it has one
      try {
        const handle = await findPlaylistDoc(
          props.playlist().id as AutomergeUrl
        );
        const raw = handle.doc() as Record<string, unknown> | undefined;
        const docMode = raw?.sharingMode as string | undefined;
        if (docMode === "public" || docMode === "knock") {
          globalSettings.mode = docMode;
        }
        setCollaborative(!!raw?.collaborative);
      } catch {
        /* doc not yet loaded - use global default */
      }
      setSettings(globalSettings);
      await refreshKnocks();
      const identity = getIdentity();
      if (identity?.node_id) {
        await rebuildShareLink();
      }
      setLeader(isLeader());
      refreshConnSummary();
    })();

    unsubKnocks = onKnocksChanged(() => void refreshKnocks());
    unsubLeader = onLeadershipChange((l) => setLeader(l));
    unsubIdentity = onIdentityChange((identity) => {
      if (identity?.node_id) void rebuildShareLink();
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
      await toggleEndpoint();
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
    // also write sharingMode to the playlist's automerge doc when it changes
    if (update.mode !== undefined) {
      try {
        const handle = await findPlaylistDoc(
          props.playlist().id as AutomergeUrl
        );
        handle.change((d: Record<string, unknown>) => {
          d.sharingMode = update.mode;
        });
        await flushDoc(props.playlist().id as AutomergeUrl);
      } catch (err) {
        log.warn("share.panel", "failed to write sharingMode to doc:", err);
      }
    }
  };

  const handleToggleCollaborative = async () => {
    const next = !collaborative();
    setCollaborative(next);
    try {
      const handle = await findPlaylistDoc(props.playlist().id as AutomergeUrl);
      handle.change((d: Record<string, unknown>) => {
        d.collaborative = next;
      });
      await flushDoc(props.playlist().id as AutomergeUrl);
    } catch (err) {
      log.warn("share.panel", "failed to write collaborative to doc:", err);
      setCollaborative(!next); // revert on failure
    }
  };

  const handleRequestCollabAccess = async () => {
    if (requestingCollab()) return;
    const ownerNodeId = props.playlist().remoteNodeId;
    if (!ownerNodeId) return;
    setRequestingCollab(true);
    setCollabRequestStatus(null);
    try {
      const result = await knockForDocAccess(
        ownerNodeId,
        props.playlist().id,
        collabRequestMessage(),
        props.playlist().title
      );
      if (result.status === "accepted") {
        setCollabRequestStatus("access granted - you can now collaborate");
      } else if (result.status === "denied") {
        setCollabRequestStatus("access denied");
      } else {
        setCollabRequestStatus("request sent - waiting for owner approval");
      }
    } catch (err) {
      setCollabRequestStatus(
        err instanceof Error ? err.message : "request failed"
      );
    } finally {
      setRequestingCollab(false);
      await refreshKnocks();
    }
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

  function selectAllGrantDocs(knockId: string) {
    setGrantSelection((prev) => ({
      ...prev,
      [knockId]: new Set(props.playlists.map((p) => p.id)),
    }));
  }

  function clearAllGrantDocs(knockId: string) {
    setGrantSelection((prev) => ({ ...prev, [knockId]: new Set() }));
  }

  const handleAccept = async (knock: KnockRecord) => {
    if (acceptingKnockId()) return;
    setAcceptingKnockId(knock.id);
    let docIds = [...(grantSelection()[knock.id] ?? [])];
    // for doc_access knocks, always ensure the requested doc is included
    if (
      knock.knockType === "doc_access" &&
      knock.requestedDocId &&
      !docIds.includes(knock.requestedDocId)
    ) {
      docIds = [knock.requestedDocId, ...docIds];
    }
    try {
      await acceptKnock(knock.id, docIds.length > 0 ? docIds : []);
    } finally {
      setAcceptingKnockId(null);
    }
    await refreshKnocks();
  };

  const handleDeny = async (knock: KnockRecord) => {
    await denyKnock(knock.id);
    await refreshKnocks();
  };

  const pendingKnocks = () => knocks().filter((k) => k.status === "pending");

  return (
    <div
      data-testid="share-panel"
      class="px-4 pb-6 pt-2 space-y-5 font-mono text-white overflow-x-hidden min-w-0"
    >
      <Show when={error()}>
        <div
          data-testid="share-link-error"
          class="p-2 border border-red-500 text-red-400 text-sm"
        >
          <span class="bg-black/80 px-1">{error()}</span>
        </div>
      </Show>
      <div>
        <Show when={!hasP2pIdentity()}>
          <button
            data-testid="btn-enable-sharing"
            onClick={() => void handleEnableP2P()}
            disabled={starting()}
            class="w-full px-4 py-3 bg-magenta-500 hover:bg-magenta-600 disabled:bg-magenta-400 text-white font-medium"
          >
            {starting() ? "starting p2p node..." : "enable p2p sharing"}
          </button>
        </Show>
        {/* display name + avatar - only shown once p2p identity exists */}
        <Show when={hasP2pIdentity()}>
          <div class="flex items-center gap-2 mt-2">
            {/* avatar with inline status dot at bottom-right */}
            <div class="relative flex-shrink-0 w-8 h-8">
              <button
                type="button"
                class="w-8 h-8 rounded-full overflow-hidden border border-gray-700 hover:border-magenta-500 transition-colors focus:outline-none"
                title={(() => {
                  if (!p2pEnabled()) return "click to change avatar";
                  const s = connSummary();
                  const parts: string[] = [
                    leader()
                      ? "this tab runs the p2p node"
                      : "another tab holds the p2p node",
                  ];
                  if (s.connected > 0) parts.push(`${s.connected} connected`);
                  if (s.reconnecting > 0)
                    parts.push(`${s.reconnecting} reconnecting`);
                  if (s.failed > 0) parts.push(`${s.failed} failed`);
                  return parts.join(" · ");
                })()}
                onClick={() => avatarFileInput.click()}
              >
                <Show
                  when={settings().avatarDataUrl}
                  fallback={
                    <div
                      class="w-full h-full flex items-center justify-center text-white text-sm font-bold"
                      style={{
                        "background-color": avatarColor(settings().name || "?"),
                      }}
                    >
                      {(settings().name?.[0] ?? "?").toUpperCase()}
                    </div>
                  }
                >
                  <img
                    src={settings().avatarDataUrl}
                    alt="avatar"
                    class="w-full h-full object-cover"
                  />
                </Show>
              </button>
              {/* status dot: green=online, yellow=connecting/reconnecting, red=failed, gray=offline */}
              <Show when={hasP2pIdentity()}>
                <span
                  data-testid="sharing-status"
                  class={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-black ${
                    !p2pEnabled()
                      ? "bg-gray-600"
                      : connSummary().failed > 0 &&
                          connSummary().connected === 0
                        ? "bg-red-500"
                        : connSummary().reconnecting > 0
                          ? "bg-yellow-400"
                          : "bg-green-500"
                  }`}
                />
              </Show>
            </div>
            <input
              ref={avatarFileInput}
              type="file"
              accept="image/*"
              class="hidden"
              onChange={handleAvatarUpload}
            />

            {/* name pill / inline edit */}
            <div class="flex-1 min-w-0">
              <Show
                when={editingName()}
                fallback={
                  <button
                    type="button"
                    class="px-2 py-0.5 text-sm bg-black border border-gray-700 hover:border-magenta-500 text-white truncate max-w-[180px] transition-colors"
                    onClick={() => setEditingName(true)}
                    title="click to edit display name"
                  >
                    {settings().name || (
                      <span class="text-gray-500">anonymous</span>
                    )}
                  </button>
                }
              >
                <div class="flex items-center gap-1 flex-1 min-w-0">
                  <input
                    data-testid="input-node-name"
                    type="text"
                    value={settings().name}
                    placeholder="anonymous"
                    autofocus
                    onInput={(e) =>
                      void handleSaveSettings({ name: e.currentTarget.value })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === "Escape")
                        setEditingName(false);
                    }}
                    class="flex-1 min-w-0 bg-black text-white px-2 py-0.5 text-sm border border-magenta-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    class="flex-shrink-0 text-gray-400 hover:text-white px-1"
                    onClick={() => setEditingName(false)}
                    aria-label="close name editor"
                  >
                    &#x2715;
                  </button>
                </div>
              </Show>
              {/* connected peer count + endpoint on/off toggle */}
              <div class="flex items-center gap-2 mt-1">
                <Show when={endpointEnabled() && connectedPeerCount() > 0}>
                  <span
                    data-testid="connected-peer-count"
                    class="text-xs text-green-400 bg-black/80 px-1"
                  >
                    {connectedPeerCount()} connected
                  </span>
                </Show>
                <button
                  data-testid="btn-toggle-endpoint"
                  type="button"
                  aria-pressed={endpointEnabled()}
                  onClick={() => void handleEnableP2P()}
                  disabled={starting()}
                  class={`text-xs px-2 py-0.5 border transition-colors disabled:opacity-50 ${
                    endpointEnabled()
                      ? "border-gray-600 text-gray-400 hover:text-red-400 hover:border-red-500"
                      : "border-magenta-500 text-magenta-400 hover:text-white hover:border-magenta-400"
                  }`}
                  title={endpointEnabled() ? "turn off p2p" : "turn on p2p"}
                >
                  {starting() ? "..." : endpointEnabled() ? "on" : "off"}
                </button>
              </div>
            </div>
          </div>
        </Show>
      </div>

      {/* request collaboration access - shown when viewing a subscribed playlist */}
      <Show when={isSubscribed() && p2pEnabled()}>
        <div>
          <label class="block text-xs mb-1">
            <span class="bg-black px-1 text-gray-400">
              request collaboration access
            </span>
          </label>
          <div class="space-y-2">
            <input
              data-testid="input-collab-request-message"
              type="text"
              placeholder="optional message to the owner"
              value={collabRequestMessage()}
              onInput={(e) => setCollabRequestMessage(e.currentTarget.value)}
              class="w-full bg-black text-white px-2 py-1.5 text-xs border border-gray-700 hover:border-gray-500 focus:border-magenta-500 focus:outline-none transition-colors"
            />
            <button
              data-testid="btn-request-collab-access"
              onClick={() => void handleRequestCollabAccess()}
              disabled={requestingCollab()}
              class="w-full px-3 py-2 text-sm border border-gray-600 hover:border-magenta-500 text-gray-300 hover:text-white disabled:opacity-50 transition-colors"
            >
              {requestingCollab()
                ? "sending request..."
                : "request edit access"}
            </button>
            <Show when={collabRequestStatus()}>
              <p
                data-testid="collab-request-status"
                class="text-xs px-1 text-magenta-400"
              >
                {collabRequestStatus()}
              </p>
            </Show>
          </div>
        </div>
      </Show>

      {/* share link for this playlist */}
      <Show when={p2pEnabled()}>
        <div>
          <label class="block text-xs mb-1">
            <span class="bg-black px-1 text-gray-400">share this playlist</span>
          </label>
          <Show
            when={shareLink()}
            fallback={
              <div class="text-xs text-gray-600">
                <span class="bg-black/80 px-1">building link...</span>
              </div>
            }
          >
            <div class="flex gap-2">
              <input
                data-testid="input-share-link"
                type="text"
                readOnly
                value={shareLink()}
                title="copy p2p share link"
                onFocus={(e) => e.currentTarget.select()}
                class="flex-1 bg-black text-white px-3 py-2 text-xs border border-magenta-200 hover:border-magenta-400 focus:outline-none truncate min-w-0 transition-colors"
              />
              <button
                data-testid="btn-copy-share-link"
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

      {/* receive a shared playlist - moved to all-playlists search bar */}

      {/* endpoint settings: sharing mode and collaborative toggle.
           shown as soon as the endpoint is enabled so the user can configure
           mode while the node is still starting up */}
      <Show when={endpointEnabled()}>
        <div class="space-y-3">
          <div>
            <label class="block text-xs mb-1">
              <span class="bg-black px-1 text-gray-400">
                who can browse this playlist?
              </span>
            </label>
            <div class="flex gap-2">
              <button
                data-testid="btn-mode-public"
                aria-pressed={settings().mode === "public"}
                onClick={() => void handleSaveSettings({ mode: "public" })}
                class={`flex-1 px-3 py-2 text-sm border transition-colors ${settings().mode === "public" ? "border-magenta-500 bg-magenta-500/20 text-white" : "border-gray-600 text-gray-400 hover:border-magenta-500 hover:text-gray-200 hover:bg-white/5"}`}
              >
                anyone (public)
              </button>
              <button
                data-testid="btn-mode-knock"
                aria-pressed={settings().mode === "knock"}
                onClick={() => void handleSaveSettings({ mode: "knock" })}
                class={`flex-1 px-3 py-2 text-sm border transition-colors ${settings().mode === "knock" ? "border-magenta-500 bg-magenta-500/20 text-white" : "border-gray-600 text-gray-400 hover:border-magenta-500 hover:text-gray-200 hover:bg-white/5"}`}
              >
                knock first
              </button>
            </div>
            <div class="mt-2">
              <button
                data-testid="btn-toggle-collaborative"
                type="button"
                aria-pressed={collaborative()}
                onClick={() => void handleToggleCollaborative()}
                class={`w-full px-3 py-2 text-sm border transition-colors ${
                  collaborative()
                    ? "border-magenta-500 bg-magenta-500/20 text-white"
                    : "border-gray-600 text-gray-400 hover:border-magenta-500 hover:text-gray-200 hover:bg-white/5"
                }`}
                title="when on, peers with access can edit without a separate approval"
              >
                collaborative editing {collaborative() ? "(on)" : "(off)"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* knock inbox - only shown when there are pending knocks */}
      <Show when={pendingKnocks().length > 0}>
        <div>
          <label data-testid="knock-inbox" class="block text-xs mb-1">
            <span class="bg-black px-1 text-gray-400">
              knock inbox
              <span class="ml-2 text-magenta-400">
                ({pendingKnocks().length} pending)
              </span>
            </span>
          </label>
          <For each={pendingKnocks()}>
            {(knock) => (
              <div class="border border-gray-700 p-3 mb-2 text-sm">
                <div class="mb-1">
                  <span class="text-white bg-black/80 px-1">
                    {knock.name || "anonymous"}
                  </span>
                  <span class="text-gray-500 text-xs ml-2 bg-black/80 px-1">
                    {knock.nodeId.slice(0, 16)}...
                  </span>
                  <span class="text-xs ml-2 bg-black/80 px-1 text-magenta-400">
                    {knock.knockType === "doc_access"
                      ? "wants playlist access"
                      : "wants to browse"}
                  </span>
                </div>
                <Show when={knock.message}>
                  <div class="text-gray-400 text-xs mb-2">
                    <span class="bg-black/80 px-1">"{knock.message}"</span>
                  </div>
                </Show>
                <div class="flex items-center justify-between text-xs text-gray-500 mb-1">
                  <span class="bg-black/80 px-1">grant access to:</span>
                  <div class="flex gap-2">
                    <button
                      type="button"
                      class="text-magenta-400 hover:text-magenta-300"
                      onClick={() => selectAllGrantDocs(knock.id)}
                    >
                      all
                    </button>
                    <button
                      type="button"
                      class="text-gray-500 hover:text-gray-300"
                      onClick={() => clearAllGrantDocs(knock.id)}
                    >
                      none
                    </button>
                  </div>
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
                        <span class="bg-black/80 px-1">{pl.title}</span>
                      </label>
                    )}
                  </For>
                </div>
                <div class="flex gap-2">
                  <button
                    onClick={() => void handleAccept(knock)}
                    disabled={acceptingKnockId() === knock.id}
                    class="flex-1 px-3 py-1 bg-magenta-500 hover:bg-magenta-600 disabled:bg-magenta-400 text-white text-xs"
                    title={
                      (grantSelection()[knock.id]?.size ?? 0) > 0
                        ? "grant selected playlistz"
                        : "grant all playlistz"
                    }
                  >
                    {acceptingKnockId() === knock.id
                      ? "accepting..."
                      : `accept${(grantSelection()[knock.id]?.size ?? 0) > 0 ? ` (${grantSelection()[knock.id]!.size})` : " (all)"}`}
                  </button>
                  <button
                    onClick={() => void handleDeny(knock)}
                    disabled={!!acceptingKnockId()}
                    class="flex-1 px-3 py-1 border border-gray-600 text-gray-300 hover:border-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-50 text-xs transition-colors"
                  >
                    deny
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* outbound pending knocks - playlists we've requested access to */}
      <Show when={outboundKnocks().some((k) => k.status === "pending")}>
        <div>
          <label class="block text-xs mb-1">
            <span class="bg-black px-1 text-gray-400">
              waiting for access
              <span class="ml-2 text-yellow-400">
                ({outboundKnocks().filter((k) => k.status === "pending").length}{" "}
                pending)
              </span>
            </span>
          </label>
          <For each={outboundKnocks().filter((k) => k.status === "pending")}>
            {(knock) => {
              const handleRetry = async () => {
                if (retryingKnockId()) return;
                setRetryingKnockId(knock.id);
                setRetryStatusMap((m) => ({ ...m, [knock.id]: "" }));
                try {
                  let result: { status: string };
                  if (
                    knock.knockType === "doc_access" &&
                    knock.requestedDocId
                  ) {
                    result = await knockForDocAccess(
                      knock.nodeId,
                      knock.requestedDocId,
                      knock.message
                    );
                  } else {
                    result = await knockOnPeer(
                      knock.nodeId,
                      knock.message || undefined
                    );
                  }
                  if (result.status === "accepted") {
                    setRetryStatusMap((m) => ({
                      ...m,
                      [knock.id]: "access granted!",
                    }));
                    await refreshKnocks();
                    if (knock.requestedDocId)
                      props.onPlaylistAdded?.(knock.requestedDocId);
                  } else if (result.status === "denied") {
                    setRetryStatusMap((m) => ({
                      ...m,
                      [knock.id]: "access denied",
                    }));
                    await refreshKnocks();
                  } else {
                    setRetryStatusMap((m) => ({
                      ...m,
                      [knock.id]: "still pending",
                    }));
                  }
                } catch (err) {
                  setRetryStatusMap((m) => ({
                    ...m,
                    [knock.id]:
                      err instanceof Error ? err.message : "retry failed",
                  }));
                } finally {
                  setRetryingKnockId(null);
                }
              };
              return (
                <div class="border border-gray-700 border-dashed p-3 mb-2 text-sm">
                  <div class="mb-1">
                    <span class="text-gray-300 bg-black/80 px-1 text-xs">
                      {knock.nodeId.slice(0, 20)}...
                    </span>
                    <span class="text-xs ml-2 text-yellow-400">waiting</span>
                  </div>
                  <Show when={retryStatusMap()[knock.id]}>
                    <p class="text-xs text-magenta-400 mb-1 bg-black/80 px-1">
                      {retryStatusMap()[knock.id]}
                    </p>
                  </Show>
                  <button
                    onClick={() => void handleRetry()}
                    disabled={retryingKnockId() === knock.id}
                    class="w-full px-3 py-1 border border-gray-600 hover:border-gray-400 text-gray-300 hover:text-white hover:bg-white/5 disabled:opacity-50 text-xs transition-colors"
                  >
                    {retryingKnockId() === knock.id
                      ? "checking..."
                      : "check if accepted"}
                  </button>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      {/* granted peers - existing access grants with edit/revoke */}
      <Show when={grants().length > 0}>
        <div>
          <label class="block text-xs mb-1">
            <span class="bg-black px-1 text-gray-400">
              granted peers ({grants().length})
            </span>
          </label>
          <For each={grants()}>
            {(grant) => {
              const isEditing = () => editingGrantId() === grant.nodeId;
              const currentSelection = () =>
                grantEditSelection()[grant.nodeId] ??
                new Set(grant.docIds ?? props.playlists.map((p) => p.id));
              const startEdit = () => {
                setGrantEditSelection((s) => ({
                  ...s,
                  [grant.nodeId]: new Set(
                    grant.docIds ?? props.playlists.map((p) => p.id)
                  ),
                }));
                setEditingGrantId(grant.nodeId);
              };
              const handleSaveGrant = async () => {
                await upsertAccessGrant({
                  ...grant,
                  docIds: [...currentSelection()],
                });
                setEditingGrantId(null);
                setGrants(await getAllAccessGrants());
              };
              const handleRevokeGrant = async () => {
                await deleteAccessGrant(grant.nodeId);
                setGrants(await getAllAccessGrants());
              };
              return (
                <div class="border border-gray-700 p-3 mb-2 text-xs">
                  <div class="flex items-center justify-between mb-1">
                    <div class="flex items-center gap-2">
                      {/* avatar circle with online indicator dot */}
                      <div class="relative w-7 h-7 shrink-0">
                        <div class="w-7 h-7 rounded-full overflow-hidden bg-gray-700 flex items-center justify-center text-xs font-bold text-white">
                          <Show
                            when={grant.avatarDataUrl}
                            fallback={
                              <span>
                                {(grant.name || "?")[0]?.toUpperCase()}
                              </span>
                            }
                          >
                            <img
                              src={grant.avatarDataUrl}
                              alt={grant.name}
                              class="w-full h-full object-cover"
                            />
                          </Show>
                        </div>
                        {/* online status dot */}
                        <span
                          class={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-gray-900 ${isPeerOnline(grant.nodeId) ? "bg-green-400" : "bg-gray-500"}`}
                          title={
                            isPeerOnline(grant.nodeId) ? "online" : "offline"
                          }
                        />
                      </div>
                      <div>
                        <span class="text-gray-200 bg-black/80 px-1">
                          {grant.name || "anonymous"}
                        </span>
                        <span class="text-gray-600 ml-2">
                          {grant.nodeId.slice(0, 12)}...
                        </span>
                      </div>
                    </div>
                    <div class="flex gap-2">
                      <button
                        type="button"
                        class="text-gray-400 hover:text-white"
                        onClick={() =>
                          isEditing() ? setEditingGrantId(null) : startEdit()
                        }
                      >
                        {isEditing() ? "close" : "edit"}
                      </button>
                      <button
                        type="button"
                        class="text-red-500 hover:text-red-400"
                        onClick={() => void handleRevokeGrant()}
                      >
                        revoke
                      </button>
                    </div>
                  </div>
                  <Show when={isEditing()}>
                    <div class="mt-2 space-y-1">
                      <div class="flex items-center justify-between text-gray-500 mb-1">
                        <span>access to:</span>
                        <button
                          type="button"
                          class="text-magenta-400 hover:text-magenta-300"
                          onClick={() =>
                            setGrantEditSelection((s) => ({
                              ...s,
                              [grant.nodeId]: new Set(
                                props.playlists.map((p) => p.id)
                              ),
                            }))
                          }
                        >
                          select all
                        </button>
                      </div>
                      <div class="max-h-24 overflow-y-auto">
                        <For each={props.playlists}>
                          {(pl) => (
                            <label class="flex items-center gap-2 text-gray-300 py-0.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={currentSelection().has(pl.id)}
                                onChange={() =>
                                  setGrantEditSelection((s) => {
                                    const next = new Set(
                                      s[grant.nodeId] ?? currentSelection()
                                    );
                                    if (next.has(pl.id)) next.delete(pl.id);
                                    else next.add(pl.id);
                                    return { ...s, [grant.nodeId]: next };
                                  })
                                }
                              />
                              <span class="bg-black/80 px-1">{pl.title}</span>
                            </label>
                          )}
                        </For>
                      </div>
                      <button
                        class="w-full mt-1 px-3 py-1 bg-magenta-500 hover:bg-magenta-600 text-white text-xs"
                        onClick={() => void handleSaveGrant()}
                      >
                        save
                      </button>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
