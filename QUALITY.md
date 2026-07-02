STARTUP SEQUENCE (execute in order before any other work):
1. Read this file in full, then SPEC.md, then progress.html, then the
   webgpu-threejs-tsl skill in full, then study every image in reference/
   and the technique in reference/webgl-water-study/ (see NOTICE.txt).
2. This is a quality pass on the existing ocean in this repo. The previous
   run's architecture decisions — CPU-worker FFT, single simulation tile,
   procedural caustics — are explicitly sanctioned for replacement per the
   Q-items below. Do not preserve them out of deference to existing code.
3. Re-establish that the headless screenshot harness still works (one
   captured frame of the current ocean, committed to shots/) BEFORE
   touching any simulation code.
4. Log the startup as the first progress.html entry, then begin with Q2.

QUALITY PASS — close the gap to reference/ (Water Pro v3 footage stills). Build on the existing repo; do not regress passing W-items (re-run the old shots as regression checks at the end).

Q1 GPU SIMULATION: move the FFT off the CPU worker onto the GPU via WebGL2 fragment-shader ping-pong (GPUComputationRenderer or hand-rolled), and implement 3 CASCADES at ~[250m, 60m, 12m] world scales, blended in the vertex/fragment stages. Evidence: high-altitude and near-surface shots showing detail at both scales with no tiling; storm preset showing plausible multi-meter significant wave height.
Q2 ADVECTED PERSISTENT FOAM: foam is a simulation, not a mask. Maintain a foam accumulation texture: inject where the Jacobian folds (crests), ADVECT it each frame by the surface horizontal displacement/flow, decay over ~4-8s, and shade it through a lacy breakup texture so it tears into filaments as it stretches. Evidence: a 4-frame time strip of one foam patch being born at a crest, stretched, and fading; side-by-side vs the reference foam.
Q3 WALLACE-TECHNIQUE CAUSTICS: replace procedural caustics with refracted-ray caustics per the technique in reference/webgl-water-study/renderer.js (causticsShader, ~line 228): render the displaced water grid into a caustic map, warping vertices to their refracted-ray seabed landing points, with intensity = oldArea/newArea via derivatives of the flat-refraction vs true-refraction positions. REIMPLEMENT in TSL from the algorithm — do not copy the GLSL (see NOTICE.txt). Ocean adaptations required: camera-local tiled caustic region; depth-dependent blur + absorption attenuation; no sphere shadow. Evidence: underwater still where bright caustic lines visibly correspond to the wave crests directly above (capture the surface and seabed in the same frame), plus a side-by-side vs the old procedural version and vs reference/ref_caustics.jpg.
Q4 CREST LIGHT TRANSPORT: subsurface scattering approximation on backlit wave peaks (thin, tall crests glow green-blue against the sun) + wave-displaced reflections (reflection lookup perturbed by surface normal). Evidence: into-the-sun shot with glowing crest rims.
Q5 SPRAY + ATMOSPHERE: GPU particle spray emitted at breaking crests in rough/storm presets; horizon aerial perspective matched to the reference stills' haze. Evidence: storm shot side-by-side vs reference storm frames.
Q6 EXPLORABLE DEMO: the default app gets a free-fly/orbit camera (drag look, WASD or drag-dolly, above and below the waterline) and a preset dropdown; document controls in README. Evidence: three shots of the SAME running session from user-chosen angles (high, wave-level, underwater).

CONDUCT: unchanged from SPEC.md (harness verification for every claim, honest assessments in progress.html, PARTIAL over optimistic PASS, 8-attempt BLOCKED rule). Priority order if budget tightens: Q2 > Q3 > Q1 > Q4 > Q6 > Q5 — foam structure is the #1 perceptual gap.