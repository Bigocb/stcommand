import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { serveHtml, sharedModuleUrls, importMapTag } from "../src/http/uiVersions.js";

/**
 * 2026-10-25: a phone could not load Tower after a deploy that added an export to shared/domain.js. The HTML stamped m.js, but
 * m.js's own imports were unstamped, so behind a CDN that holds .js for four hours a new m.js met an old domain.js. The page now
 * carries an import map that stamps every shared module.
 */
const pub = resolve(import.meta.dirname, "../public");

function render(file: string, stamp: string): string {
  let body = "";
  const res: any = { set() { return res; }, type() { return res; }, status() { return res; }, send(b: string) { body = b; return res; } };
  serveHtml(res, file, stamp);
  return body;
}

describe("sharedModuleUrls", () => {
  it("lists the shared modules as URLs", () => {
    const urls = sharedModuleUrls(resolve(pub, "shared"));
    assert.ok(urls.includes("/shared/domain.js"));
    assert.ok(urls.includes("/shared/store.js"));
    assert.ok(urls.every((u) => u.startsWith("/shared/") && u.endsWith(".js")));
  });
});

describe("served Tower page", () => {
  const html = render(resolve(pub, "m.html"), "abc123");
  it("maps every shared module to its stamped URL", () => {
    const m = /<script type="importmap">(.*?)<\/script>/.exec(html);
    assert.ok(m, "no import map");
    const imports = JSON.parse(m[1]!).imports as Record<string, string>;
    assert.equal(imports["/shared/domain.js"], "/shared/domain.js?v=abc123");
    assert.equal(imports["/shared/store.js"], "/shared/store.js?v=abc123");
  });
  it("puts the import map before the first module script, which is stamped too", () => {
    assert.ok(html.indexOf('type="importmap"') < html.indexOf('type="module"'));
    assert.match(html, /<script type="module" src="\/m\.js\?v=abc123">/);
  });
  it("a page with no module script gets no map", () => {
    const plain = importMapTag([], "x");
    assert.match(plain, /"imports":\{\}/);
  });
});
