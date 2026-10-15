/**
 * Live feed: small change events pushed to the screens, instead of each screen pulling the whole snapshot every 15 s.
 *
 * One hub per tenant. Every event gets the next sequence number and goes into a short ring buffer, so a screen that
 * reconnects (an iPhone coming back from the background) can ask for everything after the last number it saw. If that
 * number has already left the buffer, `since()` says so and the screen takes a fresh snapshot instead.
 *
 * Pure apart from calling the subscribers: no clock, no I/O.
 */

export interface LiveEvent {
  seq: number;
  type: string;
  data: unknown;
}

export class LiveFeed {
  private seq = 0;
  private readonly buffer: LiveEvent[] = [];
  private readonly subscribers = new Set<(e: LiveEvent) => void>();

  constructor(private readonly capacity = 1000) {}

  /** The number of the newest event (0 before the first). A snapshot is "as of" this number. */
  get lastSeq(): number {
    return this.seq;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  publish(type: string, data: unknown): LiveEvent {
    const e: LiveEvent = { seq: ++this.seq, type, data };
    this.buffer.push(e);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    for (const fn of this.subscribers) {
      try {
        fn(e);
      } catch {
        // One broken connection must not stop the others.
      }
    }
    return e;
  }

  /**
   * Every event after `after`, oldest first. Undefined when some of them have already left the buffer (or `after` is
   * from a different run of the server, i.e. ahead of us): the caller must send a fresh snapshot.
   */
  since(after: number): LiveEvent[] | undefined {
    if (!Number.isFinite(after) || after < 0 || after > this.seq) return undefined;
    if (after === this.seq) return [];
    const first = this.buffer[0];
    if (!first || first.seq > after + 1) return undefined;
    return this.buffer.filter((e) => e.seq > after);
  }

  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}
