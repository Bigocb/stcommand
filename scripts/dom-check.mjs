/**
 * Renders a UI page in headless Chromium and captures the resulting DOM, so
 * a refactor can be proved behaviour-neutral instead of argued to be.
 *
 * Phase 0 moves ~180KB of JavaScript out of v2.html into shared modules.
 * Nothing about that is visible to a typecheck or the test suite, which
 * never touch the frontend — the only honest check is "does the page still
 * render the same thing". This does that:
 *
 *     node scripts/dom-check.mjs --save before.html      # baseline
 *     ...make the change...
 *     node scripts/dom-check.mjs --against before.html   # diff
 *
 * Serves public/ through the same express.static config src/cli/index.ts
 * uses, so asset paths resolve exactly as they do in production. It never
 * starts the real server: that would boot a second copy of the live fleet
 * against the production database.
 *
 * Expect one diff line even on a clean run — #clock renders the current
 * time. That line is load-bearing: the authored markup contains an em dash,
 * so a real time proves the script actually executed. A DOM that matches
 * the baseline *including* a literal em dash means the page rendered
 * without its JavaScript, which is a failure, not a pass.
 */
import express from "express";
import { resolve, join } from "node:path";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const savePath = flag("--save");
const againstPath = flag("--against");
const page = flag("--page") ?? "/";

if (!savePath && !againstPath) {
  console.error("usage: dom-check.mjs (--save <file> | --against <file>) [--page /v3]");
  process.exit(2);
}

/** Chromium from the Playwright cache, or CHROME_PATH. No package needed. */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(process.env.HOME ?? "/root", ".cache", "ms-playwright");
  if (!existsSync(cache)) return null;
  for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium-"))) {
    const p = join(cache, dir, "chrome-linux64", "chrome");
    if (existsSync(p)) return p;
  }
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.error("no Chromium found. Set CHROME_PATH, or install one under ~/.cache/ms-playwright.");
  process.exit(2);
}

const app = express();
app.use(express.static(resolve("public"), { index: "v2.html" }));
const server = app.listen(0, async () => {
  const url = `http://127.0.0.1:${server.address().port}${page}`;
  // execFile, not spawnSync: a synchronous spawn blocks this process's event
  // loop, so the static server above could never answer Chromium's requests
  // and the page would hang forever waiting for its own assets.
  let res;
  try {
    res = await run(
      chrome,
      [
        "--headless", "--no-sandbox", "--disable-gpu",
        "--virtual-time-budget=6000",
        "--enable-logging=stderr", "--v=0",
        "--dump-dom", url,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    server.close();
    console.error(`chromium failed: ${err.message}`);
    process.exit(1);
  }
  server.close();

  // Blank out inline <script> bodies before comparing. --dump-dom returns the
  // script *source* as part of the document, so moving code between files
  // shifts every following line and swamps the diff — which is exactly the
  // change Phase 0 makes on purpose. What must not change is the rendered
  // result, so that is what gets compared.
  const dom = res.stdout.replace(
    /(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi,
    (_m, open, close) => `${open}/* inline script body elided for diffing */${close}`,
  );

  // Page-level problems only — the sandbox emits dbus/UPower noise that has
  // nothing to do with the page under test.
  const pageErrors = (res.stderr || "")
    .split("\n")
    .filter((l) => /error|exception|uncaught/i.test(l))
    // Chromium logs its own internals to the same stream (component updater,
    // GPU probing, dbus in a container). Page-origin messages are what matter.
    .filter((l) => !/dbus|UPower|gpu|sandbox|GLES|Vulkan|font|chrome\/browser\/|components\/|optimization_guide|component_updater|on-device model/i.test(l));

  if (savePath) {
    writeFileSync(savePath, dom);
    console.log(`saved ${(dom.length / 1024).toFixed(0)}KB of DOM to ${savePath}`);
  } else {
    const before = readFileSync(againstPath, "utf8");
    const a = before.split("\n");
    const b = dom.split("\n");
    const diffs = [];
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) diffs.push({ line: i + 1, before: a[i], after: b[i] });
    }
    const clockOnly = diffs.every((d) => /id="clock"/.test(d.before ?? "") || /id="clock"/.test(d.after ?? ""));
    const ranJs = !/id="clock">—</.test(dom);

    console.log(`${diffs.length} differing line(s) vs ${againstPath}`);
    for (const d of diffs.slice(0, 20)) {
      console.log(`  line ${d.line}:\n    - ${(d.before ?? "").trim().slice(0, 160)}\n    + ${(d.after ?? "").trim().slice(0, 160)}`);
    }
    if (!ranJs) {
      console.error("\nFAIL: #clock still shows its authored placeholder — the page rendered without its JavaScript.");
      process.exit(1);
    }
    if (diffs.length === 0 || clockOnly) {
      console.log("\nPASS: DOM identical apart from the live clock, and the clock proves the script ran.");
    } else {
      console.error("\nFAIL: the DOM changed beyond the clock.");
      process.exit(1);
    }
  }

  if (pageErrors.length) {
    console.error(`\n${pageErrors.length} page console error(s):`);
    for (const e of pageErrors.slice(0, 10)) console.error(`  ${e}`);
    process.exit(1);
  }
});
