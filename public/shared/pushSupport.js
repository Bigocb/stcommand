/**
 * What this browser can do about push, with no imports so it can be tested on its own. Used by shared/pushNotify.js.
 */

export function urlBase64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** What this browser can do, and the one thing a person must do first if it is not ready. */
export function pushSupport(win = window, nav = navigator) {
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent || "");
  const standalone = nav.standalone === true || (win.matchMedia && win.matchMedia("(display-mode: standalone)").matches);
  if (ios && !standalone) return { ok: false, reason: "On iPhone, add Tower to your Home Screen first (Share, then Add to Home Screen) and open it from there. Notifications only work in the installed app." };
  if (!("serviceWorker" in nav) || !("PushManager" in win) || !("Notification" in win)) return { ok: false, reason: "This browser does not support push notifications." };
  return { ok: true };
}

