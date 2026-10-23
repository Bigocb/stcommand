import type { DeliveryState, NotifyPrefs } from "./types.js";

/** One device that asked to be notified. */
export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  /** The device's choices, merged over DEFAULT_PREFS when read. */
  prefs: Partial<NotifyPrefs>;
  delivery: DeliveryState;
  lastSentAt: string | null;
  failures: number;
  lastError: string | null;
}

/** What the notification service and the HTTP routes need from storage. Store implements it; tests use a fake. */
export interface PushStore {
  upsertPushSubscription(tenantId: string, sub: { endpoint: string; p256dh: string; auth: string; userAgent?: string | null; prefs?: Partial<NotifyPrefs> }): Promise<PushSubscriptionRow>;
  listPushSubscriptions(tenantId: string): Promise<PushSubscriptionRow[]>;
  getPushSubscription(tenantId: string, endpoint: string): Promise<PushSubscriptionRow | undefined>;
  setPushPrefs(tenantId: string, endpoint: string, prefs: Partial<NotifyPrefs>): Promise<boolean>;
  /** Save what a device has been told; `error` records a failed send, `sent` a delivered one. */
  savePushDelivery(tenantId: string, id: string, delivery: DeliveryState, outcome?: { sent?: boolean; error?: string }): Promise<void>;
  deletePushSubscription(tenantId: string, endpoint: string): Promise<boolean>;
}
