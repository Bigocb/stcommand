/**
 * Process-wide ring buffer of recent server log lines, so an investigation can
 * ask "what did THEO-93 log in the last 20 minutes" without going out to the
 * hosting provider's log search (which returns every line mentioning a ship —
 * including the ~100-ship `fleet:` snapshot printed every few seconds).
 *
 * Debugging scaffolding, not an audit log: in memory, bounded, gone on
 * restart. Durable history lives in the ledger and `operator_actions`.
 */
export interface LogLine {
  at: number;
  tenantId: string;
  msg: string;
}

export interface LogQuery {
  /** Only this tenant's lines (plus tenant-less global lines, tenantId "?"). */
  tenantId?: string;
  /** Substring, case-insensitive. */
  text?: string;
  /** Lines mentioning this ship as a whole token (THEO-1 does not match THEO-1A). */
  ship?: string;
  sinceMs?: number;
  limit?: number;
  /** Include `fleet:` roll-ups and per-keeper snapshot chatter (default false). */
  noise?: boolean;
}

const NOISE = /^(fleet:|.*keeper: snapshot )/;

function shipRegex(ship: string): RegExp {
  const esc = ship.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9-])${esc}($|[^A-Za-z0-9-])`);
}

export class LogBuffer {
  private lines: LogLine[] = [];

  constructor(private readonly capacity = 8000, private readonly now: () => number = Date.now) {}

  push(tenantId: string, msg: string): void {
    this.lines.push({ at: this.now(), tenantId, msg });
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
  }

  size(): number {
    return this.lines.length;
  }

  /** Newest-last, at most `limit` (default 60) of the matching lines. */
  query(q: LogQuery = {}): LogLine[] {
    const text = q.text?.toLowerCase();
    const re = q.ship ? shipRegex(q.ship) : undefined;
    const since = q.sinceMs ?? 0;
    const out: LogLine[] = [];
    for (let i = this.lines.length - 1; i >= 0 && out.length < (q.limit ?? 60); i--) {
      const l = this.lines[i]!;
      if (l.at < since) break; // lines are time-ordered; nothing older can match
      if (q.tenantId && l.tenantId !== q.tenantId && l.tenantId !== "?") continue;
      if (!q.noise && NOISE.test(l.msg)) continue;
      if (text && !l.msg.toLowerCase().includes(text)) continue;
      if (re && !re.test(l.msg)) continue;
      out.push(l);
    }
    return out.reverse();
  }
}

export const logBuffer = new LogBuffer();
