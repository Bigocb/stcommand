/**
 * Cash a trader has set aside for the buy it is making (issue #88 P2). With trader tasks running side by side, two traders could
 * read the same wallet and both size a purchase against it; a reservation makes every other trader's spendable cash smaller by
 * what is already committed. Reading the wallet net of reservations and reserving happen in one synchronous stretch in the
 * trader, so there is no gap for another task to slip into. An error, if any, is on the safe side: the wallet the game reports
 * may already show part of a reserved buy, which is then subtracted twice (less spent, never more).
 *
 * In memory on purpose: a reservation lives for one buy pass (seconds), and a restart ends every pass, so there is nothing to
 * restore. Pure apart from the map it holds.
 */
export class CashReservations {
  private readonly held = new Map<string, number>();

  /** Set aside `amount` for `ship`'s current buy, replacing any it held. Returns the release. */
  reserve(ship: string, amount: number): () => void {
    const v = Math.max(0, Math.floor(amount));
    this.held.set(ship, v);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this.held.get(ship) === v) this.held.delete(ship);
    };
  }

  /** What every ship but `ship` has reserved. */
  othersThan(ship: string): number {
    let t = 0;
    for (const [s, v] of this.held) if (s !== ship) t += v;
    return t;
  }

  total(): number {
    let t = 0;
    for (const v of this.held.values()) t += v;
    return t;
  }
}
