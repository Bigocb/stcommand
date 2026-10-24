import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Every icon Tower's manifest and page name must exist and be a real PNG of the size it claims. */
const pub = resolve(import.meta.dirname, "../public");
const pngSize = (file: string): { w: number; h: number; colorType: number } => {
  const b = readFileSync(file);
  assert.equal(b.subarray(1, 4).toString("ascii"), "PNG", `${file} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25]! };
};

describe("Tower icons", () => {
  const manifest = JSON.parse(readFileSync(resolve(pub, "manifest-tower.webmanifest"), "utf8"));

  it("the manifest lists an 'any' and a maskable icon, and each file is the size it says", () => {
    const purposes = new Set(manifest.icons.map((i: { purpose?: string }) => i.purpose));
    assert.ok(purposes.has("any") && purposes.has("maskable"));
    for (const i of manifest.icons as { src: string; sizes: string }[]) {
      const file = resolve(pub, "." + i.src);
      assert.ok(existsSync(file), `${i.src} is missing`);
      const [w, h] = i.sizes.split("x").map(Number);
      assert.deepEqual(pngSize(file), { w, h, colorType: 2 }, `${i.src}: wrong size, or not opaque RGB`);
    }
  });

  it("the home-screen, tab and notification icons the page and worker name exist", () => {
    const html = readFileSync(resolve(pub, "m.html"), "utf8");
    const sw = readFileSync(resolve(pub, "sw-tower.js"), "utf8");
    const inline = html.match(/rel="apple-touch-icon"[^>]*href="data:image\/png;base64,([^"]+)"/);
    assert.ok(inline, "the apple-touch icon must be embedded in the page");
    assert.ok(Buffer.from(inline![1]!, "base64").equals(readFileSync(resolve(pub, "icons/tower-apple-touch-icon.png"))), "embedded icon differs from the PNG file");
    const named = [...html.matchAll(/href="(\/icons\/[^"]+)"/g), ...sw.matchAll(/"(\/icons\/[^"]+)"/g)].map((m) => m[1]!);
    assert.ok(named.length >= 4);
    for (const n of named) assert.ok(existsSync(resolve(pub, "." + n)), `${n} is named but missing`);
    assert.deepEqual(pngSize(resolve(pub, "icons/tower-apple-touch-icon.png")), { w: 180, h: 180, colorType: 2 }, "iOS wants an opaque 180px square");
    assert.deepEqual(pngSize(resolve(pub, "icons/tower-favicon-32.png")), { w: 32, h: 32, colorType: 2 });
    const badge = pngSize(resolve(pub, "icons/tower-notify-badge-96.png"));
    assert.deepEqual([badge.w, badge.h, badge.colorType], [96, 96, 6], "Android's notification badge must be transparent (RGBA)");
  });
});

describe("Tower root icon paths", () => {
  it("serves /apple-touch-icon.png, its precomposed twin and /favicon.ico from the server, so a failed <link> fetch can't leave iOS with a letter tile", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../src/cli/index.ts"), "utf8");
    for (const p of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/favicon.ico"]) assert.ok(src.includes(`"${p}"`), `${p} has no route`);
    assert.ok(existsSync(resolve(pub, "icons/tower-apple-touch-icon.png")) && existsSync(resolve(pub, "icons/tower-favicon-32.png")));
  });
});
