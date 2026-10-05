/**
 * Deck's 3D system/galaxy map.
 *
 * The same Three.js engine as V6's map — orbit/pan/zoom camera, procedural
 * planets, ship hulls with live motion trails, jump-gate pulses, the galaxy
 * overview with its route planner, hover/tap tips — extracted from v6.js
 * (its "BRIDGE: galaxy overview" and "preserved: map" sections) into a module
 * Deck owns. Differences from the v6 copy are deliberately small and marked
 * "DECK:" below: the v6-only globals it read (replay scrubber, mobile layout,
 * ship-details modal, system strip) are replaced by a few explicit hooks.
 *
 * three.js and its postprocessing add-ons are classic <script> tags in
 * deck.html (same as v6.html), so `THREE` is a global here.
 */
import { api } from "/shared/api.js";
import { state, systems, marketSnapshots, fleetStatus } from "/shared/store.js";
import { fmt, shortWp, shipTransitLerp, escapeHtml, escapeAttr } from "/shared/domain.js";

// DECK: no global toast on Deck; route-planner errors go to the console.
const showToastGlobal = (msg) => console.warn("[map]", msg);

const $ = (id) => document.getElementById(id);

// DECK: state the v6 copy found as module-level lets in v6.js.
let waypoints = [];
let currentSystem = "";
let galaxyMode = false;
let selectedShip = null;
const shipScreenPos = new Map();
let mapTipFor = null;
const surveyCache = new Map();
const loadoutScores = [];
// DECK: no replay scrubber on Deck's map yet — always live.
const scrubLive = true;
// DECK: set by the Map view when it is the visible screen (v6 checked its own currentView).
let deckMapVisible = false;

/** Hooks the host (deck.js) provides. */
const hooks = { onShip: null, onWaypoint: null, onSystemChange: null };

/* ── BRIDGE: galaxy overview ──────────────────
 * A zoomed-out mode of the SAME per-system 3D map/scene (see renderMap()),
 * not a separate view: every system this tenant's own fleet has actually
 * charted, laid out by real galaxy-wide coordinates (from the shared
 * crawler table, GET /api/galaxy/overview) as small markers in the same
 * three.js scene, with jump-gate edges between them. Picking one switches
 * currentSystem and re-frames the same camera back down onto that system's
 * own waypoints (renderMap()'s existing framedSystem-driven fit) — since
 * both live in one scene on one canvas, orbitCam's existing lerp-toward-
 * orbitGoal easing (tickMap3D()) turns that mode switch into one continuous
 * zoom for free, no separate transition code needed. Confirmed live that
 * DRAGOM's own nearby charted systems sit roughly 200-400 units apart —
 * close enough to a system's own waypoint-scale distances (systemSpan
 * ~80-160) that this reuses the same camera/zoom-clamp math directly
 * rather than needing a second scale regime.
 */
let galaxyOverviewData = null;
/** Which of the two content modes the shared 3D scene currently holds — set
 *  by whichever of renderMap()/renderGalaxy3D() last ran, read by both to
 *  decide whether this call is a fresh mode switch (re-frame the camera) or
 *  just another periodic redraw of the same mode (leave the operator's own
 *  zoom/pan alone). Mirrors framedSystem's existing per-system version of
 *  this same distinction, one level up. */
let mapMode = "system";
/** Route planner state — persists across re-renders while galaxy mode stays
 *  open (loadGalaxyOverview() only refetches on toggle-on, not on a timer),
 *  so picking a destination and then panning/zooming doesn't clear it. */
let routeFrom = "";
let routeTo = "";

async function loadGalaxyOverview() {
  try {
    galaxyOverviewData = await api("GET", "/api/galaxy/overview");
    if (!routeFrom) routeFrom = galaxyOverviewData.home || currentSystem;
  } catch (err) {
    galaxyOverviewData = { systems: [], edges: [], home: "" };
    showToastGlobal(err.message, true);
  }
  renderGalaxyToolbar();
  renderGalaxy3D();
}

/** BFS shortest path (fewest jumps, not distance-weighted — every hop costs
 *  roughly the same order of antimatter regardless of leg length) over the
 *  charted jump-gate graph. Returns the ordered system list including both
 *  ends, or null if the two aren't connected by any known chain of gates —
 *  a real, useful answer here ("nothing charted links these yet") rather
 *  than an error, since it's exactly the gap a scout should close next. */
function bfsRoute(edges, from, to) {
  if (!from || !to) return null;
  if (from === to) return [from];
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push(e.b);
    adj.get(e.b).push(e.a);
  }
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === to) {
      const path = [];
      for (let n = to; n !== null; n = prev.get(n)) path.unshift(n);
      return path;
    }
    for (const next of adj.get(cur) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      queue.push(next);
    }
  }
  return null;
}

/** Nudges apart any two glyphs in `posMap` (symbol -> {x, z}, mutated in
 *  place) still closer than `minDist` after real-coordinate scaling — a
 *  cheap pairwise relaxation, not a full force-directed layout, since only
 *  crowded local clusters need correcting and everything else should stay
 *  exactly where its real coordinates put it. Bails early once nothing
 *  moved a full pass, and caps iterations so a genuinely dense knot (more
 *  pairs too close than minDist can resolve in-place) settles into "less
 *  overlapping" rather than looping to convergence that may not exist. */
function declutterGlyphPositions(posMap, minDist, iterations = 40) {
  const symbols = [...posMap.keys()];
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < symbols.length; i++) {
      const a = posMap.get(symbols[i]);
      for (let j = i + 1; j < symbols.length; j++) {
        const b = posMap.get(symbols[j]);
        const dx = b.x - a.x, dz = b.z - a.z;
        const dist = Math.hypot(dx, dz) || 0.001;
        if (dist >= minDist) continue;
        moved = true;
        const push = (minDist - dist) / 2;
        const ux = dx / dist, uz = dz / dist;
        a.x -= ux * push; a.z -= uz * push;
        b.x += ux * push; b.z += uz * push;
      }
    }
    if (!moved) break;
  }
}

/**
 * Populate the shared 3D scene with the galaxy overview instead of one
 * system's own waypoints — called from renderMap() when galaxyMode is on,
 * same camera/pickables pattern. Charted systems (`known`) are real click
 * targets; the `nearby` halo is small, dim, and non-interactive.
 *
 * Each known system collapses to one small generated "mini system" glyph
 * (a core sphere, a tilted decorative ring, and a couple of deterministic
 * orbiting dots — seeded off the system symbol so the same system always
 * looks the same) rather than a full render of its actual waypoints. This
 * used to try to hold the outgoing system's real content on screen and
 * ease the camera back for a continuous zoom-out feel; that fought the
 * scene's clear-and-rebuild-every-render-pass structure (the star's own
 * glow sprites, added once, were getting destroyed on the very first
 * rebuild and never replaced) and reliably left stale geometry on screen.
 * A hard cut — clear everything, drop in the collapsed glyphs — is
 * simpler, and the camera cuts with it (orbitCam snapped straight to
 * orbitGoal, not eased into it) rather than spending a beat easing toward
 * a view nothing has swapped to yet. An eased pull-back sounds nicer in
 * the abstract, but here it meant the camera drifted out over the OLD
 * system's content for however long the overview fetch took, landing on
 * an orphaned in-between look that belonged to neither view — confirmed
 * live on video. One clean cut, camera and content together, reads better
 * than a smooth motion into a state that isn't there yet.
 */
function renderGalaxy3D() {
  // galaxyMode flips synchronously in setGalaxyMode(), before the overview
  // fetch it kicks off resolves — and renderMap()'s ~1s poll tick reads
  // galaxyMode directly, so it can call this function first, with no data
  // yet. Wait for the real fetch rather than rendering an empty galaxy.
  if (!galaxyOverviewData) return;
  if (!sceneReady && !mapUnavailable) initMap3D();
  if (mapUnavailable) return;
  $("map-hud").innerHTML = "Galaxy <b>charted space</b>";

  const enteringGalaxy = mapMode !== "galaxy";
  if (enteringGalaxy) {
    mapMode = "galaxy";
    starGroup.visible = false;
    orbitGoal.target.set(0, 0, 0);
    // Deliberately much farther than a system view's own default (~112-160)
    // — confirmed live that 200 read as barely a pull-back at all, since a
    // system's own waypoints already reach out that far. This needs to be
    // an unmistakable "the camera is now much farther away," not a modest
    // zoom adjustment.
    orbitGoal.radius = 460;
    orbitGoal.phi = 1.0;
    // Snap orbitCam straight to orbitGoal instead of letting tickMap3D()
    // ease toward it over the next several frames — this cut is meant to
    // be instant, alongside the content swap below, not a lingering pan.
    orbitCam.target.copy(orbitGoal.target);
    orbitCam.radius = orbitGoal.radius;
    orbitCam.phi = orbitGoal.phi;
  }
  clearGroup(bodiesGroup);
  clearGroup(ringsGroup);
  clearGroup(glowGroup);
  clearGroup(linesGroup);
  // Ships, their motion trails, and gate-pulse sprites are their own
  // persistent groups (see their declarations) rebuilt by the per-system
  // render path, not this one — renderMap() short-circuits into this
  // function before ever reaching that code while galaxyMode is on, so
  // without this they just froze at whatever they held the moment the
  // toggle flipped and sat there forever, showing up as stray ship glyphs
  // scattered around the collapsed system glyphs.
  clearGroup(shipsGroup);
  clearGroup(gatePulseGroup);
  liveTrailGroup?.clear();
  pickables.length = 0;

  const data = galaxyOverviewData;
  const known = (data?.systems ?? []).filter((s) => s.x !== null && s.y !== null);
  if (!known.length) return;
  const nearby = (data.nearby ?? []).filter((s) => s.x !== null && s.y !== null);

  // Centered on whatever system was on screen a moment ago (falling back to
  // fleet home, then just the first charted system), so re-entering galaxy
  // mode from a given system always lands the camera in the same place
  // relative to it.
  const anchor = known.find((s) => s.symbol === currentSystem) ?? known.find((s) => s.symbol === data.home) ?? known[0];
  const cx = anchor.x, cy = anchor.y;
  // Linear scale, not fitSystemScale()'s sqrt compression — galaxy-adjacent
  // distances (DRAGOM's own charted neighbors sit ~200-400 units apart) are
  // already close in magnitude to a system's own waypoint spread.
  let maxR = 20;
  for (const s of known) maxR = Math.max(maxR, Math.hypot(s.x - cx, s.y - cy));
  const scale = 140 / maxR;
  const toScene = (x, y) => ({ x: (x - cx) * scale, z: (y - cy) * scale });
  systemSpan = 160;

  // Real coordinates cluster tightly in places (confirmed live — a dense
  // neighborhood of charted systems overlapping into an unreadable knot of
  // rings), and this view was already a schematic rather than a precise
  // plot (see the file-level comment: each system collapses to a generated
  // "mini system" glyph, not its real content). So positions get a light
  // local declutter pass after scaling: any two glyphs still closer than
  // their combined visual footprint get pushed apart along the line
  // between them, a few iterations, until they clear or the pass gives up.
  // This only ever nudges crowded pairs — isolated systems don't move.
  const glyphPos = new Map(known.map((s) => [s.symbol, toScene(s.x, s.y)]));
  declutterGlyphPositions(glyphPos, 11);

  const path = bfsRoute(data.edges, routeFrom, routeTo);
  const routeEdgeKeys = new Set();
  if (path) for (let i = 0; i < path.length - 1; i++) routeEdgeKeys.add([path[i], path[i + 1]].sort().join("|"));
  const routeSystems = new Set(path ?? []);

  for (const s of nearby) {
    const p = toScene(s.x, s.y);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 8, 6),
      new THREE.MeshBasicMaterial({ color: themedColor("--dim"), transparent: true, opacity: 0.4 }),
    );
    mesh.position.set(p.x, 0, p.z);
    bodiesGroup.add(mesh);
  }

  for (const e of data.edges) {
    const pa = glyphPos.get(e.a), pb = glyphPos.get(e.b);
    if (!pa || !pb) continue;
    const onRoute = routeEdgeKeys.has([e.a, e.b].sort().join("|"));
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(pa.x, 0, pa.z),
      new THREE.Vector3(pb.x, 0, pb.z),
    ]);
    const mat = new THREE.LineBasicMaterial({
      color: themedColor(onRoute ? "--accent" : "--hairline"),
      transparent: true, opacity: onRoute ? 0.9 : 0.4,
    });
    const line = new THREE.Line(geo, mat);
    if (onRoute) line.renderOrder = 5;
    linesGroup.add(line);
  }

  // Deliberately just two states beyond plain/home/route: whether a ship is
  // currently there. A schematic for navigating/planning, not a market
  // survey — that detail already lives in the per-system view.
  for (const s of known) {
    const p = glyphPos.get(s.symbol);
    const isHome = s.symbol === data.home;
    const onRoute = routeSystems.has(s.symbol);
    const color = s.ships > 0 ? "--accent" : (isHome ? "--ice" : "--dim");
    const coreRadius = isHome ? 2.4 : 1.8;

    const core = new THREE.Mesh(new THREE.SphereGeometry(coreRadius, 14, 10), new THREE.MeshBasicMaterial({ color: themedColor(color) }));
    core.position.set(p.x, 0, p.z);
    bodiesGroup.add(core);
    pickables.push({ mesh: core, kind: "galaxy-system", symbol: s.symbol });

    // A tilted, always-present ring so every glyph reads as "a whole
    // system in miniature" rather than a plain dot on a graph.
    const tilt = hashString(s.symbol + "tilt");
    const glyphRing = new THREE.Mesh(
      new THREE.RingGeometry(coreRadius * 1.8, coreRadius * 2.0, 20),
      new THREE.MeshBasicMaterial({ color: themedColor("--hairline"), side: THREE.DoubleSide, transparent: true, opacity: 0.5 }),
    );
    glyphRing.rotation.x = -Math.PI / 2.4 + tilt * 0.35;
    glyphRing.position.set(p.x, 0, p.z);
    ringsGroup.add(glyphRing);

    // A couple of deterministic orbiting "planets" — purely decorative,
    // seeded off the system symbol so a given system always looks the
    // same rather than reshuffling on every rebuild.
    const planetCount = 1 + Math.floor(Math.abs(hashString(s.symbol + "n")) * 3);
    for (let i = 0; i < planetCount; i++) {
      const angle = hashString(s.symbol + "a" + i) * Math.PI * 2;
      const orbitR = coreRadius * (2.6 + i * 1.1);
      const planet = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 6, 5),
        new THREE.MeshBasicMaterial({ color: themedColor("--dim") }),
      );
      planet.position.set(p.x + Math.cos(angle) * orbitR, 0, p.z + Math.sin(angle) * orbitR);
      bodiesGroup.add(planet);
    }

    if (isHome || onRoute) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(coreRadius * 3.2, coreRadius * 3.6, 24),
        new THREE.MeshBasicMaterial({ color: themedColor("--ice"), side: THREE.DoubleSide, transparent: true, opacity: 0.7 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.x, 0.05, p.z);
      ringsGroup.add(ring);
    }

    const label = makeLabelSprite(s.symbol, isHome ? "#dff2ff" : "#93a7bd");
    label.position.set(p.x, coreRadius + 4, p.z);
    bodiesGroup.add(label);
  }
}

/** The route-planner toolbar/result panel floats over the 3D canvas in
 *  galaxy mode — the only DOM piece left of the old flat-SVG overview,
 *  since a From/To search box is still plain HTML, not a scene object. */
function renderGalaxyToolbar() {
  const host = $("galaxy-overview");
  if (!host) return;
  const data = galaxyOverviewData;
  if (!data) { host.innerHTML = ""; return; }
  const known = data.systems.filter((s) => s.x !== null && s.y !== null);
  const missing = data.systems.length - known.length;
  const path = bfsRoute(data.edges, routeFrom, routeTo);
  const options = known.map((s) => `<option value="${escapeAttr(s.symbol)}">`).join("");
  const routeResult = !routeTo
    ? ""
    : path
      ? `<div class="gx-route-result">${path.length - 1} jump${path.length - 1 === 1 ? "" : "s"}: ${path.map((s) => escapeHtml(s)).join(" → ")}</div>`
      : `<div class="gx-route-result gx-route-none">No known gate chain from ${escapeHtml(routeFrom)} to ${escapeHtml(routeTo)} yet — scout further to find one.</div>`;

  host.innerHTML = `<datalist id="gx-system-options">${options}</datalist>
  <div class="gx-toolbar">
    <input list="gx-system-options" id="gx-route-from" placeholder="From" value="${escapeAttr(routeFrom)}" />
    <span class="gx-arrow">→</span>
    <input list="gx-system-options" id="gx-route-to" placeholder="Search a system…" value="${escapeAttr(routeTo)}" />
    <button class="btn ghost" id="gx-route-clear">Clear</button>
  </div>
  ${routeResult}
  ${missing ? `<div class="gx-missing-note">${missing} charted system${missing === 1 ? "" : "s"} not yet in the galaxy index</div>` : ""}`;

  const fromInput = host.querySelector("#gx-route-from"), toInput = host.querySelector("#gx-route-to");
  const commit = () => {
    routeFrom = fromInput.value.trim().toUpperCase();
    routeTo = toInput.value.trim().toUpperCase();
    renderGalaxyToolbar();
    scheduleRebuild();
  };
  fromInput.addEventListener("change", commit);
  toInput.addEventListener("change", commit);
  host.querySelector("#gx-route-clear").addEventListener("click", () => { routeTo = ""; renderGalaxyToolbar(); scheduleRebuild(); });
}

function setGalaxyMode(on) {
  galaxyMode = on;
  $("map-galaxy-toggle")?.classList.toggle("active", on);
  // Per-system-only chrome — not meaningful zoomed out to the galaxy. The
  // map itself (map3d) and its zoom controls stay: same scene, same camera.
  for (const id of ["system-strip", "map-gallery"]) {
    $(id)?.style.setProperty("display", on ? "none" : "");
  }
  document.querySelector(".map-legend")?.style.setProperty("display", on ? "none" : "");
  if (on) {
    // Deliberately NOT kicking the camera here: this used to move it toward
    // the galaxy framing right away, before GET /api/galaxy/overview had
    // resolved — since renderGalaxy3D() (further down) waits for that data
    // and won't swap the scene content until it lands, the camera spent
    // however long that fetch took drifting out over the OLD system's
    // content, an orphaned in-between look that belonged to neither view.
    // renderGalaxy3D() now snaps both camera and content together the
    // instant the data is ready, so this is an abrupt cut either way, not
    // eased motion into a state nothing has swapped to yet.
    loadGalaxyOverview();
  } else {
    $("galaxy-overview").innerHTML = "";
    if (galaxyHoverSymbol) { galaxyHoverSymbol = null; hideWaypointTip(); }
    renderDeckMap();
  }
}

function initGalaxyToggle() {
  $("map-galaxy-toggle")?.addEventListener("click", () => setGalaxyMode(!galaxyMode));
}


/* ── preserved: map, modals, chat, helpers ── */





// Waypoint glyphs by SpaceTraders type — shape and size carry meaning now,
// not just color. Market/shipyard used to override the type entirely (any
// market rendered as an identical dot regardless of whether it was a planet,
// moon, or station); market is now a separate accent ring drawn over
// whatever the waypoint actually is, so shape stays type, and the ring
// answers "can I trade here" independently. Waypoints are sized larger than
// ships throughout (see the ship glyph block below) — they're the permanent
// structure; ships are transient traffic passing through it.
const WP_GLYPH = {
  PLANET: { shape: "circle", r: 6, cls: "wp-planet" },
  GAS_GIANT: { shape: "ringed", r: 6.5, cls: "wp-gas-giant" },
  MOON: { shape: "circle", r: 3, cls: "wp-moon" },
  // Smaller than a planet's r=6 — a station orbits its planet at the exact
  // same coordinate (confirmed: A4 shares A1's x/y, F49 shares F48's), so it
  // was fighting the planet for the same footprint and needing more cluster
  // ring separation than a genuinely smaller, orbiting structure should.
  ORBITAL_STATION: { shape: "diamond", r: 2.3, cls: "wp-station", labeled: true },
  ASTEROID_BASE: { shape: "diamond", r: 2.3, cls: "wp-station", labeled: true },
  JUMP_GATE: { shape: "gate", r: 5, cls: "gate", labeled: true },
  ASTEROID_FIELD: { shape: "asteroid", r: 4.5, cls: "asteroid" },
  ASTEROID: { shape: "asteroid", r: 4, cls: "asteroid" },
  ENGINEERED_ASTEROID: { shape: "asteroid", r: 4.5, cls: "asteroid" },
  FUEL_STATION: { shape: "circle", r: 4.5, cls: "fuel" },
  NEBULA: { shape: "phenomenon", r: 5, cls: "phenomenon" },
  DEBRIS_FIELD: { shape: "phenomenon", r: 4, cls: "phenomenon" },
  GRAVITY_WELL: { shape: "phenomenon", r: 4, cls: "phenomenon" },
  ARTIFICIAL_GRAVITY_WELL: { shape: "phenomenon", r: 4, cls: "phenomenon" },
  __default: { shape: "circle", r: 2.5, cls: "wp" },
};

function drawWaypointGlyph(g, pos, symbol, isMarket, isYard) {
  const { x, y } = pos;
  const title = `<title>${symbol}</title>`;
  // A market is a border on the waypoint's own shape, not a separate marker
  // drawn on top of it — one glyph, one outline, no extra element to
  // position/cluster/collide with anything else.
  const cls = isMarket ? `${g.cls} market` : g.cls;
  // Shipyard can't share the same trick — a shape only has one `stroke`, and
  // a waypoint can be both a market and a shipyard at once — so it's a
  // second, slightly larger concentric ring instead of fighting the market
  // outline for the same property. Rarer than markets in practice, so the
  // extra element is cheap.
  const yardRing = isYard ? `<circle class="yard-ring" cx="${x}" cy="${y}" r="${g.r + 2.4}"></circle>` : "";
  if (g.shape === "gate") {
    return `<rect class="${cls}" x="${x - g.r}" y="${y - g.r}" width="${g.r * 2}" height="${g.r * 2}" transform="rotate(45 ${x} ${y})" data-wp="${symbol}">${title}</rect>${yardRing}`;
  }
  if (g.shape === "diamond") {
    return `<rect class="${cls}" x="${x - g.r}" y="${y - g.r}" width="${g.r * 2}" height="${g.r * 2}" transform="rotate(45 ${x} ${y})" data-wp="${symbol}">${title}</rect>${yardRing}`;
  }
  if (g.shape === "ringed") {
    // The whole body — outer ring ellipse and inner circle both — gets the
    // market outline here, not just the inner circle, so a gas-giant market
    // reads as clearly outlined as every other type instead of a smaller
    // accent buried inside a bigger unmarked shape.
    const ringCls = isMarket ? `${g.cls}-ring market` : `${g.cls}-ring`;
    return `<g data-wp="${symbol}">${title}<ellipse class="${ringCls}" cx="${x}" cy="${y}" rx="${g.r * 1.7}" ry="${g.r * 0.55}" transform="rotate(-24 ${x} ${y})"></ellipse><circle class="${cls}" cx="${x}" cy="${y}" r="${g.r * 0.75}"></circle>${yardRing}</g>`;
  }
  if (g.shape === "asteroid") {
    return `<circle class="${cls}" cx="${x}" cy="${y}" r="${g.r}" data-wp="${symbol}">${title}</circle>${yardRing}`;
  }
  if (g.shape === "phenomenon") {
    return `<circle class="${cls}" cx="${x}" cy="${y}" r="${g.r}" data-wp="${symbol}">${title}</circle>${yardRing}`;
  }
  // circle — planet, moon, fuel station, and the unknown-type fallback
  return `<circle class="${cls}" cx="${x}" cy="${y}" r="${g.r}" data-wp="${symbol}">${title}</circle>${yardRing}`;
}

// One shared hull shape for every ship, regardless of role — the earlier
// per-role shape family (diamond/arrow/slim/block) made a busy map read as
// a zoo of icons rather than a fleet. Role is now carried by color alone
// (see the role-* CSS rules below), grouped the same way the old shape
// families were: miner stands alone, scout/tour together, surveyor/siphoner
// together, keeper/warehouse together — trader (the most common role) is
// the unmarked default, same fill as an unselected/role-less hull always
// had. Local coordinate span is deliberately smaller than WP_GLYPH's radii
// (max ~4.5 here vs. up to 6.5 for a gas giant) so ships read as the
// smaller, moving thing against the larger, fixed waypoints — scale lives
// in the path data itself rather than a CSS transform, since a CSS
// transform on the same element would replace (not compose with) the
// inline rotate() attribute used below for the ship's heading.
//
// `headingDeg` is the real direction of travel (see shipHeadingDeg()) — SVG
// rotation is continuous, so this needed no per-direction sprite art, just
// one vector hull pointed by transform. A docked/orbiting ship (no motion)
// or a mid-transit one with incomplete route data falls back to the old
// fixed tilt (0 stationary / 45 "moving, direction unknown") rather than
// pointing nowhere meaningful.
function shipGlyphMarkup(role, docked, headingDeg) {
  const rot = headingDeg != null ? headingDeg : docked ? 0 : 45;
  return `<path class="hull role-${role ?? "trader"}" d="M0,-2.6 L2.1,2.1 L0,1.1 L-2.1,2.1 Z" transform="rotate(${rot})"></path>`;
}






/**
 * ── 3D map (v6) ──────────────────────────────────────────────────────────
 *
 * v3's flat SVG map replaced by a WebGL scene: the current system's
 * waypoints laid out at their real x/y (unchanged data, just plotted on a
 * horizontal plane instead of a flat screen), viewed through a camera that
 * orbits instead of panning/zooming a 2D transform. A waypoint sharing its
 * exact x/y with another (a station orbiting its planet — SpaceTraders does
 * this routinely) sits at the same point in 3D too, same as it always did;
 * the win over the flat map is that "same point" now separates visibly the
 * moment the camera tilts even slightly, with no cluster-ring math needed.
 *
 * A faint ring is drawn at each waypoint's real distance from the system's
 * origin (0,0) — an orbit path, not decoration: that radius is the same
 * hypot(x,y) the flat map already had, just drawn instead of implied.
 *
 * Everything downstream of "where is this waypoint/ship in the scene" is
 * unchanged: showWaypointTip()/openShipDetails() are the exact same
 * functions v3 called, and shipTransitLerp() (imported from domain.js) is
 * the exact same world-space interpolation the flat map used — only the
 * projection from world (x,y) to something on screen changed.
 *
 * Not ported in this pass: motion trails, and pinch/scroll-zoom's old
 * fixed 0.5–24x range (replaced by an orbit radius clamp scaled to each
 * system's own span, so "zoomed out" always means "the whole system", not
 * a magic number tuned for one).
 */

let lastRenderedShips = [];
/** World-space → scene-space transform from the most recent renderMap()
 *  call: an offset (the system's own centroid) and a uniform scale, so
 *  repositionShips() places a ship exactly where renderMap() would have
 *  placed a waypoint at the same coordinate. */
let mapScale = null;
let shipAnimHandle = null;
/** Live motion-trail state — same idea as the flat map's own liveTrails/
 *  lastTrailSamplePos (a per-ship buffer of recently sampled scene
 *  positions, sampled by distance moved rather than by frame or timer, so
 *  a ship sitting still doesn't fill the buffer with duplicate points). */
let liveTrails = new Map();
let lastTrailSamplePos = new Map();
/** The THREE.Line[] currently drawn for each ship's live trail, so
 *  repositionShips() can replace just that ship's segments each frame
 *  without touching linesGroup's renderMap()-owned contents. */
let liveTrailObjects = new Map();
const TRAIL_SAMPLE_MIN_SCENE = 0.5; // scene units — the flat map's 4px analog
const TRAIL_MAX_POINTS = 10;

const WP3D_COLOR = {
  PLANET: "--ice", GAS_GIANT: "--violet", MOON: "--buff",
  ORBITAL_STATION: "--bone", ASTEROID_BASE: "--bone",
  JUMP_GATE: "--teal", ASTEROID_FIELD: "--warn", ASTEROID: "--warn",
  ENGINEERED_ASTEROID: "--red", FUEL_STATION: "--teal",
  NEBULA: "--violet", DEBRIS_FIELD: "--violet", GRAVITY_WELL: "--violet",
  ARTIFICIAL_GRAVITY_WELL: "--violet",
};
// Kept small deliberately: a body's own radius feeds straight into the
// anti-overlap minimum distance below, so a large radius swallows small
// real coordinate differences under "just enough padding to not overlap."
// Shrinking the bodies gives real distances room to read as real distances.
const WP3D_SIZE = {
  PLANET: 3.0, GAS_GIANT: 4.2, MOON: 1.0,
  ORBITAL_STATION: 0.8, ASTEROID_BASE: 0.8,
  JUMP_GATE: 1.4, ASTEROID_FIELD: 0.6, ASTEROID: 0.45,
  ENGINEERED_ASTEROID: 0.6, FUEL_STATION: 1.0,
  NEBULA: 0.8, DEBRIS_FIELD: 0.6, GRAVITY_WELL: 1.4,
  ARTIFICIAL_GRAVITY_WELL: 1.4,
};
const SHIP3D_COLOR = {
  miner: "--buff", scout: "--violet", tour: "--violet",
  surveyor: "--teal", siphoner: "--teal",
  keeper: "--bone", warehouse: "--bone",
};

/**
 * Artificial Z-axis (elevation) for the 3D map.
 *
 * SpaceTraders only gives x/y, so we invent a stable, meaningful height
 * per waypoint. The goal is visual depth and natural-looking ship flight:
 * not everything sits on the same pancake plane.
 *
 * Rules:
 *  - Planets/gas giants define the ecliptic plane (z ≈ 0).
 *  - Moons orbit above/below their planet in a narrow band.
 *  - Stations orbit farther out from the plane than moons.
 *  - Asteroid fields and nebulae form a thick belt with a gentle wobble.
 *  - Jump gates sit on the plane but get a vertical glow instead of height.
 *  - A deterministic per-symbol micro-jitter separates multiple orbiters
 *    sharing the same x/y (common for stations orbiting a planet).
 *
 * All heights are in scene units, scaled so the camera can still frame the
 * whole system comfortably.
 */
const WP3D_ELEVATION = {
  PLANET: 0,
  GAS_GIANT: 0,
  JUMP_GATE: 0,
  MOON: 2.2,
  ORBITAL_STATION: 4.5,
  ASTEROID_BASE: 4.5,
  FUEL_STATION: 4.0,
  ASTEROID_FIELD: 2.0,
  ASTEROID: 1.5,
  ENGINEERED_ASTEROID: 1.8,
  NEBULA: 3.0,
  DEBRIS_FIELD: 2.2,
  GRAVITY_WELL: 2.5,
  ARTIFICIAL_GRAVITY_WELL: 2.5,
};
const ELEVATION_MICRO_RANGE = 1.2; // ± this much, deterministic per symbol
const TRANSIT_ARC_FACTOR = 0.12;    // arc height as fraction of scene distance

/** Stable pseudo-random float in [-1, 1] from a string. */
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h / 2147483647);
}

/** Elevation for a single waypoint. Cached by symbol because it is called
 *  from several places (bodies, rings, labels, ships, trails). */
const elevationCache = new Map();
function computeElevation(symbol, type, x, y) {
  const key = symbol;
  if (elevationCache.has(key)) return elevationCache.get(key);
  const base = WP3D_ELEVATION[type] ?? 0;
  const micro = hashString(symbol) * ELEVATION_MICRO_RANGE;
  // Belt objects (asteroid/nebula) also get a slow radial wave so the belt
  // reads as a volume rather than a flat ribbon.
  const r = Math.hypot(x, y);
  const beltWobble = (type === "ASTEROID_FIELD" || type === "ASTEROID" || type === "NEBULA" || type === "DEBRIS_FIELD")
    ? Math.sin(r * 0.15 + hashString(symbol) * 2) * 0.8
    : 0;
  const z = base + micro + beltWobble;
  elevationCache.set(key, z);
  return z;
}

function clearElevationCache() {
  elevationCache.clear();
}

/** Scene position with artificial elevation baked in. */
function waypointScenePos(wp, s) {
  const { x, z } = worldToScene(wp.x, wp.y, s);
  const y = computeElevation(wp.symbol, wp.type, wp.x, wp.y);
  return { x, y, z };
}

/** Elevation of a ship mid-transit. It arcs above/below the straight line
 *  between origin and destination so long hops read as climbs/dives rather
 *  than flat crawls. The arc peaks at the midpoint and returns to the
 *  destination's own elevation. */
function transitArcHeight(baseScenePos, originWP, destWP, s) {
  const originY = originWP ? computeElevation(originWP.symbol, originWP.type, originWP.x, originWP.y) : 0;
  const destY = destWP ? computeElevation(destWP.symbol, destWP.type, destWP.x, destWP.y) : 0;
  // Estimate fraction along the route from the base (flat) position. If
  // either endpoint is missing, just use the straight interpolation.
  let frac = 0.5;
  let routeDist = 0;
  if (originWP && destWP) {
    const o = worldToScene(originWP.x, originWP.y, s);
    const d = worldToScene(destWP.x, destWP.y, s);
    routeDist = Math.hypot(d.x - o.x, d.z - o.z);
    const done = Math.hypot(baseScenePos.x - o.x, baseScenePos.z - o.z);
    frac = routeDist > 0 ? Math.min(1, Math.max(0, done / routeDist)) : 0.5;
  }
  const linearY = originY + (destY - originY) * frac;
  // Arc above the straight line: taller for longer hops, peaking mid-route.
  const arc = routeDist > 0 ? Math.sin(Math.PI * frac) * routeDist * TRANSIT_ARC_FACTOR : 0;
  return { y: linearY + arc };
}

/** A CSS custom property, resolved to whatever color space it's actually
 *  declared in (oklch, hex, whatever the hue picker set) via the browser's
 *  own conversion, so the 3D scene tracks the live theme — including the
 *  operator's hue choice — instead of a hardcoded copy of it. */
const cssColorCache = new Map();
const colorProbe = document.createElement("span");
colorProbe.style.display = "none";
document.body.appendChild(colorProbe);
// Read back through a 1x1 canvas rather than THREE.Color.setStyle(): the
// theme's --accent is declared in oklch (so the hue picker can rotate it),
// and modern browsers hand that straight back from getComputedStyle() as an
// oklch() string. THREE r128 predates CSS Color 4 and can't parse that —
// setStyle() fails silently, leaving the accent black. Canvas fillStyle
// parsing goes through the browser's own CSS color engine and always reads
// back as sRGB bytes via getImageData(), so it handles any color syntax the
// stylesheet throws at it without this needing to know which one that is.
const probeCanvas = document.createElement("canvas");
probeCanvas.width = 1; probeCanvas.height = 1;
const probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true });
function cssColor(varName) {
  colorProbe.style.color = `var(${varName})`;
  const value = getComputedStyle(colorProbe).color;
  probeCtx.fillStyle = value;
  probeCtx.fillRect(0, 0, 1, 1);
  const [r, g, b] = probeCtx.getImageData(0, 0, 1, 1).data;
  return new THREE.Color(r / 255, g / 255, b / 255);
}
function invalidateColorCache() { cssColorCache.clear(); }
function themedColor(varName) {
  if (!cssColorCache.has(varName)) cssColorCache.set(varName, cssColor(varName));
  return cssColorCache.get(varName);
}
// A darker two-tone variant of a body/ship's own role color, for secondary
// structural parts (wings, struts, pods) that should read as "part of this
// same thing" rather than a fixed, unrelated accent color — keeps "role/
// selection owns color" intact (nothing here is hardcoded to a bucket or
// waypoint type) while giving flat single-hue shapes some depth.
function trimColor(color) {
  return color.clone().multiplyScalar(0.55);
}
// The hue picker (header) repaints --accent-hue on click; ship/selection
// materials below are read once at scene-build time, so a hue change needs
// this to know the cache is stale. Cheap: only fires on an explicit click.
document.getElementById("hue-picker")?.addEventListener("click", (e) => {
  if (e.target.closest(".hue-btn")) { invalidateColorCache(); scheduleRebuild(); }
});

let scene, camera, renderer, host;
let composer, bloomPass; // undefined if the postprocessing addons failed to load — see initMap3D()
let bodiesGroup, ringsGroup, shipsGroup, glowGroup, linesGroup, liveTrailGroup;
const pickables = []; // { mesh, kind: 'waypoint'|'ship', symbol }
let raycaster, pointerNdc;
let galaxyHoverSymbol = null; // which galaxy-system glyph the pointer is currently over, or null
const orbitCam = { theta: 0.7, phi: 1.0, radius: 60, target: new THREE.Vector3(0, 0, 0) };
const orbitGoal = { theta: 0.7, phi: 1.0, radius: 60, target: new THREE.Vector3(0, 0, 0) };
let systemSpan = 90; // current system's own radius, used to scale zoom limits to it
let sceneReady = false;
let pendingRebuild = null;
let mapUnavailable = false;
let framedSystem = null; // which system the camera was last auto-fit to
let starGlowPulse = null; // { core, corona, t } — set once in initMap3D(), animated in tickMap3D()
// The star (sphere + its two glow sprites) lives in its own group, never
// touched by clearGroup() — bodiesGroup/glowGroup/etc. get wiped and
// rebuilt on every render pass (system or galaxy), and the star is a
// permanent fixture created once by initMap3D(), not per-render content.
// It used to sit directly in `scene` (mesh) and inside glowGroup (its
// glow sprites) — the glow sprites being in a cleared group meant they
// were destroyed the very first render pass of the whole session and
// never came back. Galaxy mode has no star of its own (a whole system
// reduces to one small marker at that scale), so this group is just
// toggled visible/hidden on mode switch instead.
let starGroup = null;
// The star sphere/glow/light, and which SystemType they're currently
// painted for — module-scope (like starGroup) rather than local to
// initMap3D(), since renderMap() needs to recolor them whenever the
// current system's own star type differs from the last one rendered. See
// applyStarColor() below.
let starMesh = null;
let starLight = null;
let starCoreGlow = null;
let starCorona = null;
let lastStarType;
// Jump-gate "active portal" pulse rings. A persistent group (like
// liveTrailGroup) rather than something renderMap() rebuilds every poll —
// a gate's own animation phase would otherwise reset every ~1s and never
// visibly progress. renderMap() only adds/removes entries as gates appear/
// disappear from the current system; tickMap3D() animates them every frame.
let gatePulseGroup;
const gatePulses = new Map(); // symbol -> { sprite, phase }

function initMap3D() {
  if (sceneReady || mapUnavailable) return;
  host = $("map3d");
  scene = new THREE.Scene();
  // Near/far tightened to what the camera actually ever uses (zoom clamps
  // to [systemSpan*0.35, systemSpan*6] ≈ [28, 480] — see the wheel/pinch
  // handlers below) rather than an arbitrary 0.1-4000. A standard (non-
  // logarithmic) depth buffer's precision is worst at the far end of its
  // range and wasted almost entirely on distances nothing ever renders at;
  // a 40,000:1 near:far ratio left too little precision at the distances
  // that matter, which read as z-fighting flicker between a body and its
  // own atmosphere rim — worse on mobile GPUs' typically lower-precision
  // depth buffers, confirmed live as exactly where it showed up. 1500 (not
  // 480) keeps headroom for wide pans/edge cases without giving back the
  // precision this was fixing.
  camera = new THREE.PerspectiveCamera(50, host.clientWidth / host.clientHeight || 1, 1, 1500);
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (err) {
    mapUnavailable = true;
    host.innerHTML = '<div class="map3d-unavailable">3D map unavailable — this browser has no WebGL support.</div>';
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(host.clientWidth || 1, host.clientHeight || 1);
  host.appendChild(renderer.domElement);

  // Bloom: without it, the star/glow sprites/emissive markers are just
  // bright-colored pixels, no different from any other mesh — a real
  // bloom pass is what actually sells "this is emitting light" rather
  // than "this is painted a bright color". The addon scripts load as
  // plain classic <script> tags in v6.html (same pattern three.min.js
  // itself already uses), so this checks for them rather than assuming —
  // the map has to keep working even if that CDN load fails for any
  // reason, just without the bloom.
  if (typeof THREE.EffectComposer === "function") {
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloomPass = new THREE.UnrealBloomPass(
      new THREE.Vector2(host.clientWidth || 1, host.clientHeight || 1),
      0.75, // strength — dimmed slightly from 0.9; the star's own glow (a
            // separate corona sprite, dimmed alongside this) still bloomed
            // brighter than intended even after the threshold fix
      0.5,  // radius
      // threshold — raised from an initial 0.18. A normal lit body surface
      // (diffuse shading + the small 0.05 emissive floor) already sits
      // well above a low threshold, so *everything* bloomed a little and
      // the per-type surface textures — much subtler contrast than the
      // star or a glow sprite — got crushed into a uniform soft blur
      // along with it. 0.55 keeps bloom for what's actually meant to look
      // like it's emitting light (the star, glow sprites, jump-gate/fuel
      // halos) without smearing out ordinary lit-surface detail.
      0.55,
    );
    composer.addPass(bloomPass);
  }

  bodiesGroup = new THREE.Group();
  ringsGroup = new THREE.Group();
  shipsGroup = new THREE.Group();
  glowGroup = new THREE.Group();
  linesGroup = new THREE.Group();
  // Separate from linesGroup deliberately: renderMap() clears and rebuilds
  // linesGroup on every state refresh, but a live trail has to survive
  // that — it's built up frame by frame in repositionShips(), independent
  // of the slower render cycle.
  liveTrailGroup = new THREE.Group();
  // Same reasoning as liveTrailGroup: a gate's pulse animation has to keep
  // progressing across renderMap()'s ~1s poll cycle, so it lives outside
  // the groups that cycle gets cleared and rebuilt.
  gatePulseGroup = new THREE.Group();
  starGroup = new THREE.Group();
  scene.add(bodiesGroup, ringsGroup, shipsGroup, glowGroup, linesGroup, liveTrailGroup, gatePulseGroup, starGroup);

  // Bodies use a lit material now (see WP3D_MATERIAL below) instead of flat
  // MeshBasicMaterial — a shaded, lit sphere reads as a rendered object. The
  // system star is the light source: a point light at the origin radiates
  // outward in all directions, so every body is lit from the center no
  // matter where it orbits. Low decay keeps distant outliers from going dim.
  //
  // The star's own *visible* color (per-SystemType, see applyStarColor()
  // below) and the *light* it casts are deliberately different colors —
  // confirmed live: casting light in the star's own warm-pink default tone
  // washed every lit body pink, since it was the only real light source in
  // the scene. A near-neutral warm-white light keeps a body's shading
  // legible without tinting everything the color of whatever star it
  // orbits.
  //
  // The dark side was also crushed to near-black: a PointLight decays with
  // distance, so anything shadow-facing got only whatever the flat ambient
  // fill provided, and that fill was too dim/dark a color to matter. A
  // HemisphereLight fills from every direction with NO distance falloff
  // (unlike the star), so it's what actually keeps a shadow face legible
  // regardless of how far that body orbits — the flat AmbientLight is kept
  // too, small, just to lift the absolute floor a touch further.
  scene.add(new THREE.HemisphereLight(0x4a5578, 0x1a1420, 1.35));
  scene.add(new THREE.AmbientLight(0x2a3040, 0.35));
  starLight = new THREE.PointLight(0xfff1d8, 2.2, 0, 0.32);
  starLight.position.set(0, 0, 0);
  scene.add(starLight);

  // A central star marker, bigger than planets so it reads as the system
  // primary and justifies pushing everything else outward. The sphere
  // itself is unlit (MeshBasicMaterial — it IS the light source, nothing
  // should shade it), but a flat single fillStyle read as a placeholder dot
  // rather than a star: a radial gradient texture gives it a hot
  // white-yellow core fading to the edge tone, the same "limb" cue a real
  // star photo has. Built once here with a plain placeholder texture —
  // applyStarColor() (below) repaints it for the current system's real
  // SystemType the moment renderMap() knows one, so the brief placeholder
  // is never actually visible.
  starMesh = new THREE.Mesh(
    new THREE.SphereGeometry(6.5, 32, 24),
    new THREE.MeshBasicMaterial(),
  );
  starMesh.position.set(0, 0, 0);
  starGroup.add(starMesh);

  // Layered glow instead of one flat halo: a tight hot-white core glow
  // reads as brightness right at the surface, a much larger, softer,
  // dimmer corona around that reads as light actually spilling into
  // space. `starGlowPulse` holds both so tickMap3D() can breathe them —
  // a static glow read as another placeholder once the sphere itself
  // stopped looking like one. The core glow stays warm-white regardless of
  // star type (a star's very core reads as white-hot either way); only the
  // corona is tinted per-type, by applyStarColor().
  starCoreGlow = makeGlowSprite(new THREE.Color(0xfff2d0), 26);
  starCorona = makeGlowSprite(new THREE.Color(0xff7b72), 70);
  starCoreGlow.position.set(0, 0, 0);
  starCorona.position.set(0, 0, 0);
  starCorona.material.opacity = 0.42;
  starGroup.add(starCorona, starCoreGlow);
  starGlowPulse = { core: starCoreGlow, corona: starCorona, t: 0 };
  lastStarType = undefined;

  raycaster = new THREE.Raycaster();
  pointerNdc = new THREE.Vector2();

  applyOrbitCamera();
  attachMapControls();
  new ResizeObserver(onMapResize).observe(host);
  sceneReady = true;
  tickMap3D();
}

function onMapResize() {
  if (!sceneReady) return;
  const w = host.clientWidth || 1, h = host.clientHeight || 1;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  if (composer) {
    composer.setSize(w, h);
    bloomPass.resolution.set(w, h);
  }
}

function applyOrbitCamera() {
  const sp = orbitCam.radius * Math.sin(orbitCam.phi);
  camera.position.set(
    orbitCam.target.x + sp * Math.cos(orbitCam.theta),
    orbitCam.target.y + orbitCam.radius * Math.cos(orbitCam.phi),
    orbitCam.target.z + sp * Math.sin(orbitCam.theta),
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(orbitCam.target);
}

/** A tiny deterministic PRNG seeded from a string (via hashString above), so
 *  a body's surface texture and crater/blotch placement are stable across
 *  every re-render instead of re-randomizing (and visibly flickering) on
 *  every ~1s poll. Not cryptographic — a linear congruential generator is
 *  plenty for "these blotches always land in the same place." */
function seededRandom(seedStr) {
  let seed = Math.abs(Math.floor(hashString(seedStr) * 2147483647)) || 1;
  return function () {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/** 3D simplex noise (Gustavson's public-domain algorithm), permutation
 *  table shuffled by the same seeded `rand` a body's drawer already
 *  receives — so a waypoint's noise field is exactly as stable as
 *  everything else keyed off its symbol. Returns roughly [-1, 1]. Sampled
 *  in 3D (never the flat 2D canvas directly) so wrapping it around a
 *  sphere has no seam at U=0/1 and no pinching at the poles — see
 *  sphereNoise() below. */
function makeSimplex3(rand) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }
  const grad3 = [
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
  ];
  const F3 = 1 / 3, G3 = 1 / 6;
  return function simplex3(xin, yin, zin) {
    let n0, n1, n2, n3;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const X0 = i - t, Y0 = j - t, Z0 = k - t;
    const x0 = xin - X0, y0 = yin - Y0, z0 = zin - Z0;
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 < 0) n0 = 0;
    else {
      const gi0 = permMod12[ii + perm[jj + perm[kk]]];
      t0 *= t0;
      n0 = t0 * t0 * (grad3[gi0][0] * x0 + grad3[gi0][1] * y0 + grad3[gi0][2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 < 0) n1 = 0;
    else {
      const gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]];
      t1 *= t1;
      n1 = t1 * t1 * (grad3[gi1][0] * x1 + grad3[gi1][1] * y1 + grad3[gi1][2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 < 0) n2 = 0;
    else {
      const gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]];
      t2 *= t2;
      n2 = t2 * t2 * (grad3[gi2][0] * x2 + grad3[gi2][1] * y2 + grad3[gi2][2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 < 0) n3 = 0;
    else {
      const gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]];
      t3 *= t3;
      n3 = t3 * t3 * (grad3[gi3][0] * x3 + grad3[gi3][1] * y3 + grad3[gi3][2] * z3);
    }
    return 32 * (n0 + n1 + n2 + n3);
  };
}

/** Sums `octaves` layers of the given noise fn at doubling frequency and
 *  `persistence`-scaled amplitude (standard fractal Brownian motion),
 *  normalized back to roughly [-1, 1]. */
function fbm3(noiseFn, x, y, z, octaves, persistence) {
  let total = 0, amplitude = 1, maxAmplitude = 0, freq = 1;
  for (let o = 0; o < octaves; o++) {
    total += noiseFn(x * freq, y * freq, z * freq) * amplitude;
    maxAmplitude += amplitude;
    amplitude *= persistence;
    freq *= 2;
  }
  return total / maxAmplitude;
}

/** UV→sphere→fbm3 glue: converts a canvas pixel's (u, v) to a point on a
 *  unit sphere and samples fbm3 there, so the resulting texture has no
 *  seam where U wraps and no pinch at the poles. */
function sphereNoise(noiseFn, u, v, octaves, persistence, freq) {
  const theta = u * Math.PI * 2;
  const phi = v * Math.PI;
  const x = Math.sin(phi) * Math.cos(theta) * freq;
  const y = Math.cos(phi) * freq;
  const z = Math.sin(phi) * Math.sin(theta) * freq;
  return fbm3(noiseFn, x, y, z, octaves, persistence);
}

/** Fills the whole canvas from a per-pixel (u, v) -> [r, g, b, a] callback
 *  in one ImageData write instead of thousands of individual fillRect
 *  calls — the noise-driven drawer backgrounds below all use this. */
function paintNoiseCanvas(ctx, size, colorAt) {
  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const [r, g, b, a] = colorAt(u, v);
      const idx = (y * size + x) * 4;
      data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Procedural per-body surface texture — grayscale lightness only, drawn
 * once per waypoint symbol and cached (elevationCache's own pattern) so a
 * periodic renderMap() doesn't regenerate a canvas, and re-roll its random
 * placement, on every poll. Applied as `material.map` alongside the
 * existing flat `color`: Three multiplies the two, so a system still reads
 * by its established WP3D_COLOR palette — this only adds real surface
 * detail (continents, bands, craters) on top of it instead of replacing it.
 * Types with no plausible natural surface (stations, gates, gravity wells)
 * return null and stay flat, same as before this pass.
 */
/**
 * One cache entry per waypoint holds everything derived from its biome
 * canvas: the texture makeBodyTexture() hands to the material, and the raw
 * pixel data makeBodyGeometry() reads as a height field for real vertex
 * displacement — see that function's comment. Both draw from the exact
 * same canvas (same variant, same seed), so the bumps line up with the
 * pattern instead of two independently-random textures fighting each
 * other.
 */
const bodyVisualCache = new Map();
function ensureBodyVisual(symbol, type, traits) {
  if (bodyVisualCache.has(symbol)) return bodyVisualCache.get(symbol);
  const variants = BODY_TEXTURE_DRAWERS[type];
  if (!variants) {
    bodyVisualCache.set(symbol, null);
    return null;
  }
  // Prefer the waypoint's own real SpaceTraders traits over a coin flip: a
  // VOLCANIC-tagged planet should look volcanic, not whichever variant its
  // symbol happened to hash to. BODY_TEXTURE_TRAITS lists, per type, which
  // trait symbols point at which variant index — first match wins. Only
  // waypoints with none of the listed traits (or a type with no mapping at
  // all) fall back to the old hash, which is still what keeps two otherwise
  // identical bodies from looking like carbon copies.
  const traitSymbols = (traits ?? []).map((t) => t?.symbol ?? t);
  const traitMap = BODY_TEXTURE_TRAITS[type];
  let variantIndex = traitMap ? traitMap.findIndex((symbols) => symbols.some((s) => traitSymbols.includes(s))) : -1;
  if (variantIndex < 0) {
    // Which variant a waypoint gets is picked once, from a hash of its own
    // symbol — a real SpaceTraders symbol never changes, so this is stable
    // forever with no need to actually assign-and-persist a "subtype" on
    // first discovery: the hash IS the persisted assignment, for free.
    variantIndex = Math.floor(Math.abs(hashString(symbol + ":variant")) * variants.length) % variants.length;
  }
  const variant = variants[variantIndex];
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  variant(ctx, size, seededRandom(symbol));
  // The drawers above were designed against a flat, unlit preview and read
  // clearly there — but under this map's actual point-light + PBR specular
  // response, that same ~90-220 lightness range gets compressed hard: the
  // lit hemisphere pushes toward a blown-out highlight, the unlit side
  // toward a flat emissive floor, and what's left in between barely
  // survives. Push contrast out from mid-gray before this ever becomes a
  // texture, so the surface pattern still reads once real lighting (and
  // the sphere-UV mip issue worked around above) get their turn at it.
  const boosted = ctx.getImageData(0, 0, size, size);
  const px = boosted.data;
  const contrast = 1.7;
  for (let i = 0; i < px.length; i += 4) {
    px[i] = Math.max(0, Math.min(255, (px[i] - 128) * contrast + 128));
    px[i + 1] = Math.max(0, Math.min(255, (px[i + 1] - 128) * contrast + 128));
    px[i + 2] = Math.max(0, Math.min(255, (px[i + 2] - 128) * contrast + 128));
  }
  ctx.putImageData(boosted, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  // Confirmed live (a JUNGLE planet rendering as a flat, patternless blob)
  // and reproduced in isolation: a body's mip-mapped canvas texture, wrapped
  // around a SphereGeometry's UVs, samples as a smooth near-uniform blur
  // with no surface detail at all — even fully unlit, even on a bare test
  // scene with nothing else in it. A flat PlaneGeometry with the identical
  // texture renders correctly; only the sphere's wrapped UVs trigger it,
  // which points at automatic mip selection picking a wildly-too-coarse
  // level (the U seam's UV derivative jumps hugely at a full 0→1 wrap).
  // Skipping mipmaps and sampling the base level directly restores the
  // pattern. The texture is only ever seen at a few fixed close-in zoom
  // levels on this map, never minified enough for losing mips to look
  // aliased, so there's no real tradeoff here.
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  // Reused across every renderMap() rebuild — see clearGroup()'s comment for
  // why this must survive the mesh that's currently wearing it.
  tex.__persistent = true;
  const entry = { tex, imageData: boosted, size };
  bodyVisualCache.set(symbol, entry);
  return entry;
}

function makeBodyTexture(symbol, type, traits) {
  return ensureBodyVisual(symbol, type, traits)?.tex ?? null;
}

// Planets and moons get real relief carved into the mesh, not just a flat
// color texture — the same biome canvas ensureBodyVisual() already draws
// (jungle canopy, volcanic cracks, ice fractures, crater fields...) doubles
// as a height field, so a JUNGLE world reads as lumpy canopy and a rocky
// moon as genuinely cratered under real lighting, not just tinted. Gas
// giants (fluid, banded, no surface) and everything else keep a plain
// sphere — displacement only makes sense for a body with actual terrain.
const DISPLACED_BODY_TYPES = new Set(["PLANET", "MOON"]);
const bodyGeometryCache = new Map();
function makeBodyGeometry(symbol, type, traits, radius) {
  if (bodyGeometryCache.has(symbol)) return bodyGeometryCache.get(symbol);
  const displace = DISPLACED_BODY_TYPES.has(type);
  // Higher tessellation only where it buys real detail — everything else
  // keeps the original 20x16 a flat-shaded sphere doesn't need more than.
  const geo = displace
    ? new THREE.SphereGeometry(radius, 48, 32)
    : new THREE.SphereGeometry(radius, 20, 16);
  if (displace) {
    const visual = ensureBodyVisual(symbol, type, traits);
    if (visual) {
      const { imageData, size } = visual;
      const pos = geo.attributes.position;
      const uv = geo.attributes.uv;
      // Up to ~7% of the body's own radius — enough to read as real relief
      // at this map's usual zoom without turning a planet into a spiky mess.
      const amplitude = radius * 0.07;
      for (let i = 0; i < pos.count; i++) {
        const px = Math.min(size - 1, Math.max(0, Math.floor(uv.getX(i) * size)));
        const py = Math.min(size - 1, Math.max(0, Math.floor((1 - uv.getY(i)) * size)));
        const lightness = imageData.data[(py * size + px) * 4] / 255; // grayscale: R=G=B
        const displacement = (lightness - 0.5) * 2 * amplitude;
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const len = Math.hypot(x, y, z) || 1;
        const scale = (len + displacement) / len;
        pos.setXYZ(i, x * scale, y * scale, z * scale);
      }
      pos.needsUpdate = true;
      // Bent normals from the new bumps, not the original sphere's — this
      // is what makes the relief actually catch light instead of just
      // silently reshaping the silhouette.
      geo.computeVertexNormals();
    }
  }
  // Reused across every renderMap() rebuild — recomputing ~1,600 displaced
  // vertices every ~1s poll for every visible planet/moon for no reason
  // would be wasteful, and clearGroup() already knows to leave a
  // `__persistent` resource alone instead of disposing it out from under
  // the cache that's still holding it (see that function's comment).
  geo.__persistent = true;
  bodyGeometryCache.set(symbol, geo);
  return geo;
}

// ASTEROID/ASTEROID_FIELD/ENGINEERED_ASTEROID get the same "not quite
// round" treatment as ASTEROID_BASE's rock, rather than the smooth sphere
// every other undisplaced type keeps — real asteroids read as lumpy at any
// size, unlike a planet or gas giant. Deliberately its own cache/function
// rather than folding into makeBodyGeometry()/DISPLACED_BODY_TYPES: that
// pipeline's displacement rides the body's own biome canvas as a height
// field (continents, ice fractures...) which doesn't apply to a bare rock,
// so this perturbs the mesh geometry directly instead.
const IRREGULAR_ROCK_TYPES = new Set(["ASTEROID", "ASTEROID_FIELD", "ENGINEERED_ASTEROID"]);
const rockGeometryCache = new Map();
function makeRockGeometry(symbol, radius) {
  if (rockGeometryCache.has(symbol)) return rockGeometryCache.get(symbol);
  const rand = seededRandom(symbol + ":rock");
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const bump = 1 + (rand() - 0.5) * 0.4;
    pos.setXYZ(i, (x / len) * len * bump, (y / len) * len * bump, (z / len) * len * bump);
  }
  geo.computeVertexNormals();
  geo.__persistent = true; // same reuse-across-rebuilds reasoning as bodyGeometryCache
  rockGeometryCache.set(symbol, geo);
  return geo;
}

// Each type maps to an array of *variant* drawers, not one — which variant
// a given waypoint gets is picked in makeBodyTexture() from a hash of its
// own symbol, so two PLANET waypoints in the same system can look
// genuinely different (continents vs. ice vs. cracked-volcanic) instead of
// every one being a minor random reshuffle of the same single pattern.
//
// This used to say every variant was deliberately grayscale — pattern
// only, never hue — to protect the map's one color contract (WP3D_COLOR
// says "this is a planet" vs "this is a gas giant" by hue). Confirmed
// live: that was the actual reason only the volcanic variant ever read as
// textured. A pure `rgba(v,v,v,a)` blotch only shifts *lightness*, and
// this map's real lighting (a strong point light plus PBR specular
// response) compresses lightness differences hard — volcanic's orange
// embers survived because a hue shift doesn't get compressed the same
// way, not because its blotches were bigger or more opaque (the failed
// first attempt at this fix pushed every variant's alpha and value range
// toward volcanic's own and it made no visible difference). Every variant
// below now carries a small hue accent the same way volcanic always did.
// The accents are subtly off-neutral, not saturated — the base fill (most
// of the visible disc) stays close to the type's own palette color, so
// "this is a planet" still reads at a glance; only the feature blotches
// that are supposed to stand out now actually can.
const BODY_TEXTURE_DRAWERS = {
  PLANET: [
    // Continents: soft overlapping blotches at varying lightness — reads
    // as terrain from orbit without needing real Perlin noise for a
    // sphere this small on screen.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // Land above the noise field's median, base tone below it — real
      // jagged coastlines instead of soft round blobs.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 3, 0.5, 1.8);
        if (n > 0) {
          const t = Math.min(1, n * 1.8);
          const val = Math.round(140 + t * 95);
          // Warm tan/green landmass hue, not pure gray — see the comment
          // above BODY_TEXTURE_DRAWERS for why a hue accent (not just
          // alpha/range) is what actually survives this map's real lighting.
          return [Math.min(255, val + 12), Math.min(255, val + 4), Math.max(0, val - 22), 255];
        }
        const val = Math.round(130 + n * 25);
        return [val, val, val, 255];
      });
    },
    // Ice: a bright base with soft frost patches for area coverage plus a
    // network of cracks on top — the patches alone (cracks are thin lines
    // that cover almost no area) are what make this variant actually read
    // from a distance instead of just looking like a flat pale ball with
    // a few hairline scratches.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // A lower-frequency fbm layer for frost-patch area coverage, plus a
      // ridge-noise pass (1 - abs(noise), the standard trick for linear
      // crack-like features) for the crack network — a real fracture
      // pattern instead of hand-drawn random-walk lines.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const frost = sphereNoise(noise, u, v, 3, 0.5, 1.6);
        const ridge = 1 - Math.abs(sphereNoise(noise, u + 7.3, v + 2.1, 1, 0.5, 2.6));
        if (ridge > 0.92) return [70, 90, 110, 255];
        const base = Math.round(160 + frost * 70);
        // Cold blue-white frost, not pure gray.
        return [Math.max(0, base - 20), base, Math.min(255, base + 15), 255];
      });
    },
    // Volcanic: a dark base with glowing cracks/blotches — same silhouette
    // as the continents variant but inverted lightness and hot accents.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // Higher-frequency ridge noise for the fracture network itself,
      // thresholded and colored with the same warm-ember hue at the ridge
      // crests. The radial-gradient glow below is a lighting effect on top
      // of the fractures, not a background pattern — left untouched.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const ridge = 1 - Math.abs(sphereNoise(noise, u, v, 1, 0.5, 3.2));
        if (ridge > 0.85) {
          const t = (ridge - 0.85) / 0.15;
          return [Math.round(200 + t * 55), Math.round(90 + t * 90), Math.round(50 + t * 70), 255];
        }
        return [58, 50, 48, 255];
      });
      for (let i = 0; i < 10; i++) {
        const x = rand() * size, y = rand() * size;
        const r = size * (0.03 + rand() * 0.1);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(255,180,120,0.9)");
        g.addColorStop(0.4, "rgba(200,90,50,0.5)");
        g.addColorStop(1, "rgba(200,90,50,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }
    },
    // Swamp: a mid-grey base pocked with small dark bog pools plus a
    // network of thin winding waterways — busier and more irregular than
    // continents' broad soft blotches, reading as wet, low terrain rather
    // than dry landmasses.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // Low-threshold blotchy fbm for bog-pool coverage, plus a ridge-noise
      // pass for the waterway channels — a real drainage-like network
      // instead of hand-drawn random-walk lines.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const bog = sphereNoise(noise, u, v, 2, 0.55, 1.8);
        const channel = 1 - Math.abs(sphereNoise(noise, u + 4.1, v + 9.7, 1, 0.5, 2.8));
        if (channel > 0.93) return [35, 55, 35, 255];
        if (bog > 0.25) {
          const val = Math.round(30 + (bog - 0.25) * 40);
          // Murky bog green, not pure gray.
          return [Math.max(0, val - 10), val + 12, Math.max(0, val - 15), 255];
        }
        return [138, 138, 128, 255];
      });
    },
    // Rocky: a barren, cracked rock face — jagged angular facets at varying
    // lightness plus a few sharper impact-style dark/light pairs, closer to
    // the moon's cratered look than continents' soft terrain but denser and
    // more fractured, since this is a whole planet's worth of exposed stone.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // High-frequency, low-octave noise for jagged facet coverage — the
      // discrete crater stamps below are genuinely better represented as
      // shapes than noise, so they stay as-is.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 2, 0.5, 3.5);
        const val = Math.round(125 + n * 65);
        // Warm reddish-brown stone, not pure gray.
        return [Math.min(255, val + 15), Math.max(0, val - 10), Math.max(0, val - 25), 255];
      });
      const craters = 4 + Math.floor(rand() * 5);
      for (let i = 0; i < craters; i++) {
        const x = rand() * size, y = rand() * size;
        const r = size * (0.02 + rand() * 0.05);
        ctx.beginPath();
        ctx.fillStyle = "rgba(30,22,18,0.7)";
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = "rgba(230,210,190,0.55)";
        ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    // Barren: flat and mostly featureless — deliberately the quietest
    // variant of the set, but still real enough to read as *something*
    // rather than vanishing entirely once real lighting gets hold of it.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // A single low-amplitude, low-frequency octave only — deliberately
      // the quietest variant, matching its "nothing much going on"
      // character; noise here should barely read, not disappear.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 1, 0.5, 1.2);
        const val = Math.round(135 + n * 18);
        // Dusty tan, not pure gray — kept subtler than the busier variants.
        return [Math.min(255, val + 10), val, Math.max(0, val - 14), 255];
      });
    },
    // Jungle: dense, heavily overlapping blotches at high count — reads as
    // near-total canopy cover, the busiest and most textured of the
    // vegetated variants next to continents' sparser landmasses.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // High-frequency, high-octave-count fbm thresholded broadly — canopy
      // covers most of the surface, the busiest variant of the set.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 3, 0.6, 2.4);
        const t = Math.max(0, Math.min(1, (n + 0.6) / 1.2));
        const val = Math.round(80 + t * 130);
        // Real canopy green, not pure gray.
        return [Math.max(0, val - 35), Math.min(255, val + 10), Math.max(0, val - 35), 255];
      });
    },
    // Ocean: mostly a flat, smooth base (open water) with just a few small,
    // crisp light patches (islands/reefs) — the inverse of continents'
    // land-dominant look, land is the exception here instead of the rule.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // The inverse of continents: a high threshold so only small isolated
      // bright regions surface as islands against an otherwise flat field.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 2, 0.55, 2.2);
        if (n > 0.55) {
          const val = Math.round(160 + (n - 0.55) * 180);
          // Sandy tan islands against blue water, not pure gray.
          return [Math.min(255, val + 15), val, Math.max(0, val - 35), 255];
        }
        const val = Math.round(150 + n * 20);
        return [val, val, val, 255];
      });
      // A few broad, very soft current/depth bands so it doesn't read as
      // perfectly flat.
      for (let i = 0; i < 3; i++) {
        const y = rand() * size;
        const h = size * (0.08 + rand() * 0.1);
        const v = Math.round(60 + rand() * 30);
        ctx.fillStyle = `rgba(${Math.max(0, v - 20)},${Math.max(0, v - 10)},${Math.min(255, v + 25)},0.4)`;
        ctx.fillRect(0, y, size, h);
      }
    },
    // Radioactive: a scarred, speckled base with scattered small glowing
    // hot-spots — similar idea to volcanic's accent glow but colder, finer,
    // and much more numerous, reading as widespread contamination rather
    // than a few active vents.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // The scattered-hotspot glow loop below already works and isn't a
      // "background pattern" problem — untouched. Only the base speckle
      // fill swaps from per-pixel random dots to very-high-frequency,
      // low-octave noise.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 1, 0.5, 6);
        // Sickly green-yellow glow specks and dark scarring, not pure gray.
        if (n > 0.6) return [20, 24, 16, 255];
        if (n < -0.6) {
          const val = Math.round(200 + (-n - 0.6) * 130);
          return [Math.max(0, val - 40), val, Math.max(0, val - 130), 255];
        }
        return [122, 122, 120, 255];
      });
      for (let i = 0; i < 8; i++) {
        const x = rand() * size, y = rand() * size;
        const r = size * (0.02 + rand() * 0.05);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(210,255,90,0.9)");
        g.addColorStop(1, "rgba(210,255,90,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }
    },
  ],
  GAS_GIANT: [
    // Storm bands: horizontal bands of varying lightness plus a couple of
    // wavy streaks breaking up the hard edges — the classic look.
    (ctx, size, rand) => {
      const bands = 6 + Math.floor(rand() * 5);
      for (let i = 0; i < bands; i++) {
        const v = Math.round(150 + rand() * 105);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(0, (i / bands) * size, size, size / bands + 1);
      }
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = "#fff";
      for (let i = 0; i < 3; i++) {
        const yBase = rand() * size;
        const phase = rand() * 10;
        ctx.lineWidth = 2 + rand() * 4;
        ctx.beginPath();
        ctx.moveTo(0, yBase);
        for (let x = 0; x <= size; x += 8) ctx.lineTo(x, yBase + Math.sin(x * 0.05 + phase) * 6);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
    // Great storm: fewer, wider bands plus one big swirling oval accent —
    // reads as a single dominant storm system rather than uniform stripes.
    (ctx, size, rand) => {
      const bands = 3 + Math.floor(rand() * 3);
      for (let i = 0; i < bands; i++) {
        const v = Math.round(150 + rand() * 105);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(0, (i / bands) * size, size, size / bands + 1);
      }
      const sx = size * (0.3 + rand() * 0.4), sy = size * (0.3 + rand() * 0.4);
      const sr = size * (0.12 + rand() * 0.08);
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
      g.addColorStop(0, "rgba(255,255,255,0.5)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(1.6, 1);
      ctx.translate(-sx, -sy);
      ctx.fillRect(0, 0, size, size);
      ctx.restore();
    },
  ],
  MOON: [
    // Cratered: dark base with light/dark crater pairs (rim + highlight)
    // scattered across the surface.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // Discrete crater stamps stay as-is; only the flat base fill swaps
      // for a low-octave noise background.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 2, 0.5, 2.5);
        const val = Math.round(100 + n * 35);
        return [val, val, val, 255];
      });
      const count = 10 + Math.floor(rand() * 10);
      for (let i = 0; i < count; i++) {
        const x = rand() * size, y = rand() * size;
        const r = size * (0.02 + rand() * 0.07);
        ctx.beginPath();
        ctx.fillStyle = "rgba(25,22,20,0.8)";
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        // Warm rim highlight, not pure gray — see the comment above
        // BODY_TEXTURE_DRAWERS for why hue (not just alpha) is what
        // actually survives this map's real lighting.
        ctx.fillStyle = "rgba(225,205,180,0.6)";
        ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    // Smooth/mottled: fewer, larger soft patches and no crisp craters — a
    // moon that reads as geologically quieter than its cratered sibling.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // A single low-octave fbm blotch field, replacing the radial-gradient
      // patches — a geologically quiet moon.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 2, 0.5, 2);
        const val = Math.round(105 + n * 45);
        return [Math.min(255, val + 15), val, Math.max(0, val - 18), 255];
      });
    },
  ],
  ASTEROID: [
    // Coarse blocky noise — a rough, jagged rock face rather than a
    // smooth gradient, matching how small/near these bodies read.
    (ctx, size, rand) => {
      const cell = 8;
      for (let y = 0; y < size; y += cell) {
        for (let x = 0; x < size; x += cell) {
          const v = Math.round(120 + rand() * 130);
          ctx.fillStyle = `rgb(${v},${v},${v})`;
          ctx.fillRect(x, y, cell, cell);
        }
      }
    },
    // Streaked: elongated jagged facets instead of a uniform grid — reads
    // as a more angular, fractured chunk of rock.
    (ctx, size, rand) => {
      ctx.fillStyle = "#8a8a8a";
      ctx.fillRect(0, 0, size, size);
      const facets = 14 + Math.floor(rand() * 10);
      for (let i = 0; i < facets; i++) {
        const x = rand() * size, y = rand() * size;
        const w = size * (0.05 + rand() * 0.2), h = size * (0.03 + rand() * 0.08);
        const v = Math.round(100 + rand() * 140);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rand() * Math.PI);
        ctx.fillStyle = `rgba(${v},${v},${v},0.6)`;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.restore();
      }
    },
  ],
  // Soft, large, overlapping wisps — a gas cloud rather than a solid
  // surface, so blobs are bigger and softer than a planet's continents.
  // Left as a single variant: a nebula is diffuse by nature, so the same
  // technique already varies plenty from its own random blob placement.
  NEBULA: [
    (ctx, size, rand) => {
      ctx.fillStyle = "#999";
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 6; i++) {
        const x = rand() * size, y = rand() * size;
        const r = size * (0.2 + rand() * 0.35);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(255,255,255,0.35)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }
    },
  ],
};
BODY_TEXTURE_DRAWERS.ASTEROID_FIELD = BODY_TEXTURE_DRAWERS.ASTEROID;
BODY_TEXTURE_DRAWERS.ENGINEERED_ASTEROID = BODY_TEXTURE_DRAWERS.ASTEROID;
BODY_TEXTURE_DRAWERS.DEBRIS_FIELD = BODY_TEXTURE_DRAWERS.ASTEROID;

// Real waypoint traits (WaypointTraitSymbol from the SpaceTraders schema)
// that point at a specific BODY_TEXTURE_DRAWERS variant index for that type.
// Index in this array === index into that type's drawer array above.
// A waypoint with none of a type's listed traits falls back to the hash in
// makeBodyTexture() — most waypoints only carry economy/settlement traits
// (MARKETPLACE, HIGH_TECH, ...) with nothing environmental to key off.
const BODY_TEXTURE_TRAITS = {
  // Every real SpaceTraders planet-biome trait (ROCKY, VOLCANIC, FROZEN,
  // SWAMP, BARREN, TEMPERATE, JUNGLE, OCEAN, RADIOACTIVE) gets its own
  // explicit entry here — a planet with none of these (rare; most carry
  // exactly one) is the only case that reaches the symbol-hash fallback in
  // makeBodyTexture(). Leaving a trait unmapped is what let a JUNGLE planet
  // draw as volcanic purely by hash luck; every biome trait needs a home.
  PLANET: [
    ["TEMPERATE"], // continents — also the fallback default
    ["FROZEN", "ICE_CRYSTALS"], // ice
    ["VOLCANIC", "MAGMA_SEAS", "SUPERVOLCANOES", "ASH_CLOUDS"], // volcanic
    ["SWAMP"], // swamp
    ["ROCKY"], // rocky
    ["BARREN"], // barren
    ["JUNGLE"], // jungle
    ["OCEAN"], // ocean
    ["RADIOACTIVE"], // radioactive
  ],
  MOON: [
    ["DEEP_CRATERS", "SHALLOW_CRATERS", "ROCKY"], // cratered
    ["TERRAFORMED", "TEMPERATE"], // smooth/mottled
  ],
};

/**
 * Atmospheric fresnel rim: a slightly larger, additive-blended shell around
 * a body that's nearly invisible face-on and brightens toward the visible
 * silhouette edge — the standard cheap "planet glow" trick (no post-
 * processing pipeline needed, unlike real bloom). Real atmospheres scatter
 * light most at a grazing angle, which is exactly what `1 - dot(normal,
 * viewDir)` measures, so this doubles as the fix for airless-looking
 * terminators: the edge now reads as lit air, not a hard cutoff into black.
 */
const ATMOSPHERE_RIM_VERTEX = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;
const ATMOSPHERE_RIM_FRAGMENT = `
  uniform vec3 rimColor;
  uniform float rimPower;
  uniform float rimIntensity;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    float rim = 1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0);
    gl_FragColor = vec4(rimColor, pow(rim, rimPower) * rimIntensity);
  }
`;
function makeAtmosphereRim(size, colorHex, power, intensity) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      rimColor: { value: new THREE.Color(colorHex) },
      rimPower: { value: power },
      rimIntensity: { value: intensity },
    },
    vertexShader: ATMOSPHERE_RIM_VERTEX,
    fragmentShader: ATMOSPHERE_RIM_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(size * 1.16, 24, 18), mat);
}
// Per-type atmosphere tint/power/intensity — planets and gas giants get a
// confident glow; moons (mostly airless) get a much fainter one, just
// enough to soften the terminator without implying a real atmosphere.
const ATMOSPHERE_RIM = {
  PLANET: { color: 0x9fd0ff, power: 2.4, intensity: 0.8 },
  GAS_GIANT: { color: 0xffcf8a, power: 1.9, intensity: 0.9 },
  MOON: { color: 0xcdd8e8, power: 3.0, intensity: 0.35 },
};

/** Shared hollow-ring gradient for jump-gate pulses — transparent center
 *  and outside, bright only in a band partway out, so scaling the whole
 *  sprite up over time reads as a ring expanding outward from the gate
 *  rather than a glow blob growing in place. */
let gatePulseTexture = null;
function getGatePulseTexture() {
  if (gatePulseTexture) return gatePulseTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "#fff0");
  g.addColorStop(0.62, "#fff0");
  g.addColorStop(0.78, "#fffc");
  g.addColorStop(1, "#fff0");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  gatePulseTexture = new THREE.CanvasTexture(c);
  return gatePulseTexture;
}

/** Shared soft-round point sprite for asteroid-field particles — generated
 *  once (not per field) since every field's particles use the same dot,
 *  just tinted by that field's own WP3D_COLOR at material level. */
let asteroidDotTexture = null;
function getAsteroidDotTexture() {
  if (asteroidDotTexture) return asteroidDotTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
  g.addColorStop(0, "#fffa");
  g.addColorStop(1, "#fff0");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 16);
  asteroidDotTexture = new THREE.CanvasTexture(c);
  // Shared across every field/every rebuild — see clearGroup()'s comment.
  asteroidDotTexture.__persistent = true;
  return asteroidDotTexture;
}

/**
 * A real asteroid field is *many* small rocks, not one dot — rendering it
 * as a single sphere (same as every other waypoint type) was the one
 * place the map's "one body, one dot" convention actively undersold what
 * the type means. This scatters a small cloud of point sprites in a
 * flattened spherical shell around the field's own position, seeded from
 * its symbol so the scatter is stable across re-renders. Decorative only —
 * the actual pickable/selectable body underneath (added by the caller,
 * same as every other type) is untouched, so click-to-select behavior
 * doesn't change.
 */
function makeAsteroidCluster(symbol, size, color) {
  const rand = seededRandom(symbol + ":cluster");
  const count = 26;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = size * (1.1 + rand() * 2.0);
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.35; // flattened, not a true sphere
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    map: getAsteroidDotTexture(), color, size: Math.max(0.18, size * 0.4),
    sizeAttenuation: true, transparent: true, depthWrite: false, alphaTest: 0.05,
  });
  return new THREE.Points(geo, mat);
}

// Orbital stations and asteroid bases used to render as a plain sphere,
// same as everything else, differentiated only by size/color/height — a
// station looked identical in silhouette to a moon. Both now build a real
// multi-part THREE.Group instead of a single sphere Mesh: the waypoint-body
// loop below is responsible for positioning the returned group and pushing
// every sub-mesh (not just the group) into `pickables`, since pickAt()
// raycasts against individual meshes and looks them up by exact reference.
function makeStationBody(symbol, size, color) {
  const group = new THREE.Group();

  const hub = new THREE.Mesh(
    new THREE.SphereGeometry(size * 0.4, 16, 12),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.08, roughness: 0.4, metalness: 0.6 }),
  );
  group.add(hub);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(size * 1.05, size * 0.13, 8, 28),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.05, roughness: 0.5, metalness: 0.7, side: THREE.DoubleSide }),
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);

  const strutMat = new THREE.MeshStandardMaterial({ color: themedColor("--dim"), roughness: 0.6, metalness: 0.5 });
  const struts = [];
  const strutCount = 4;
  for (let i = 0; i < strutCount; i++) {
    const angle = (2 * Math.PI * i) / strutCount;
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.045, size * 0.045, size * 0.75, 6), strutMat);
    strut.position.set(Math.cos(angle) * size * 0.72, 0, Math.sin(angle) * size * 0.72);
    strut.rotation.z = Math.PI / 2;
    strut.rotation.y = -angle;
    group.add(strut);
    struts.push(strut);
  }

  const rand = seededRandom(symbol + ":station-lights");
  const lights = [];
  for (let i = 0; i < 3; i++) {
    const angle = rand() * Math.PI * 2;
    const light = makeGlowSprite(themedColor("--buff"), size * 0.45);
    light.position.set(Math.cos(angle) * size * 1.05, 0, Math.sin(angle) * size * 1.05);
    group.add(light);
    lights.push(light);
  }

  return { group, meshes: [hub, ring, ...struts] };
}

// A single irregular displaced icosahedron (no shared cache the way
// makeBodyGeometry() has one for planets/moons — cheap enough, and unique
// per waypoint, to just rebuild each renderMap() pass like the rings/stalks
// already do) plus one small attached structure standing in for the actual
// base, oriented outward from a random point on the rock's own surface.
function makeAsteroidBaseBody(symbol, size, color) {
  const rand = seededRandom(symbol + ":asteroidbase");
  const group = new THREE.Group();

  const geo = new THREE.IcosahedronGeometry(size, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const bump = 1 + (rand() - 0.5) * 0.45;
    pos.setXYZ(i, (x / len) * len * bump, (y / len) * len * bump, (z / len) * len * bump);
  }
  geo.computeVertexNormals();
  const rock = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: themedColor("--dim"), roughness: 0.9, metalness: 0.05, flatShading: true,
  }));
  group.add(rock);

  const theta = rand() * Math.PI * 2;
  const phi = Math.acos(2 * rand() - 1);
  const bx = Math.sin(phi) * Math.cos(theta);
  const by = Math.sin(phi) * Math.sin(theta);
  const bz = Math.cos(phi);
  const structure = new THREE.Mesh(
    new THREE.BoxGeometry(size * 0.5, size * 0.35, size * 0.5),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.15, roughness: 0.5, metalness: 0.5 }),
  );
  structure.position.set(bx * size * 0.9, by * size * 0.9, bz * size * 0.9);
  structure.lookAt(bx * size * 2, by * size * 2, bz * size * 2);
  group.add(structure);

  const light = makeGlowSprite(themedColor("--buff"), size * 0.6);
  light.position.set(bx * size * 1.15, by * size * 1.15, bz * size * 1.15);
  group.add(light);

  return { group, meshes: [rock, structure] };
}

function makeGlowSprite(color, size) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  const hex = "#" + color.getHexString();
  g.addColorStop(0, hex + "aa");
  g.addColorStop(1, hex + "00");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(size, size, 1);
  return sp;
}

function shouldLabelWaypoint(wp) {
  const traits = wp.traits ?? [];
  const hasMarket = traits.some((t) => (t.symbol ?? t) === "MARKETPLACE");
  const hasShipyard = traits.some((t) => (t.symbol ?? t) === "SHIPYARD");
  const isParent = wp.type === "PLANET" || wp.type === "GAS_GIANT";
  return isParent || wp.type === "JUMP_GATE" || hasMarket || hasShipyard;
}

function makeLabelSprite(text, color) {
  // The sprite maps its *whole* texture onto whatever quad sp.scale gives
  // it — sizing that quad from the measured text width while the canvas
  // stayed a fixed, mostly-blank 220x28 squished the entire texture (glyphs
  // included) down to a sliver. Sizing the canvas to the text itself keeps
  // canvas pixels and sprite-scale units in the same frame, so nothing gets
  // squeezed.
  const scale = 3;
  const font = "500 10px Rajdhani, sans-serif";
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = font;
  const w = Math.ceil(measure.measureText(text).width) + 6;
  const h = 16;
  const c = document.createElement("canvas");
  c.width = w * scale; c.height = h * scale;
  const ctx = c.getContext("2d");
  ctx.scale(scale, scale);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  ctx.fillText(text, 3, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(w * 0.08, h * 0.08, 1);
  sp.center.set(0, 0.5);
  return sp;
}

/**
 * Same shape as the flat map's own bounding-box fit (renderMap()'s
 * min/max/span/pad math) — the whole system framed by default rather than
 * cropped to whatever happens to be active — just producing a 3D scale
 * factor and centroid instead of an SVG viewBox.
 */
/**
 * A linear world->scene scale cannot show both ends of a real SpaceTraders
 * system at once: a home cluster's own members are often tens of units
 * apart while a genuine outlier sits hundreds of units out — two orders of
 * magnitude apart. Scaled to keep the outlier on screen, the home cluster's
 * real spacing collapses to sub-body-size and the anti-overlap pass alone
 * decides its layout; scaled to resolve the home cluster, outliers go off
 * the edge. Distance from the system's star (its natural center, (0,0) in
 * SpaceTraders' own coordinates) is compressed through sqrt() instead — the
 * same trick subway maps and fisheye views use for data with a huge dynamic
 * range: nearby differences get outsized visual room, a distant point still
 * reads as clearly farther, without either end swallowing the other's
 * resolution.
 */
function fitSystemScale(pool) {
  let maxR = 20;
  for (const p of pool) maxR = Math.max(maxR, Math.hypot(p.x, p.y));
  // A slightly gentler compression than sqrt() so nearby planets keep more
  // of their real separation while distant outliers still fit. Tuned for the
  // new "readable" body sizes (planets ~3-4, orbiters ~0.5-1). The larger
  // target pushes the home cluster farther from the central star so the map
  // reads as a real solar system rather than a tight knot.
  const pow = 0.55;
  const scale = 140 / Math.pow(maxR, pow); // world units -> scene units
  return { scale, pow };
}

function worldToScene(x, y, s) {
  const r = Math.hypot(x, y);
  if (r < 1e-6) return { x: 0, z: 0 };
  const rPrime = Math.pow(r, s.pow) * s.scale;
  return { x: (x / r) * rPrime, z: (y / r) * rPrime };
}

/**
 * Confirmed live: every biome texture (bodyTextureCache) and the shared
 * asteroid-dot sprite (asteroidDotTexture) were rendering as a flat,
 * patternless gradient — never the jungle/rocky/ice/etc. surface pattern,
 * even fully unlit with the atmosphere rim hidden. Root cause: this ran on
 * every ~1s renderMap() poll, disposing `material.map` for every mesh being
 * torn down. That's correct for a label sprite's one-off canvas-text
 * texture (freshly redrawn each render, genuinely needs freeing), but wrong
 * for a *cached* texture that's deliberately reused across rebuilds — the
 * first poll disposed the GPU resource bodyTextureCache/asteroidDotTexture
 * still held a JS reference to, so the very next rebuild rebound an already-
 * disposed texture. The first frame after a fresh page load looked fine
 * (nothing had been disposed yet); every frame after the first poll didn't.
 * Persistent textures are tagged `.__persistent` where created
 * (makeBodyTexture(), getAsteroidDotTexture()) and skipped here. The same
 * applies to makeBodyGeometry()'s displaced planet/moon geometry — freeing
 * that every poll would be the exact same bug, just for the mesh shape
 * instead of its texture, so geometry checks the same flag before disposal.
 */
function disposeObject3D(c) {
  if (c.geometry && !c.geometry.__persistent) c.geometry.dispose();
  if (c.material?.map && !c.material.map.__persistent) c.material.map.dispose();
  c.material?.dispose?.();
}

function clearGroup(g) {
  while (g.children.length) {
    const c = g.children.pop();
    // Station/asteroid-base bodies and ship hulls are THREE.Group instances
    // holding several meshes each (hub+ring+struts, rock+structure,
    // fuselage+wings...) — a bare pop()+dispose() here only ever touched the
    // group itself (no geometry/material of its own), silently leaking every
    // mesh nested inside it on each rebuild. traverse() reaches all of them.
    c.traverse(disposeObject3D);
  }
}

function scheduleRebuild() {
  if (pendingRebuild) return;
  pendingRebuild = requestAnimationFrame(() => { pendingRebuild = null; renderMap(state?.ships ?? []); });
}

// One look per SpaceTraders SystemType (captured in galaxy_systems.
// system_type by the galaxy crawler, surfaced on state.systems[].type — see
// tenantRegistry.ts's refreshState()). `mid`/`edge` are the star sphere's
// own gradient stops (core stays a constant white-hot fff8e8 for every
// type); `light` is the PointLight color. Not attempting a literal
// black-hole render (an accretion disk is a different shape entirely, not
// just a different tint) — a near-black core with a faint violet rim reads
// as "unusual" without a bespoke mesh.
const STAR_TYPE_STYLE = {
  NEUTRON_STAR: { mid: 0xdcecff, edge: 0xbfe0ff, light: 0xdbe8ff },
  RED_STAR: { mid: 0xffd9a0, edge: 0xff7b72, light: 0xfff1d8 },
  ORANGE_STAR: { mid: 0xffcf8a, edge: 0xff9c4d, light: 0xffe9c8 },
  BLUE_STAR: { mid: 0x9fd0ff, edge: 0x5aa4ff, light: 0xe4f0ff },
  YOUNG_STAR: { mid: 0xd7f0ff, edge: 0x8fd6ff, light: 0xeef8ff },
  WHITE_DWARF: { mid: 0xffffff, edge: 0xeaf2ff, light: 0xffffff },
  BLACK_HOLE: { mid: 0x3a2350, edge: 0x1a0e28, light: 0x8f6ad1 },
  HYPERGIANT: { mid: 0xe8f6ff, edge: 0xbfe6ff, light: 0xf3fbff },
  NEBULA: { mid: 0xe4c8ff, edge: 0xb48cff, light: 0xead6ff },
  UNSTABLE: { mid: 0xffb37a, edge: 0xff5a3c, light: 0xffd9b8 },
};

/** Rebuilds a radial-gradient CanvasTexture and swaps it onto `target`
 *  (a Mesh or a glow Sprite, both of which read their color from
 *  `material.map`, not `material.color` — see makeGlowSprite()'s own
 *  comment) — the same construction each was originally built with, just
 *  parameterized by color instead of hardcoded. `stops` is [offset, hex,
 *  alphaHex?] triples, alphaHex defaulting to opaque ("ff") for the star
 *  sphere and to a fade-to-transparent pair for a glow sprite. */
function repaintRadialTexture(target, size, stops) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  for (const [offset, hex, alpha] of stops) g.addColorStop(offset, "#" + new THREE.Color(hex).getHexString() + (alpha ?? "ff"));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  target.material.map?.dispose();
  target.material.map = new THREE.CanvasTexture(c);
  target.material.needsUpdate = true;
}

/** Repaints the system-view star (sphere + corona glow + its point light)
 *  for `type` (a SystemType, or undefined for a system the crawl hasn't
 *  typed yet — falls back to the original red-dwarf default). No-ops once
 *  already painted for this type, so renderMap()'s ~1s poll tick doesn't
 *  rebuild two canvas textures every call — only an actual system switch
 *  (or the type arriving from a later crawl pass) does. */
function applyStarColor(type) {
  if (!starMesh || type === lastStarType) return;
  lastStarType = type;
  const style = STAR_TYPE_STYLE[type] ?? STAR_TYPE_STYLE.RED_STAR;
  repaintRadialTexture(starMesh, 128, [[0, 0xfff8e8], [0.35, style.mid], [0.7, style.edge], [1, style.edge]]);
  repaintRadialTexture(starCorona, 64, [[0, style.edge, "aa"], [1, style.edge, "00"]]);
  starLight.color.set(style.light);
}

function renderMap(ships, trails = new Map()) {
  if (galaxyMode) { renderGalaxy3D(); return; }
  if (!sceneReady && !mapUnavailable) initMap3D();
  if (mapUnavailable) return;
  const sys = currentSystem || state.agent.headquarters.slice(0, state.agent.headquarters.lastIndexOf("-"));
  $("map-hud").innerHTML = `Sector <b>${sys}</b>`;

  // Same cross-system leak guard the flat map had: an in-transit ship's
  // route carries raw world coordinates with no system tag of its own, so
  // filtering the whole list up front (before shipTransitLerp() runs on any
  // of it) is the one fix that covers every case.
  ships = ships.filter((s) => s.nav.systemSymbol === sys);
  lastRenderedShips = ships;

  const system = systems.find((s) => s.symbol === sys);
  applyStarColor(system?.type);
  waypoints = system?.waypoints ?? state.waypoints ?? [];
  if (!waypoints.length) {
    const seen = new Map();
    for (const s of ships) {
      const wp = s.nav.waypointSymbol;
      if (!seen.has(wp)) seen.set(wp, { x: Math.random() * 100, y: Math.random() * 100 });
    }
    waypoints = [...seen.entries()].map(([symbol, p]) => ({ symbol, x: p.x, y: p.y, type: "PLANET", traits: [] }));
  }

  // A real home system commonly runs 50-90 waypoints, most of them bare
  // asteroids/debris with no market, shipyard, or fleet reason to ever be
  // shown — plotting all of them turned the map into unreadable noise for
  // no operational payoff. Keep only what an operator would ever act on: a
  // market or shipyard, a jump gate, or wherever a ship actually is. This
  // is a rendering-only subset — the shared `waypoints` stays the full
  // list, since other panels (the miner field picker, ship-details lookup)
  // need waypoints this map no longer draws.
  // Previously filtered down to markets/shipyards/gates/occupied waypoints
  // only, as noise-reduction for dense 50-90-waypoint systems -- reverted
  // per user request: bare asteroids and other unremarkable waypoints are
  // expected to render (this is what the old flat map's "little circles"
  // scattered around a system were), not be hidden entirely.
  const sceneWaypoints = waypoints;

  const s = fitSystemScale(sceneWaypoints);
  mapScale = s;
  systemSpan = 80;

  // Leaving galaxy mode is a scene-content mode switch too — see
  // renderGalaxy3D()'s own comment on why this is a hard cut rather than a
  // held-content transition.
  if (mapMode !== "system") {
    mapMode = "system";
    starGroup.visible = true;
  }
  clearGroup(bodiesGroup);
  clearGroup(ringsGroup);
  clearGroup(glowGroup);
  clearGroup(linesGroup);
  pickables.length = 0;

  const seenRadii = new Set();

  // SpaceTraders routinely puts several waypoints at the exact same x/y — a
  // gas giant and the stations orbiting it share one coordinate. Ported from
  // the flat map's byCoord/relaxation pass (same algorithm, scene-space x/z
  // in place of screen-space sx/sy): a coincident group first fans out on a
  // ring sized to its members, then a few relaxation passes nudge any two
  // waypoints — clustered or not — that still overlap apart. Left as raw
  // worldToScene() output, every member of such a group rendered as one
  // stacked sphere with the rest hidden behind it.
  const effR = (wp) => WP3D_SIZE[wp.type] ?? 1.8;
  const byCoord = new Map();
  for (const wp of sceneWaypoints) {
    const key = `${wp.x},${wp.y}`;
    if (!byCoord.has(key)) byCoord.set(key, []);
    byCoord.get(key).push(wp);
  }
  const posBySymbol = new Map();
  for (const group of byCoord.values()) {
    const { x: baseX, z: baseZ } = worldToScene(group[0].x, group[0].y, s);
    if (group.length === 1) {
      posBySymbol.set(group[0].symbol, { x: baseX, z: baseZ });
      continue;
    }
    const maxEffR = Math.max(...group.map(effR));
    const ringR = maxEffR * 1.15 + Math.min(group.length, 6) * 0.35;
    group.forEach((wp, i) => {
      const angle = (2 * Math.PI * i) / group.length;
      posBySymbol.set(wp.symbol, { x: baseX + ringR * Math.cos(angle), z: baseZ + ringR * Math.sin(angle) });
    });
  }
  const relaxEntries = sceneWaypoints.map((wp) => ({ symbol: wp.symbol, r: effR(wp), ...posBySymbol.get(wp.symbol) }));
  for (let iter = 0; iter < 4; iter++) {
    for (let i = 0; i < relaxEntries.length; i++) {
      for (let j = i + 1; j < relaxEntries.length; j++) {
        const a = relaxEntries[i], b = relaxEntries[j];
        let dx = b.x - a.x, dz = b.z - a.z;
        let dist = Math.hypot(dx, dz);
        const minDist = a.r + b.r + 0.6;
        if (dist >= minDist) continue;
        if (dist < 0.01) { dx = 1; dz = 0; dist = 1; }
        const push = ((minDist - dist) / dist) * 0.5;
        const ox = dx * push, oz = dz * push;
        a.x -= ox; a.z -= oz;
        b.x += ox; b.z += oz;
      }
    }
  }
  for (const e of relaxEntries) posBySymbol.set(e.symbol, { x: e.x, z: e.z });

  const activeGateSymbols = new Set();
  for (const wp of sceneWaypoints) {
    const { x, z } = posBySymbol.get(wp.symbol);
    const color = themedColor(WP3D_COLOR[wp.type] ?? "--ice");
    const size = WP3D_SIZE[wp.type] ?? 1.8;
    const y = computeElevation(wp.symbol, wp.type, wp.x, wp.y);

    let body;
    if (wp.type === "ORBITAL_STATION" || wp.type === "ASTEROID_BASE") {
      const built = wp.type === "ORBITAL_STATION"
        ? makeStationBody(wp.symbol, size, color)
        : makeAsteroidBaseBody(wp.symbol, size, color);
      body = built.group;
      body.position.set(x, y, z);
      bodiesGroup.add(body);
      // pickAt() raycasts against individual meshes, not groups, and looks
      // the hit up by exact reference — every visible sub-mesh needs its
      // own pickables entry (all resolving to the same waypoint symbol) or
      // clicking most of the shape would silently miss.
      for (const mesh of built.meshes) {
        pickables.push({ mesh, kind: "waypoint", symbol: wp.symbol });
      }
    } else {
      body = new THREE.Mesh(
        IRREGULAR_ROCK_TYPES.has(wp.type)
          ? makeRockGeometry(wp.symbol, size)
          : makeBodyGeometry(wp.symbol, wp.type, wp.traits, size),
        // A small emissive floor in the body's own color, independent of any
        // light reaching it — the HemisphereLight above already keeps the
        // shadow side well off pure black at normal distances, but this is
        // the actual floor for a body far enough out that even that fill
        // reads as dim: a hint of the body's own hue rather than a void.
        // `map` (when this type has a texture drawer) rides alongside color:
        // Three multiplies the two, so the surface detail below tints to
        // this system's own palette rather than replacing it.
        new THREE.MeshStandardMaterial({
          color, emissive: color, emissiveIntensity: 0.05, roughness: 0.55, metalness: 0.15,
          map: makeBodyTexture(wp.symbol, wp.type, wp.traits),
        }),
      );
      body.position.set(x, y, z);
      bodiesGroup.add(body);
      pickables.push({ mesh: body, kind: "waypoint", symbol: wp.symbol });
    }

    const rim = ATMOSPHERE_RIM[wp.type];
    if (rim) {
      const rimMesh = makeAtmosphereRim(size, rim.color, rim.power, rim.intensity);
      rimMesh.position.copy(body.position);
      bodiesGroup.add(rimMesh);
    }

    // A faint vertical stalk connects elevated orbiters back to the
    // ecliptic plane, so the operator can see which planet/region they
    // belong to even when the camera is looking edge-on.
    if (Math.abs(y) > 0.3) {
      const stalkLen = Math.max(0.2, Math.abs(y) - size * 0.4);
      const stalk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, stalkLen, 8),
        new THREE.MeshBasicMaterial({ color: themedColor("--dim"), transparent: true, opacity: 0.22 }),
      );
      stalk.position.set(x, Math.sign(y) * (stalkLen / 2 + size * 0.35), z);
      ringsGroup.add(stalk);
    }

    if (wp.type === "GAS_GIANT") {
      const belt = new THREE.Mesh(
        new THREE.RingGeometry(size * 1.5, size * 1.9, 48),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
      );
      belt.position.copy(body.position);
      belt.rotation.x = -Math.PI / 2 + 0.35;
      bodiesGroup.add(belt);
    }
    if (wp.type === "ASTEROID_FIELD") {
      const cluster = makeAsteroidCluster(wp.symbol, size, color);
      cluster.position.copy(body.position);
      bodiesGroup.add(cluster);
    }
    if (wp.type === "JUMP_GATE" || wp.type === "FUEL_STATION") {
      const glow = makeGlowSprite(color, size * 3.5);
      glow.position.copy(body.position);
      glowGroup.add(glow);
    }
    if (wp.type === "JUMP_GATE") {
      activeGateSymbols.add(wp.symbol);
      let pulse = gatePulses.get(wp.symbol);
      if (!pulse) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: getGatePulseTexture(), color, transparent: true, depthWrite: false,
        }));
        gatePulseGroup.add(sprite);
        // Own phase per gate (from its symbol) so multiple gates in one
        // system don't pulse in lockstep — reads as more alive than a
        // single synchronized heartbeat would.
        pulse = { sprite, phase: Math.abs(hashString(wp.symbol)) * Math.PI * 2, baseSize: size * 2.2 };
        gatePulses.set(wp.symbol, pulse);
      }
      pulse.sprite.position.copy(body.position);
    }
    const isMarket = (wp.traits ?? []).some((t) => (t.symbol ?? t) === "MARKETPLACE");
    if (isMarket) {
      const marketGlow = makeGlowSprite(themedColor("--buff"), size * 2.5);
      marketGlow.position.copy(body.position);
      glowGroup.add(marketGlow);
    }

    if (shouldLabelWaypoint(wp)) {
      const label = makeLabelSprite(shortWp(wp.symbol), "#" + themedColor("--dim").getHexString());
      label.position.set(x, y + size + 1.3, z);
      bodiesGroup.add(label);
    }

    // A real orbit path — the waypoint's actual distance from the system's
    // origin, not a fabricated one. Deduped by radius so a station sharing
    // its planet's exact x/y doesn't draw the same ring twice. Kept on the
    // ecliptic plane (y=0); the body itself floats at its computed elevation.
    const radius = Math.pow(Math.hypot(wp.x, wp.y), s.pow) * s.scale;
    const key = Math.round(radius * 4);
    if (radius > 0.5 && !seenRadii.has(key)) {
      seenRadii.add(key);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius - 0.05, radius + 0.05, 96),
        new THREE.MeshBasicMaterial({ color: themedColor("--dim"), transparent: true, opacity: 0.22, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ringsGroup.add(ring);
    }
  }

  // A gate that's left this render (system switch, or no longer counted
  // "purposeful") gets its pulse sprite disposed rather than left running
  // forever in a group renderMap() never otherwise touches.
  for (const [symbol, pulse] of gatePulses) {
    if (activeGateSymbols.has(symbol)) continue;
    gatePulseGroup.remove(pulse.sprite);
    pulse.sprite.material.dispose();
    gatePulses.delete(symbol);
  }

  // Trade lanes: removed for now — two rounds of tuning (occlusion, then
  // arc height) still didn't read well in the real, dense-cluster case.
  // Revisit with a different approach rather than a third parameter tweak.

  // Ship trails — real recent movement history during scrub playback (see
  // renderScrubFrame()), not the static trade lanes above. Segments nearer
  // the ship's current position are more opaque than older ones, matching
  // the flat map's own fading-trail treatment. Same depthTest reasoning as
  // the trade lanes above. Elevation is included so trails follow the same
  // 3D layout as live ship movement.
  const trailColor = themedColor("--dim");
  for (const [, trail] of trails) {
    for (let i = 1; i < trail.length; i++) {
      const a = scenePosForWaypoint(trail[i - 1], s);
      const b = scenePosForWaypoint(trail[i], s);
      if (!a || !b) continue;
      const frac = i / (trail.length - 1);
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(a.x, a.y + 0.08, a.z),
        new THREE.Vector3(b.x, b.y + 0.08, b.z),
      ]);
      const mat = new THREE.LineBasicMaterial({ color: trailColor, transparent: true, opacity: 0.1 + frac * 0.4, depthTest: false });
      const line = new THREE.Line(geo, mat);
      line.renderOrder = 9;
      linesGroup.add(line);
    }
  }

  // Frame the whole system, same intent as the flat map's default fit —
  // but only on first arriving here or switching systems. renderMap() runs
  // on every periodic state refresh, not just navigation; resetting the
  // camera every time was undoing any zoom or pan the operator had just
  // made mid-session.
  if (framedSystem !== sys || mapMode !== "system") {
    // Only a mode switch (leaving galaxy view) gets its camera snapped
    // instantly, alongside the content swap — a plain system-to-system
    // switch while already in system mode keeps the normal eased pan.
    // See renderGalaxy3D()'s own comment on why an eased camera here reads
    // worse, not better, once the target it's easing toward already exists.
    const leavingGalaxy = mapMode !== "system";
    framedSystem = sys;
    mapMode = "system";
    orbitGoal.target.set(0, 0, 0);
    orbitGoal.radius = 160;
    orbitGoal.phi = 1.0;
    if (leavingGalaxy) {
      orbitCam.target.copy(orbitGoal.target);
      orbitCam.radius = orbitGoal.radius;
      orbitCam.phi = orbitGoal.phi;
    }
    // A live trail's points are in the old system's scene coordinates —
    // meaningless (and, worse, plottable-looking garbage) once worldToScene
    // is scaled for a different system.
    liveTrails.clear();
    lastTrailSamplePos.clear();
    for (const obj of liveTrailObjects.values()) disposeTrailGroup(obj);
    liveTrailGroup?.clear();
    liveTrailObjects.clear();
  }

  renderShipsInto(ships, s);
  if (shipAnimHandle) cancelAnimationFrame(shipAnimHandle);
  if (scrubLive) shipAnimHandle = requestAnimationFrame(repositionShips);
}

/**
 * Procedural hull-plating texture — same idea as the planet/moon biome
 * canvases (a drawn pattern applied as `material.map` so it multiplies
 * with the ship's own role color instead of replacing it), but for ships:
 * an irregular grid of panel seams, per-panel brightness variation like
 * brushed/weathered plate, and rivets at the panel corners. One shared
 * canvas for every ship's every hull part (not per-symbol like a body's
 * texture — plating doesn't need to be unique per ship, just present) so
 * this only ever draws once per page load, then rides `tex.repeat` to
 * tile across whatever size box/cylinder/cone face it lands on.
 */
let hullPanelTexture = null;
function makeHullPanelTexture() {
  if (hullPanelTexture) return hullPanelTexture;
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgb(150,150,150)";
  ctx.fillRect(0, 0, size, size);

  // An irregular grid, not an even tile — real plating doesn't repeat on a
  // neat interval, and an even grid would read as a texture bug (moire)
  // once it's tiled small over a tiny hull part. Contrast pushed hard
  // (a 100-value swing per panel, near-black seams/rivets) because a
  // subtler first pass (30-value swing, mid-gray seams) washed out to
  // looking flat on an actual small on-screen hull — confirmed live.
  const vLines = [0, 21, 37, 70, 91, size];
  const hLines = [0, 17, 45, 76, 101, size];
  for (let i = 0; i < vLines.length - 1; i++) {
    for (let j = 0; j < hLines.length - 1; j++) {
      const v = 90 + Math.floor(Math.random() * 100);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(vLines[i], hLines[j], vLines[i + 1] - vLines[i], hLines[j + 1] - hLines[j]);
    }
  }
  ctx.strokeStyle = "rgb(25,25,25)";
  ctx.lineWidth = 3.5;
  for (const x of vLines) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size); ctx.stroke(); }
  for (const y of hLines) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke(); }
  ctx.fillStyle = "rgb(15,15,15)";
  for (const x of vLines.slice(1, -1)) {
    for (const y of hLines.slice(1, -1)) {
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // A small hull part (a fin, a pod) would otherwise show only a sliver of
  // one panel — repeating the pattern a few times over keeps plating
  // visible at every part's own scale. Bumped from 2x2: even with the
  // contrast fix above, 2x2 still tiled too coarsely to put a visible seam
  // on the smallest parts (fins, pods) at normal zoom.
  tex.repeat.set(3, 3);
  tex.__persistent = true;
  hullPanelTexture = tex;
  return tex;
}

// Real SpaceTraders frame symbols (confirmed via grep across the codebase)
// bucketed into five silhouette families, plus a sixth "command" bucket that
// overrides all of them for the one flagship per fleet (SpaceTraders' own
// registration.role, not this app's dispatcher role used for SHIP3D_COLOR).
// A frame this app hasn't seen yet falls back to "explorer" rather than the
// single undifferentiated cone every ship used to render as.
const FRAME_HULL_BUCKET = {
  FRAME_PROBE: "probe", FRAME_DRONE: "probe",
  FRAME_FIGHTER: "fighter", FRAME_INTERCEPTOR: "fighter", FRAME_RACER: "fighter",
  FRAME_FRIGATE: "frigate", FRAME_CRUISER: "frigate", FRAME_DESTROYER: "frigate",
  FRAME_LIGHT_FREIGHTER: "hauler", FRAME_HEAVY_FREIGHTER: "hauler", FRAME_TRANSPORT: "hauler",
  FRAME_BULK_FREIGHTER: "hauler", FRAME_CARRIER: "hauler",
  FRAME_EXPLORER: "explorer", FRAME_SHUTTLE: "explorer", FRAME_MINER: "explorer",
};

function shipHullBucket(sh) {
  if (sh.registration?.role === "COMMAND") return "command";
  return FRAME_HULL_BUCKET[sh.frame?.symbol] ?? "explorer";
}

// Every hull below is built nose-first along +Z (the same convention the
// old single ConeGeometry ended up in after its own body.rotation.x =
// Math.PI/2 — see that rotation's comment history) so renderShipsInto()'s
// outer group.rotation.y (transit heading) and .x (transit pitch) apply
// unchanged. `mat` (the fuselage/primary parts) carries the real role/
// selection color; `trimMat` is that same color darkened (trimColor()) for
// secondary parts — wings, fins, pods, engines — so a hull reads as more
// than a flat single-hue silhouette without introducing any color that
// isn't derived from the ship's own.
function buildShipHull(bucket, mat, trimMat) {
  const group = new THREE.Group();
  const meshes = [];
  const add = (mesh) => { group.add(mesh); meshes.push(mesh); return mesh; };

  switch (bucket) {
    case "command": {
      const fuselage = add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.16, 0.6, 8), mat));
      fuselage.rotation.x = Math.PI / 2;
      const nose = add(new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 8), mat));
      nose.rotation.x = Math.PI / 2;
      nose.position.z = 0.41;
      const fin = add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.22, 0.3), trimMat));
      fin.position.set(0, 0.13, -0.05);
      fin.rotation.x = -0.5;
      const wingL = add(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.03, 0.16), trimMat));
      wingL.position.set(-0.18, -0.02, -0.18);
      wingL.rotation.z = 0.25;
      const wingR = add(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.03, 0.16), trimMat));
      wingR.position.set(0.18, -0.02, -0.18);
      wingR.rotation.z = -0.25;
      const engineL = add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 6), trimMat));
      engineL.rotation.x = Math.PI / 2;
      engineL.position.set(-0.26, -0.03, -0.28);
      const engineR = add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 6), trimMat));
      engineR.rotation.x = Math.PI / 2;
      engineR.position.set(0.26, -0.03, -0.28);
      break;
    }
    case "probe": {
      const body = add(new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.34, 6), mat));
      body.rotation.x = Math.PI / 2;
      const dish = add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), trimMat));
      dish.position.z = -0.15;
      break;
    }
    case "fighter": {
      const body = add(new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.5, 4), mat));
      body.rotation.x = Math.PI / 2;
      const wingL = add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.18), trimMat));
      wingL.position.set(-0.24, 0, -0.05);
      wingL.rotation.z = 0.1;
      const wingR = add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.18), trimMat));
      wingR.position.set(0.24, 0, -0.05);
      wingR.rotation.z = -0.1;
      break;
    }
    case "frigate": {
      const body = add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.55, 8), mat));
      body.rotation.x = Math.PI / 2;
      const nose = add(new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.18, 8), mat));
      nose.rotation.x = Math.PI / 2;
      nose.position.z = 0.36;
      const finL = add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.2), trimMat));
      finL.position.set(-0.13, 0.02, -0.2);
      const finR = add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.2), trimMat));
      finR.position.set(0.13, 0.02, -0.2);
      break;
    }
    case "hauler": {
      add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.55), mat));
      const podL = add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.4), trimMat));
      podL.position.set(-0.24, -0.02, -0.02);
      const podR = add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.4), trimMat));
      podR.position.set(0.24, -0.02, -0.02);
      break;
    }
    case "explorer":
    default: {
      const body = add(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 0.45, 8), mat));
      body.rotation.x = Math.PI / 2;
      const dish = add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), trimMat));
      dish.position.z = -0.2;
      break;
    }
  }
  return { group, meshes };
}

// Real cargo capacity varies enormously (a probe hauls 0, a carrier several
// hundred) and the old single cone was one fixed size regardless — a
// sqrt curve keeps small ships from vanishing to a pinprick and large ones
// from swallowing the map, clamped to a sane on-screen range.
function shipHullScale(sh) {
  const cap = sh.cargo?.capacity ?? 0;
  // Floor raised from 0.7 to 1.0: at 0.7 a 0-capacity probe rendered too
  // small to read clearly even though it was correctly proportioned
  // relative to everything else — the whole curve needed lifting, not the
  // ratio changed.
  return Math.min(1.9, Math.max(1.0, 1.0 + 0.04 * Math.sqrt(cap)));
}

function renderShipsInto(ships, s) {
  clearGroup(shipsGroup);

  // Ships docked/orbiting at the same waypoint would otherwise all sit at
  // that waypoint's own scene position — the exact center of its body's
  // sphere. On the flat map that's harmless (a ship glyph just paints on
  // top); in 3D it means the ship ends up inside that sphere's actual
  // geometry, hidden rather than merely overlapping. Every waypoint's
  // stationary ships (a group of one included, so a lone ship still clears
  // the body's surface) fan onto a ring sized to that body's own radius.
  // In-transit ships are left alone — they're moving through empty space
  // with no body to hide inside, and repositionShips() moves them every
  // frame without recomputing this grouping.
  const dockedByWaypoint = new Map();
  for (const sh of ships) {
    if (sh.nav.status === "IN_TRANSIT") continue;
    const wp = sh.nav.waypointSymbol;
    if (!dockedByWaypoint.has(wp)) dockedByWaypoint.set(wp, []);
    dockedByWaypoint.get(wp).push(sh.symbol);
  }
  const dockedOffset = new Map();
  for (const [wpSymbol, symbols] of dockedByWaypoint) {
    const bodyR = WP3D_SIZE[waypoints.find((w) => w.symbol === wpSymbol)?.type] ?? 1.8;
    // Tight orbit for small bodies (moons/stations) so ships stay visually
    // attached to their waypoint inside a planet cluster, not floating in
    // the parent planet's space. Lifted slightly in y so they read as
    // orbiting rather than embedded in the surface.
    const ringR = bodyR * 1.0 + 0.7 + Math.min(symbols.length, 6) * 0.35;
    symbols.forEach((sym, i) => {
      const angle = (2 * Math.PI * i) / symbols.length;
      dockedOffset.set(sym, { dx: ringR * Math.cos(angle), dy: bodyR * 0.35, dz: ringR * Math.sin(angle) });
    });
  }

  for (const sh of ships) {
    const role = (fleetStatus.ships ?? []).find((r) => r.symbol === sh.symbol)?.role;
    const docked = sh.nav.status === "DOCKED";
    const sel = sh.symbol === selectedShip;
    const color = sel ? themedColor("--accent") : themedColor(SHIP3D_COLOR[role] ?? "--star");

    const group = new THREE.Group();
    // Lit like the waypoint bodies now, but with a strong emissive glow in
    // the same color rather than plain unlit — a ship still has to read as
    // a bright, glanceable marker at a glance, not a shaded model with a
    // dark side that can wash out against space. One material shared by
    // every part of this ship's hull: role/selection owns the color, the
    // hull shape (see buildShipHull) owns which kind of ship it reads as.
    // map alone wasn't enough: a flat, UV-independent emissive glow this
    // strong (built for "read as a bright marker," not a shaded planet)
    // swamped the diffuse texture's contrast entirely -- confirmed live,
    // the hull looked completely flat even zoomed in close. Same texture
    // as emissiveMap makes the seams/rivets dim the glow too, so the
    // pattern survives being lit this bright.
    const hullTex = makeHullPanelTexture();
    const mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.2,
      map: hullTex, emissiveMap: hullTex,
    });
    const trim = trimColor(color);
    const trimMat = new THREE.MeshStandardMaterial({
      color: trim, emissive: trim, emissiveIntensity: 0.4, roughness: 0.45, metalness: 0.25,
      map: hullTex, emissiveMap: hullTex,
    });
    const hull = buildShipHull(shipHullBucket(sh), mat, trimMat);
    hull.group.scale.setScalar(shipHullScale(sh));
    group.add(hull.group);
    if (sel) {
      // A 3D torus ring that stays oriented with the ship instead of a flat
      // disk lying on the ecliptic plane. It scales with the tiny new ship
      // size so the selection read is tight, not a giant pancake.
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.55, 0.06, 8, 32),
        new THREE.MeshBasicMaterial({ color: themedColor("--accent"), transparent: true, opacity: 0.75 }),
      );
      halo.rotation.x = Math.PI / 2;
      group.add(halo);
    }

    let scenePos;
    if (sh.nav.status === "IN_TRANSIT") {
      const r = sh.nav.route;
      const world = shipTransitLerp(sh) ?? { x: r?.origin?.x ?? 0, y: r?.origin?.y ?? 0 };
      const originWP = waypoints.find((w) => w.symbol === r?.origin?.symbol);
      const destWP = waypoints.find((w) => w.symbol === r?.destination?.symbol);
      const base = worldToScene(world.x, world.y, s);
      const arc = transitArcHeight(base, originWP, destWP, s);
      scenePos = { x: base.x, y: arc.y, z: base.z };
      if (r?.origin && r?.destination) {
        const o = scenePosForWaypoint(r.origin.symbol, s) ?? { ...worldToScene(r.origin.x, r.origin.y, s), y: 0 };
        const d = scenePosForWaypoint(r.destination.symbol, s) ?? { ...worldToScene(r.destination.x, r.destination.y, s), y: 0 };
        const dx = d.x - o.x, dy = d.y - o.y, dz = d.z - o.z;
        if (dx !== 0 || dz !== 0) {
          group.rotation.y = Math.atan2(dx, dz);
          // A small pitch so the hull tilts toward/away from the destination's elevation.
          const dist = Math.hypot(dx, dz) || 1;
          group.rotation.x = Math.atan2(dy, dist);
        }
      }
    } else {
      const wp = waypoints.find((w) => w.symbol === sh.nav.waypointSymbol);
      scenePos = wp ? waypointScenePos(wp, s) : { x: 0, y: 0, z: 0 };
    }
    const off = dockedOffset.get(sh.symbol);
    group.position.set(scenePos.x + (off?.dx ?? 0), scenePos.y + (off?.dy ?? 0), scenePos.z + (off?.dz ?? 0));

    shipsGroup.add(group);
    // pickAt() raycasts against individual meshes and looks the hit up by
    // exact reference — every part of the hull needs its own entry (all
    // resolving to this same ship) or clicking most of a multi-mesh hull
    // would silently miss.
    for (const mesh of hull.meshes) {
      pickables.push({ mesh, kind: "ship", symbol: sh.symbol, group });
    }
  }
}

function findWaypointPos(symbol, s) {
  const wp = waypoints.find((w) => w.symbol === symbol);
  return wp ? { x: wp.x, y: wp.y } : { x: 0, y: 0 };
}

/** Scene position of a waypoint by symbol, looked up against the full
 *  `waypoints` list rather than the map's own purposeful-only subset —
 *  trade-route markets and ship-trail history can name a waypoint that
 *  isn't itself drawn as a body (a plain rock a ship passed through). */
function scenePosForWaypoint(symbol, s) {
  const wp = waypoints.find((w) => w.symbol === symbol);
  return wp ? waypointScenePos(wp, s) : null;
}

function disposeTrailGroup(group) {
  for (const line of group.children) {
    line.geometry?.dispose?.();
    line.material?.dispose?.();
  }
}

function repositionShips() {
  shipAnimHandle = null;
  const mapVisible = deckMapVisible;
  if (!mapVisible || !scrubLive || !mapScale || !lastRenderedShips.length) return;
  const inTransitSymbols = new Set(lastRenderedShips.filter((sh) => sh.nav.status === "IN_TRANSIT").map((sh) => sh.symbol));
  // Prune trail state for any ship not in transit *right now*, before the
  // early return below for "nothing to animate" — otherwise the pass where
  // the fleet's last in-transit ship arrives at its destination never
  // reaches this, leaving its sample buffer stale for whenever it next
  // departs (its new trail would jump from the previous leg's tail).
  for (const symbol of [...liveTrails.keys()]) {
    if (inTransitSymbols.has(symbol)) continue;
    liveTrails.delete(symbol);
    lastTrailSamplePos.delete(symbol);
    const obj = liveTrailObjects.get(symbol);
    if (obj) {
      liveTrailGroup.remove(obj);
      disposeTrailGroup(obj);
      liveTrailObjects.delete(symbol);
    }
  }
  if (inTransitSymbols.size === 0) return;
  const trailColor = themedColor("--accent");
  for (const p of pickables) {
    if (p.kind !== "ship") continue;
    const sh = lastRenderedShips.find((x) => x.symbol === p.symbol);
    if (!sh || sh.nav.status !== "IN_TRANSIT") continue;
    const world = shipTransitLerp(sh);
    if (!world) continue;
    const r = sh.nav.route;
    const base = worldToScene(world.x, world.y, mapScale);
    const originWP = waypoints.find((w) => w.symbol === r?.origin?.symbol);
    const destWP = waypoints.find((w) => w.symbol === r?.destination?.symbol);
    const { y } = transitArcHeight(base, originWP, destWP, mapScale);
    p.group.position.set(base.x, y, base.z);

    // Motion trail for in-transit ships. Sampled by scene distance moved,
    // not every frame, and tinted by the ship's own role color so each
    // trajectory is glanceable against the dark map.
    const points = liveTrails.get(sh.symbol) ?? [];
    const lastPos = lastTrailSamplePos.get(sh.symbol);
    if (!lastPos || Math.hypot(base.x - lastPos.x, base.z - lastPos.z) >= TRAIL_SAMPLE_MIN_SCENE) {
      points.push({ x: base.x, y, z: base.z });
      if (points.length > TRAIL_MAX_POINTS) points.shift();
      liveTrails.set(sh.symbol, points);
      lastTrailSamplePos.set(sh.symbol, { x: base.x, y, z: base.z });
    }
    if (points.length > 1) {
      const old = liveTrailObjects.get(sh.symbol);
      if (old) {
        liveTrailGroup.remove(old);
        disposeTrailGroup(old);
      }
      const trailGroup = new THREE.Group();
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        // 0.25-0.7: a real fade from tail to head while making sure no
        // segment is ever too faint to notice — matches the flat map's own
        // live-trail opacity range.
        const opacity = 0.25 + (i / (points.length - 1)) * 0.45;
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(a.x, a.y + 0.06, a.z),
          new THREE.Vector3(b.x, b.y + 0.06, b.z),
        ]);
        const mat = new THREE.LineBasicMaterial({ color: trailColor, transparent: true, opacity, depthTest: false, linewidth: 2 });
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 8;
        line.material.linewidth = 2;
        trailGroup.add(line);
      }
      liveTrailGroup.add(trailGroup);
      liveTrailObjects.set(sh.symbol, trailGroup);
    }
  }
  shipAnimHandle = requestAnimationFrame(repositionShips);
}

/** Book mode's clause hover: ring the real hulls a rule fired against, at
 *  their real (projected) screen position. Same idea as the flat map's
 *  version — draw at shipScreenPos — just filled from a 3D→screen
 *  projection instead of an SVG transform's own x/y. */
function pulseHulls(shipSymbols) {
  clearHullPulse();
  if (!sceneReady) return;
  const rect = host.getBoundingClientRect();
  const group = document.createElement("div");
  group.id = "hull-pulse-group-3d";
  for (const sym of shipSymbols) {
    const p = pickables.find((x) => x.kind === "ship" && x.symbol === sym);
    if (!p) continue;
    const v = p.group.position.clone().project(camera);
    const x = (v.x * 0.5 + 0.5) * rect.width;
    const y = (-v.y * 0.5 + 0.5) * rect.height;
    shipScreenPos.set(sym, { x, y });
    const dot = document.createElement("div");
    dot.className = "hull-pulse-3d";
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
    group.appendChild(dot);
  }
  host.appendChild(group);
}

function clearHullPulse() {
  document.getElementById("hull-pulse-group-3d")?.remove();
}

function resetMapView() {
  orbitGoal.target.set(0, 0, 0);
  orbitGoal.radius = galaxyMode ? 200 : 112;
  orbitGoal.theta = 0.7;
  orbitGoal.phi = 1.0;
}

// Drag pans the target across the ground plane rather than orbiting the
// camera around a fixed point — this is a top-down strategic map (v3's
// flat map has no rotation at all, just pan and zoom), so a fixed point
// you can only orbit around meant an outer waypoint stayed out of reach
// short of zooming out far enough to shrink everything else with it.
// Panning direction is derived from the camera's current facing (theta)
// so a drag always moves the world the way it visually should, whatever
// angle the map happens to be at.
function panCamera(dx, dy) {
  const panSpeed = orbitCam.radius * 0.0022;
  const theta = orbitCam.theta;
  const rightX = Math.sin(theta), rightZ = -Math.cos(theta);
  const fwdX = -Math.cos(theta), fwdZ = -Math.sin(theta);
  orbitGoal.target.x -= dx * rightX * panSpeed - dy * fwdX * panSpeed;
  orbitGoal.target.z -= dx * rightZ * panSpeed - dy * fwdZ * panSpeed;
}

function rotateCamera(dx, dy) {
  orbitGoal.theta -= dx * 0.006;
  orbitGoal.phi = Math.max(0.2, Math.min(Math.PI - 0.2, orbitGoal.phi - dy * 0.005));
}

// Same clamp the wheel/pinch handlers below use — a button click just
// nudges orbitGoal.radius by a fixed factor instead of a continuous
// gesture delta. Zooming in means a SMALLER radius (camera closer).
function zoomMapBy(factor) {
  const min = systemSpan * 0.35, max = systemSpan * 6;
  orbitGoal.radius = Math.max(min, Math.min(max, orbitGoal.radius * factor));
}

function attachMapControls() {
  $("map-fit")?.addEventListener("click", resetMapView);
  $("map-zoom-in")?.addEventListener("click", () => zoomMapBy(1 / 1.4));
  $("map-zoom-out")?.addEventListener("click", () => zoomMapBy(1.4));
  // Right-click-drag orbits (desktop's usual "secondary drag" gesture) —
  // genuine depth is one of the few things a 3D map has over the flat one,
  // worth keeping reachable even though plain drag now pans.
  host.addEventListener("contextmenu", (e) => e.preventDefault());

  let dragging = false, rotating = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
  host.addEventListener("pointerdown", (e) => {
    if (e.button === 2) rotating = true; else dragging = true;
    lastX = downX = e.clientX; lastY = downY = e.clientY;
    host.classList.add("dragging");
  });
  window.addEventListener("pointerup", (e) => {
    const wasRotating = rotating;
    dragging = false; rotating = false;
    host.classList.remove("dragging");
    if (wasRotating || Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return; // was a drag, not a click
    const hit = pickAt(e.clientX, e.clientY);
    if (!hit) { if (mapTipFor) hideWaypointTip(); return; }
    if (hit.kind === "galaxy-system") {
      currentSystem = hit.symbol;
      setGalaxyMode(false);
      hooks.onSystemChange?.(currentSystem);
    } else if (hit.kind === "ship") hooks.onShip?.(hit.symbol);
    else {
      if (mapTipFor === hit.symbol) hideWaypointTip();
      else { showWaypointTip(hit.symbol); mapTipFor = hit.symbol; hooks.onWaypoint?.(hit.symbol); }
    }
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging && !rotating) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (rotating) rotateCamera(dx, dy); else panCamera(dx, dy);
  });
  // Hover tooltip for galaxy-mode system glyphs — a separate, host-scoped
  // listener rather than folding into the window-level one above, since
  // that one only needs to fire while a drag/rotate gesture is already in
  // progress and this one only needs to fire while the pointer is over the
  // canvas at all.
  host.addEventListener("pointermove", (e) => {
    if (dragging || rotating || !galaxyMode) return;
    updateGalaxyHover(e.clientX, e.clientY);
  });
  host.addEventListener("pointerleave", () => {
    if (galaxyHoverSymbol) { galaxyHoverSymbol = null; hideWaypointTip(); }
  });
  host.addEventListener("wheel", (e) => {
    e.preventDefault();
    const min = systemSpan * 0.35, max = systemSpan * 6;
    orbitGoal.radius = Math.max(min, Math.min(max, orbitGoal.radius * (1 + e.deltaY * 0.0012)));
  }, { passive: false });
  host.addEventListener("dblclick", resetMapView);

  // Touch: one finger pans, two fingers combine pinch-to-zoom (distance)
  // with drag-to-rotate (midpoint movement) in the same gesture.
  let pinchDist = null, pinchMidX = 0, pinchMidY = 0;
  host.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) { dragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; }
    else if (e.touches.length === 2) {
      const [a, b] = e.touches;
      pinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      pinchMidX = (a.clientX + b.clientX) / 2;
      pinchMidY = (a.clientY + b.clientY) / 2;
    }
  }, { passive: true });
  host.addEventListener("touchmove", (e) => {
    if (e.touches.length === 1 && dragging) {
      const t = e.touches[0];
      const dx = t.clientX - lastX, dy = t.clientY - lastY;
      lastX = t.clientX; lastY = t.clientY;
      panCamera(dx, dy);
    } else if (e.touches.length === 2 && pinchDist != null) {
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const min = systemSpan * 0.35, max = systemSpan * 6;
      orbitGoal.radius = Math.max(min, Math.min(max, orbitGoal.radius * (1 + (pinchDist - d) * 0.004)));
      pinchDist = d;
      const midX = (a.clientX + b.clientX) / 2, midY = (a.clientY + b.clientY) / 2;
      rotateCamera(midX - pinchMidX, midY - pinchMidY);
      pinchMidX = midX; pinchMidY = midY;
    }
  }, { passive: true });
  host.addEventListener("touchend", () => { dragging = false; pinchDist = null; });
  host.addEventListener("touchcancel", () => { dragging = false; pinchDist = null; });
}

function pickAt(clientX, clientY) {
  const rect = host.getBoundingClientRect();
  pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  const meshes = pickables.map((p) => p.mesh);
  const hits = raycaster.intersectObjects(meshes);
  if (!hits.length) return null;
  return pickables.find((p) => p.mesh === hits[0].object) || null;
}

function tickMap3D() {
  requestAnimationFrame(tickMap3D);
  // DECK: nothing to draw while another screen is showing (v6's map is always on screen).
  if (!sceneReady || !deckMapVisible) return;
  orbitCam.theta += (orbitGoal.theta - orbitCam.theta) * 0.14;
  orbitCam.phi += (orbitGoal.phi - orbitCam.phi) * 0.14;
  orbitCam.radius += (orbitGoal.radius - orbitCam.radius) * 0.14;
  orbitCam.target.lerp(orbitGoal.target, 0.14);
  applyOrbitCamera();
  // Billboard every sprite (labels, glows) toward the camera every frame —
  // cheap now that renderMap() only builds a body for waypoints an operator
  // would actually act on, and correct regardless of orbit angle.
  bodiesGroup.children.forEach((c) => { if (c.isSprite) c.quaternion.copy(camera.quaternion); });
  glowGroup.children.forEach((c) => { if (c.isSprite) c.quaternion.copy(camera.quaternion); });
  starGroup.children.forEach((c) => { if (c.isSprite) c.quaternion.copy(camera.quaternion); });
  // A slow, subtle breathing pulse on the star's glow — the one thing a
  // static sun-shaped sprite can't sell on its own is that it's a light
  // source rather than a painted decal. Small range (±6%/±10%) so it reads
  // as alive without looking like a strobing bug.
  if (starGlowPulse) {
    starGlowPulse.t += 0.012;
    const corePulse = 1 + Math.sin(starGlowPulse.t) * 0.06;
    const coronaPulse = 1 + Math.sin(starGlowPulse.t * 0.7 + 1.1) * 0.1;
    starGlowPulse.core.scale.set(26 * corePulse, 26 * corePulse, 1);
    starGlowPulse.corona.scale.set(70 * coronaPulse, 70 * coronaPulse, 1);
    starGlowPulse.corona.material.opacity = 0.42 + Math.sin(starGlowPulse.t * 0.7) * 0.08;
  }
  // Jump-gate "active portal" pulse: a ring sprite expanding outward from
  // 1x to ~2.6x its base size while fading out, looping continuously. Each
  // gate's own phase (set once in renderMap()) keeps multiple gates in one
  // system out of lockstep.
  const gateCycle = 2.4; // seconds per pulse
  for (const pulse of gatePulses.values()) {
    const t = ((performance.now() / 1000) * (Math.PI * 2 / gateCycle) + pulse.phase) % (Math.PI * 2);
    const frac = t / (Math.PI * 2); // 0 (just spawned) -> 1 (about to loop)
    const scale = pulse.baseSize * (1 + frac * 1.6);
    pulse.sprite.scale.set(scale, scale, 1);
    pulse.sprite.material.opacity = 1 - frac;
  }
  if (composer) composer.render(); else renderer.render(scene, camera);
}

function initMapInteractions() {
  // Scene construction is lazy (first renderMap() call, once #map3d has a
  // real size) rather than here — matches the flat map's own timing, where
  // initMapInteractions() ran once at boot before any data existed.
}

function showWaypointTip(symbol) {
  const tip = $("map-tip");
  const wp = waypoints.find((w) => w.symbol === symbol);
  if (!wp) return;
  const shipsHere = (state?.ships ?? []).filter((s) => s.nav.waypointSymbol === symbol);
  const snaps = marketSnapshots.filter((m) => m.waypointSymbol === symbol);
  const offers = loadoutScores.filter((s) => s.yardSymbol === symbol);
  // marketplace/shipyard sort first so they can never be the ones bumped
  // off the visible list by the +N truncation below — those two are also
  // the traits the dot/ring overlay and the sections further down key off
  // of, so silently hiding them made the tooltip look self-contradictory
  // (dot says market, chip list doesn't).
  const traits = (wp.traits ?? [])
    .map((t) => t.replace(/_/g, " ").toLowerCase())
    .sort((a, b) => (b === "marketplace" || b === "shipyard" ? 1 : 0) - (a === "marketplace" || a === "shipyard" ? 1 : 0));
  const isMarket = traits.includes("marketplace");
  const isYard = traits.includes("shipyard");
  const isAsteroid = ["asteroid", "asteroid field", "engineered asteroid"].includes(wp.type.replace(/_/g, " ").toLowerCase());

  let html = `<h4>${symbol}</h4>`;
  html += `<span class="coords">x ${wp.x} · y ${wp.y}</span>`;
  html += `<div class="tags"><span class="tag type">${wp.type.replace(/_/g, " ").toLowerCase()}</span>`;
  const shownTraits = traits.slice(0, 5);
  for (const t of shownTraits) {
    const cls = t === "marketplace" ? " market" : t === "shipyard" ? " yard" : "";
    html += `<span class="tag${cls}">${t}</span>`;
  }
  if (traits.length > shownTraits.length) html += `<span class="tag more">+${traits.length - shownTraits.length}</span>`;
  html += `</div>`;

  if (shipsHere.length) {
    html += `<div class="sub">Ships here</div>`;
    for (const s of shipsHere) {
      html += `<div class="ship-line"><b>${s.symbol}</b><span>${s.nav.status.replace(/_/g, " ")} · fuel ${s.fuel.current}/${s.fuel.capacity}</span></div>`;
    }
  }

  if (isAsteroid) {
    html += `<div class="survey-sec" data-wp="${symbol}"><div class="empty">Survey data unavailable</div></div>`;
  }

  if (isMarket) {
    const goods = snaps.slice(0, 6);
    if (goods.length) {
      html += `<div style="margin-top:6px">`;
      for (const g of goods) {
        const dir = g.type === "IMPORT" ? " <span class='up'>▲</span>" : g.type === "EXPORT" ? " <span class='down'>▼</span>" : "";
        html += `<div class="row"><span>${g.goodSymbol}${dir}</span><span>buy <b>${g.purchasePrice}</b> · sell <b>${g.sellPrice}</b></span></div>`;
      }
      html += `</div>`;
    } else {
      html += `<div class="empty">Prices not observed yet — dock a ship here.</div>`;
    }
  }

  if (isYard) {
    if (offers.length) {
      html += `<div style="margin-top:6px">`;
      for (const o of offers.slice(0, 3)) {
        html += `<div class="row"><span>${o.type.replace("SHIP_", "")}</span><span><b>${fmt(o.purchasePrice)}c</b></span></div>`;
      }
      html += `</div>`;
    } else {
      html += `<div class="empty">Yard inventory not scanned.</div>`;
    }
  }

  tip.innerHTML = html;
  tip.classList.add("visible");

  const surveySec = tip.querySelector(".survey-sec");
  if (surveySec) {
    const wp = surveySec.dataset.wp;
    const cached = surveyCache.get(wp);
    const apply = (surveys) => {
      const sec = $("map-tip").querySelector(".survey-sec");
      if (!sec || sec.dataset.wp !== wp) return;
      if (!surveys.length) {
        sec.innerHTML = `<div class="empty">No active surveys here yet — send the surveyor.</div>`;
        return;
      }
      const html = surveys.map((s) => {
        const left = Math.max(0, Math.floor((new Date(s.expiration).getTime() - Date.now()) / 60000));
        const size = s.size ? ` · ${s.size}` : "";
        return `<div class="row"><span>${s.deposits.join(", ")}${size}</span><span>expires in ${left}m</span></div>`;
      }).join("");
      sec.innerHTML = `<div style="margin-top:6px"><div class="sub">Surveys</div>${html}</div>`;
    };
    if (cached) {
      apply(cached);
    } else {
      fetch(`/api/surveys?waypoint=${encodeURIComponent(wp)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
        .then((d) => { surveyCache.set(wp, d.surveys ?? []); apply(d.surveys ?? []); })
        .catch(() => apply([]));
    }
  }
}

function hideWaypointTip() {
  $("map-tip").classList.remove("visible");
  mapTipFor = null;
}

/** Hover-driven, not click-toggle like showWaypointTip() — a galaxy-mode
 *  glyph is a click TARGET (click drops into that system), so the tip has
 *  to appear on hover alone or it would never be readable before the click
 *  already navigated away. Reuses the same #map-tip panel and stat-tag
 *  markup as the per-system waypoint tip since it's the same "stats at a
 *  glance" job, one level zoomed out. */
function showGalaxySystemTip(symbol) {
  const tip = $("map-tip");
  const data = galaxyOverviewData;
  const s = data?.systems.find((x) => x.symbol === symbol);
  if (!s) return;
  const typeLabel = s.type ? s.type.replace(/_/g, " ").toLowerCase() : "unknown type";
  let html = `<h4>${symbol}</h4>`;
  html += `<span class="coords">${typeLabel}</span>`;
  html += `<div class="tags">`;
  if (symbol === data.home) html += `<span class="tag type">home</span>`;
  if (s.hasMarket) html += `<span class="tag market">marketplace</span>`;
  if (s.hasShipyard) html += `<span class="tag yard">shipyard</span>`;
  if (s.hasJumpGate) html += `<span class="tag type">jump gate</span>`;
  html += `</div>`;
  html += `<div class="row"><span>Ships here</span><b>${s.ships}</b></div>`;
  tip.innerHTML = html;
  tip.classList.add("visible");
}

/** Called on every galaxy-mode pointermove (not drag/rotate) to keep the
 *  hover tip in sync with whichever glyph, if any, is under the pointer.
 *  Cheap no-op when the hovered symbol hasn't changed, so a stationary
 *  pointer over one glyph doesn't re-render the tip every frame. */
function updateGalaxyHover(clientX, clientY) {
  const hit = pickAt(clientX, clientY);
  const symbol = hit && hit.kind === "galaxy-system" ? hit.symbol : null;
  if (symbol === galaxyHoverSymbol) return;
  galaxyHoverSymbol = symbol;
  if (symbol) showGalaxySystemTip(symbol); else hideWaypointTip();
}


/* ── DECK: public surface ─────────────────── */
export function initDeckMap(h = {}) {
  Object.assign(hooks, h);
  initGalaxyToggle();
  if (!sceneReady && !mapUnavailable) initMap3D();
}

/** Redraw from the latest store state. Safe to call often (v6 calls it ~1s). */
export function renderDeckMap() {
  if (!state) return;
  renderMap(state.ships ?? []);
}

export function setDeckMapVisible(v) {
  deckMapVisible = !!v;
  if (v) requestAnimationFrame(() => { onMapResize?.(); renderDeckMap(); });
}

export function setDeckMapSystem(sym) {
  currentSystem = sym;
  if (galaxyMode) setGalaxyMode(false);
  resetMapView();
  renderDeckMap();
}
/** Move the one shared map (a single WebGL scene) into `el` — Overview and the
 *  Map screen are never visible together, so they take turns hosting it. */
export function mountDeckMap(el) {
  const wrap = document.getElementById("map-wrap");
  if (!wrap || !el || wrap.parentElement === el) return;
  el.appendChild(wrap);
  requestAnimationFrame(() => onMapResize?.());
}
export function getDeckMapSystem() { return currentSystem; }
export function setDeckMapSelectedShip(sym) { selectedShip = sym; }
export function deckMapWaypoints() { return waypoints; }
