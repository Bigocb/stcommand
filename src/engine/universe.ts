/**
 * The key for "this agent, in this week's universe": `<agent symbol>@<reset date>`, e.g. `THEOREM@2026-10-11`.
 *
 * The game resets weekly into a different universe, and ship symbols (THEO-1, THEOREM-1) are reused every week, so a
 * row that names a ship cannot say which week it belongs to. Stamping this key on a ledger row says so, which is what
 * lets a week's rows be kept for comparison without leaking into another week's numbers: the symbol keeps agents apart,
 * the date keeps weeks apart. It matches how `run_results` is keyed (agent symbol + the universe's reset date).
 *
 * Pure: no I/O, no clock. The agent symbol comes from the game, the reset date from the game's public status.
 */

const SYMBOL_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Strict on purpose: the key is interpolated into a SET LOCAL statement, which cannot take a bound parameter. */
const KEY_RE = /^[A-Za-z0-9_-]{1,40}@\d{4}-\d{2}-\d{2}$/;

/** The key for an agent in a universe, or undefined when either part is missing or malformed. Symbols compare upper-case. */
export function universeKey(agentSymbol: string | undefined, resetDate: string | undefined): string | undefined {
  if (!agentSymbol || !resetDate) return undefined;
  if (!SYMBOL_RE.test(agentSymbol) || !DATE_RE.test(resetDate)) return undefined;
  return `${agentSymbol.toUpperCase()}@${resetDate}`;
}

export function isUniverseKey(key: string | undefined): key is string {
  return key !== undefined && KEY_RE.test(key);
}

/** Splits a key back into its agent symbol and reset date, or undefined if it is not a key. */
export function parseUniverseKey(key: string): { agentSymbol: string; resetDate: string } | undefined {
  if (!KEY_RE.test(key)) return undefined;
  const at = key.lastIndexOf("@");
  return { agentSymbol: key.slice(0, at), resetDate: key.slice(at + 1) };
}
