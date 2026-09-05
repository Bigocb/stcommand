// Map projection, glyph geometry, transit lerp, heading — no DOM, no shared app state.
// See docs/ui-versions-plan.md §3.

export const WP_GLYPH = {
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

export function drawWaypointGlyph(g, pos, symbol, isMarket, isYard) {
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

export function shipGlyphMarkup(role, docked, headingDeg) {
  const rot = headingDeg != null ? headingDeg : docked ? 0 : 45;
  return `<path class="hull role-${role ?? "trader"}" d="M0,-2.6 L2.1,2.1 L0,1.1 L-2.1,2.1 Z" transform="rotate(${rot})"></path>`;
}

export function shipHeadingDeg(ship, sx, sy) {
  if (ship.nav.status !== "IN_TRANSIT") return null;
  const r = ship.nav.route;
  if (!r?.origin || !r?.destination) return null;
  const dx = sx(r.destination.x) - sx(r.origin.x);
  const dy = sy(r.destination.y) - sy(r.origin.y);
  if (dx === 0 && dy === 0) return null;
  return (Math.atan2(dy, dx) * 180) / Math.PI + 90;
}

export function shipTransitLerp(ship) {
  if (ship.nav.status !== "IN_TRANSIT") return null;
  const r = ship.nav.route;
  if (!r?.departureTime || !r?.arrival || !r.origin || !r.destination) return null;
  const t0 = new Date(r.departureTime).getTime();
  const t1 = new Date(r.arrival).getTime();
  if (!(t1 > t0)) return null;
  const frac = Math.min(1, Math.max(0, (Date.now() - t0) / (t1 - t0)));
  return {
    x: r.origin.x + (r.destination.x - r.origin.x) * frac,
    y: r.origin.y + (r.destination.y - r.origin.y) * frac,
  };
}
