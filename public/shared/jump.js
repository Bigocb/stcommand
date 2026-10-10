/* Jump planner rows for a ship's sheet, shared by Tower (m.js) and Deck (deck.js).
 * One row per gate connection out of the ship's system. A gate that isn't finished is greyed out
 * and can't be used; a ship in transit can't jump either. */
import { escapeHtml, escapeAttr, shortWp } from "/shared/domain.js";

export function jumpPlannerHtml(waypoint, navStatus, connections) {
  const sys = String(waypoint ?? "").slice(0, String(waypoint ?? "").lastIndexOf("-"));
  const inTransit = navStatus === "IN_TRANSIT";
  const rows = (connections ?? []).filter((c) => c.from.startsWith(sys + "-")).map((c) => {
    const toSystem = c.to.slice(0, c.to.lastIndexOf("-"));
    const blocked = c.complete !== true;
    const why = blocked ? "gate not finished" : inTransit ? "in transit" : "";
    return `<div class="jump-row${blocked ? " gate-off" : ""}">
      <span class="tgt"><b>${escapeHtml(toSystem)}</b> → ${escapeHtml(shortWp(c.to))} <span class="via">via ${escapeHtml(shortWp(c.from))}${why ? ` · ${why}` : ""}</span></span>
      <button class="btn" data-act="jump" data-to="${escapeAttr(c.to)}" ${blocked || inTransit ? "disabled" : ""}>Jump</button>
    </div>`;
  }).join("");
  return `<div class="sec-h">Jump planner</div>${rows || `<div class="empty">No jump gates in ${escapeHtml(sys)}.</div>`}`;
}
