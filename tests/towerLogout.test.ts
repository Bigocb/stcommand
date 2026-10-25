import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Tower had no way to sign out, so after registering a second agent the first one's session could not be left (2026-10-25).
 * Read at the source: the button exists, is wired to the shared logout, and reloads so no state carries to the next agent.
 */
const pub = resolve(import.meta.dirname, "../public");
const html = readFileSync(resolve(pub, "m.html"), "utf8");
const js = readFileSync(resolve(pub, "m.js"), "utf8");

test("the Tower header has a Log out button", () => {
  assert.match(html, /<button[^>]*id="logout-btn"[^>]*>Log out<\/button>/);
});

test("it ends the session through the shared logout and reloads the page", () => {
  assert.match(js, /import \{[^}]*\blogout\b[^}]*\} from "\/shared\/session\.js"/);
  const handler = /\$\("logout-btn"\)\.addEventListener\("click",[\s\S]*?\n\}\);/.exec(js);
  assert.ok(handler, "click handler not found");
  assert.match(handler[0], /await logout\(\)/);
  assert.match(handler[0], /window\.location\.reload\(\)/);
});

test("the shared logout calls the server's logout route", () => {
  const session = readFileSync(resolve(pub, "shared/session.js"), "utf8");
  assert.match(session, /export async function logout\(\)[\s\S]*?\/api\/gate\/logout/);
});
