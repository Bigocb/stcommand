/**
 * Live feed client: one server-sent-events connection per open screen (GET /api/live). The server pushes small
 * changes (ships, credits, activity) as they happen; this applies them to the shared store, so screens update within
 * a couple of seconds and the 15-second poll can slow down while the feed is connected.
 *
 *   startLive();          // once, after sign-in
 *   liveConnected();      // true while the stream is open: poll the state less often
 *
 * The browser reconnects on its own and resends the last event number, so the server sends only what was missed. An
 * iPhone closes the connection when Tower goes to the background; coming back reopens it.
 */
import { applyCredits, applyShipRows, pushActivity } from "/shared/store.js";

let source = null;

function open() {
  if (typeof EventSource === "undefined") return;
  source = new EventSource("/api/live");
  const on = (type, fn) => source.addEventListener(type, (e) => {
    try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); }
  });
  on("snapshot", (d) => { applyShipRows(d.ships ?? []); if (d.credits !== null && d.credits !== undefined) applyCredits(d.credits); });
  on("ships", (d) => applyShipRows(d.changed ?? [], d.removed ?? []));
  on("credits", (d) => applyCredits(d.credits));
  on("activity", (d) => pushActivity(d));
}

export function startLive() {
  if (source) return;
  open();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    // A closed stream (iPhone background, server restart that gave up) is reopened; an open one is left alone.
    if (!source || source.readyState === 2) open();
  });
}

export function liveConnected() {
  return !!source && source.readyState === 1;
}
