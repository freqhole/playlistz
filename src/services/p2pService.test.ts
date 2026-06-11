import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { P2PIdentity } from "freqhole-api-client/storage";

// --- mocks (hoisted before module imports) ---

const {
  mockResolveIdentity,
  mockPersistIdentity,
  mockAcquireLeadership,
  mockCreateWithAlpns,
} = vi.hoisted(() => ({
  mockResolveIdentity: vi.fn(),
  mockPersistIdentity: vi.fn(),
  mockAcquireLeadership: vi.fn(),
  mockCreateWithAlpns: vi.fn(),
}));

vi.mock("freqhole-api-client/storage", () => ({
  resolveIdentity: mockResolveIdentity,
  persistIdentity: mockPersistIdentity,
  acquireNodeLeadership: mockAcquireLeadership,
}));

vi.mock("midden", () => ({
  MiddenNode: {
    create_with_alpns: mockCreateWithAlpns,
  },
}));

// automerge types are type-only imports in the service; no runtime mock needed.
// playlistz constants are plain strings - no mock needed either.

import {
  startP2P,
  stopP2P,
  getNode,
  getIdentity,
  isLeader,
  onLeadershipChange,
  onIdentityChange,
  getAdapterOptions,
  _resetForTests,
} from "./p2pService.js";

// --- test helpers ---

const fakeIdentity = (overrides: Partial<P2PIdentity> = {}): P2PIdentity => ({
  id: "p2p_identity",
  secret_key: new Uint8Array(32).fill(7),
  node_id: "fake-node-id",
  created_at: 1000,
  ...overrides,
});

const fakeMockNode = {
  node_id: vi.fn().mockReturnValue("real-node-id"),
  open_bi: vi.fn(),
  accept: vi.fn().mockResolvedValue(null),
};

/** simulate the leadership callback being called (i.e. this tab won the lock). */
async function triggerLeader(): Promise<void> {
  const call = mockAcquireLeadership.mock.calls[0];
  if (!call) throw new Error("acquireNodeLeadership was not called");
  await call[0].onAcquired();
}

// --- setup / teardown ---

beforeEach(() => {
  _resetForTests();
  vi.clearAllMocks();

  // default: acquireLeadership never calls onAcquired (another tab holds the lock)
  mockAcquireLeadership.mockReturnValue(() => {});

  // default: persistIdentity succeeds silently
  mockPersistIdentity.mockResolvedValue(undefined);
});

afterEach(() => {
  stopP2P();
});

// --- identity fallback chain ---

describe("identity fallback chain", () => {
  it("generates a new identity when none exists anywhere", async () => {
    mockResolveIdentity.mockResolvedValue(null);

    await startP2P();

    const identity = getIdentity();
    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("p2p_identity");
    expect(identity!.secret_key).toBeInstanceOf(Uint8Array);
    expect(identity!.secret_key.length).toBe(32);
    // node_id is empty until midden boots
    expect(identity!.node_id).toBe("");
    expect(identity!.created_at).toBeGreaterThan(0);
    // new identity should be persisted
    expect(mockPersistIdentity).toHaveBeenCalledOnce();
  });

  it("uses existing identity from resolveIdentity when one exists", async () => {
    const existing = fakeIdentity({ node_id: "stored-node-id" });
    mockResolveIdentity.mockResolvedValue(existing);

    await startP2P();

    const identity = getIdentity();
    expect(identity).toEqual(existing);
    // should not generate or persist a new identity
    expect(mockPersistIdentity).not.toHaveBeenCalled();
  });

  it("notifies identity listeners after resolution", async () => {
    const existing = fakeIdentity();
    mockResolveIdentity.mockResolvedValue(existing);

    const listener = vi.fn();
    onIdentityChange(listener);

    await startP2P();

    expect(listener).toHaveBeenCalledWith(existing);
  });

  it("is idempotent: calling startP2P twice has no effect the second time", async () => {
    mockResolveIdentity.mockResolvedValue(fakeIdentity());

    await startP2P();
    await startP2P();

    // resolveIdentity called exactly once
    expect(mockResolveIdentity).toHaveBeenCalledOnce();
  });

  it("handles identity resolution failure gracefully", async () => {
    mockResolveIdentity.mockRejectedValue(new Error("idb exploded"));

    // should not throw
    await expect(startP2P()).resolves.toBeUndefined();
    expect(getIdentity()).toBeNull();
  });
});

// --- leadership gating ---

describe("leadership gating", () => {
  it("does not boot midden when this tab is not the leader", async () => {
    mockResolveIdentity.mockResolvedValue(fakeIdentity());
    // acquireLeadership never calls onAcquired (someone else holds the lock)
    mockAcquireLeadership.mockReturnValue(() => {});

    await startP2P();

    expect(getNode()).toBeNull();
    expect(isLeader()).toBe(false);
  });

  it("boots midden and exposes the node when this tab wins the lock", async () => {
    mockResolveIdentity.mockResolvedValue(fakeIdentity({ node_id: "" }));
    mockCreateWithAlpns.mockResolvedValue(fakeMockNode);

    await startP2P();
    await triggerLeader();

    expect(isLeader()).toBe(true);
    expect(getNode()).toBe(fakeMockNode);
  });

  it("updates node_id in the stored identity after midden boots", async () => {
    mockResolveIdentity.mockResolvedValue(fakeIdentity({ node_id: "old-id" }));
    mockCreateWithAlpns.mockResolvedValue(fakeMockNode);

    await startP2P();
    await triggerLeader();

    // real node_id from midden should be persisted
    const updatedIdentity = getIdentity();
    expect(updatedIdentity!.node_id).toBe("real-node-id");
    expect(mockPersistIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ node_id: "real-node-id" }),
      expect.anything()
    );
  });

  it("notifies leadership listeners when acquiring leadership", async () => {
    mockResolveIdentity.mockResolvedValue(fakeIdentity());
    mockCreateWithAlpns.mockResolvedValue(fakeMockNode);

    const listener = vi.fn();
    onLeadershipChange(listener);
    // called immediately with current state (false)
    expect(listener).toHaveBeenCalledWith(false);
    listener.mockClear();

    await startP2P();
    await triggerLeader();

    expect(listener).toHaveBeenCalledWith(true);
  });

  it("releases leadership and clears node on stopP2P", async () => {
    mockResolveIdentity.mockResolvedValue(fakeIdentity());
    mockCreateWithAlpns.mockResolvedValue(fakeMockNode);

    await startP2P();
    await triggerLeader();
    expect(isLeader()).toBe(true);

    stopP2P();

    expect(isLeader()).toBe(false);
    expect(getNode()).toBeNull();
  });
});

// --- graceful degradation when wasm is unavailable ---

describe("graceful degradation when wasm import fails", () => {
  it("does not throw when midden import fails", async () => {
    mockResolveIdentity.mockResolvedValue(fakeIdentity());
    mockCreateWithAlpns.mockRejectedValue(new Error("wasm not available"));

    await startP2P();
    await triggerLeader();

    // identity is still set; node is null (midden boot failed)
    expect(getIdentity()).not.toBeNull();
    expect(getNode()).toBeNull();
    // still became leader (lock acquired) even though midden failed
    expect(isLeader()).toBe(true);
  });

  it("does not throw when midden module is missing entirely", async () => {
    mockResolveIdentity.mockResolvedValue(fakeIdentity());
    // simulate dynamic import("midden") rejecting with module-not-found
    mockCreateWithAlpns.mockImplementation(() => {
      throw new TypeError("cannot find module 'midden'");
    });

    await startP2P();
    await triggerLeader();

    expect(getNode()).toBeNull();
    expect(getIdentity()).not.toBeNull();
  });
});

// --- adapter options ---

describe("getAdapterOptions", () => {
  it("getNode rejects when node is not available", async () => {
    mockResolveIdentity.mockResolvedValue(fakeIdentity());

    await startP2P();
    const opts = getAdapterOptions();

    await expect(opts.getNode()).rejects.toThrow(
      "p2p: midden node is not available"
    );
  });

  it("getIdentity returns the current identity", async () => {
    const id = fakeIdentity();
    mockResolveIdentity.mockResolvedValue(id);

    await startP2P();
    const opts = getAdapterOptions();

    await expect(opts.getIdentity()).resolves.toEqual(id);
  });

  it("getNode resolves the midden node after boot", async () => {
    mockResolveIdentity.mockResolvedValue(fakeIdentity());
    mockCreateWithAlpns.mockResolvedValue(fakeMockNode);

    await startP2P();
    await triggerLeader();

    const opts = getAdapterOptions();
    await expect(opts.getNode()).resolves.toBe(fakeMockNode);
  });

  it("onIdentityChange subscribes to identity updates", async () => {
    const id = fakeIdentity();
    mockResolveIdentity.mockResolvedValue(id);

    const opts = getAdapterOptions();
    const listener = vi.fn();
    const unsub = opts.onIdentityChange!(listener);

    await startP2P();

    expect(listener).toHaveBeenCalledWith(id);
    unsub();
  });

  it("syncAlpn is the automerge ALPN", () => {
    const opts = getAdapterOptions();
    expect(opts.syncAlpn).toBe("iroh/automerge-repo/1");
  });
});
