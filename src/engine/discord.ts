import type { ActivityEntry } from "../db/store.js";

/**
 * Straders' original `getDiscord()` module-level singleton is gone —
 * deliberately, not an oversight. One process now serves every tenant
 * (docs/architecture-plan.md §5), and a shared singleton would mean tenant
 * A's ship purchases posting to tenant B's Discord channel the moment both
 * had a webhook configured. `TenantRegistry` constructs one `DiscordRelay`
 * per tenant instead, seeded from that tenant's `discord_webhook_enc`
 * column (src/db/tenants.ts), and hands it to that tenant's `FleetManager`
 * alone.
 */
interface DiscordPayload {
  content?: string;
  embeds?: {
    title?: string;
    description?: string;
    color?: number;
    fields?: { name: string; value: string; inline?: boolean }[];
    timestamp?: string;
  }[];
}

export class DiscordRelay {
  private webhookUrl: string | null = null;
  private lastPost = 0;
  // Separate from webhookUrl so pausing from the UI doesn't discard the
  // saved URL — resuming later is just flipping this back, not re-entering it.
  private enabled = true;

  setWebhook(url: string): void {
    this.webhookUrl = url;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private canPost(): boolean {
    // Rate-limit ourselves to one Discord post per 30s to avoid spam.
    if (Date.now() - this.lastPost < 30_000) return false;
    this.lastPost = Date.now();
    return true;
  }

  async postStatus(credits: number, ships: number, netProfit: number): Promise<void> {
    if (!this.webhookUrl || !this.enabled || !this.canPost()) return;
    const payload: DiscordPayload = {
      embeds: [{
        title: "Startraders Fleet Status",
        color: 0x4fd1c5,
        fields: [
          { name: "Credits", value: credits.toLocaleString("en-US"), inline: true },
          { name: "Ships", value: String(ships), inline: true },
          { name: "Net Profit", value: netProfit.toLocaleString("en-US"), inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
    };
    await this.send(payload);
  }

  async postActivity(entry: ActivityEntry): Promise<void> {
    if (!this.webhookUrl || !this.enabled) return;
    // Only post notable events immediately.
    if (entry.kind !== "sell" && entry.kind !== "buy" && entry.kind !== "ship") return;
    const payload: DiscordPayload = {
      embeds: [{
        description: `**${entry.shipSymbol}** ${entry.kind}: ${entry.detail}${entry.credits != null ? ` (${entry.credits >= 0 ? "+" : ""}${entry.credits.toLocaleString("en-US")}c)` : ""}`,
        color: entry.kind === "sell" ? 0x7dd87d : entry.kind === "buy" ? 0xff6b6b : 0xffb454,
        timestamp: entry.timestamp,
      }],
    };
    await this.send(payload);
  }

  private async send(payload: DiscordPayload): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // fetch() only rejects on a network failure — Discord rejecting the
      // webhook (bad/deleted URL, malformed payload, rate limit) comes back
      // as a normal response with a non-2xx status, which the old code never
      // checked. That silently dropped every post with no trace anywhere.
      if (!res.ok) {
        console.error(`[discord] webhook post rejected: ${res.status} ${res.statusText} — ${await res.text()}`);
      }
    } catch (err) {
      console.error("[discord] webhook post failed", err);
    }
  }
}
