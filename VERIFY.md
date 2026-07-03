# VERIFY.md — adversarial verification contract

`verify.mjs` is the ONLY producer of claimable evidence. The agent may render
extra exploratory shots, but no R-item or gate may cite anything verify.mjs
did not produce. verify.mjs must be committed, deterministic in its camera
work, and runnable as:

    node verify.mjs [--backend webgpu|webgl] [--preset all|<name>] [--out shots/]

It serves the built app, drives headless Chromium (playwright-core; reuse
installed browsers under /opt or ~/.cache before downloading), waits for the
sim to reach t≥10s, captures via CDP Page.captureScreenshot, and writes:
  shots/pass-<n>-matrix.png   (contact sheet: M1–M10 × 3 presets, labeled)
  shots/pass-<n>-sweep.png    (24-frame free-roam sheet, labeled)
  shots/pass-<n>-gates.txt    (the gate table, plain text)
plus any per-gate crops it needs. Console errors are collected; any pageerror
fails the run outright.

## CAMERA MATRIX (identical every pass; positions hardcoded in verify.mjs)
M1  wave-level (h+2 m) looking toward sun
M2  wave-level looking away from sun
M3  grazing shot along the surface toward the horizon
M4  100 m altitude, 45° down
M5  400 m altitude, straight down
M6  waterline half-submerged (camera at mean sea level)
M7  underwater (−8 m) looking at the seabed WITH surface visible in frame
M8  underwater (−15 m) looking up at the surface
M9  underwater, caustic-region BOUNDARY centered in frame
M10 underwater, level gaze across the seabed toward its far field

## FREE-ROAM SWEEP
A scripted 25 s spiral: 300 m altitude → wave level → through the waterline →
along the floor → back up through the surface. 24 evenly spaced frames on one
labeled sheet. The agent must review every frame and log findings (or
"no anomalies") in progress.html each pass before claiming anything.

## NUMERIC GATES (verify.mjs computes; table printed and committed)
G1 FAR DETAIL      In M1: Laplacian variance of a far-band crop (upper third
                   of the water, below horizon) ≥ 25% of a near-band crop
                   (lower third). Per preset. Kills fade-to-silk.
G2 PRESET DISTANCE Mean pairwise RMS difference between the three presets at
                   M1 and at M4 ≥ 12% of full scale. Kills same-looking presets.
G3 NO VOID         Renderer clear color forced to magenta (#FF00FF) during
                   verification. Zero magenta pixels in every matrix shot.
                   Kills world edges, seabed edges, sky gaps, the abyss.
G4 PHYSICS ASSERTS Readbacks, not pixels: (a) min surface height − seabed top
                   > 2 m in storm; (b) every underwater light-shaft's geometry
                   intersects the floor plane AND its axis deviates < 10° from
                   the refracted sun vector; (c) storm Hs ≥ 4 m. Kills floating
                   props, cardboard sunbeams, flat seas.
G5 CAUSTIC INTEGRITY In M9: mean luminance step across the region boundary
                   < 8% (seamless); two frames 0.5 s apart show caustic
                   pattern displacement correlated with surface flow
                   (normalized cross-correlation peak offset ≠ 0 and aligned
                   within 25° of flow). Kills the square and static noise.
G6 FOLD SANITY     In storm at M1/M4: pixels within ΔE<10 of any flat interior
                   /churn constant < 0.3% of water pixels. Kills green discs.

## RULES
- Gates run every pass, on all three presets, before any claim.
- A gate that cannot be computed counts as FAIL, not SKIP.
- Changing thresholds requires a written justification in progress.html and
  is only permitted to make a gate STRICTER.
- If backend webgpu cannot render headless in this container, run gates on
  webgl and additionally capture ONE webgpu matrix via any available path;
  if impossible, log it as an explicit environment limitation each pass.
