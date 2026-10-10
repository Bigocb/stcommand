#!/usr/bin/env node
/**
 * Production entry point: run the compiled server (dist/, built by `npm install` via postinstall).
 *
 * Why not `tsx src/cli/index.ts`: under `npm start` that is four processes (npm, sh, the tsx launcher, then the app),
 * and the app itself carries tsx's loader and source maps. Measured 2026-10-10 on an empty database: 259 MB for the tsx
 * tree against about 100 MB for the compiled server, on a 512 MB box that was creeping towards its limit.
 *
 * Imports the server in this same process, so there is no wrapper. If dist/ is missing (a build that was skipped) it
 * falls back to tsx rather than crash-looping the service, and says so.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiled = resolve(root, "dist/cli/index.js");

if (existsSync(compiled)) {
  await import(pathToFileURL(compiled).href);
} else {
  console.error("[start] dist/cli/index.js not found — run `npm run build`. Falling back to tsx (uses far more memory).");
  const child = spawn(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, "src/cli/index.ts")], { stdio: "inherit", cwd: root });
  child.on("exit", (code) => process.exit(code ?? 1));
}
