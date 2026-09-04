import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiVersionRouter, cacheHeaders, UI_VERSIONS } from "../src/http/uiVersions.js";

/**
 * Routing for the parallel UI versions. Exercised over a real HTTP server
 * against a temporary public dir, so this covers what an operator's browser
 * actually gets — including the case that holds for most of this work's
 * life, where a version is routed but not yet built.
 */
let dir: string;
let server: ReturnType<express.Express["listen"]>;
let base: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "uiversions-"));
  // v3 exists; v4 and v5 do not yet — the normal mid-project state.
  writeFileSync(join(dir, "v3.html"), "<!doctype html><title>v3</title>refined bridge");
  writeFileSync(join(dir, "v2.html"), "<!doctype html><title>v2</title>current");

  const app = express();
  app.use(createUiVersionRouter(dir));
  app.use(express.static(dir, { index: "v2.html" }));
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  rmSync(dir, { recursive: true, force: true });
});

describe("UI version routing", () => {
  it("serves a built version at its own path", async () => {
    const res = await fetch(`${base}/v3`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /refined bridge/);
  });

  it("answers a routed-but-unbuilt version with something actionable, not a bare 404 page", async () => {
    // True for most of this work's life: routes land in Phase 1, the files
    // arrive one phase at a time. An operator who follows the switcher to
    // v4 early should be told what is going on.
    const res = await fetch(`${base}/v4`);
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.match(body, /not built yet/);
    assert.match(body, /docs\/ui-versions-plan\.md/, "should point at the plan");
    assert.match(body, /current interface is at \//i, "should say how to get back");
  });

  it("leaves / on v2 — the default does not move until it is moved deliberately", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /current/);
  });

  it("does not shadow unrelated paths", async () => {
    assert.equal((await fetch(`${base}/v9`)).status, 404);
    assert.equal((await fetch(`${base}/v3/extra`)).status, 404);
  });

  it("lists v2 among the versions so the switcher can offer it as an escape", () => {
    // Whatever state a half-finished version gets into, going back to the
    // working one has to be reachable from inside it.
    assert.ok(UI_VERSIONS.includes("v2"));
    assert.deepEqual([...UI_VERSIONS], ["v2", "v3", "v4", "v5"]);
  });
});

describe("cacheHeaders()", () => {
  it("forbids caching HTML", () => {
    // The HTML names which modules to load; a stale copy pins a browser to
    // superseded ones after a deploy.
    assert.deepEqual(cacheHeaders("/srv/public/v2.html"), { "Cache-Control": "no-cache" });
  });

  it("caches fonts hard — they are content-stable and fetched by every version", () => {
    const h = cacheHeaders("/srv/public/fonts/RBdisp-700.woff2")!;
    assert.match(h["Cache-Control"]!, /max-age=31536000/);
    assert.match(h["Cache-Control"]!, /immutable/);
  });

  it("caches shared modules only briefly, since they have no content hash", () => {
    // shared/store.js is replaced in place by a deploy, so the window in
    // which new HTML can pair with old modules has to stay small.
    const h = cacheHeaders("/srv/public/shared/store.js")!;
    assert.equal(h["Cache-Control"], "public, max-age=300");
  });

  it("caches each version's own CSS and JS — the whole point of extracting them", () => {
    // These were inlined into the HTML until the split; leaving them
    // uncached means a browser re-fetches ~250KB per load and the
    // extraction bought nothing. Same short window as shared modules, and
    // for the same reason: no content hash, replaced in place by a deploy.
    for (const f of ["/srv/public/v2.css", "/srv/public/v2.js", "/srv/public/v5.js"]) {
      assert.equal(cacheHeaders(f)!["Cache-Control"], "public, max-age=300", f);
    }
  });

  it("says nothing about anything else", () => {
    assert.equal(cacheHeaders("/srv/public/icons/icon-192.png"), undefined);
    // Not every file whose name starts with a v is a version bundle.
    assert.equal(cacheHeaders("/srv/public/vendor.js"), undefined);
  });
});
