# Deck — desktop redesign, build spec for an initial (low-context) build pass

**Audience note, read this first**: this doc is written to be followed
literally, step by step, with as little invention as possible — it is the
brief for a first build pass, not a design discussion. Every data field
named below has been checked against the real code (`public/shared/store.js`,
`public/m.js`, `src/http/dashboard.ts`) as of 2026-09-19 — don't re-derive
field names from guessing at the mockup's static numbers. If something here
turns out to be wrong (a function renamed, a field that no longer exists),
stop and say so rather than improvising a replacement.

## 0. What Deck is

A from-scratch **desktop** redesign — Tower's sibling, not Tower stretched
wide. Same approved visual identity (phosphor-amber on near-black,
Chakra Petch / IBM Plex), built for desk-class density instead of a phone:
dense multi-column panels, a persistent right-hand rail for
approvals/activity instead of a tab you have to remember, and a
"Wants vs. Doing" triage table.

It was designed as a 7-screen static HTML mockup, published as a Claude.ai
artifact (`https://claude.ai/artifact/VrRF7Uucw4MqZGGdD93VyV`, "Deck Command
Console") — a design reference only, not committed to this repo, same as
Tower's own mockup wasn't. **This doc's §4 embeds the parts of that mockup
this pass actually needs (full CSS, Screen 1's markup) verbatim** so a build
pass doesn't need network access to the artifact to work from it.

## 1. Scope of THIS pass — Overview only

Build:
- The `/deck` route and app shell (rail nav, topbar, signal panel).
- **Screen 1 (Overview) only**, wired to real data.
- Nav items for Fleet / Markets / Map / Ops / Doctrine exist in the rail
  and are clickable, but render an inert "not built yet" panel — the exact
  precedent Tower's own first pass set (`docs/mobile-app-design.md`: "Fleet/
  Map/Markets/More render an inert 'not built yet' state").

Do **NOT** build in this pass (later passes, once Overview's pattern is
proven — same reasoning Tower's own plan gave):
- Screen 2 (Fleet — dense table + detail split, bulk select).
- Screen 3 (Markets & Trade).
- Screen 4 (Map — spatial chart).
- Screen 5 (⌘K command palette) — **the visual hint pill in the topbar can
  render, but it must not be wired to anything.** No keyboard listener, no
  overlay, no fuzzy search. A dead-looking control that does nothing on
  click is fine for this pass; a half-built one that opens but doesn't
  work is not.
- Screens 6–7 (Fleet system-switcher / rollup) — these are Fleet-screen
  features, out of scope until Fleet itself is built.

## 2. Hard requirement: reuse, don't reinvent

This is the single most important rule, and the exact rule Tower's own
build already proved out:

- **All data comes through `public/shared/*.js`** — `api.js`, `session.js`,
  `store.js`, `domain.js`. No new fetch layer, no new endpoint. Every value
  Overview needs already has a loader in `store.js` (see §3's mapping
  table) — if something seems to need a new endpoint, it doesn't; it needs
  a different existing field, or (per §5) it gets dropped from this pass.
- **Copy `public/m.js`'s own patterns directly** — its auth-gate block
  (`showAuthGate`/`hideAuthGate`/the login form handler), its `subscribe()`
  wiring, its polling/`visibilitychange` pattern (see `public/m.js`'s own
  `pollTick()`/`boot()`/the `visibilitychange` listener — Deck needs the
  exact same one, for the exact same reason: a backgrounded desktop tab
  suspends `setInterval` too). Read `public/m.js` in full before writing
  `deck.js` — it is the closest working example of everything this file
  needs to do, just styled differently.
- **No new backend routes, no new `FleetManager`/`Store` methods.** If
  Overview's mockup shows a number this codebase doesn't currently compute
  anywhere (see §5), drop that element from this pass rather than adding a
  new data source to get it.

## 3. Files to create

```
public/deck.html                    — shell page (see §4 for markup)
public/deck.css                     — full stylesheet (see §4, copy verbatim)
public/deck.js                      — ES module, boot + Overview rendering
public/manifest-deck.webmanifest    — copy public/manifest-tower.webmanifest,
                                       change name/short_name to "Deck",
                                       start_url "/deck", scope "/deck"
public/icons/deck-*.png             — placeholder icons; either reuse Tower's
                                       generation script with the same amber-
                                       on-near-black mark under new filenames,
                                       or literally copy Tower's PNGs under
                                       deck-* names for now — not final brand
                                       artwork either way, same as Tower's own
                                       first-pass icons weren't
```

Files to edit:
- `src/cli/index.ts` — register `GET /deck` the same way `GET /m` is
  registered (find that exact line and mirror its pattern: plain
  unauthenticated `res.sendFile()`, no `resolveTenant` middleware — the
  page does its own client-side auth).
- `src/http/uiVersions.ts` — extend `cacheHeaders()`'s CSS/JS regex
  (currently matches `m.css`/`m.js` too) to also match `deck.css`/`deck.js`.

## 4. The mockup source — copy this literally

### 4a. Full CSS (copy verbatim into `public/deck.css`)

This is the complete, self-consistent stylesheet from the published mockup
— every token, every component class. It already covers everything
Overview needs (`.shell`, `.rail`, `.topbar`, `.kpirow`, `.cols2`,
`.panel`, `.signal`, `.approval`, `.actlog`, `.chart`/`.minimap`/`.blip`
for the home-system mini-map, plus classes Overview doesn't use yet —
`.fleetsplit`, `.mgrid`, `.cpoverlay`, etc. — which is fine, they're
inert until later passes use them). **Do not redesign tokens, spacing, or
color — this is a design reference, not a starting point to iterate on.**

```css
:root{
  --ground:#0a0908; --panel:#15130f; --raised:#201d16; --raised2:#2a251b; --sunken:#0f0d0a;
  --hair:rgba(255,199,120,.14); --hair-hi:rgba(255,199,120,.26);
  --amber:#ffb020; --amber-dim:rgba(255,176,32,.14); --amber-glow:rgba(255,176,32,.35);
  --ice:#93a6b4; --ice-dim:rgba(147,166,180,.5);
  --green:#58d68d; --green-dim:rgba(88,214,141,.14);
  --red:#ff6152; --red-dim:rgba(255,97,82,.14);
  --bone:#f3efe6; --dim:#93897a; --dim2:#5f5648;
  --chrome:'Chakra Petch',ui-sans-serif,system-ui,sans-serif;
  --sans:'IBM Plex Sans',ui-sans-serif,system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,'SFMono-Regular',monospace;
  color-scheme: dark;
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0; background:var(--ground); color:var(--bone); font-family:var(--sans);
  overflow:hidden;
}
a{color:var(--amber)}

/* ── shell ── */
.shell{display:flex;height:100vh;height:100dvh;min-height:0}
.rail{width:76px;flex:0 0 auto;background:var(--panel);border-right:1px solid var(--hair);display:flex;flex-direction:column;align-items:center;padding:16px 0;gap:6px}
.rail .mark{width:28px;height:28px;border:1.5px solid var(--amber);border-radius:50%;position:relative;margin-bottom:16px}
.rail .mark::after{content:"";position:absolute;inset:6px;border:1px solid var(--amber);border-radius:50%;opacity:.5}
/* 60px square — clears the 44px touch floor with real margin, since this
   is the one control an operator taps every screen change on a kiosk. */
.rail .item{width:60px;height:60px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--dim);font-family:var(--chrome);font-size:9.5px;letter-spacing:.04em;flex-direction:column;gap:5px;cursor:pointer;border:none;background:none}
.rail .item .ic{width:19px;height:19px;font-size:17px;line-height:1}
.rail .item.active{background:var(--amber-dim);color:var(--amber);box-shadow:inset 0 0 0 1px var(--hair-hi)}
.rail .item:not(.active):hover{background:var(--raised);color:var(--ice)}

.main{flex:1;display:flex;flex-direction:column;min-width:0}
.topbar{
  height:46px;flex:0 0 auto;border-bottom:1px solid var(--hair);display:flex;align-items:center;
  gap:22px;padding:0 16px;background:var(--panel);
}
.topbar .brand{font-family:var(--chrome);font-weight:700;font-size:13px;letter-spacing:.14em;color:var(--bone)}
.topbar .brand em{color:var(--amber);font-style:normal}
.topbar .stat{display:flex;flex-direction:column;gap:1px;line-height:1.1}
.topbar .stat .l{font-family:var(--chrome);font-size:8.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim2)}
.topbar .stat .v{font-family:var(--mono);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.topbar .stat .v.amber{color:var(--amber)} .topbar .stat .v.bad{color:var(--red)} .topbar .stat .v.good{color:var(--green)}
.topbar .grow{flex:1}
.topbar .pill{font-family:var(--mono);font-size:10px;color:var(--green);background:var(--green-dim);border:1px solid rgba(88,214,141,.3);border-radius:3px;padding:3px 8px;display:flex;align-items:center;gap:5px}
.topbar .pill i{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green)}
.topbar .pill.stale{color:var(--amber);background:var(--amber-dim);border-color:var(--amber-glow)}
.topbar .pill.stale i{background:var(--amber);box-shadow:0 0 6px var(--amber)}
.topbar .pill.offline{color:var(--red);background:var(--red-dim);border-color:rgba(255,97,82,.3)}
.topbar .pill.offline i{background:var(--red);box-shadow:0 0 6px var(--red)}
.topbar .kbd{font-family:var(--mono);font-size:10px;color:var(--dim);background:var(--sunken);border:1px solid var(--hair);border-radius:4px;padding:4px 8px;cursor:default}
.topbar .modes{display:flex;background:var(--sunken);border:1px solid var(--hair);border-radius:4px;overflow:hidden}
.topbar .modes span{font-family:var(--chrome);font-size:10px;letter-spacing:.08em;padding:5px 10px;color:var(--dim);cursor:pointer;border:none;background:none}
.topbar .modes span.on{background:var(--amber-dim);color:var(--amber)}

.body3{flex:1;display:flex;min-height:0}
.content{flex:1;overflow:hidden;padding:16px;display:flex;flex-direction:column;gap:14px;min-width:0}
.signal{width:290px;flex:0 0 auto;border-left:1px solid var(--hair);background:var(--panel);display:flex;flex-direction:column;overflow:hidden}
.sig-h{font-family:var(--chrome);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);padding:12px 14px 8px;display:flex;justify-content:space-between}
.sig-h b{color:var(--amber);font-weight:600}
.sig-sec{border-bottom:1px solid var(--hair);padding-bottom:10px;margin-bottom:8px}
.approval{margin:0 12px 8px;background:var(--raised);border:1px solid var(--hair-hi);border-left:2px solid var(--amber);border-radius:4px;padding:10px 11px;display:flex;flex-direction:column;gap:6px}
.approval .kind{font-family:var(--chrome);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--amber)}
.approval .body{font-size:11.5px;color:var(--bone);line-height:1.45}
.approval .body code{font-family:var(--mono);font-size:10.5px;color:var(--ice)}
.approval .meta{font-family:var(--mono);font-size:9.5px;color:var(--dim2)}
.approval .btns{display:flex;gap:6px;margin-top:2px}
/* 44px is the touch target floor (Apple HIG / WCAG 2.5.5) — every
   tappable control is sized to clear it, not just padded. */
.btn{font-family:var(--chrome);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;border-radius:4px;padding:10px 16px;min-height:40px;border:1px solid var(--hair-hi);background:var(--raised2);color:var(--bone);cursor:pointer}
.btn.pri{background:var(--amber);border-color:var(--amber);color:#1a1204;font-weight:700}
.btn.deny{color:var(--red);border-color:rgba(255,97,82,.35)}
.btn:disabled{opacity:.5;cursor:default}
.actlog{flex:1;overflow-y:auto;padding:0 12px 12px;display:flex;flex-direction:column;gap:7px}
.actline{font-size:11px;line-height:1.5;color:var(--dim);border-left:2px solid var(--hair);padding-left:9px}
.actline b{color:var(--ice);font-weight:600;font-family:var(--mono);font-size:10.5px}
.actline.warn{border-color:var(--red);color:#d9b9b3}
.actline.warn b{color:var(--red)}
.actline .t{font-family:var(--mono);font-size:9px;color:var(--dim2);display:block;margin-top:1px}
.empty{color:var(--dim);font-size:11px;padding:8px 0}

/* KPI row */
.kpirow{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;flex:0 0 auto}
.kpi{background:var(--panel);border:1px solid var(--hair);border-radius:5px;padding:11px 13px;display:flex;flex-direction:column;gap:5px}
.kpi .k{font-family:var(--chrome);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim2)}
.kpi .v{font-family:var(--mono);font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
.kpi .v.amber{color:var(--amber)} .kpi .v.bad{color:var(--red)} .kpi .v.good{color:var(--green)}
.kpi .sub{font-family:var(--mono);font-size:9.5px;color:var(--dim2)}

.cols2{flex:1;display:grid;grid-template-columns:1.1fr 1.4fr;gap:14px;min-height:0}
.panel{background:var(--panel);border:1px solid var(--hair);border-radius:6px;display:flex;flex-direction:column;overflow:hidden;min-height:0}
.panel-h{padding:10px 14px;border-bottom:1px solid var(--hair);display:flex;align-items:center;gap:8px;flex:0 0 auto}
.panel-h .dot{width:6px;height:6px;border-radius:50%;background:var(--amber);box-shadow:0 0 5px var(--amber)}
.panel-h .title{font-family:var(--chrome);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--bone)}
.panel-h .count{font-family:var(--mono);font-size:10px;color:var(--dim);margin-left:auto}
.panel-b{flex:1;overflow:auto;padding:10px 14px}

/* spatial mini-map — real x/y waypoint positions, home system only,
   no radar rings/sweep: same data v6's own map uses, restyled flat. */
.chart{position:relative;flex:1;overflow:hidden;min-height:0;
  background-color:var(--sunken);
  background-image:
    linear-gradient(rgba(147,166,180,.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(147,166,180,.05) 1px, transparent 1px);
  background-size:28px 28px;
}
.minimap{position:relative;flex:1;border-radius:4px;margin:10px 14px;overflow:hidden}
.chartlines{position:absolute;inset:0;width:100%;height:100%}
.blip{position:absolute;border-radius:50%;transform:translate(-50%,-50%)}
.blip.planet{width:8px;height:8px;background:var(--ice)}
.blip.station{width:8px;height:8px;border-radius:2px;background:var(--bone)}
.blip.market{width:7px;height:7px;background:var(--ice)}
.blip.asteroid{width:6px;height:6px;border-radius:2px;transform:translate(-50%,-50%) rotate(45deg);background:var(--dim2)}
.blip.fuel{width:7px;height:7px;background:var(--green)}
.blip.gate{width:0;height:0;border-radius:0;background:none;
  border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:10px solid var(--amber);
  filter:drop-shadow(0 0 4px var(--amber-glow))}
.blip.ship{width:0;height:0;border-radius:0;background:none;
  border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:8px solid var(--green);
  filter:drop-shadow(0 0 4px var(--green))}
.blip.shipwarn{border-bottom-color:var(--red);filter:drop-shadow(0 0 5px var(--red))}
.blabel{position:absolute;font-family:var(--mono);font-size:8.5px;color:var(--dim);white-space:nowrap;transform:translate(7px,-6px)}
.legend{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--hair);font-family:var(--mono);font-size:9.5px;color:var(--dim);flex-wrap:wrap}
.legend span{display:flex;align-items:center;gap:5px}
.legend i.sw-gate{width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:8px solid var(--amber)}
.legend i.sw-ship{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:7px solid var(--green)}
.legend i{width:8px;height:8px;border-radius:50%;display:block}

table{width:100%;border-collapse:collapse;font-size:11.5px}
th{text-align:left;font-family:var(--chrome);font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim2);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--hair);position:sticky;top:0;background:var(--panel)}
td{padding:7px 8px;border-bottom:1px solid rgba(255,199,120,.06);vertical-align:middle}
tr:hover td{background:var(--raised)}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.shipsym{font-family:var(--mono);color:var(--bone);font-weight:600}
.mismatch{display:flex;flex-direction:column;gap:2px}
.mismatch .w{color:var(--ice);font-size:10.5px}
.mismatch .d{color:var(--red);font-size:10.5px}
.badge-age{font-family:var(--mono);font-size:10px;color:var(--red);background:var(--red-dim);border-radius:3px;padding:2px 6px}
.rowact{display:flex;gap:5px}
.rowact button{font-family:var(--chrome);font-size:9px;padding:3px 7px;border-radius:3px;border:1px solid var(--hair-hi);background:var(--raised2);color:var(--bone);cursor:pointer}

/* auth gate — same mechanism Tower's own gate uses (POST /api/gate/login);
   a tenant already signed in on desktop is already signed in here too. */
.auth-gate{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:var(--ground);z-index:50}
.auth-gate[hidden]{display:none}
.auth-box{width:320px;display:flex;flex-direction:column;gap:14px;padding:24px;background:var(--panel);border:1px solid var(--hair);border-radius:8px}
.auth-box h1{font-family:var(--chrome);font-size:18px;margin:0;color:var(--bone)}
.auth-box input{background:var(--sunken);border:1px solid var(--hair);border-radius:5px;padding:10px 12px;min-height:40px;color:var(--bone);font-family:var(--mono);font-size:12px}
.auth-err{color:var(--red);font-size:11px;min-height:14px}
.app[hidden]{display:none}

@media (max-width:980px){
  .cols2{grid-template-columns:1fr}
  .kpirow{grid-template-columns:repeat(3,1fr)}
  .signal{display:none}
}
```

### 4b. `deck.html` — shell markup

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Deck</title>
<link rel="manifest" href="/manifest-deck.webmanifest">
<link rel="apple-touch-icon" href="/icons/deck-apple-touch-icon.png">
<link rel="icon" href="/icons/deck-favicon-32.png" sizes="32x32">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="Deck">
<meta name="theme-color" content="#0a0908">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/deck.css">
</head>
<body>

<div class="auth-gate" id="auth-gate">
  <form class="auth-box" id="auth-form">
    <h1>DECK</h1>
    <input id="auth-token" type="password" placeholder="Agent token" autocomplete="off">
    <div class="auth-err" id="auth-err"></div>
    <button class="btn pri" type="submit">Sign in</button>
  </form>
</div>

<div class="app" id="app-root" hidden>
  <div class="shell">
    <div class="rail" id="rail">
      <div class="mark"></div>
      <button class="item active" data-view="overview"><div class="ic">◎</div>Overview</button>
      <button class="item" data-view="fleet"><div class="ic">⛴</div>Fleet</button>
      <button class="item" data-view="markets"><div class="ic">₡</div>Markets</button>
      <button class="item" data-view="map"><div class="ic">✦</div>Map</button>
      <button class="item" data-view="ops"><div class="ic">☰</div>Ops</button>
      <button class="item" data-view="doctrine"><div class="ic">§</div>Doctrine</button>
    </div>
    <div class="main">
      <div class="topbar">
        <div class="brand">DECK <em>· <span id="tb-agent">—</span></em></div>
        <div class="stat"><span class="l">Credits</span><span class="v amber" id="tb-credits">—</span></div>
        <div class="stat"><span class="l">Rate</span><span class="v" id="tb-rate">—</span></div>
        <div class="stat"><span class="l">Ships</span><span class="v" id="tb-ships">—</span></div>
        <div class="grow"></div>
        <div class="pill" id="tb-conn"><i></i>—</div>
        <div class="modes" id="tb-modes"><span data-mode="auto">AUTO</span><span data-mode="halt">HALT</span></div>
        <div class="kbd" title="Not wired yet">⌘K</div>
      </div>
      <div class="body3">
        <div class="content" id="view-overview">
          <div class="kpirow" id="ov-kpis"></div>
          <div class="cols2">
            <div class="panel">
              <div class="panel-h"><span class="dot"></span><span class="title">Home system</span><span class="count" id="ov-map-count"></span></div>
              <div class="chart minimap" id="ov-minimap"></div>
              <div class="legend">
                <span><i style="background:var(--ice)"></i>Market</span>
                <span><i class="sw-gate"></i>Gate</span>
                <span><i class="sw-ship" style="border-bottom-color:var(--green)"></i>Ship</span>
                <span><i style="background:var(--red)"></i>Stranded</span>
              </div>
            </div>
            <div class="panel">
              <div class="panel-h"><span class="dot"></span><span class="title">Wants vs. Doing</span><span class="count">sorted by mismatch age</span></div>
              <div class="panel-b" style="padding:0">
                <table>
                  <tr><th>Ship</th><th>Wants</th><th>Doing</th><th></th></tr>
                  <tbody id="ov-wantsdo-rows"></tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <!-- Inert placeholders — later passes replace these -->
        <div class="content" id="view-fleet" hidden><div class="empty">Fleet — coming soon.</div></div>
        <div class="content" id="view-markets" hidden><div class="empty">Markets — coming soon.</div></div>
        <div class="content" id="view-map" hidden><div class="empty">Map — coming soon.</div></div>
        <div class="content" id="view-ops" hidden><div class="empty">Ops — coming soon.</div></div>
        <div class="content" id="view-doctrine" hidden><div class="empty">Doctrine — coming soon.</div></div>

        <div class="signal">
          <div class="sig-sec">
            <div class="sig-h">Approvals<b id="sig-approvals-count">—</b></div>
            <div id="sig-approvals"></div>
          </div>
          <div class="sig-h">Activity</div>
          <div class="actlog" id="sig-activity"></div>
        </div>
      </div>
    </div>
  </div>
</div>

<script type="module" src="/deck.js"></script>
</body>
</html>
```

## 5. Data binding map — mockup value → real source

Every static number in the mockup maps to one of these. **Do not invent a
value for anything not listed here** — if it's not in this table, it isn't
computed anywhere in this codebase yet, and belongs in a later pass, not
worked around with a guess.

| Mockup element | Real source (import from `/shared/store.js`) | Notes |
|---|---|---|
| Topbar Credits, KPI Credits | `state?.agent?.credits ?? bridge.credits ?? 0` | Exactly Tower's own `renderTiles()` pattern in `public/m.js` — copy it. Format with `fmt()` from `domain.js`. |
| Topbar Rate, KPI Rate | `bridge.rate ?? 0` | Format with `signed()` from `domain.js`; color `amber`/`v` class per Tower's `rate >= 0 ? "green" : "red"` pattern (note: mockup uses amber for the topbar stat, green/red for the KPI tile — follow the mockup's own classing per-element, don't unify them). |
| Topbar Ships | `(state?.ships ?? []).length` | |
| Connection pill (LIVE/stale/offline) | `connectionStatus.level` from `store.js` (`subscribeConnection()`) | Three states already exist: `"live"` → `.pill`, `"stale"` → `.pill.stale`, `"offline"` → `.pill.offline` (classes added in §4a's CSS). Text: `LIVE` / `STALE` / `OFFLINE`. |
| AUTO / HALT toggle | `fleetStatus.paused` | `false` → AUTO active, `true` → HALT active. Click handler: `POST /api/fleet/pause` or `POST /api/fleet/resume` — copy the exact handler from `public/v6.js` around its own `mode === "halt"` toggle (search `fleet/pause` in `v6.js`), then call `loadBridge()` to refresh. |
| KPI Stranded (count + ship list) | `fleetStatus.stranded` (array) | count = `.length`; sub-line = `.map(s => s.symbol).join(" · ")`. Empty array → KPI still renders, value `0`, sub-line `"none"` — don't hide the tile. |
| KPI Unassigned | Same `unassignedTraders()` logic already in `public/m.js` — copy it verbatim: ships with `role === "trader"` (from `fleetStatus.ships`) that have no entry in `dispatchAssignments` (from `loadDispatch()`/`store.js`). | `dispatchAssignments` needs `loadDispatch()` called at boot — see §6. |
| KPI Manual hold | `fleetStatus.ships.filter(s => s.paused)` | Field confirmed on each `fleetStatus.ships[i]` entry (same field `public/v6.js` reads as `st?.paused` for "manual hold"). |
| KPI Alerts | `approvals.length` only. | The mockup's "2 approvals · 1 drift" sub-text: **drop the "drift" half** — there's no such count computed anywhere in this codebase. Sub-line becomes just `${approvals.length} approvals`. |
| KPI Best route now | `[...dispatchAssignments].sort((a,b) => (b.profitPerTrip??0)-(a.profitPerTrip??0))[0]` | Same computation Tower's `renderTiles()` already does for its own "Best route" tile — copy it. Value = `signed(bestRoute.profitPerTrip)`, sub = `bestRoute.good`. |
| KPI "Forgone" (mockup shows −3,120) | **No source exists. Drop this KPI tile entirely for this pass** — do not invent a number or a new backend computation for it. Six KPI tiles become five; that's fine, `.kpirow`'s grid is `repeat(6,1fr)` in the mockup CSS but will look fine with 5 (or change to `repeat(5,1fr)` — either is acceptable, this is a cosmetic call, not a data one). |
| Home-system mini-map | `state?.systems` (from `GalaxyAtlas.listSystems()`, same source Tower's Map screen reads), scoped to `state?.systemSymbol`; ships from `state?.ships` filtered to `nav.systemSymbol === state.systemSymbol` | This is genuinely the most complex element in Overview. **If it's taking meaningful effort, it is acceptable for this pass to render a simple placeholder** (`"Map view — see the Map tab"` or similar `.empty` block) instead of a working mini spatial chart, and note that explicitly in the summary — the Wants-vs-Doing table and the signal rail are Overview's actual point; the mini-map is not required for this pass to be useful. Don't spend disproportionate effort here. |
| Wants vs. Doing table | `fleetStatus.summary` — **each entry already has exactly the fields this table needs**: `.symbol`, `.wants`, `.doing`, `.wantsReason` (present when `.wants` is set), no `.wants` field at all for a ship with nothing pinned (render `"—"` or omit the row — your call, keep it simple). Sort by... there is no "mismatch age" field; **sort by whether `.wants` and `.doing` differ** (a real mismatch) first, then alphabetical by symbol — don't invent an age/timestamp field that doesn't exist. | This is the single highest-value real feature in Overview — these fields already exist and already say exactly what the mockup wants to show, no new computation needed. |
| Approvals panel | `approvals` array — each entry has `.id`, `.kind`, `.detail`, `.cost` (nullable), `.expiresAt` (nullable) | Copy `public/m.js`'s `triageItems()`/`renderTriage()` approval-card rendering and its Approve/Deny handler (`POST /api/approvals/${id}/decide` with `{decision: "approved"|"denied"}`, then `loadApprovals()`) verbatim — same fields, same endpoint. |
| Activity log | `activity` array (from `loadActivity()`) | Copy Tower's `ACTIVITY_HIDDEN_KINDS` filtering from `public/m.js` (`renderMoreActivity()`) so mining/scanning noise doesn't drown the panel — same reasoning applies here. Each entry: `.timestamp`, `.detail`, `.credits` (nullable), `.shipSymbol`. |

## 6. Boot sequence — copy Tower's shape exactly

`public/m.js`'s `boot()`/`boot0()`/the `setInterval` poll/the
`visibilitychange` handler (added in the "Fix Tower going stale" commit,
`e213e4b`) is the exact pattern to copy. Deck's `boot()` needs, at minimum:
`loadState()`, `loadBridge()`, `loadApprovals()`, `loadDispatch()`,
`loadActivity()` — those five cover every data point in §5's table. Poll
on the same ~15s cadence Tower uses, with the same immediate-refresh-on-
`visibilitychange` fix.

Auth: copy `public/m.js`'s `showAuthGate()`/`hideAuthGate()`/the
`auth-form` submit handler and `boot0()`'s `probeSession()` check verbatim
— same session-cookie mechanism, so a tenant signed in on desktop v6 or
Tower is already signed in here.

## 7. Build sequence (do in this order)

1. Read `public/m.js` in full — it's the working reference for everything
   below.
2. Read `public/shared/store.js` in full (already summarized in §5, but
   read it directly too — the live source is the ground truth).
3. Create `public/deck.css` — paste §4a verbatim.
4. Create `public/deck.html` — paste §4b verbatim (adjust only if an
   element id needs to change to match how `deck.js` ends up wiring it).
5. Create `public/deck.js` — an ES module: imports (same as `m.js`'s own
   import block), auth gate (§6), boot sequence (§6), then one render
   function per §5's table entries, `subscribe()`-wired to the right
   slices (`state`, `bridge`, `approvals`, `dispatch`, `activity` — see
   `store.js`'s own slice list in its header comment).
6. Create `public/manifest-deck.webmanifest` — copy
   `public/manifest-tower.webmanifest`, edit `name`/`short_name` to
   `"Deck"`, `start_url`/`scope` to `"/deck"`.
7. Create placeholder icons under `public/icons/deck-*.png` (see §3).
8. Register `GET /deck` in `src/cli/index.ts` — find `GET /m`'s
   registration and mirror it exactly (same `sendFile`/cache-header
   pattern, no auth middleware).
9. Extend `src/http/uiVersions.ts`'s `cacheHeaders()` regex to also match
   `deck.css`/`deck.js`.
10. Verify: `npx tsc --noEmit` (only `.ts` files changed — should be
    clean, this pass touches no engine logic) and `node --check
    public/deck.js` (syntax check, matching this repo's own convention
    for plain-JS frontend files).
11. **Do not attempt to start the server and hit it live** unless a real
    Postgres + a real SpaceTraders tenant token are actually available in
    the environment — if not (no local DB is the normal case in a sandbox
    session), say so plainly in the summary rather than claiming it was
    verified. Live verification is the operator's job after this lands,
    exactly like Tower's own first pass.

## 8. Definition of done for this pass

- `/deck` loads, shows the real auth gate, and once signed in shows
  Overview with live credits/rate/ships/stranded/unassigned/manual-hold/
  alerts/best-route KPIs, the Wants-vs-Doing table, live Approvals
  (Approve/Deny both work end-to-end), and a live Activity feed.
- Fleet/Markets/Map/Ops/Doctrine nav items exist, are clickable, and show
  an inert placeholder — no errors, no half-built content.
- The ⌘K hint renders but does nothing when clicked.
- No new backend files touched; no new `Store`/`FleetManager` methods.
- `npx tsc --noEmit` clean; `node --check public/deck.js` clean.
- `CHANGELOG.md` gets one new entry (this repo's own convention: written
  for someone who wasn't in the room) and `docs/TODO.md` gets a "Verify
  Deck (`/deck`) live" item, mirroring the exact one Tower got after its
  own first pass.
- **Commit and push to both `main` and the feature branch** per this
  repo's dual-push convention (`CLAUDE.md`) — Render only auto-deploys
  from `main`.

## 9. What happens after this pass

Once Overview is live and the operator has actually looked at it (same
sequencing Tower followed — Home first, then Fleet, then Map, then
Markets+More), the next natural screen is Fleet (mockup screens 2, 6, 7) —
but that's a separate pass with its own spec, not part of this one.
