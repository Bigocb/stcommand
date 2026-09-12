import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApprovalGate } from "../src/engine/approvals.js";
import type { PendingApprovalRow, Store } from "../src/db/store.js";

/**
 * DB-independent: a tiny in-memory stand-in for the four Store methods
 * ApprovalGate actually calls, exercising the same restart-survival
 * property the real table gives it (state lives in `rows`, not in
 * ApprovalGate itself — a fresh ApprovalGate instance reading the same
 * fake store picks up exactly where the old one left off).
 */
function fakeStore(): { store: Store; rows: PendingApprovalRow[] } {
  const rows: PendingApprovalRow[] = [];
  let seq = 0;
  const store = {
    async createPendingApproval(_tenantId: string, kind: string, shipSymbol: string | undefined, detail: string, cost: number | undefined, expiresAtIso: string) {
      const row: PendingApprovalRow = {
        id: `a${++seq}`, kind, shipSymbol: shipSymbol ?? null, detail, cost: cost ?? null,
        status: "pending", consumed: false, createdAt: new Date().toISOString(), expiresAt: expiresAtIso, decidedAt: null,
      };
      rows.push(row);
      return row;
    },
    async getUnconsumedApproval(_tenantId: string, kind: string) {
      return [...rows].reverse().find((r) => r.kind === kind && !r.consumed);
    },
    async getLastDecidedApproval(_tenantId: string, kind: string) {
      return [...rows].filter((r) => r.kind === kind && r.status !== "pending").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))[0];
    },
    async decideApproval(_tenantId: string, id: string, status: PendingApprovalRow["status"], consumed = false) {
      const row = rows.find((r) => r.id === id);
      if (row) { row.status = status; row.consumed = consumed; row.decidedAt = new Date().toISOString(); }
    },
    async consumeApproval(_tenantId: string, id: string) {
      const row = rows.find((r) => r.id === id);
      if (row) row.consumed = true;
    },
  } as unknown as Store;
  return { store, rows };
}

const opts = { detail: "buy a thing", timeoutMs: 60_000, onTimeout: "approve" as const };

describe("ApprovalGate", () => {
  it("no persistence configured behaves as pre-approved", async () => {
    const gate = new ApprovalGate(undefined, undefined, () => {});
    assert.equal(await gate.request("buyShip", opts), true);
  });

  it("first request opens a pending row and returns undefined", async () => {
    const { store, rows } = fakeStore();
    const gate = new ApprovalGate(store, "t1", () => {});
    assert.equal(await gate.request("buyShip", opts), undefined);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "pending");
  });

  it("stays undefined while the same row is still pending and unexpired", async () => {
    const { store } = fakeStore();
    const gate = new ApprovalGate(store, "t1", () => {});
    await gate.request("buyShip", opts);
    assert.equal(await gate.request("buyShip", opts), undefined);
  });

  it("an operator approval is picked up exactly once, then a fresh request opens a new row", async () => {
    const { store, rows } = fakeStore();
    const gate = new ApprovalGate(store, "t1", () => {});
    await gate.request("buyShip", opts);
    await store.decideApproval("t1", rows[0]!.id, "approved"); // simulates the dashboard's decide route
    assert.equal(await gate.request("buyShip", opts), true);
    assert.equal(rows[0]!.consumed, true);
    // Consumed and gone — the next call is a brand-new decision, not a replay.
    assert.equal(await gate.request("buyShip", opts), undefined);
    assert.equal(rows.length, 2);
  });

  it("a denial is picked up once and then holds a cooldown before asking again", async () => {
    const { store, rows } = fakeStore();
    const gate = new ApprovalGate(store, "t1", () => {});
    await gate.request("buyShip", opts);
    await store.decideApproval("t1", rows[0]!.id, "denied");
    assert.equal(await gate.request("buyShip", { ...opts, denyCooldownMs: 10_000 }), false);
    // Still within the cooldown window: denied again without a new row.
    assert.equal(await gate.request("buyShip", { ...opts, denyCooldownMs: 10_000 }), false);
    assert.equal(rows.length, 1);
  });

  it("survives a restart: a fresh ApprovalGate reading the same store resumes an approved decision", async () => {
    const { store, rows } = fakeStore();
    const before = new ApprovalGate(store, "t1", () => {});
    await before.request("buyShip", opts);
    await store.decideApproval("t1", rows[0]!.id, "approved");
    // A brand-new ApprovalGate instance — nothing carried over in memory.
    const after = new ApprovalGate(store, "t1", () => {});
    assert.equal(await after.request("buyShip", opts), true);
  });

  it("times out to the configured onTimeout outcome with nobody deciding", async () => {
    const { store, rows } = fakeStore();
    const gate = new ApprovalGate(store, "t1", () => {});
    await gate.request("buyShip", { ...opts, timeoutMs: -1 }); // already expired on creation
    assert.equal(await gate.request("buyShip", { ...opts, timeoutMs: -1 }), true);
    assert.equal(rows[0]!.status, "auto_approved");
    assert.equal(rows[0]!.consumed, true);
  });

  it("times out to denied when onTimeout is \"deny\"", async () => {
    const { store, rows } = fakeStore();
    const gate = new ApprovalGate(store, "t1", () => {});
    await gate.request("scrapShip", { ...opts, timeoutMs: -1, onTimeout: "deny" });
    assert.equal(await gate.request("scrapShip", { ...opts, timeoutMs: -1, onTimeout: "deny" }), false);
    assert.equal(rows[0]!.status, "expired");
  });

  it("different kinds never interfere with each other", async () => {
    const { store, rows } = fakeStore();
    const gate = new ApprovalGate(store, "t1", () => {});
    await gate.request("buyShip", opts);
    await gate.request("scrapShip", opts);
    assert.equal(rows.length, 2);
    assert.equal(await gate.request("scrapShip", opts), undefined);
    assert.equal(rows.filter((r) => r.kind === "buyShip").length, 1);
  });
});
