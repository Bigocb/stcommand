/**
 * Tower's service worker: receives web-push messages and shows them, and opens Tower when one is tapped.
 * It caches nothing and intercepts no requests, so it can never serve a stale page. The server sends a small JSON
 * payload { title, body, url, severity, tag } (src/engine/notify/transport.ts).
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Tower", body: event.data ? event.data.text() : "" }; }
  const title = data.title || "Tower";
  // The icon badge: how many things need a person. Not every platform has one; where there is none this does nothing.
  const nav = self.navigator;
  const badge = typeof data.badge === "number" && nav
    ? (data.badge > 0 ? (nav.setAppBadge ? nav.setAppBadge(data.badge) : null) : (nav.clearAppBadge ? nav.clearAppBadge() : null))
    : null;
  event.waitUntil(Promise.resolve(badge).catch(() => {}).then(() => self.registration.showNotification(title, {
    body: data.body || "",
    // The same tag replaces the earlier notification for that condition instead of stacking another.
    tag: data.tag || undefined,
    icon: "/icons/tower-icon-192.png",
    badge: "/icons/tower-favicon-32.png",
    data: { url: data.url || "/m" },
    requireInteraction: data.severity === "critical",
  })));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/m", self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).pathname.startsWith("/m"));
    if (open) {
      await open.focus();
      open.postMessage({ type: "tower-open", url: target });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
