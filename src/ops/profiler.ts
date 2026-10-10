/**
 * In-process profiling for the operator: where the CPU goes and what holds memory, on the running server.
 *
 * Built for "why did the server grow so much": the Render box has 0.5 vCPU and 512 MB, and a log line can say a step took
 * 300 s without saying why. Uses the Node inspector in-process (no port is opened). The aggregation functions are pure so
 * they can be tested on a small fixture; the session handling at the bottom is the only part that touches the runtime.
 */
import inspector from "node:inspector";
import v8 from "node:v8";
import { monitorEventLoopDelay } from "node:perf_hooks";

// ── shapes of what the inspector returns (only the fields used) ──

export interface CallFrame { functionName: string; url: string; lineNumber: number; columnNumber?: number }
export interface CpuNode { id: number; callFrame: CallFrame; hitCount?: number; children?: number[] }
export interface CpuProfile { nodes: CpuNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] }

export interface HeapNode { callFrame: CallFrame; selfSize: number; id: number; children: HeapNode[] }
export interface HeapProfile { head: HeapNode }

const clean = (url: string): string => url.replace(/^file:\/\//, "").replace(/^.*\/(dist|src|node_modules)\//, "$1/");
const label = (f: CallFrame): string => `${f.functionName || "(anonymous)"} ${clean(f.url) || "(native)"}:${f.lineNumber + 1}`;
const isSystem = (f: CallFrame): boolean => ["(idle)", "(program)", "(garbage collector)", "(root)"].includes(f.functionName);

export interface CpuSummary {
  windowMs: number;
  /** Share of the window the process was running JavaScript (not idle), 0..1. */
  busyShare: number;
  idleMs: number;
  gcMs: number;
  programMs: number;
  top: { fn: string; selfMs: number; share: number }[];
  byFile: { file: string; selfMs: number; share: number }[];
}

/** Self time per function and per file, from a V8 CPU profile. */
export function summarizeCpuProfile(p: CpuProfile, topN = 40): CpuSummary {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const self = new Map<number, number>();
  const samples = p.samples ?? [];
  const deltas = p.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i += 1) self.set(samples[i]!, (self.get(samples[i]!) ?? 0) + (deltas[i] ?? 0));
  const windowUs = Math.max(1, p.endTime - p.startTime);
  let idle = 0, gc = 0, program = 0;
  const fn = new Map<string, number>();
  const file = new Map<string, number>();
  for (const [id, us] of self) {
    const node = byId.get(id);
    if (!node) continue;
    const name = node.callFrame.functionName;
    if (name === "(idle)") { idle += us; continue; }
    if (name === "(garbage collector)") { gc += us; continue; }
    if (name === "(program)" || name === "(root)") { program += us; continue; }
    fn.set(label(node.callFrame), (fn.get(label(node.callFrame)) ?? 0) + us);
    const f = clean(node.callFrame.url) || "(native)";
    file.set(f, (file.get(f) ?? 0) + us);
  }
  const rank = <K extends string>(m: Map<string, number>, key: K) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k, us]) => ({ [key]: k, selfMs: Math.round(us / 1000), share: Math.round((us / windowUs) * 1000) / 1000 }));
  return {
    windowMs: Math.round(windowUs / 1000),
    busyShare: Math.round(((windowUs - idle) / windowUs) * 1000) / 1000,
    idleMs: Math.round(idle / 1000), gcMs: Math.round(gc / 1000), programMs: Math.round(program / 1000),
    top: rank(fn, "fn") as CpuSummary["top"],
    byFile: rank(file, "file") as CpuSummary["byFile"],
  };
}

export interface HeapSummary {
  totalBytes: number;
  /** Bytes still live from allocations since sampling began, by allocating function, with the calling stack. */
  top: { fn: string; bytes: number; share: number; stack: string[] }[];
  byFile: { file: string; bytes: number; share: number }[];
}

/** Live bytes by allocation site, from a sampling heap profile (allocations that have not been freed). */
export function summarizeHeapProfile(p: HeapProfile, topN = 40): HeapSummary {
  const sites = new Map<string, { bytes: number; stack: string[] }>();
  const files = new Map<string, number>();
  let total = 0;
  const walk = (n: HeapNode, stack: string[]): void => {
    const here = isSystem(n.callFrame) ? stack : [...stack, label(n.callFrame)];
    if (n.selfSize > 0) {
      total += n.selfSize;
      const key = here.at(-1) ?? "(unknown)";
      const cur = sites.get(key) ?? { bytes: 0, stack: here.slice(-4, -1) };
      cur.bytes += n.selfSize;
      sites.set(key, cur);
      const f = clean(n.callFrame.url) || "(native)";
      files.set(f, (files.get(f) ?? 0) + n.selfSize);
    }
    for (const c of n.children) walk(c, here);
  };
  walk(p.head, []);
  const share = (b: number) => Math.round((b / Math.max(1, total)) * 1000) / 1000;
  return {
    totalBytes: total,
    top: [...sites.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, topN).map(([fn, s]) => ({ fn, bytes: s.bytes, share: share(s.bytes), stack: s.stack })),
    byFile: [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([file, bytes]) => ({ file, bytes, share: share(bytes) })),
  };
}

// ── runtime side ──

let session: inspector.Session | undefined;
let heapSamplingSince: number | undefined;

function sess(): inspector.Session {
  if (!session) { session = new inspector.Session(); session.connect(); }
  return session;
}

function post<T = unknown>(method: string, params?: object): Promise<T> {
  return new Promise((resolve, reject) => {
    sess().post(method, params as never, (err: Error | null, res: unknown) => (err ? reject(err) : resolve(res as T)));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Profile the CPU for `seconds` (1-30) and summarize it. */
export async function profileCpu(seconds: number): Promise<CpuSummary> {
  const s = Math.min(30, Math.max(1, Math.round(seconds)));
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 1000 });
  await post("Profiler.start");
  await sleep(s * 1000);
  const { profile } = await post<{ profile: CpuProfile }>("Profiler.stop");
  await post("Profiler.disable");
  return summarizeCpuProfile(profile);
}

export async function heapStart(): Promise<{ startedAt: string }> {
  await post("HeapProfiler.enable");
  await post("HeapProfiler.startSampling", { samplingInterval: 16384 });
  heapSamplingSince = Date.now();
  return { startedAt: new Date(heapSamplingSince).toISOString() };
}

export async function heapReport(): Promise<HeapSummary & { since: string | null }> {
  if (heapSamplingSince === undefined) throw new Error("heap sampling is not running; call heap_start first");
  const { profile } = await post<{ profile: HeapProfile }>("HeapProfiler.getSamplingProfile");
  return { since: new Date(heapSamplingSince).toISOString(), ...summarizeHeapProfile(profile) };
}

export async function heapStop(): Promise<{ stopped: boolean }> {
  if (heapSamplingSince === undefined) return { stopped: false };
  await post("HeapProfiler.stopSampling");
  await post("HeapProfiler.disable");
  heapSamplingSince = undefined;
  return { stopped: true };
}

/** Process memory, V8 heap, and event-loop delay over a short window. */
export async function runtimeStatus(windowMs = 3000): Promise<Record<string, unknown>> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  await sleep(windowMs);
  h.disable();
  const mb = (n: number) => Math.round(n / 1048576);
  const m = process.memoryUsage();
  const hs = v8.getHeapStatistics();
  const cpu = process.cpuUsage();
  return {
    uptimeMin: Math.round(process.uptime() / 60),
    rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers),
    heapLimitMb: mb(hs.heap_size_limit), mallocedMb: mb(hs.malloced_memory), detachedContexts: hs.number_of_detached_contexts,
    cpuSecondsSinceBoot: Math.round((cpu.user + cpu.system) / 1e6),
    eventLoopDelayMs: { p50: +(h.percentile(50) / 1e6).toFixed(1), p99: +(h.percentile(99) / 1e6).toFixed(1), max: +(h.max / 1e6).toFixed(1) },
    heapSamplingRunning: heapSamplingSince !== undefined,
    heapSpaces: v8.getHeapSpaceStatistics().map((s) => ({ space: s.space_name, usedMb: mb(s.space_used_size) })).filter((s) => s.usedMb > 0),
  };
}
