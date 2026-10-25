import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Tower's sign-in screen took only a token, so a brand-new agent could not be created from a phone (2026-10-25).
 * Read at the source: the register form posts through the shared register(), a new agent goes to standing orders before the
 * app, a cold load of a tenant that still owes onboarding lands there too, and a hidden card really is hidden.
 */
const pub = resolve(import.meta.dirname, "../public");
const html = readFileSync(resolve(pub, "m.html"), "utf8");
const js = readFileSync(resolve(pub, "m.js"), "utf8");
const css = readFileSync(resolve(pub, "m.css"), "utf8");

test("the sign-in card links to a register form with symbol, faction and account token", () => {
  assert.match(html, /id="auth-show-register"/);
  const form = /<form[^>]*id="register-form"[\s\S]*?<\/form>/.exec(html);
  assert.ok(form, "register form not found");
  for (const id of ["reg-symbol", "reg-faction", "reg-token"]) assert.match(form[0], new RegExp(`id="${id}"`));
});

test("registering goes through the shared register() and then to onboarding when pending", () => {
  assert.match(js, /import \{[^}]*\bregister as registerAgent\b[^}]*\} from "\/shared\/session\.js"/);
  assert.match(js, /await registerAgent\(agentSymbol, faction, accountToken\)/);
  assert.match(js, /function enterAfterSignIn\(who\)\s*\{\s*if \(who\?\.onboardingPending\) return showOnboarding\(\);/);
});

test("token sign-in and a cold load use the same onboarding check", () => {
  assert.match(js, /enterAfterSignIn\(await login\(token\)\)/);
  assert.match(js, /enterAfterSignIn\(session\)/);
});

test("confirming standing orders uses the shared confirm call", () => {
  assert.match(js, /await completeOnboarding\(selections\)/);
});

test("a hidden auth card stays hidden (display:flex used to win over the hidden attribute)", () => {
  assert.match(css, /\.auth-card\[hidden\]\s*\{\s*display:\s*none;/);
});
