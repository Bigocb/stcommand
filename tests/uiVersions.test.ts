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
 *
 * v6 is the default (served at `/`) since its 3D map/hull work landed; v5
 * is the only other actively offered version. v2/v3/v4 were retired —
 * their files may still exist on disk, but they no longer have a route or
 * a switcher entry, so there is nothing version-router-specific left to
 * test about them.
 */
async function startServer(dirFiles: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "uiversions-"));
  for (const [name, content] of Object.entries(dirFiles)) {
    writeFileSync(join(dir, name), content);
  }
  const app = express();
  app.use(createUiVersionRouter(dir));
  app.use(express.static(dir, { index: "v6.html" }));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { dir, server, base };
}

describe("UI version routing — v5 built", () => {
  let dir: string;
  let server: ReturnType<express.Express["listen"]>;
  let base: string;

  before(async () => {
    ({ dir, server, base } = await startServer({
      "v5.html": "<!doctype html><title>v5</title>mission control",
      "v6.html": "<!doctype html><title>v6</title>3d bridge",
    }));
  });

  after(async () => {
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves a built routed version at its own path", async () => {
    const res = await fetch(`${base}/v5`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /mission control/);
  });

  it("sends the routed version the same no-cache the static HTML gets", async () => {
    // res.sendFile() bypasses express.static's setHeaders hook, so this has
    // to be set explicitly: /v5 was answering max-age=0 while / answered
    // no-cache — two paths serving the same kind of file under two rules.
    const res = await fetch(`${base}/v5`);
    assert.equal(res.headers.get("cache-control"), "no-cache");
  });

  it("leaves / on v6 — the default, since its 3D map/hull work is what made it one", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /3d bridge/);
  });

  it("does not shadow unrelated paths", async () => {
    assert.equal((await fetch(`${base}/v9`)).status, 404);
    assert.equal((await fetch(`${base}/v5/extra`)).status, 404);
  });

  it("offers only v5 and v6 — v2/v3/v4 were retired", () => {
    assert.deepEqual([...UI_VERSIONS], ["v5", "v6"]);
  });
});

describe("UI version routing — v5 not yet built", () => {
  let dir: string;
  let server: ReturnType<express.Express["listen"]>;
  let base: string;

  before(async () => {
    ({ dir, server, base } = await startServer({
      "v6.html": "<!doctype html><title>v6</title>3d bridge",
    }));
  });

  after(async () => {
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers a routed-but-unbuilt version with something actionable, not a bare 404 page", async () => {
    const res = await fetch(`${base}/v5`);
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.match(body, /not built yet/);
    assert.match(body, /docs\/ui-versions-plan\.md/, "should point at the plan");
    assert.match(body, /current interface is at \//i, "should say how to get back");
  });
});

describe("cacheHeaders()", () => {
  it("forbids caching HTML", () => {
    // The HTML names which modules to load; a stale copy pins a browser to
    // superseded ones after a deploy.
    assert.deepEqual(cacheHeaders("/srv/public/v6.html"), { "Cache-Control": "no-cache" });
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
    for (const f of ["/srv/public/v6.css", "/srv/public/v6.js", "/srv/public/v5.js"]) {
      assert.equal(cacheHeaders(f)!["Cache-Control"], "public, max-age=300", f);
    }
  });

  it("says nothing about anything else", () => {
    assert.equal(cacheHeaders("/srv/public/icons/icon-192.png"), undefined);
    // Not every file whose name starts with a v is a version bundle.
    assert.equal(cacheHeaders("/srv/public/vendor.js"), undefined);
  });
});
