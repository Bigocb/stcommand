import { readFileSync } from "node:fs";
import v8 from "node:v8";
import { parseCgroupMemory, type CgroupMemory } from "./containerStats.js";

/** The I/O half of containerStats.ts: read the cgroup memory files (v2, else v1) and parse them. A file that cannot be read is skipped. */
export function readCgroupMemory(root = "/sys/fs/cgroup"): CgroupMemory {
  const read = (p: string): string | undefined => { try { return readFileSync(`${root}/${p}`, "utf8"); } catch { return undefined; } };
  return parseCgroupMemory({
    v2: { max: read("memory.max"), current: read("memory.current"), peak: read("memory.peak"), events: read("memory.events"), stat: read("memory.stat") },
    v1: { limit: read("memory/memory.limit_in_bytes"), usage: read("memory/memory.usage_in_bytes"), maxUsage: read("memory/memory.max_usage_in_bytes"), oomControl: read("memory/memory.oom_control"), stat: read("memory/memory.stat") },
  });
}

const mb = (n: number | null): number | null => (n === null ? null : Math.round(n / 1048576));

/** This process's memory and the container's, in MB, for the heartbeat row (migration 070). */
export function processMemorySample(): { rssMb: number; heapUsedMb: number; heapLimitMb: number; cgroupCurrentMb: number | null; cgroupLimitMb: number | null; oomKills: number | null } {
  const m = process.memoryUsage();
  const cg = readCgroupMemory();
  return {
    rssMb: mb(m.rss)!, heapUsedMb: mb(m.heapUsed)!, heapLimitMb: mb(v8.getHeapStatistics().heap_size_limit)!,
    cgroupCurrentMb: mb(cg.currentBytes), cgroupLimitMb: mb(cg.limitBytes), oomKills: cg.oomKills,
  };
}
