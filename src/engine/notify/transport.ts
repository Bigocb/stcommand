import type { Severity } from "./types.js";

/**
 * Delivery channels. A channel takes one message for one device and says whether it arrived; the policy upstream has
 * already decided whether to send. To add a channel (Discord, e-mail), implement PushTransport for its kind of target and
 * hand it to the service; nothing else changes.
 */

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  severity: Severity;
  /** A later message with the same tag replaces the earlier one on the device instead of stacking. */
  tag?: string;
  /** The count for the app icon, when the device supports one. 0 clears it. */
  badge?: number;
}

export type SendResult = { ok: true } | { ok: false; /** The push service says this subscription no longer exists (404/410). */ gone: boolean; status?: number; error: string };

export interface PushTransport {
  send(target: PushTarget, message: PushMessage): Promise<SendResult>;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** A mailto: or https: contact the push services can reach, required by the protocol. */
  subject: string;
}

/** Keys come from the environment (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT); without both keys push is simply off. */
export function vapidFromEnv(env: Record<string, string | undefined> = process.env): VapidConfig | undefined {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return undefined;
  return { publicKey, privateKey, subject: env.VAPID_SUBJECT?.trim() || "mailto:operator@example.invalid" };
}

/**
 * The web-push library is loaded the first time something is sent, not when the server starts. Push is off until VAPID
 * keys are set, and a server that has not run `npm ci` since the library was added must still boot.
 */
type WebPushLib = typeof import("web-push");
async function loadWebPush(): Promise<WebPushLib> {
  return (await import("web-push")).default;
}

/** Browser push through the web-push protocol. The payload is a small JSON the service worker turns into a notification. */
export class WebPushTransport implements PushTransport {
  constructor(private readonly vapid: VapidConfig, private readonly load: () => Promise<WebPushLib> = loadWebPush) {}

  async send(target: PushTarget, message: PushMessage): Promise<SendResult> {
    const payload = JSON.stringify({ title: message.title, body: message.body, url: message.url ?? "/m", severity: message.severity, tag: message.tag, badge: message.badge });
    try {
      const webpush = await this.load().catch(() => {
        throw new Error("the web-push library is not installed on this server (run npm ci)");
      });
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        payload,
        {
          vapidDetails: { subject: this.vapid.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
          TTL: 60 * 60,
          // Critical things may wake the phone; the rest wait for it to be awake.
          urgency: message.severity === "critical" ? "high" : message.severity === "warning" ? "normal" : "low",
        },
      );
      return { ok: true };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      return { ok: false, gone: status === 404 || status === 410, status, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
