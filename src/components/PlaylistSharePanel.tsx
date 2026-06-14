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
  acceptKnock,
  denyKnock,
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
} from "../services/sharingState.js";
import type { KnockRecord } from "../services/indexedDBService.js";
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
  const [grantSelection, setGrantSelection] = createSignal<
    Record<string, Set<string>>
  >({});
  const [error, setError] = createSignal<string | null>(null);
  const [editingName, setEditingName] = createSignal(false);
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
        <Show when={hasP2pIdentity() && p2pEnabled()}>
          <div
            data-testid="sharing-status"
            class="flex items-center gap-2 text-sm"
          >
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
        {/* display name + avatar */}
        <div class="flex items-center gap-2 mt-2">
          {/* avatar circle: image if set, colored initial fallback */}
          <button
            type="button"
            class="flex-shrink-0 w-8 h-8 rounded-full overflow-hidden border border-gray-700 hover:border-magenta-500 transition-colors focus:outline-none"
            title="click to change avatar"
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
          <input
            ref={avatarFileInput}
            type="file"
            accept="image/*"
            class="hidden"
            onChange={handleAvatarUpload}
          />

          {/* name pill / inline edit */}
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
                class="flex-1 bg-black text-white px-3 py-2 text-xs border border-magenta-200 focus:outline-none truncate min-w-0"
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

      {/* endpoint settings: mode and visibility */}
      <div class="space-y-3">
        <div>
          <label class="block text-xs mb-1">
            <span class="bg-black px-1 text-gray-400">
              who can browse my playlistz?
            </span>
          </label>
          <div class="flex gap-2">
            <button
              data-testid="btn-mode-public"
              aria-pressed={settings().mode === "public"}
              onClick={() => void handleSaveSettings({ mode: "public" })}
              class={`flex-1 px-3 py-2 text-sm border ${settings().mode === "public" ? "border-magenta-500 bg-magenta-500/20 text-white" : "border-gray-600 text-gray-400"}`}
            >
              anyone (public)
            </button>
            <button
              data-testid="btn-mode-knock"
              aria-pressed={settings().mode === "knock"}
              onClick={() => void handleSaveSettings({ mode: "knock" })}
              class={`flex-1 px-3 py-2 text-sm border ${settings().mode === "knock" ? "border-magenta-500 bg-magenta-500/20 text-white" : "border-gray-600 text-gray-400"}`}
            >
              knock first
            </button>
          </div>
        </div>
      </div>

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
                </div>
                <Show when={knock.message}>
                  <div class="text-gray-400 text-xs mb-2">
                    <span class="bg-black/80 px-1">"{knock.message}"</span>
                  </div>
                </Show>
                <div class="text-xs text-gray-500 mb-2">
                  <span class="bg-black/80 px-1">grant access to:</span>
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
        </div>
      </Show>
    </div>
  );
}
