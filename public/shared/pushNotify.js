/**
 * Push notification settings for this device, shared so Deck can mount it the same way as Tower.
 *
 *   const n = mountNotifications(rootEl, { api });
 *   n.show();   // reads this device's state and draws it
 *
 * The root needs the elements in m.html's #more-sec-notify (ids notify-*). Talks to /api/push/* (src/http/push.ts).
 * The permission prompt must come from a tap, never from page load: that is a browser rule, and iOS enforces it hardest.
 */
import { escapeHtml } from "/shared/domain.js";
import { pushSupport, urlBase64ToUint8Array } from "/shared/pushSupport.js";

const SW_URL = "/sw-tower.js";
const SW_SCOPE = "/m";
const h = (s) => escapeHtml(String(s ?? ""));

const toMin = (hhmm) => { const [a, b] = String(hhmm || "0:0").split(":").map(Number); return ((a || 0) * 60 + (b || 0)) % 1440; };
const toHhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function mountNotifications(root, { api }) {
  const $ = (id) => root.querySelector(`#${id}`) ?? document.getElementById(id);
  let config = null;
  let endpoint = null;
  let saveTimer;

  const status = (text, tone) => { const el = $("notify-status"); el.textContent = text; el.style.color = tone === "bad" ? "var(--red)" : tone === "ok" ? "var(--green)" : ""; };
  const registration = async () => (await navigator.serviceWorker.getRegistration(SW_SCOPE)) ?? navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  /** Wait for this registration's worker to be active. (navigator.serviceWorker.ready only answers for the page's own scope.) */
  const active = (reg) => new Promise((resolve, reject) => {
    const sw = reg.active ?? reg.waiting ?? reg.installing;
    if (!sw) return reject(new Error("the service worker did not install"));
    if (sw.state === "activated") return resolve(reg);
    const t = setTimeout(() => reject(new Error("the service worker took too long to start")), 15_000);
    sw.addEventListener("statechange", () => {
      if (sw.state === "activated") { clearTimeout(t); resolve(reg); }
      else if (sw.state === "redundant") { clearTimeout(t); reject(new Error("the service worker failed to install")); }
    });
  });

  function readPrefs() {
    const categories = {};
    root.querySelectorAll("[data-notify-cat]").forEach((el) => { categories[el.dataset.notifyCat] = el.checked; });
    const quiet = $("notify-quiet-on").checked
      ? { startMin: toMin($("notify-quiet-start").value), endMin: toMin($("notify-quiet-end").value), tzOffsetMin: -new Date().getTimezoneOffset(), allowCritical: $("notify-quiet-crit").checked }
      : null;
    const prefs = { categories, maxPerHour: Number($("notify-cap").value) || 6, statusEveryHours: Number($("notify-status-every").value) || 1 };
    if (quiet) prefs.quietHours = quiet;
    return prefs;
  }

  function drawPrefs(prefs) {
    $("notify-cats").innerHTML = config.categories.map((c) => `
      <label class="notify-cat"><input type="checkbox" data-notify-cat="${h(c.id)}"${(prefs.categories?.[c.id] ?? c.defaultOn) ? " checked" : ""}>
        <span><b>${h(c.label)}</b><br><small>${h(c.description)}</small></span></label>`).join("");
    const q = prefs.quietHours;
    $("notify-quiet-on").checked = !!q;
    if (q) { $("notify-quiet-start").value = toHhmm(q.startMin); $("notify-quiet-end").value = toHhmm(q.endMin); $("notify-quiet-crit").checked = q.allowCritical !== false; }
    $("notify-cap").value = prefs.maxPerHour ?? 6;
    $("notify-status-every").value = String(prefs.statusEveryHours ?? 1);
  }

  async function savePrefs() {
    if (!endpoint) return;
    try { await api("PUT", "/api/push/prefs", { endpoint, prefs: readPrefs() }); status("Saved.", "ok"); }
    catch (err) { status(`Could not save: ${err.message ?? err}`, "bad"); }
  }
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(savePrefs, 400); };

  async function enable() {
    const sup = pushSupport();
    if (!sup.ok) return status(sup.reason, "bad");
    try {
      const perm = await Notification.requestPermission(); // from a tap, as the browser requires
      if (perm !== "granted") return status("Permission was not given. You can allow it in the browser's site settings.", "bad");
      const reg = await active(await registration());
      const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.publicKey) });
      const r = await api("POST", "/api/push/subscribe", { subscription: sub.toJSON(), prefs: readPrefs() });
      endpoint = sub.endpoint;
      drawPrefs(r.prefs);
      await show();
      status("Notifications are on for this device.", "ok");
    } catch (err) { status(`Could not turn on notifications: ${err.message ?? err}`, "bad"); }
  }

  async function disable() {
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
      const sub = await reg?.pushManager.getSubscription();
      if (sub) { await api("POST", "/api/push/unsubscribe", { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      endpoint = null;
      await show();
      status("Notifications are off for this device.");
    } catch (err) { status(`Could not turn them off: ${err.message ?? err}`, "bad"); }
  }

  async function test() {
    if (!endpoint) return;
    try { await api("POST", "/api/push/test", { endpoint }); status("Test sent. It should arrive in a few seconds.", "ok"); }
    catch (err) { status(`Test failed: ${err.message ?? err}`, "bad"); }
  }

  async function show() {
    try { config = await api("GET", "/api/push/config"); } catch { return status("Could not reach the server.", "bad"); }
    const show = (id, on) => { $(id).hidden = !on; };
    if (!config.enabled) { show("notify-enable", false); show("notify-test", false); show("notify-off", false); show("notify-prefs", false); return status("Push notifications are not set up on this server yet (no VAPID keys)."); }
    const sup = pushSupport();
    if (!sup.ok) { show("notify-enable", false); show("notify-test", false); show("notify-off", false); show("notify-prefs", false); return status(sup.reason); }
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    const sub = await reg?.pushManager.getSubscription();
    endpoint = sub?.endpoint ?? null;
    let saved = null;
    if (endpoint) { try { const r = await api("GET", `/api/push/subscription?endpoint=${encodeURIComponent(endpoint)}`); if (r.subscribed) saved = r; else endpoint = null; } catch { /* leave as not subscribed */ } }
    show("notify-enable", !saved); show("notify-test", !!saved); show("notify-off", !!saved); show("notify-prefs", !!saved);
    if (saved) {
      drawPrefs(saved.prefs);
      status(saved.failures > 0 ? `On for this device. The last ${saved.failures} send(s) failed: ${saved.lastError ?? "unknown error"}` : "On for this device.", saved.failures > 0 ? "bad" : "ok");
    } else status(Notification.permission === "denied" ? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again." : "Off for this device.");
  }

  $("notify-enable").addEventListener("click", enable);
  $("notify-off").addEventListener("click", disable);
  $("notify-test").addEventListener("click", test);
  $("notify-prefs").addEventListener("change", saveSoon);

  return { show, hide() { clearTimeout(saveTimer); } };
}

/** A tap on a notification while Tower is open arrives as a message from the service worker; this routes it. */
export function listenForNotificationTaps(onOpen) {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.type === "tower-open") onOpen(new URL(e.data.url).hash.replace(/^#/, "")); });
}
