/**
 * A value that is recomputed in the background, never while the caller waits.
 *
 * The coordinator's core pass awaited the contract buy targets (a contract fetch, a gate-path check and market lookups, all network)
 * and one pass took 20.8 s in it on 2026-10-31 while the API was rate limiting; every ship's dispatch waited. The answer changes slowly
 * and being a few seconds stale costs nothing, so the caller gets the last value at once and a refresh runs behind it.
 *
 * Pure apart from the clock, which is injected. The first call waits for one computation (there is nothing to return yet); a failed
 * computation keeps the last good value (or the initial one) and is tried again at the next call after the TTL.
 */
export class StaleWhileRevalidate<T> {
  private value: T;
  private has = false;
  private at = -Infinity;
  private inflight: Promise<void> | undefined;

  constructor(
    private readonly ttlMs: number,
    private readonly compute: () => Promise<T>,
    initial: T,
    private readonly now: () => number = Date.now,
    private readonly onError: (err: unknown) => void = () => {},
  ) {
    this.value = initial;
  }

  async get(): Promise<T> {
    if (!this.has) await this.refresh();
    else if (this.now() - this.at >= this.ttlMs) void this.refresh();
    return this.value;
  }

  /** Forget how old the value is: the next get() returns it and recomputes behind it. */
  invalidate(): void {
    this.at = -Infinity;
  }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.compute()
      .then((v) => { this.value = v; this.has = true; this.at = this.now(); })
      .catch((err) => { this.at = this.now(); this.has = true; this.onError(err); })
      .finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
}
