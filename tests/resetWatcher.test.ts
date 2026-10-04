import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ResetWatcher, type ResetWatcherPorts, type TokenProbe } from "../src/engine/resetWatcher.js";

/** In-memory ports: one tenant THEO, a game whose resetDate and token validity the test controls. */
function harness(opts: { seen?: string; apiReset: string; probe?: TokenProbe; accountToken?: boolean; enabled?: boolean }) {
  const calls: string[] = [];
  const st = {
    seen: opts.seen,
    apiReset: opts.apiReset,
    tokenState: (opts.probe ?? "dead") as TokenProbe,
    booted: false,
    registerFails: 0,
    captureFails: 0,
    bootFails: 0,
  };
  const ports: ResetWatcherPorts = {
    fetchStatus: async () => ({ resetDate: st.apiReset, nextReset: "2026-10-11T13:00:00.000Z" }),
    getSeenResetDate: async () => st.seen,
    setSeenResetDate: async (d) => { calls.push(`seen:${d}`); st.seen = d; },
    listTenants: async () => [{ id: "t1", agentSymbol: "THEO" }],
    probeTenant: async () => st.tokenState,
    isBooted: () => st.booted,
    stopWorker: () => { calls.push("stop"); st.booted = false; },
    captureRunResult: async (_t, ended, next) => {
      if (st.captureFails > 0) { st.captureFails -= 1; throw new Error("db hiccup"); }
      calls.push(`capture:${ended}->${next}`);
      return true;
    },
    wipeTenantGameData: async () => { calls.push("wipe"); },
    truncateSharedGalaxy: async () => { calls.push("truncate"); },
    resetCrawler: () => { calls.push("crawler"); },
    registerAndStore: async (symbol) => {
      if (st.registerFails > 0) { st.registerFails -= 1; throw new Error("api warming up"); }
      calls.push(`register:${symbol}`);
      st.tokenState = "alive";
      return { tenantId: "t1", agentSymbol: symbol };
    },
    boot: async () => {
      if (st.bootFails > 0) { st.bootFails -= 1; throw new Error("boot boom"); }
      calls.push("boot");
      st.booted = true;
    },
  };
  const w = new ResetWatcher(ports, { accountTokenConfigured: opts.accountToken ?? true, enabled: opts.enabled });
  return { w, st, calls };
}

describe("ResetWatcher", () => {
  it("first run records the baseline and touches nothing when tokens are alive", async () => {
    const { w, calls } = harness({ apiReset: "2026-09-27", probe: "alive" });
    await w.tick();
    assert.deepEqual(calls, ["seen:2026-09-27"]);
  });

  it("first run with dead tokens treats it as a reset it missed", async () => {
    const { w, calls, st } = harness({ apiReset: "2026-10-04" });
    await w.tick();
    assert.deepEqual(calls, ["capture:unknown->2026-10-04", "stop", "wipe", "truncate", "crawler", "register:THEO", "boot", "seen:2026-10-04"]);
    assert.equal(st.seen, "2026-10-04");
    assert.equal(w.status().state, "recovered");
  });

  it("does nothing while resetDate is unchanged", async () => {
    const { w, calls } = harness({ seen: "2026-09-27", apiReset: "2026-09-27", probe: "alive" });
    await w.tick();
    assert.deepEqual(calls, []);
  });

  it("a changed resetDate clears stale data, registers, boots, then records it handled", async () => {
    const { w, calls } = harness({ seen: "2026-09-27", apiReset: "2026-10-04" });
    await w.tick();
    assert.deepEqual(calls, ["capture:2026-09-27->2026-10-04", "stop", "wipe", "truncate", "crawler", "register:THEO", "boot", "seen:2026-10-04"]);
    // wipe happens strictly before the new agent exists
    assert.ok(calls.indexOf("wipe") < calls.indexOf("register:THEO"));
  });

  it("an unknown token state (network blip) aborts without wiping anything", async () => {
    const { w, calls } = harness({ seen: "2026-09-27", apiReset: "2026-10-04", probe: "unknown" });
    await w.tick();
    assert.deepEqual(calls, []);
  });

  it("a failed registration is retried next tick without wiping again", async () => {
    const { w, calls, st } = harness({ seen: "2026-09-27", apiReset: "2026-10-04" });
    st.registerFails = 1;
    await w.tick();
    assert.equal(st.seen, "2026-09-27", "not marked handled yet");
    assert.equal(w.status().state, "error");
    await w.tick();
    assert.equal(st.seen, "2026-10-04");
    assert.equal(calls.filter((c) => c === "wipe").length, 1);
    assert.equal(calls.filter((c) => c === "truncate").length, 1);
    assert.equal(calls.filter((c) => c.startsWith("register")).length, 1);
  });

  it("a boot failure after registering is retried without registering a second agent", async () => {
    const { w, calls, st } = harness({ seen: "2026-09-27", apiReset: "2026-10-04" });
    st.bootFails = 1;
    await w.tick();
    assert.equal(st.seen, "2026-09-27");
    await w.tick();
    assert.equal(st.seen, "2026-10-04");
    assert.equal(calls.filter((c) => c.startsWith("register")).length, 1, "never a second registration");
    assert.equal(calls.filter((c) => c === "boot").length, 1);
  });

  it("without an account token it reports needs_account_token and changes nothing", async () => {
    const { w, calls } = harness({ seen: "2026-09-27", apiReset: "2026-10-04", accountToken: false });
    await w.tick();
    assert.deepEqual(calls, []);
    assert.equal(w.status().state, "needs_account_token");
  });

  it("disabled: detects but never acts", async () => {
    const { w, calls } = harness({ seen: "2026-09-27", apiReset: "2026-10-04", enabled: false });
    await w.tick();
    assert.deepEqual(calls, []);
    assert.equal(w.status().state, "disabled");
  });

  it("if the operator already re-registered by hand (tokens alive), it just marks the reset handled", async () => {
    const { w, calls, st } = harness({ seen: "2026-09-27", apiReset: "2026-10-04", probe: "alive" });
    st.booted = true;
    await w.tick();
    assert.deepEqual(calls, ["seen:2026-10-04"]);
  });

  it("saves the scoreboard before anything is wiped", async () => {
    const { w, calls } = harness({ seen: "2026-09-27", apiReset: "2026-10-04" });
    await w.tick();
    assert.ok(calls.indexOf("capture:2026-09-27->2026-10-04") < calls.indexOf("wipe"));
    assert.ok(calls.indexOf("capture:2026-09-27->2026-10-04") < calls.indexOf("truncate"));
  });

  it("a failed capture holds the wipe and is retried", async () => {
    const { w, calls, st } = harness({ seen: "2026-09-27", apiReset: "2026-10-04" });
    st.captureFails = 1;
    await w.tick();
    assert.equal(calls.length, 0, "nothing wiped while the week's numbers are unsaved");
    await w.tick();
    assert.equal(st.seen, "2026-10-04");
    assert.ok(calls.includes("capture:2026-09-27->2026-10-04"));
  });

  it("a capture that keeps failing eventually stops blocking recovery", async () => {
    const { w, calls, st } = harness({ seen: "2026-09-27", apiReset: "2026-10-04" });
    st.captureFails = 99;
    await w.tick();
    await w.tick();
    assert.equal(calls.length, 0);
    await w.tick();
    assert.equal(st.seen, "2026-10-04", "third failure: proceed without the results");
    assert.ok(calls.includes("wipe"));
  });
});
