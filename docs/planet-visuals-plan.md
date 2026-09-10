# Planet/moon visuals — assets vs. deeper procedural generation

Written up as a reference for whenever we pick this back up, not a commitment
to build any of it now. Covers where the map's body rendering actually stands
today, the three ways to push it further, and a recommended sequence with
rough effort.

## Where we are today

Every PLANET/MOON body on the v6 3D map is fully procedural, generated at
render time in `public/v6.js`, with no external assets and no build step:

- **`ensureBodyVisual()`** picks one of several hand-drawn Canvas2D "biome"
  patterns per type (`BODY_TEXTURE_DRAWERS`) based on the waypoint's real
  SpaceTraders traits (`BODY_TEXTURE_TRAITS` — JUNGLE, VOLCANIC, FROZEN,
  SWAMP, ROCKY, BARREN, TEMPERATE, OCEAN, RADIOACTIVE all map to a specific
  drawer; a waypoint with none of those falls back to a stable hash of its
  own symbol). The canvas is contrast-boosted and given a real hue accent
  (not just grayscale) before becoming a `THREE.CanvasTexture`.
- **`makeBodyGeometry()`** reads that same canvas as a height field and
  displaces a higher-resolution `SphereGeometry`'s vertices along their own
  normals — so a JUNGLE planet's canopy or a ROCKY moon's craters are real
  3D relief, not just a flat tint, and normals are recomputed so the relief
  actually catches light.
- Both are cached per waypoint symbol (`bodyVisualCache`, `bodyGeometryCache`,
  tagged `__persistent`) since `renderMap()` rebuilds the whole scene every
  ~1s poll and would otherwise dispose/regenerate them constantly.
- Non-terrain types (GAS_GIANT bands, the asteroid-field particle cluster,
  jump-gate pulse rings, atmosphere fresnel rim) have their own simpler
  procedural treatments, untouched by any of this.

This is the result of several rounds of live bug-fixing this session — the
mip-selection bug, the disposal bug, and the "grayscale doesn't survive real
lighting" fix are all documented in the git history for `public/v6.js` around
commits `bf19463`, `d28952c`, `fef0649`, `5326dcd`. The system now works and
is verified against real waypoint data, but the actual *drawing* is still
fairly simple: radial-gradient blotches, not real noise-based terrain.

## Three ways to go further

### A. Curated free asset packs (Quaternius, Kenney.nl, etc.)

Pre-made, CC0-licensed `.glb`/`.fbx` models. Fastest to get something
polished-looking on screen; the catch is these are a handful of *fixed*
models (one gas giant with rings, one ice planet, one lava-looking planet,
...), not a system that can render arbitrary trait combinations. Good fit
for the parts of the map where one look is fine regardless of waypoint data:

- GAS_GIANT (a good rings model is a clear upgrade over procedural bands)
- JUMP_GATE (satellite-dish-style models fit well)
- Asteroid-field particles (real rock meshes instead of point sprites)
- Stations/outposts, if we ever give those their own geometry

Not a good fit for PLANET/MOON, where the whole point of the last session's
work was making the *specific* biome trait visible per waypoint.

**Cost:** low. Download the pack, self-host the needed `.glb` files under
`public/assets/`, add a `GLTFLoader` `<script>` tag (same CDN pattern the
bloom addons already use, same fallback-to-procedural-on-load-failure
safety net), write a small load-once/clone-per-instance cache, map
type/trait combos to filenames, scale to match `WP3D_SIZE`.

### B. Custom-authored or AI-generated models per biome

Either hand-modeled in Blender or produced via an AI 3D-generation service,
baked to `.glb`, one (or a few) per biome trait so PLANET/MOON keep their
trait-specific variety while getting real sculpted geometry instead of
displaced-sphere relief.

**Cost:** highest. Needs an actual authoring pipeline (Blender + someone
modeling nine-plus biome variants, or a paid AI-3D-gen API and a curation
pass on its output), plus the same loader/hosting work as option A, plus
a decision on how many biome buckets are worth a unique model vs. sharing
one with a palette swap.

### C. Deepen the existing procedural system (no new assets, no pipeline)

Keep everything exactly where it lives now (`public/v6.js`, zero external
dependencies, zero hosting/licensing questions) and make the *drawing* and
*displacement* themselves more sophisticated. This is the natural next
increment on what's already built, and the recommended starting point —
see below for specifics.

## Recommended sequence

1. **Deepen procedural generation (option C) first.** Cheapest, lowest risk,
   builds directly on the caching/mip/contrast/hue work already done this
   session, and improves every PLANET/MOON on the map at once rather than
   needing per-biome asset curation.
2. **Option A for the decorative, non-trait-driven categories** (gas giants,
   gates, asteroid rocks) once there's an appetite for a real asset pipeline
   — independent of (1), can happen anytime.
3. **Option B only if (1) turns out to have a hard ceiling** worth paying
   real authoring cost to break through. Revisit after (1) ships and gets
   real feedback rather than speculating now.

## Concrete scope for (1), if/when we pick it up

Roughly in order of value-for-effort:

- **Real coherent noise instead of random radial blotches.** The current
  drawers scatter `createRadialGradient()` blobs at random positions — reads
  fine at a glance but has no real structure (no coastlines, no continental
  plates, no storm-system coherence). A small value-noise or simplex-noise
  function (hand-rolled, ~40 lines, no library needed) driving the same
  canvas-fill approach would give continents actual jagged coastlines,
  volcanic worlds real fracture networks, gas-giant bands real turbulence.
- **Multi-octave detail.** Layer 2-3 octaves of the same noise at different
  frequencies (coarse landmass shape + medium terrain + fine grain) instead
  of one pass — cheap, standard technique, meaningfully more "real" looking.
- **A real normal map, not just displaced geometry.** Vertex displacement
  gives silhouette-level relief but at this map's poly count won't show
  fine surface detail. A normal map generated from the same height data
  (Sobel-filter the canvas, encode XY gradients as RG) would let small-scale
  bumps affect lighting without needing more geometry.
- **Cloud layer for OCEAN/TEMPERATE/JUNGLE.** A second, slightly larger
  transparent sphere with a wispy alpha-noise texture, slowly rotated
  independently of the planet — cheap, and a huge legibility win for "this
  is a living world" vs. "this is barren."
- **City lights on the dark side for high-population traits** (SPRAWLING_CITIES,
  HIGH_TECH, OVERCROWDED, TRADING_HUB, etc.) — small bright emissive specks
  seeded the same deterministic-hash way as everything else, only visible
  on the unlit hemisphere. Reuses the emissive-floor mechanism already in
  place, just keyed off a different trait set.
- **Ring systems for eligible GAS_GIANT/PLANET bodies** — a flat, textured
  annulus mesh, deterministically present/absent and sized from the waypoint
  symbol hash, same pattern as the asteroid-cluster scatter.
- **Weather/storm systems as an animated overlay** on GAS_GIANT specifically
  (the existing "great storm" variant is static; a slowly-drifting alpha
  texture over the base bands would sell it as gas rather than a painted
  ball).

None of this needs new assets, a loader, or hosting — it's all extensions
of the existing canvas-drawing + `ensureBodyVisual()`/`makeBodyGeometry()`
caching pattern already in place. The main cost is design/tuning time
(getting noise parameters, cloud density, city-light thresholds to look
good) rather than engineering risk.

## Non-goals / open questions for whoever picks this up

- Whether to keep the "hue is reserved for TYPE, biome only tints" rule
  from the current comment above `BODY_TEXTURE_DRAWERS`, or relax it
  further now that volcanic/jungle/etc. already carry real accent hues —
  a full noise-based recolor per biome might want more hue range than the
  current "off-neutral, not saturated" constraint allows.
- Whether normal-mapping is worth the extra shader complexity given this
  map is viewed at a handful of fixed zoom levels, not a true flight sim —
  diminishing returns past a certain distance.
- If option A/B ever happens: whether asset variety should be keyed to the
  same `BODY_TEXTURE_TRAITS` table (one model bucket per biome group) or a
  coarser scheme (just "rocky/icy/gassy/lush").
