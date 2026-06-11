// reactive sharing state shared across the UI (sidebar share button,
// playlist header, edit panel): whether the p2p endpoint is set up and
// how many inbound knock requests are pending.
//
// module-level solid signals so every component sees the same state.
// call initSharingState() from any component that reads the signals.

import { createSignal } from "solid-js";
import {
  getIdentity,
  hasExistingIdentity,
  onIdentityChange,
} from "./p2pService.js";
import { getInboundKnocks, onKnocksChanged } from "./sharingService.js";

const [sharingReady, setSharingReady] = createSignal(false);
const [pendingKnockCount, setPendingKnockCount] = createSignal(0);

export { sharingReady, pendingKnockCount };

let initialized = false;

async function refreshKnockCount(): Promise<void> {
  try {
    const knocks = await getInboundKnocks();
    setPendingKnockCount(
      knocks.filter((k) => k.status === "pending").length
    );
  } catch {
    // idb unavailable (early boot)
  }
}

/**
 * start tracking p2p readiness + the knock inbox. idempotent - safe to
 * call from every component that uses the signals.
 */
export function initSharingState(): void {
  if (initialized) return;
  initialized = true;

  // ready when an identity exists (persisted or freshly created)
  if (getIdentity()?.node_id) {
    setSharingReady(true);
  } else {
    void hasExistingIdentity().then((exists) => {
      if (exists) setSharingReady(true);
    });
  }
  onIdentityChange((identity) => {
    if (identity?.node_id) setSharingReady(true);
  });

  onKnocksChanged(() => void refreshKnockCount());
  void refreshKnockCount();
}

/** reset module state. for use in tests only. */
export function _resetSharingStateForTests(): void {
  initialized = false;
  setSharingReady(false);
  setPendingKnockCount(0);
}
