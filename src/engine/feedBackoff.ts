/** How long a feed carrier waits after its margin gate blocks a buy: 30s, then doubling, up to 5 minutes. */
export const MARGIN_WAIT_MIN_MS = 30_000;
export const MARGIN_WAIT_MAX_MS = 5 * 60_000;

/** `blocks` is how many times in a row the gate has blocked (1 for the first). */
export function marginWaitMs(blocks: number): number {
  const n = Math.max(1, Math.floor(blocks));
  return Math.min(MARGIN_WAIT_MAX_MS, MARGIN_WAIT_MIN_MS * 2 ** (n - 1));
}
