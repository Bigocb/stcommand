import { DEFAULT_START_POLICY, scoreStart, type StartFacts, type StartPolicy, type StartScore } from "./startScore.js";

/**
 * Register several agents and rank their starting systems. The network parts are ports, so this runs against fakes in tests and
 * against the real API from src/cli/scoutStarts.ts. Registration is the only side effect, and nothing registers unless `go` is set.
 */

export const MAX_SCOUT_COUNT = 10;

export interface ScoutPorts {
  register(symbol: string): Promise<{ token: string; agentSymbol: string; headquarters: string }>;
  /** Read the home system (waypoints, market lists, gate) with the new agent's own token. */
  read(token: string, headquarters: string, agentSymbol: string): Promise<StartFacts>;
  /** Pause between registrations; the game rate-limits them. */
  sleep?(ms: number): Promise<void>;
  /** Suffix that makes a symbol unique: 3-14 letters and digits in all. */
  suffix?(i: number): string;
}

export interface ScoutResult extends StartScore {
  agentSymbol: string;
  headquarters: string;
  system: string;
  token: string;
}

export interface ScoutOutcome {
  results: ScoutResult[];
  errors: { symbol: string; error: string }[];
  /** What would have been registered when `go` is off. */
  planned: string[];
}

function defaultSuffix(): string {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

export function scoutSymbol(prefix: string, suffix: string): string {
  return `${prefix}${suffix}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 14);
}

export async function scoutStarts(opts: { count: number; prefix: string; ports: ScoutPorts; go: boolean; policy?: StartPolicy; delayMs?: number }): Promise<ScoutOutcome> {
  const { count, prefix, ports } = opts;
  if (!Number.isInteger(count) || count < 1 || count > MAX_SCOUT_COUNT) throw new Error(`count must be 1 to ${MAX_SCOUT_COUNT}`);
  if (!/^[A-Za-z0-9]{1,9}$/.test(prefix)) throw new Error("prefix must be 1 to 9 letters or digits");
  const suffix = ports.suffix ?? defaultSuffix;
  const symbols = Array.from({ length: count }, (_, i) => scoutSymbol(prefix, suffix(i)));
  if (new Set(symbols).size !== symbols.length) throw new Error("symbols are not unique");
  for (const s of symbols) if (s.length < 3) throw new Error(`symbol ${s} is too short`);
  if (!opts.go) return { results: [], errors: [], planned: symbols };

  const results: ScoutResult[] = [];
  const errors: { symbol: string; error: string }[] = [];
  for (const [i, symbol] of symbols.entries()) {
    try {
      if (i > 0 && ports.sleep) await ports.sleep(opts.delayMs ?? 1500);
      const reg = await ports.register(symbol);
      const facts = await ports.read(reg.token, reg.headquarters, reg.agentSymbol);
      results.push({ ...scoreStart(facts, opts.policy ?? DEFAULT_START_POLICY), agentSymbol: reg.agentSymbol, headquarters: reg.headquarters, system: facts.system, token: reg.token });
    } catch (err) {
      errors.push({ symbol, error: err instanceof Error ? err.message : String(err) });
    }
  }
  results.sort((a, b) => b.score - a.score || a.agentSymbol.localeCompare(b.agentSymbol));
  return { results, errors, planned: symbols };
}
