/**
 * Which build is this process? (operator, 2026-11-08: "yes, do the label changes", after the question "is the box really running main?"
 * could not be answered from outside: /version.json said "local" because the label only read RENDER_GIT_COMMIT, a Render variable this
 * box does not have.)
 *
 * Pure: the caller reads the environment, the git HEAD and the file times and passes them in. The commit comes from, in order:
 * RENDER_GIT_COMMIT, GIT_COMMIT, BUILD_COMMIT (a deploy script can set any of them), then `git rev-parse HEAD` in the app's directory,
 * else "local". `loadedFileMtime` is the modification time of the file this process is running from (dist/cli/index.js for `npm start`):
 * if it is older than the commit's date, the box pulled but did not rebuild, which `npm start` hides because it runs dist/, not src/.
 */

export type BuildSource = "env" | "git" | "none";

export interface BuildInfo {
  /** Seven characters of the commit, or "local". */
  build: string;
  source: BuildSource;
  /** When this process started, ISO. */
  startedAt: string;
  /** Modification time of the file the process runs from, ISO; absent when it could not be read. */
  loadedFileMtime?: string;
}

export interface BuildInput {
  env: Record<string, string | undefined>;
  /** Output of `git rev-parse HEAD` (full or short), if it could be read. */
  gitHead?: string;
  startedAtMs: number;
  loadedFileMtimeMs?: number;
}

const ENV_KEYS = ["RENDER_GIT_COMMIT", "GIT_COMMIT", "BUILD_COMMIT"] as const;
const SHORT = 7;

function clean(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  return /^[0-9a-f]{7,40}$/i.test(s) ? s.slice(0, SHORT).toLowerCase() : "";
}

export function resolveBuildInfo(input: BuildInput): BuildInfo {
  let build = "";
  let source: BuildSource = "none";
  for (const key of ENV_KEYS) {
    const v = clean(input.env[key]);
    if (v) { build = v; source = "env"; break; }
  }
  if (!build) {
    const g = clean(input.gitHead);
    if (g) { build = g; source = "git"; }
  }
  return {
    build: build || "local",
    source,
    startedAt: new Date(input.startedAtMs).toISOString(),
    ...(input.loadedFileMtimeMs !== undefined && Number.isFinite(input.loadedFileMtimeMs)
      ? { loadedFileMtime: new Date(input.loadedFileMtimeMs).toISOString() }
      : {}),
  };
}

/** The running process's build, set once at startup (cli/index.ts) and read by the MCP server's initialize response. */
let current: BuildInfo | undefined;

export function setBuildInfo(info: BuildInfo): void {
  current = info;
}

export function currentBuildInfo(): BuildInfo | undefined {
  return current;
}
