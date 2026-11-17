# Tower readability audit (operator request, 2026-11-17)

Read-only audit of Tower (`public/m.html`, `public/m.css`, `public/m.js`, `public/shared/*.js`) for reading at a glance, written for an
operator with poor eyesight and meant to help anybody. **Nothing in the app was changed.** The layout, the bottom-bar groups, the
sub-tabs, the card structure and the dark Gruvbox look stay as they are; this is a list of dials to turn, not a redesign.

Screenshots and scripts are **not in the repo**. They are in
`/tmp/claude-0/-home-user-stcommand/e3a83d2d-b1d8-59a3-97ca-a942740c9c18/scratchpad/audit/` (`shots/*.png`, `server.js` stub server,
`measure.js`, `gruv.js`, `gruv2.js`, `eff.js`, `scale.js`, `shots.js`). They may be cleared by a reboot.

## 1. The finding that explains most of it

`public/m.css:1068-1070` (the "Tower scale" block, added 2026-10-29 when the operator said "everything's just a little too big... reduce
everything by 30%"):

```css
:root { --tower-scale: 0.7; }
.app, .auth-gate { zoom: var(--tower-scale); width: calc(100vw / var(--tower-scale)); height: calc(100dvh / var(--tower-scale)); }
```

Every size in the file was set to 15-16 px "for low vision" (the Clear Tower block, 2026-10-29) and then the whole app is drawn at 70%. So
the 15 and 16 px text the stylesheet appears to have is **10.5 and 11.2 px on the phone**. I measured this in Chromium (390 px wide,
`getComputedStyle(.app).zoom` = 0.7). That one variable is worth more than every other recommendation here combined, and it is the
operator's own earlier request, so it needs the operator's decision (question 1 below). The shell is already built around a single
knob, so changing it is a one-line change.

Other things that follow directly from it:

* `viewport` in `public/m.html:5` has `user-scalable=no`, so the operator cannot pinch-zoom as a fallback either (WCAG 1.4.4).
* `m.css:1073` sets `.subnav button { min-height: 44px }` (a plain `44px`, after the `calc(48px / var(--tower-scale))` rules at 936 and 1053),
  and the zoom shrinks it to **31 px on screen**. The bottom-bar buttons are 42 px (60 px x 0.7).

## 2. How this was measured, and what could not be verified

* **Static**: `measure.js` parses `m.css` (font sizes, weights, letter-spacing, text-transform, families, colours); `gruv.js`/`gruv2.js`
  compute WCAG 2.x contrast ratios and CIE76 deltaE against Gruvbox.
* **Rendered**: a tiny static server (`server.js`) serves `public/` and stubs about 50 `/api/*` calls (nine ships, two approvals, routes,
  keepers, a queue with live/staged/scouted systems, hourly buckets). Playwright, Chromium, 390x844 at deviceScaleFactor 2. The real
  webfonts (Chakra Petch, IBM Plex Mono) did load from Google Fonts through the proxy. `eff.js` walks the DOM of 17 screens and
  records the on-screen size of every visible text node and the size of every button, select and input.
* **Layout at other scales**: `scale.js` overrides `--tower-scale` and reports anything wider than the viewport, at 360 and 390 px.

Not verified, plainly:

* **No real phone.** iOS Safari behaviour of `zoom`, the safe-area insets and `user-scalable` was not tested. Firefox support of CSS
  `zoom` (non-standard until recently) was not checked.
* **Stub data is small and tidy.** Long ship names, long goods names, six-digit prices, 40 ships and real hold values will wrap and
  overflow more than what I saw.
* **Metrics, Explorers (cards), Compare, Season, Opening, Mining, Co-pilot, Admin, Alerts, MCP keys, Blocked goods, Spaced routes**: not
  rendered usefully. Metrics rendered its layout but several numbers read `undefined`/`NaN` because my stub is incomplete (these are stub
  artefacts, not Tower bugs); Explorers printed its headline but not its cards. I audited those from the CSS and the JS only.
* The "duplicate `·`" in the route row (`~12 runs left` preceded by `· ·`) comes from `tripLabel(r)` returning nothing for my stub; I
  did not check what the real data gives.
* Contrast figures are WCAG 2 relative-luminance ratios on flat colours. Blended colours (opacity, rgba borders) are estimates.

## 3. Measurements

### 3.1 What the phone actually shows (17 screens, ~6,100 text characters)

| On-screen font size | Characters | Share | Where |
|---|---|---|---|
| 5 - 9.3 px | 18 | 0.3% | price chart axis labels (`m.js:1843-1845` `font-size="8"`), the `c` unit in yard prices |
| 10.5 px (15 px CSS) | 1,816 | 30% | labels, sub lines, table headers, badges, buttons on cards |
| 11.2 px (16 px CSS) | 2,216 | 36% | body text, row text, details, hints, segment buttons |
| 11.9 - 12.6 px | 1,781 | 29% | headings (18 px CSS), hourly table body, check rows |
| 13.3 - 14 px | 188 | 3% | tile "sub" figures, key figures |
| 16.8 - 28 px | 79 | 1% | hero figures, queue counts, By-system goods counts |

So about two thirds of everything on screen is 10.5-11.2 px, and nothing but the three hero figures is above 14 px. For reference,
iOS body text is 17 px and the usual minimum for comfortable reading is 16 px; people with low vision typically need well beyond that.
The Expand > By system change (30 px `b` count, 19 px row, 18 px YARD chip) is the right idea but those are also multiplied by 0.7
(21 px, 13.3 px, 12.6 px on screen), and `.sys-age` (17 px, dim) is 11.9 px.

### 3.2 Font sizes in `m.css` (as written, before the 0.7)

| CSS size | Declarations | Used for |
|---|---|---|
| 15px | 66 | all-caps chrome (`.tile .k`, table `th`, `.hull .role`, `.keeper-badge`, `.fm-tag`, `.ss-st`, kpi labels), dim sub lines (`.tile .sub`, `.card .exp`, `.rr-legs`, `.detail-row .d`, `.mx-note`), tab-bar labels and buttons (`button, .btn { font-size: 15px }`, line 950), status bar and Guide/Log out |
| 16px | 127 | body: `.card .detail`, `.card .who`, rows, inputs, segment buttons, sub-tabs, table cells, hints |
| 17-20px | 9+32+2+1 | headings (`.sec-h` 18), roster/check/hourly rows (18), `.tile .pair .pv` (24), `.hr-t td` (18), `.sys-*` |
| 24-40px | 3+2+2+1 | `.ex-v` 24, `.tile .v` 32, `.qq-counts b` 32, `.qq-big` 28, `.tile .v.hero` 40 |
| `font-size="8"` (SVG user units) | 3 | price chart axis and legend text, `m.js:1843-1845` (8 x 0.7 = 5.6 px) |

There is **nothing below 15 px in the CSS** except that SVG text. The problem is the multiplier, then the 15 px labels. Full list of the
15 px rules by purpose is in appendix A.

### 3.3 Families, weights, tracking, case

* Two families: `--mono` IBM Plex Mono (77 declarations: all prose, rows and numbers) and `--chrome` Chakra Petch (50: labels, headings,
  buttons, tab bars). One system sans for the co-pilot messages (`m.css:713`). Weights used: 400 (2), 600 (33), 700 (23), 800 (2; the
  font is only loaded at 500-700 for Chakra and 400-700 for Plex Mono, so 800 renders as 700).
* **`text-transform: uppercase` appears 44 times**: every label, table header, sub-tab, button, tab-bar item, badge and segment control.
  Sub-tabs are uppercase (`m.css:1073`) even though the comment at 1047 says "sentence case". All-caps is about 10-15% slower to read and
  at 10.5 px it is the hardest text in the app.
* Letter-spacing: 17 distinct values (0 to 0.2em). `m.css:912` `[class] { letter-spacing: normal }` neutralises most single-class
  trackings, but rules with two classes (`.tile .k`, `.subnav button` at 1073 = 0.06em, `.sec-h`, `.mx th`) still track, so the effect is
  patchy. On screen the sub-tab letter-spacing computes to 0.96 px.

### 3.4 Colours: Tower is already exactly Gruvbox

Every colour variable in `m.css:12-32` is a Gruvbox dark value, **deltaE 0** (CIE76, `gruv.js`):

| Tower variable | Hex | Gruvbox name | deltaE |
|---|---|---|---|
| `--ground` / `--on-accent` | #282828 | bg0 | 0 |
| `--panel` | #32302f | bg0_s | 0 |
| `--raised` | #3c3836 | bg1 | 0 |
| `--raised-2` / `--hair` | #504945 | bg2 | 0 |
| `--hair-hi` | #7c6f64 | bg4 | 0 |
| `--field` | #1d2021 | bg0_h | 0 |
| `--bone` | #ebdbb2 | fg1 | 0 |
| `--dim` | #a89984 | fg4 | 0 |
| `--amber` | #fabd2f | bright yellow | 0 |
| `--green` | #b8bb26 | bright green | 0 |
| `--red` | #fb4934 | bright red | 0 |
| `--ice` | #83a598 | bright blue | 0 |
| `--label` | #fe8019 | bright orange | 0 |

The palette is right. What drifts from it is a set of **hard-coded leftovers from the earlier palette**, none of them Gruvbox:

| Where (`m.css` line) | Value | Nearest Gruvbox |
|---|---|---|
| 133 `.btn.deny` border, 222 `.fg.low` glow, 840 `.ss-st-missed` | rgba(255,97,82) ≈ #ff6152 | bright red #fb4934 |
| 330 `.keeper-badge.covered`, 524, 839 | rgba(88,214,141) ≈ #58d68d | bright green #b8bb26 or aqua #8ec07c |
| 610, 619, 618 | rgba(255,149,133) ≈ #ff9585 | bright red #fb4934 |
| 611 `.fm-burn` | rgba(79,209,197) ≈ #4fd1c5 | aqua #8ec07c |
| 386, 390, 492, 841 | rgba(147,166,180), rgba(255,176,32) | blue #83a598, yellow #fabd2f |
| 402 ship blip | rgba(243,239,230) | fg1 #ebdbb2 |
| 673 `.mx td` | rgba(255,199,120) | yellow #fabd2f |
| 320 `.sys-yard` | #121212 | bg0_h #1d2021 |
| 764-781, 903 | fallbacks #d9a400, #5fd38d, #e8a73a, #000 | yellow, green, yellow, bg0_h |

(The `var(--x, #fallback)` ones never fire while the variable exists, so they are tidy-ups, not live bugs.)

### 3.5 Contrast (WCAG ratios; AA text 4.5, AA large 3.0, AAA text 7.0, non-text UI 3.0)

Text colours Tower uses, on the backgrounds they sit on (`measure.js`, `gruv.js`):

| Text | #hex | on ground bg0 | on panel bg0_s | on raised bg1 | on field bg0_h | on bg2 |
|---|---|---|---|---|---|---|
| `--bone` fg1 | ebdbb2 | 10.75 | 9.57 | 8.45 | 11.95 | 6.43 |
| `--amber` yellow | fabd2f | 8.69 | 7.74 | 6.84 | 9.67 | 5.20 |
| `--green` | b8bb26 | 7.14 | 6.36 | 5.62 | 7.94 | 4.27 |
| `--label` orange | fe8019 | 5.84 | 5.20 | 4.59 | 6.49 | 3.49 |
| `--ice` blue | 83a598 | 5.48 | 4.88 | **4.31** | 6.09 | 3.28 |
| `--dim` fg4 | a89984 | 5.30 | **4.72** | **4.17** | 5.90 | 3.17 |
| `--red` | fb4934 | **4.29** | **3.82** | **3.37** | 4.77 | 2.56 |
| `--hair-hi` bg4 (control borders) | 7c6f64 | 3.03 | **2.70** | **2.38** | 3.37 | 1.81 |
| `--hair` bg2 (card borders) | 504945 | | **1.49** | | | |

Bold = fails AA for normal text (or 3:1 for borders). Facts to carry forward:

* The comment at `m.css:906-907` says "every text colour 7:1 or better on the card". That is not true on `--panel`: only bone (9.57) and
  amber (7.74) reach 7:1. Dim is 4.72, ice 4.88, label 5.20, green 6.36, red 3.82.
* **Red text fails AA on every Tower surface except the darkest field**: `.btn.deny` (133), `.card .amt.red` (108), `.card.trouble .sev`
  (1023), `.check .cv.red` (1014), `.rr-blocked` (763), `.tile .v.red` (85), `.ch-weak`, `.fm-drift`. Stranded and Critical are the
  things you most want to read.
* **Dim on `--raised`** (4.17) fails: the `.tile .pair` boxes, `.sheet` (sheet text sits on bg1), `.yc-stats .chip i`, `.keeper-badge.none`
  inside rows. Dim on `--panel` passes by 0.2 and at 10.5 px on screen that is not enough.
* Button and input borders (`--hair-hi` on panel 2.70) and card outlines (`--hair` 1.49) are under the 3:1 needed to see the control
  shape (WCAG 1.4.11). `.sw` and the `.seg` buttons are mostly their border.
* `.btn[disabled] { opacity: .5 }` on the amber primary button gives about 3.3:1 for its label, and `.cg.off { opacity: .45 }` makes the
  empty-cargo dot about 2:1.
* Filled controls are fine: bg0 on amber 8.69, bg0 on green 7.14, bg0_h on amber 9.67. Dark text on a **red** fill is 4.29 (bg0) or 4.77
  (bg0_h).

### 3.6 Gruvbox text and fills, ranked (this is the menu for the recommendations)

| Gruvbox | hex | bg0_h | bg0 | bg0_s (panel) | bg1 (raised) | bg2 |
|---|---|---|---|---|---|---|
| fg0 | fbf1c7 | 14.45 | 12.99 | 11.57 | 10.22 | 7.78 |
| fg1 (bone) | ebdbb2 | 11.95 | 10.75 | 9.57 | 8.45 | 6.43 |
| fg2 | d5c4a1 | 9.56 | 8.59 | 7.65 | 6.76 | 5.14 |
| fg3 | bdae93 | 7.53 | 6.77 | 6.03 | 5.32 | 4.05 |
| fg4 (Tower dim) | a89984 | 5.90 | 5.30 | 4.72 | 4.17 | 3.17 |
| gray | 928374 | 4.47 | 4.02 | **3.58** | **3.16** | 2.40 |
| bright yellow | fabd2f | 9.67 | 8.69 | 7.74 | 6.84 | 5.20 |
| bright orange | fe8019 | 6.49 | 5.84 | 5.20 | 4.59 | 3.49 |
| bright green | b8bb26 | 7.94 | 7.14 | 6.36 | 5.62 | 4.27 |
| bright aqua | 8ec07c | 7.79 | 7.01 | 6.24 | 5.51 | 4.19 |
| bright blue | 83a598 | 6.09 | 5.48 | 4.88 | 4.31 | 3.28 |
| bright purple | d3869b | 5.98 | 5.37 | 4.78 | 4.23 | 3.22 |
| bright red | fb4934 | 4.77 | 4.29 | 3.82 | 3.37 | 2.56 |
| neutral yellow | d79921 | 6.61 | 5.94 | 5.29 | 4.68 | 3.56 |
| neutral red (fill) | cc241d | 3.00 | 2.69 | 2.40 | 2.12 | 1.61 |

`gray` #928374 and `fg4` are the usual low-contrast culprits: gray on bg0 is 4.02 (fails AA for text) and on panel 3.58; fg4 on panel is
4.72 (a bare AA pass). Tower does not use `gray` as text, good, but it uses fg4 as its main secondary colour in almost every row.

Fills with text on them: bg0_h on bright yellow 9.67, bg0_h on bright aqua 7.79, bg0_h on bright orange 6.49, bg0_h on bright red 4.77,
bg0_h on neutral yellow 6.61, bg0_h on neutral green 5.29, fg0 on neutral red 4.82 (AA), fg0 on neutral blue 3.73 (fails),
fg0 on neutral orange 3.41 (fails), fg0 on neutral green 2.73 (fails).

**One place where Gruvbox has no answer:** a bright-red text that passes AA on bg1/panel. Named tints between steps (allowed):
`red-tint` = bright red mixed 35% toward fg0 = **#fb8467** (6.04 on bg0, 5.38 on panel, 4.75 on bg1), or 25% = #fb7359 (5.40 / 4.81 / 4.25).
Where a tint is not wanted: put red on the `--field` bg0_h (4.77) or use a **filled** red chip with bg0_h text (4.77), which also
helps colour-blind readers because the shape carries the meaning.

### 3.7 Tap targets (on screen, from `eff.js`)

| Control | On screen | Rule | Verdict |
|---|---|---|---|
| `.keeper-badge` (tap toggles a keeper) | 58-59 x 16-18 px | `m.css:326`, no min-height; `button, .btn...` rule at 950 does not apply to a `span` | too small, and it changes the fleet |
| `.sw` toggles (doctrine, keeper cover) | 39 x 22 px | 976 (56 x 32 x 0.7) | small, no on/off text |
| Sub-tabs `#subnav button` | 31 px tall | 1073 `min-height: 44px` | below 44 |
| `.mx-fold` panel headers (fold/unfold) | 32 px tall | 664 | small |
| Bottom bar | 42 px tall, 77 wide | 943 | fine |
| `.btn`, `.ship-filter`, `.seg`, selects, inputs | 44 px (`calc(44px / scale)`) | 950 | fine |
| `.doc-row .dv` value box | 96 CSS px wide (67 on screen) | 972 | `5000000` is clipped to `500000(` (see screenshot 19) |
| `.yc-more`, `.why-more`, `.route-sort button`, `.crew-toggle`, `.mat-hold` (small pills) | not measured on every screen; padding 1-3 px, so under 30 px | 435, 770, 766, 776, 625 | too small |

### 3.8 Line-heights

`body` 1.45 (911); prose rows 1.4-1.5 (`.detail`, `.cp-msg`, `.onboard-item .d`); `.tile .v` 1.15; `.sys-goods b` 1. Line-heights are fine; do not
touch. Row padding is generous (`!important` 16 px at 1078), which already helps.

## 4. Screen by screen

Screenshot paths are under `.../scratchpad/audit/shots/`. "px" below is on-screen px at the current 0.7 scale.

| Screen | What is hard at a glance | Where |
|---|---|---|
| **Header / status bar** (all screens) | Status bar is 10.5 px dim with a build label (`Tower audit-stub`, `m.css:50-52,731`). "3 need you" is 11 px green and the only global alert count; Guide / Log out are 11 px. `.topbar .who` truncates at narrow widths with an ellipsis. | `m.css:50-59,955-957`; `m.html:59-63` |
| **Sub-tab row** (all screens) | 31 px tall, 12 px all-caps. In Money (6 tabs) and Expand (5 tabs) the row scrolls sideways and the last pill is cut off, so **Compare** and **Yards** are invisible until you swipe (screenshots 06, 12). The wrap-to-a-second-line rule of 2026-10-29 (`m.css:934`) is overridden by `#subnav { flex-wrap: nowrap }` at 1083. Active tab is amber fill: good. | `m.css:1073-1085` |
| **Now > Status** (01) | Best screen: one number per card, 28 px hero figures, units dimmer. Weak points: the hero is `--ice` (blue-grey) so "profit" is not green; the second line is dim 11 px prose; Credits / Holds are `3.18M` and `~607k` (abbreviated, while the card above shows exact); the hourly table headers are 10.5 px orange caps; the `now` marker is 10.5 px; the "Ships" check shows `9 hulls` in **red** because something is stranded, so a neutral count wears an alarm colour. | `m.css:915-922,992-1004`; `m.js:413-433,476-491` |
| **Now > Status > Needs a decision** (01) | Shows the raw kind (`buyKeeperProbeForMarket`, `buyShip`) while the Approvals tab shows the friendly label (`APPROVAL_LABELS`). Duplicates Approvals. Disabled "Reassign — Fleet tab soon" buttons are noise. | `m.js:549-575` vs `m.js:653-685` |
| **Now > Approvals** (02) | Good structure. Cost is amber bold 11 px; `auto-decides 0h 13m` is dim 10.5 px (the deadline matters here); Deny is red outline text at 3.82:1 on a 1.5:1 border. The Approve button is 44 px: good. | `m.css:107-113,126-134` |
| **Now > Trouble** (03) | **Model screen**: severity word (CRITICAL / WARNING / NOTE) plus coloured border plus colour. The detail line is dim mono 11 px and has the kind as raw snake_case (`no fuel stranded:`). | `m.css:1019-1025`; `m.js:499-510` |
| **Now > Activity** (04) | `.act-row .when` 10.5 px dim on its own line, then the text, then a green or red signed amount in the same line: the amount is not aligned or bigger. Colour (green/red) plus the sign: fine. | `m.css:338-347,927-928` |
| **Money > Hourly** (05) and the Status table | Good size and tabular figures. **No colour at all**: `m.js:466` gives cells `class="green"`/`"red"` but there is **no `.hr-t .green/.red` rule** in `m.css` (only `.tile .v.green`, `.cmp .good`...). Loss hours look the same as profit hours, and the only cue is a `−`. `short()` gives `+417k`, `+140k`: fine. Table `th` is orange 10.5 px caps. | `m.css:998-1004`; `m.js:463-475` |
| **Money > Routes** (06) | The key number appears three times (`+310,000/hr` right-aligned green 11 px; the same in the dim line; `/trip` again in the idle line), each at 10.5-11 px. Five lines per route, three of them dim. Filter pills `Show: All 6 / Local 3 / Cross-system 3` and `Sort by` are 11 px, 38 px pills in a different shape from the square sub-tabs. The `Assign a ship` button is full width and clear. At 360 px and scale 1.15 the pills wrap to two lines (screenshot `scale1.15-w360-money-routes.png`). | `m.css:470-484,763-776`; `m.js:1554-1600` |
| **Money > Contracts** (07) | `x/y` progress and a 5 px bar; the amount is `110,000c` in 11 px. Not looked at beyond the CSS: `crew-*` pills are small. | `m.css:513-518,775-785`; `m.js:2007-2040` |
| **Money > Prices** (08) | The chart text is **5.6 px** (SVG `font-size="8"` x 0.7) and illegible; the tap-to-enlarge view (blowout.js) fixes it once you tap, but the row `buy 1,138 · sell 938` underneath is dim 10.5 px, and the keeper badge on each row is a 16 px-high tap target. Numbers are not right-aligned across rows. | `m.js:1840-1860`; `m.css:464-468` |
| **Money > Metrics** (09) | Not usable to judge with my stub. From CSS: KPI label 10.5 px caps, value 20 px (14 px on screen), `.mx-axis` 18 user units in a viewBox (scales with the chart width, so it varies), tables are `white-space: nowrap` inside `overflow-x: auto`, so wide tables scroll sideways. Fold headers (`mx-fold`) 32 px. | `m.css:639-688`; `shared/metrics.js` |
| **Expand > Queue** (10) | Good: one question per card, `qq-q` orange 11 px caps, `qq-big` 28 px, counts 32 px. Weak: the counts' labels (`live`, `staged`, `scouted`) are dim 10.5 px; the release rule is dim prose; `Keepers: 14 covered, polling 61 of 105/min ›` is a long sentence on a button. | `m.css:1026-1039`; `shared/queue.js` |
| **Expand > Keepers** (11) | The switch row (`Cover whole list ...`) puts the label above a switch that is on the far right line below, with no ON/OFF word. The station list is `● THEO-5` / `◐ no keeper yet`: shape plus text, good, but dim 10.5 px. | `m.css:507-534`; `m.js:2264-2282` |
| **Expand > By system** (12) | Today's change works: the goods count is the loudest thing and YARD is a solid amber chip. Remaining: `+ keeper` badge 10.5 px dim and 18 px tall; `8h old` is 11.9 px dim; the market name `FR76-A2` is 12.6 px bold, not as strong as the count; `not priced yet` is amber but small. | `m.css:311-322`; `m.js:1795-1803` |
| **Expand > Explorers** (13) | A 6-line paragraph of explanation (`mx-purpose`, dim 11 px) sits above the data on every visit. The cards were not rendered by my stub; from the code they hold 3 dim `detail` lines each. | `m.css:652-653`; `shared/explorers.js:100-160` |
| **Expand > Yards** (14) | Price is amber bold with a dim `c` unit at 9.3 px; `Buy` is a clear 44 px button; the chips (`CARGO 40`) are good (label dim 10.5 px, value 11 px). The cheapest yard is shown first, but the nearest-yard rule in `CLAUDE.md` (2026-11-10) has no distance cue here. | `m.css:426-439` |
| **Ships > Ships** (15) | The four filter buttons are the largest controls on the screen (52 px). The rows: ship name 11 px bold, job 11 px ice, then **two colour dots and a value**: cargo dot (amber filled / hollow) and fuel dot (green/amber/red) are **colour-only**, 8 px, with the explanation in a hover `title` that a phone cannot show. `—` is shown for ETA when docked and for the role in the id column. Group headers are 11 px caps; sub-group headers (`ROUTES 2 120 HOLD`) are 10.5 px dim. | `m.css:195-229`; `m.js:947-965` |
| **Ships > ship sheet** (16) | Action buttons are 44 px and clear. The sheet title is 14 px, the `sub` line 11 px dim. A destructive `Sell / scrap` is red outline text (3.82:1), same weight as the harmless buttons. | `m.css:232-263,1057-1062` |
| **Ships > Stuck** | Same screen as Trouble (good). | |
| **Menu** | Big rows (64 px) with a chevron; 12.6 px labels. Section headers (`Industry`, `Plan`, `Rules`, `Setup`) are 12.6 px bold caps. Good. | `m.css:1006-1017`; `m.js:525-532` |
| **Menu > Doctrine** (19) | Name is 12.6 px, the value box shows `5000000` unseparated and clipped to `500000(` at 96 px; `APPLIED`/`NOT WIRED` 10.5 px tag with a green or neutral border; the switch has **no on/off text** (position and colour only). | `m.css:518-534,968-978`; `m.js:2207-2225` |
| **Not rendered** | Co-pilot (18 px text already: fine), Alerts, MCP keys, Compare, Season, Opening, Mining, Blocked goods, Spaced routes, Admin, sign-in/onboarding. CSS says 15-16 px everywhere, so the same scale issue. | |

Cross-cutting patterns (each one repeats on many screens):

1. **Dim text carrying the useful second fact** (age, deadline, margin, hold, fuel). 10.5-11.2 px and 4.2-4.7:1.
2. **Numbers share a line with words in one size and colour** (`+48,000/trip · +310,000/hr · ~12 runs left`). The eye has no anchor.
3. **Numbers without separators or units in a few places**: doctrine values (`5000000`), `c` as a 9 px suffix, `8h old`, `3.18M` next to `3,184,220`.
4. **Colour as the only signal**: cargo and fuel dots (`.cg`, `.fg`, 216-223), hourly table cells (and the missing rule), the doctrine switch, `Ships 9 hulls` in red.
5. **All-caps small labels** everywhere (44 rules).
6. **Hidden sub-tabs** off the right edge (Compare, Yards, Scrap).
7. **Tap-to-act badges that are tiny** (`.keeper-badge`).

## 5. Recommendations

Everything keeps the Gruvbox palette: only existing Gruvbox values or named tints between steps appear below.

### 5.1 The proposed scale and type roles (on-screen px; "CSS" column is the value to write if `--tower-scale` is 1)

| Role | Now (CSS / on screen) | Proposed on screen | Proposed CSS at scale 1 | Notes |
|---|---|---|---|---|
| Label / chrome caps (`.tile .k`, `th`, `.qq-q`) | 15 / 10.5, uppercase, orange | 14 min, **sentence case or Title Case**, weight 600 | 14-15 | keep orange (`--label`, 5.20) for labels on panel; on bg1 use fg2 |
| Secondary / dim line | 15-16 / 10.5-11.2, fg4 | 15 | 15-16 | colour fg3 (see 5.2) |
| Body / row text | 16 / 11.2 | 16 | 16 | |
| Row title, heading | 18 / 12.6 | 18 | 18 | `.sec-h`, `.card .who` |
| **Row key number** | 16 / 11.2 (same as the words) | **20, 700, tabular** | 20 | the number a row exists for |
| Card key number | 20 / 14 | 24-28 | 24-28 | |
| Hero number | 28-40 / 20-28 | 32-40 | 32-40 | already fine at scale 1 |

The floor is 14 px on screen for anything, 15 px for anything that carries information, and 16 px for prose. At the current 0.7 this
needs CSS sizes of 20-23 px, which is the same as removing the scale; the clean way is P1 item 1 below.

### 5.2 Text colours: proposed set (Gruvbox values only; AA minimum, AAA for key numbers)

| Use | Now | Proposed | Ratio on panel / bg1 | Why |
|---|---|---|---|---|
| Key numbers, titles, row text | bone fg1 (9.57 / 8.45) | keep **fg1**; hero figures on dark surfaces may use **fg0 #fbf1c7** (11.57 / 10.22) | AAA | already AAA |
| Positive money / good status | `--ice` for hero profit, `--green` elsewhere | keep ice for the single "profit per hour" hero if the operator likes it; use **bright green #b8bb26** for +amounts (6.36 / 5.62, AA; 4.5 AAA-large at 24 px+) | AA / AAA large | one green for "good" everywhere |
| Amber figures (costs, warnings, active tab) | `--amber` | keep (7.74 / 6.84) | AAA on panel | |
| **Secondary / dim text** | fg4 #a89984 (4.72 / 4.17) | **fg3 #bdae93** for lines that carry facts (age, deadline, margin, hold); **fg2 #d5c4a1** (7.65 / 6.76) on `--raised` | 6.03 / 5.32 (fg3); 7.65 / 6.76 (fg2) | fg4 stays for truly decorative text (the build label, placeholder) |
| Labels on panel | `--label` orange (5.20 / 4.59) | keep, but at the new size and not tracked caps | AA | for the key number's name, the orange label is a pleasant anchor |
| Ice job/ship lines (`.rr-job`, `.act-row .txt`, `.yc-where`) | #83a598 (4.88 / 4.31) | **blue + 30% fg0 = #a7bca6** (6.49 / 5.74), or fg2 | AA+ | named tint |
| **Red text** (Deny, Critical, Stranded, Blocked, negative) | #fb4934 (3.82 / 3.37) | **red-tint #fb8467** (5.38 / 4.75) for text; for buttons and badges a **filled** red chip with **bg0_h #1d2021** text (4.77) | AA | red on dark can not reach AA otherwise |
| Disabled | opacity .5 (~3:1) | fg4 text on bg1 fill, no opacity | 4.17 | disabled should be dim, not unreadable |
| Control borders | hair-hi #7c6f64 (2.70 on panel) | **gray #928374** (3.58 on panel, 4.02 on bg0, 3.16 on bg1) | 3:1+ | non-text contrast, WCAG 1.4.11 |
| Card borders | hair #504945 (1.49) | keep for hairlines between rows; use **bg4 #7c6f64** (2.70) for card outlines if cards must read as boxes | | cosmetic |
| Text on amber fill | #282828 (8.69) / #121212 (11.05) | **bg0_h #1d2021** (9.67), no off-palette `#121212` / `#000` | AAA | tidy |

Neutral Gruvbox variants (`#cc241d`, `#d79921`...) are for **fills only** (a pill background), as intended: fg0 on neutral red 4.82 passes,
bg0_h on neutral yellow 6.61 passes. Avoid neutral red/green/blue/orange as text (2.1-3.8 on bg1/panel).

### 5.3 Status rule: icon or word plus colour, never colour alone

* Every status gets a **word or glyph** that is in the DOM, not in a `title`: `STRANDED`, `LOW FUEL`, `EMPTY`, `FULL`, `ON`, `OFF`.
  Colour reinforces. Trouble cards already do this (severity word + coloured border): copy that pattern.
* Ship rows: replace the two 8 px dots by text the way ETA is shown: `fuel 12%` (amber at under 50%, red-tint at under 25%, with a `!`
  glyph below 25%), `hold 80/80` or `hold empty`. Colour blind safe because text and glyph repeat it.
* Switches: show `ON` / `OFF` inside or beside every `.sw`.
* Profit and loss: sign (`+`/`−`) is already there; add the missing `.hr-t .green/.red` colours **and** keep the sign. Add `▲`/`▼` only where
  trend matters (the pace hero already has it).
* Never use red for a neutral count (`Ships 9 hulls` in red on Status); put the alarm in the second line (`1 stranded`) in a filled chip.
* Badges (`● covered`, `◐ pending`, `+ keeper`) already carry a glyph and a word: good; just make them larger (below).

### 5.4 Key-number rule for a row

One number per row is the *point* of the row. Right-aligned, 20 px (on screen), weight 700, `font-variant-numeric: tabular-nums`, thousands
separators always (`fmt()` in `shared/domain.js:150` already does it), the **unit directly after in fg3 at 14-15 px weight 400** (`/hr`, `c`, `units`).
Everything else on the row is fg3 15 px. Example (routes): `ELECTRONICS` left, `+310,000` bold 20 px with `/hr` dim, and the legs
(`PT36-A2 → PT36-B7`, margin, runs left) in one dim line below; drop the repeated `+310,000/hr` from the dim line.

Avoid abbreviating (`3.18M`) beside the exact figure for the same thing. If a table needs the short form (four columns at 360 px), say
so in the column heading (`Trading (k)`), or keep `short()` and put the exact value in the line below.

### 5.5 Prioritised list

#### P1: CSS-only, low risk (each fits in one change)

| # | File / selector | Current | Proposed | Why / risk |
|---|---|---|---|---|
| 1 | `m.css:1068` `:root { --tower-scale: … }` | `0.7` | `1` (default), see 5.6 for the setting. Alternatively `0.85` as a compromise. | Removes the shrink that produces all the 10.5-11 px text. The shell already uses the variable. **Layout:** tested at 360 and 390 px, scale 1: no overflow on 8 screens. At 1.15 and 360 px the top bar truncates, the hero tile overflows by 3 px and the pills wrap. |
| 2 | `m.css:1073` `.subnav button` | `min-height: 44px` | `min-height: calc(44px / var(--tower-scale))` (matches 1053 and every other control) | 31 px to 44 px on screen at 0.7; no effect at 1.0. Low risk. |
| 3 | `m.css:11-32` text colours | `--dim: #a89984` | add `--text2: #bdae93` (fg3) and `--text2-on-raised: #d5c4a1` (fg2); change the ~60 `color: var(--dim)` that carry facts to `var(--text2)`; keep `--dim` for the build label and placeholders | contrast 4.72/4.17 to 6.03/5.32 (7.65/6.76 with fg2). Pure colour. |
| 4 | red text: `.btn.deny`, `.card .amt.red`, `.sev` (crit), `.check .cv.red`, `.rr-blocked`, `.tile .v.red`, `.ch-weak` | `var(--red)` #fb4934 (3.82) | new `--red-text: #fb8467` (red + 35% fg0, 5.38 on panel). Keep `--red` for fills and borders and dots. | AA for the most important words. Hue family unchanged, slightly lighter. |
| 5 | `m.css:1003/999` add `.hr-t .green { color: var(--green) } .hr-t .red { color: var(--red-text) }` (and `.cmp .good/.bad` already exist) | no rule: profit and loss hours look the same | add the two rules | The JS already emits the classes (`m.js:466`). Zero risk. |
| 6 | control borders: `.btn`, `select`, inputs, `.seg button`, `.subnav button`, `.sw` | `--hair-hi` #7c6f64 (2.70 on panel) | `#928374` (Gruvbox gray; 3.58 on panel) | WCAG 1.4.11. Colour only. |
| 7 | `.keeper-badge`, `.yc-more`, `.why-more`, `.route-sort button`, `.crew-toggle`, `.mat-hold` | 16-30 px tall | `min-height: calc(36px / var(--tower-scale)); display: inline-flex; align-items: center; padding: 0 10px` | tap targets. Risk: By-system row gets one line taller; it wraps already (`flex-wrap`). |
| 8 | `m.css:1043,1073,…` small-caps labels: `.tile .k`, `.tile .pair .pk`, `.hr-t th`, `.qq .qq-q`, `.mx .kpi .k`, `.ex-k`, `.mx th`, `.roster-grp` | `text-transform: uppercase; font-size: 15px` | `text-transform: none; font-size: 16px; font-weight: 600` | removes ~35 of the 44 all-caps rules where they are labels; keep caps for buttons and tab-bar only. Risk: tables with several columns at 360 px get wider headers (`Trading`, `Worth`); `.hr-t th` already shrinks at 360. |
| 9 | `.sw` and the doctrine row | colour and knob position only | `.sw::after { content: "OFF"; }` / `.sw[aria-pressed="true"]::after { content: "ON"; }` positioned beside the knob (56 px wide fits it at 14 px) | colour-not-alone. Risk: switch width; needs a visual check. |
| 10 | `.doc-row .dv` | `width: 96px` | `width: 9.5ch; min-width: 120px; font-variant-numeric: tabular-nums` | `5000000` is clipped now. Separators need JS (P2). |
| 11 | `m.html:5` viewport | `user-scalable=no` | remove it | lets pinch-zoom work (WCAG 1.4.4). Risk: the map/deck gestures (`touch-action`) and accidental zoom on double-tap. Test the scope map and the chart blow-up. |
| 12 | `m.css:1083-1085` `#subnav` | one row, scroll sideways, last pill clipped | `flex-wrap: wrap` for groups with more than 4 tabs, or a left/right fade and `scroll-snap`, or shrink to 2 rows. | Compare/Yards/Scrap are hidden today. Risk: the sub-nav grows to 2 rows (about 44 px) on Money. |
| 13 | tidy off-palette colours (3.4 table): `rgba(255,97,82,…)`, `rgba(88,214,141,…)`, `rgba(255,149,133,…)`, `#4fd1c5`, `#121212`, fallbacks | non-Gruvbox | the Gruvbox value in the same row of the table | consistency only. |

#### P2: small markup or JS changes

| # | File | Change |
|---|---|---|
| 14 | `m.js:947-965` roster row | Replace the cargo dot and fuel dot by text: `hold 80/80` or `empty`; `fuel 12%` with `!` below 25%. Keep the dots as decoration if wanted. (Status not colour alone.) |
| 15 | `m.js:1554-1600` route row | One key number per row (profit/hr or /trip, per the active sort) in the right-aligned 20 px bold slot; remove the duplicate from the dim line; put `40u +24,000 · 80u +48,000` on one dim line. Fix the doubled `·` when `tripLabel(r)` is empty. |
| 16 | `m.js:2207-2225` doctrine | show `fmt(value)` separators in the input via `inputmode` text + parse, or a dim formatted caption under the box (`5,000,000 c`). |
| 17 | `m.js:549-575` (Needs a decision) | use `APPROVAL_LABELS` (the Approvals tab already does), and render the title as a sentence (`Keeper probe`, `Ship purchase`). |
| 18 | `m.js:1840-1860` price chart | `font-size="8"` becomes `14` and the axes get fewer labels (min, max); or hide the SVG text and print min and max under the chart in HTML at 15 px. |
| 19 | `m.js:476-491` checks | not red for a count: tone the `Ships` value neutral and put `1 stranded` in a red-tint chip on the second line. |
| 20 | `shared/explorers.js:100-110` | collapse the explanatory paragraph under a `?` toggle after the first view (it pushes the data below the fold). |
| 21 | `m.js:499-510` Trouble | translate `kind` from `no_fuel_stranded` to a sentence (`No fuel, stranded`), keep severity word. |

#### P3: larger ideas

* **Large text control** in Menu (5.6).
* **Express the sizes in `rem`** so the browser's own text-size setting and a root `font-size` can scale everything: about 250 px
  declarations in `m.css`, plus fixed pixel heights (`.statusbar { height: 24px }`, `.stack { height: 230px }`, `.price-chart-room { height: 150px }`,
  `.sheet { max-height: 62vh }`). Worth it only if the operator wants more than 1.15x.
* **Row layout pattern** for Routes/Hourly/Ships: left = what, right = the one number; second line = three dim facts. A shared `.kv-row`
  class so every list looks the same.
* **A "glance" strip** at the top of Ships, Routes and Approvals: three numbers in 28 px (hulls / stranded / unassigned; routes / best
  per hour; waiting / oldest deadline). Pure additions, no layout change.
* **Per-user high-contrast toggle** that swaps `--text2` to fg2 and `--hair-hi` to gray everywhere (a colour set within the Gruvbox
  family).

### 5.6 Optional "Large text" setting

* **What exists.** One knob already drives everything: `--tower-scale` (`m.css:1068`). It is applied with `zoom` on `.app` and
  `.auth-gate` and `.rl-toast` (1069-1070), with width/height divided by it, and with every control's `min-height` written as
  `calc(Npx / var(--tower-scale))`. All text sizes are **px**, not rem, so a root `font-size` would do nothing, but the zoom scales them.
  `m.js` does not read or write the variable (grep: no matches); `blowout.js` has its own pixel sizes (22 px bars, 56 px buttons) and sits
  outside `.app`, so it is **not** scaled and is already large.
* **What it takes** (about 25 lines): `Menu > Text size` row with four buttons (`Standard 0.85 / Large 1.0 / Larger 1.15 / Largest 1.3`),
  saved in `localStorage` (wrapped in try/catch, as `navGet`/`navSet` already are), applied at page start with
  `document.documentElement.style.setProperty("--tower-scale", value)` before first paint to avoid a flash. No other module is affected.
* **What breaks above 1.0 on a 360 px phone** (measured with `scale.js`; 1.0 was clean on 8 screens at 360 and 390 px):
  1. The top bar (`.topbar .who` ellipsises at 1.15: `4 nee…`). Fix: let `.who` wrap or move it to its own line under the brand.
  2. The Status hero tile overflows by 3 px at 1.15 (`40px` figure, `+18,400,000`). Fix: `.tile .v.hero { font-size: clamp(28px, 9vw, 40px) }`.
  3. Filter pills wrap to two lines (`All 6`, `Cross-system 3`). Fix: `white-space: nowrap` and let the row scroll or wrap.
  4. The bottom bar labels nearly touch (`MONEY` / `EXPAND`) at 1.15. Fix: keep the bar at 1.0 (put the bar outside the zoom) or shorten to icons plus 13 px.
  5. Fixed heights: status bar 24 px (`m.css:51`), deck `.stack` 230 px (`:151`), `.price-chart-room` 150 px (`:465`); they clip at large scale.
  6. `.sheet { max-height: 62vh }` is in viewport units that the zoom does not scale; check it at 1.3.
  7. `zoom` is non-standard in Firefox and was not tested on iOS Safari.

## 6. Do these first (in this order)

1. **Raise `--tower-scale` to 1 (or 0.85)** and **remove `user-scalable=no`** (P1 #1, #11). Biggest single gain; needs the operator's call (Q1).
2. **Sub-tabs: `min-height: calc(44px / var(--tower-scale))` and make the hidden tabs reachable** (P1 #2, #12).
3. **Secondary text from fg4 to fg3** (`--text2`), fg2 on raised surfaces (P1 #3).
4. **Red text to the red tint `#fb8467`**, keep bright red for fills and borders (P1 #4).
5. **Colour the hourly table** (`.hr-t .green/.red`, P1 #5): loss hours become visible at a glance.
6. **Control borders to Gruvbox gray** (P1 #6) and **keeper badges and small pills to 36 px tap height** (P1 #7).
7. **Labels: sentence case, 16 px** instead of 15 px tracked caps (P1 #8).
8. **Key number per row** in routes and the ship roster (P2 #14, #15): bigger, bold, tabular, unit dimmer; replace the colour-only dots by text.
9. **ON/OFF on switches; fix the clipped doctrine value box** (P1 #9, #10).
10. **Price chart axis text 8 to 14** (P2 #18) and use the approval labels on Now (P2 #17).

Items 1-7 are pure CSS plus one HTML attribute; none changes the layout structure. Check each on a 360 px phone after the change
(P1 #1, #7, #8, #12 are the ones that can reflow).

## 7. Consistency with today's changes

* **Chart tap-to-enlarge (`shared/blowout.js`)**: consistent; it uses 22 px text and 56 px buttons outside the scaled shell, which is the right
  size. It does not fix the *inline* chart text (5.6 px axis labels on Prices), so the P2 #18 change is still worth doing. A small
  "tap to enlarge" hint on each chart would make it discoverable (the cursor style only helps with a mouse).
* **By system (`.sys-*`)**: consistent with 5.4 (bigger number, bold, tabular, dim unit; loud amber chip with dark text). Two adjustments:
  `.sys-yard` uses `#121212` (use bg0_h #1d2021: 9.67 vs 11.05, both AAA), and `.sys-age` (17 px dim, 11.9 px on screen) should take the
  `--text2` colour. After the scale change these sizes will land at 19/30/17/18 px on screen, which is already the target range for the
  scale in 5.1; you may then drop the `.sys-*` px values a little (to 18/28/16/17).

## 8. Questions for the operator

1. **Scale.** On 2026-10-29 you asked to shrink everything by 30% (`--tower-scale: 0.7`). Now text is too small to read. Which do you want: 1.0 standard
   with a Large text setting in Menu (my recommendation), 0.85 as a fixed compromise, or 0.7 kept for some screens? Which phone and width?
2. **Which screens do you use most?** (Status, Approvals, Routes, Hourly, Ships, Queue, Keepers?) The first changes should go there.
3. **Is pinch-zoom wanted?** Removing `user-scalable=no` lets you zoom any screen, but can interfere with the map/deck gestures and accidental double-tap zoom.
4. **All caps.** Are you happy to lose the all-caps labels (keep caps only on buttons and the bottom bar)?
5. **Red.** May text red move to the lighter tint (#fb8467, a lightened Gruvbox red), keeping the original red for fills and borders? Otherwise red text cannot reach AA.
6. **Hero profit colour.** The "profit per hour" figure is ice blue-grey, not green. Intentional?
7. **Status wording.** OK to add words beside dots and switches (`fuel 12%`, `hold empty`, `ON`/`OFF`)?
8. **Sub-tabs.** Wrap to two rows, or keep one scrolling row with a visible edge fade? Compare and Yards are currently off screen.
9. **Dim labels** like the build number and "Guide / Log out" at the top: keep quiet or make readable?

## Appendix A: every rule that sets text at 15 px (the smallest in the CSS), by purpose

All of these render at 10.5 px at the current scale.

| Purpose | Lines in `m.css` |
|---|---|
| Header, status bar, build label, Guide / Log out | 52, 59, 731, 733, 737 |
| Cockpit tile label and sub line, pair labels | 81, 86, 918, 995 |
| Section count badge | 95 |
| Card expiry line (`auto-decides ...`) | 113 |
| Hull card (deck): role, gauge labels and values, location | 163, 168, 175, 176 |
| Roster: header, role, group, badge, stats (cargo, fuel, ETA) | 193, 204, 208, 211, 215 |
| Ship sheet: sub line, warning, section heading, detail row, small buttons | 251, 281, 299, 308, 309 |
| Keeper badge | 327 |
| Activity time | 342 |
| Map: system picker, blip tag, sheet small label | 368, 407, 418 |
| Yards: "more" pill, chip labels | 435, 439 |
| Routes: `protected` tag, legs line | 475, 479 |
| Doctrine: tag, unit | 523, 527 |
| Tab bar labels and badge, sub-tab count | 543, 553, 571, 943, 946, 950, 981 |
| Onboarding category | 594 |
| Flight mode, chain tags | 609, 619, 620 |
| Metrics: note, kpi label and sub, table head, projection | 652, 657, 659, 672, 682, 684, 798 |
| Season, explorers, week-over-week labels | 835, 838, 845, 868, 875, 878, 885 |
| Hourly: header, `now` | 999, 1003, 1046 |
| Global: `button, .btn, select, input` | 950, 1058 |

Smaller than 15 px: SVG `font-size="8"` at `m.js:1843-1845` (price chart) and `.mx-axis` (18 user units in a scaled viewBox).
