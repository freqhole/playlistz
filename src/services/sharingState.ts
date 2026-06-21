// reactive sharing state shared across the UI: p2p endpoint readiness,
// pending knock count, connected peer count, active transfer flag, and
// the persisted "endpoint enabled" toggle.
//
// module-level solid signals so every component sees the same state.
// call initSharingState() from any component that reads the signals.

import { createSignal } from "solid-js";
import {
  getIdentity,
  hasExistingIdentity,
  onIdentityChange,
  stopP2P,
} from "./p2pService.js";
import {
  getInboundKnocks,
  getOutboundKnocks,
  onKnocksChanged,
  ensureSharingReady,
} from "./sharingService.js";
import { loadSetting, saveSetting } from "./indexedDBService.js";
import { getIrohAdapter } from "./automergeRepo.js";
import {
  onTransferCountChange,
  getActiveTransferCount,
} from "./blobTransferService.js";

const ENDPOINT_ENABLED_KEY = "p2p:endpoint_enabled";

const [sharingReady, setSharingReady] = createSignal(false);
const [pendingKnockCount, setPendingKnockCount] = createSignal(0);
const [endpointEnabled, setEndpointEnabled] = createSignal(false);
const [connectedPeerCount, setConnectedPeerCount] = createSignal(0);
const [isTransferring, setIsTransferring] = createSignal(false);
// true once a p2p identity has been created (persisted); stays true even
// when the endpoint is toggled off. used to hide the "enable" button.
const [hasP2pIdentity, setHasP2pIdentity] = createSignal(
  !!getIdentity()?.node_id
);
// number of outbound knocks we sent that are still pending (waiting for owner
// to accept). shown as a badge on the share button so the user can follow up.
const [outboundPendingCount, setOutboundPendingCount] = createSignal(0);

export {
  sharingReady,
  pendingKnockCount,
  outboundPendingCount,
  endpointEnabled,
  connectedPeerCount,
  isTransferring,
  hasP2pIdentity,
};

let initialized = false;
let connPollTimer: ReturnType<typeof setInterval> | null = null;
let _unsubTransfer: (() => void) | null = null;

async function refreshKnockCount(): Promise<void> {
  try {
    const inbound = await getInboundKnocks();
    setPendingKnockCount(inbound.filter((k) => k.status === "pending").length);
    const outbound = await getOutboundKnocks();
    setOutboundPendingCount(outbound.filter((k) => k.status === "pending").length);
  } catch {
    // idb unavailable (early boot)
  }
}

function refreshConnSummary(): void {
  try {
    const summary = getIrohAdapter().getConnectionSummary();
    setConnectedPeerCount(summary.connected);
  } catch {
    // adapter not ready yet
  }
}

/**
 * start tracking p2p readiness, knock inbox, connection count, and
 * active transfers. idempotent - safe to call from every component.
 */
export function initSharingState(): void {
  if (initialized) return;
  initialized = true;

  onKnocksChanged(() => void refreshKnockCount());
  void refreshKnockCount();

  // poll connection count every 3s
  connPollTimer = setInterval(refreshConnSummary, 3000);
  refreshConnSummary();

  // track active blob transfers
  _unsubTransfer = onTransferCountChange(() => {
    setIsTransferring(getActiveTransferCount() > 0);
  });

  // load persisted endpoint setting first, then decide whether to auto-start
  void loadSetting<boolean>(ENDPOINT_ENABLED_KEY).then((persisted) => {
    // identity may already be in-memory (populated by a previous module load)
    const hasIdentity = !!getIdentity()?.node_id;
    if (hasIdentity) setHasP2pIdentity(true);
    else {
      void hasExistingIdentity().then((exists) => {
        if (exists) setHasP2pIdentity(true);
      });
    }

    // only consider "enabled" if the user explicitly turned it on (persisted=true).
    // null/undefined means never set - treat as disabled.
    if (persisted === true) {
      setEndpointEnabled(true);
      void ensureSharingReady()
        .then(() => setSharingReady(true))
        .catch(() => {
          // endpoint may fail silently on boot
        });
    }

    // keep hasP2pIdentity up to date as identity resolves asynchronously
    onIdentityChange((identity) => {
      if (identity?.node_id) setHasP2pIdentity(true);
    });
  });
}

/**
 * toggle the iroh endpoint on or off.
 * persists the choice to indexeddb so the next page load respects it.
 */
export async function toggleEndpoint(): Promise<void> {
  const next = !endpointEnabled();
  setEndpointEnabled(next);
  await saveSetting(ENDPOINT_ENABLED_KEY, next);
  if (next) {
    await ensureSharingReady();
    setSharingReady(true);
    setHasP2pIdentity(true);
  } else {
    stopP2P();
    setSharingReady(false);
    setConnectedPeerCount(0);
  }
}

/** reset module state. for use in tests only. */
export function _resetSharingStateForTests(): void {
  initialized = false;
  setSharingReady(false);
  setPendingKnockCount(0);
  setEndpointEnabled(false);
  setConnectedPeerCount(0);
  setIsTransferring(false);
  setHasP2pIdentity(false);
  if (connPollTimer) {
    clearInterval(connPollTimer);
    connPollTimer = null;
  }
  _unsubTransfer?.();
  _unsubTransfer = null;
}
