# REBUILD.md — OpenOcean v2 (clean rewrite)

This file supersedes SPEC.md and QUALITY.md entirely. v1 history lives on the
`main` branch; nothing from the old `src/` may be copied without re-justifying
it against this spec and VERIFY.md.

## STARTUP SEQUENCE (execute in order before any other work)
1. Read this file in full, then VERIFY.md in full, then the
   `.claude/skills/webgpu-threejs-tsl` skill in full, then study every image
   in `reference/` (note which stills belong to which target preset — see R7),
   then the technique in `reference/webgl-water-study/renderer.js`
   (causticsShader ~line 228; see NOTICE.txt — reimplement in TSL, never copy).
2. Build `verify.mjs` per VERIFY.md against the placeholder scene in `src/`
   and prove it end-to-end (matrix contact sheet + sweep sheet + gate table
   committed to `shots/`) BEFORE writing any water code. The gate table will
   be all-FAIL against the placeholder — that is the expected, correct start.
3. Log startup as the first entry in progress.html, then begin R1.

## HARD ARCHITECTURE DIRECTIVES
- WebGPU-first via `three/webgpu` + TSL node materials + TSL compute
  (`three` is pinned; record exact version in README). WebGL2 fallback path
  must exist; headless verification uses whichever backend renders in the
  container, and `verify.mjs --backend` must support forcing either.
- The world is UNBOUNDED. No visible edge of ocean, seabed, caustics, or fog
  may ever appear from any camera position (VERIFY gate G3 hunts for this
  with a magenta clear color).
- Anti-aliasing by DELETING detail is banned. When wave detail falls below
  resolvable frequency, convert filtered-normal variance into micro-roughness
  (Toksvig/LEAN-style) so chop and glint read to the horizon (gate G1).
- Placeholder visuals are banned: no flat "churn" discs (gate G6), no
  screen-space or billboard fakes for volumetric light that ignore sun
  elevation or fail to span surface→floor (gate G4).
- CC0 textures ARE permitted and encouraged for foam lace masks, detail
  normals, and seabed material (ambientCG / Poly Haven). Every asset gets a
  line in ASSETS.md (name, source URL, license, use). No other asset sources.
- All shading decisions must survive both backends; if TSL behaves
  differently across them, prefer the construct the skill documents.

## R-ITEMS (each PASS requires the cited VERIFY.md evidence)
R1 GPU FFT CASCADES — JONSWAP spectrum, TSL compute, three cascades at
   ~[250, 60, 12] m world scales blended in vertex+fragment; wind speed,
   direction and fetch as live parameters. Evidence: matrix shots M1/M4/M5
   showing detail at all scales, no visible tiling in M5; numeric readback
   proving storm significant wave height ≥ 4 m printed in the gate table.
R2 HORIZON DETAIL — the variance→roughness pipeline of the directives.
   Evidence: gate G1 PASS in M1 for all presets; an annotated near/far crop
   pair committed to shots/.
R3 SURFACE OPTICS — Fresnel, GGX sun glint, per-preset absorption/scatter
   colors, and reflections (SSR or planar) perturbed by the displaced
   normals. Evidence: M1/M2/M3 across presets; reflection shot containing a
   prop (ship primitive or buoy) visibly reflected on displaced water.
R4 FOAM SYSTEM — Jacobian-fold injection into a persistent accumulation
   texture, advected by surface flow, ~4–8 s decay, shaded through CC0 lace
   masks so stretching tears it into filaments; whitecaps, ambient foam, and
   contact foam as separate contributions. Evidence: 4-frame time strip of
   one patch (birth→stretch→fade); side-by-side vs the storm-foam reference
   still; gate G6 PASS.
R5 CAUSTICS — Wallace-technique refracted-grid caustics in a camera-following
   region, slope inputs low-pass filtered to the region's texel frequency
   (no hatching), fading seamlessly into a matched far-field approximation.
   Evidence: M7 with wave surface and seabed in the same frame showing
   pattern↔wave correspondence; gate G5 PASS (seamless boundary + two-frame
   flow correlation); side-by-side vs reference/ref_caustics.jpg.
R6 UNDERWATER — waterline transition without a hard cut (M6), depth fog and
   downwelling color, unbounded seabed, and volumetric sun shafts aligned to
   the REFRACTED sun vector spanning surface→floor. Evidence: M6/M7/M8;
   gates G3 and G4 PASS.
R7 THREE PRESETS, FULLY DISTINCT — exactly these, tuned against their
   reference stills: `blackflag` (clear turquoise, readable seabed from
   above, bright believable daylight — refs of the calm ship/island shots),
   `storm` (dark grey-green, Hs ≥ 4 m, heavy lace foam, muted sky — storm
   refs), `seaofthieves` (stylized: saturated banded blues, exaggerated
   crisp foam shapes, painterly sky). Presets must specify spectrum AND
   optics AND sky AND sun. Evidence: same-camera triptychs at M1 and M4;
   gate G2 PASS.
R8 LIBRARY + DEMO — `createOcean(renderer, scene, camera, opts)` public API;
   default app has free-fly camera (drag look + WASD + scroll dolly, above
   and below water) and preset/quality/backend UI; README quickstart ≤ 15
   lines; a second minimal consumer project under `consumer-test/` renders
   the ocean through the public API. Evidence: three shots of one session at
   user-chosen angles (high / wave-level / underwater); consumer-test
   headless shot.

## CONDUCT
Work autonomously; never wait for confirmation — state assumptions in
progress.html and proceed. Every pass ends by running `verify.mjs` and
committing its outputs; the gate table and the R-item status table
(item / PASS-PARTIAL-FAIL-BLOCKED / evidence file) are printed as plain text
in every reply. Review the sweep sheet every pass and log anomalies BEFORE
claiming progress; one weird frame is a bug. PARTIAL over optimistic PASS —
if you would hedge, it is PARTIAL. If an item stays FAIL after 8 focused
attempts, mark it BLOCKED with a diagnosis and continue. If budget tightens,
priority: R4 > R5 > R2 > R7 > R6 > R1 > R3 > R8. Honest assessment per pass
in progress.html naming the worst remaining visual tell versus reference/.
