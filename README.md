# OpenOcean

A standalone FFT ocean rendering system for [three.js](https://threejs.org), built on the
WebGPU renderer + TSL node materials with an automatic WebGL2 fallback. Everything is
derived from published techniques — Tessendorf FFT spectra (JONSWAP / Phillips),
Gerstner swell, GGX/Fresnel water optics — with no proprietary code or paid assets.

**three.js version: pinned to `0.181.0`** (declared peer range `>=0.181.0`).

## Quickstart (14 lines)

```js
import * as THREE from 'three/webgpu';
import { createOcean } from 'openocean';

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 40000);
camera.position.set(0, 12, 0);
camera.lookAt(120, 0, -220);
const ocean = await createOcean({ scene, camera, renderer, preset: 'breeze' });
const clock = new THREE.Clock();
renderer.setAnimationLoop(async () => {
  await ocean.update(clock.getDelta());
  await renderer.renderAsync(scene, camera);
});
```

A complete consumer example lives in [`consumer-test/`](consumer-test/) — a fresh Vite
scaffold that installs this package as a dependency and renders the ocean with the code
above. If you install via a `file:` link, add `resolve: { dedupe: ['three'] }` to your
Vite config so the library shares your app's three.js instance (two copies break TSL).

## Explorable demo controls

`npm run dev` opens the default demo scene with a free-fly camera and a preset
dropdown (top-right). You can fly above and below the waterline — the underwater
mode (fog, caustics, Snell window) engages automatically.

| input           | action |
|-----------------|--------|
| drag (hold LMB) | look around |
| `W`/`A`/`S`/`D` | fly forward / left / back / right |
| `Q` / `E`       | descend / ascend |
| `Shift`         | 3× speed boost |
| mouse wheel     | adjust base speed |
| preset dropdown | switch environment preset live (rebuilds spectra, resets foam) |

Add `?controls=0` to the URL to disable both (the verification harness relies on
input-free determinism, which is unaffected because the camera only moves on input).

## `createOcean(options)` — full options table

| option        | type / values                                                        | default      | notes |
|---------------|----------------------------------------------------------------------|--------------|-------|
| `renderer`    | `THREE.WebGPURenderer`                                               | **required** | WebGPU backend or its WebGL2 fallback |
| `scene`       | `THREE.Scene`                                                        | **required** | surface, sky dome, overlay and shafts are added here |
| `camera`      | `THREE.Camera`                                                       | **required** | the grid follows this camera |
| `preset`      | `'glassy' 'calm' 'breeze' 'moderate' 'rough' 'storm' 'sunset'`       | `'moderate'` | see preset table |
| `quality`     | `'low' 'medium' 'high'`                                              | `'medium'`   | see quality tiers |
| `seed`        | `number`                                                             | `1337`       | deterministic: same seed + sim time ⇒ identical waves |
| `spectrum`    | `'jonswap' \| 'phillips'`                                            | `'jonswap'`  | wave energy spectrum |
| `sky`         | `boolean`                                                            | `true`       | built-in procedural sky dome |
| `reflections` | `boolean`                                                            | `true`       | planar reflections of scene objects (off on `low`) |
| `sunShafts`   | `boolean`                                                            | `true`       | underwater crepuscular light shafts |
| `seabed`      | `{ texture, bounds: [minX, minZ, sizeX, sizeZ], deepY } \| null`     | `null`       | heightfield for shallows/absorption/contact foam |
| `fftSize`     | `number` (power of two)                                              | tier value   | override the FFT resolution |
| `segments`    | `number`                                                             | tier value   | override surface grid density |
| `overrides`   | `{ sim, water, sky, swell, secondary }`                              | `{}`         | deep-merge over the chosen preset |

### Returned `ocean` object

| member | description |
|--------|-------------|
| `await ocean.update(dt, simTime?)` | advance the simulation; call once per frame (lockstep worker) |
| `ocean.getHeightAt(x, z)` | CPU water height matching the render — single-point buoyancy |
| `ocean.getNormalAt(x, z, target?)` | CPU water normal — multi-point buoyancy / pitch & roll |
| `await ocean.setPreset(name, overrides?)` | switch environment preset at runtime |
| `ocean.underwater` | `true` while the camera is submerged |
| `ocean.cameraSurfaceHeight` | water height under the camera this frame |
| `ocean.uniforms`, `ocean.material`, `ocean.surface`, `ocean.sim` | escape hatches for advanced use |
| `ocean.wrapUnderwaterFog(buildColorFn)` | wrap your own material colors in the underwater murk |
| `ocean.stats.simMs` | worker simulation cost of the last step |

## Presets

| preset     | wind (m/s) | character |
|------------|-----------:|-----------|
| `glassy`   | 1.6        | mirror-calm dawn water, barely a ripple |
| `calm`     | 4          | light airs, gentle long swell |
| `breeze`   | 7.5        | fresh breeze, scattered small whitecaps |
| `moderate` | 10.5       | moderate open sea, regular whitecaps |
| `rough`    | 15         | rough sea, streaky foam, heavy swell |
| `storm`    | 21         | storm-force sea, dense foam, spray-torn crests |
| `sunset`   | 5.5        | low golden sun over a settling evening sea |

## Quality tiers

| tier     | FFT    | grid segments | planar reflections | typical sim cost* |
|----------|--------|---------------|--------------------|-------------------|
| `low`    | 128²   | 128           | off (+ lite shader: no per-pixel noise/caustics) | ~6 ms |
| `medium` | 256²   | 224           | on (0.35× res)     | ~25 ms |
| `high`   | 512²   | 320           | on (0.5× res)      | ~150 ms |

*Worker thread cost per sim step measured under software rendering (SwiftShader);
GPU-accelerated machines are far faster. The renderer never blocks on the worker
beyond one lockstep await.

## Verification

Everything in this repo is verified headless: `node scripts/shoot.mjs jobs/<file>.json`
renders the demo scenario in headless Chromium (software GL) and captures PNGs;
`node scripts/determinism.mjs` proves two independent launches produce pixel-identical
frames (0.0000% diff); `node scripts/perf.mjs` measures the tier table;
`node scripts/consumer-smoke.mjs` builds and renders the consumer project with zero
console errors. See `progress.html` for the pass-by-pass evidence log.

## Known limitations

- **No float-texture mips on the WebGL2 fallback** — distance aliasing is controlled
  by an fwidth-based detail fade instead of true mip filtering, so very distant water
  converges to a smooth (slightly simplified) shading model.
- **Swell geometry fades with grid density** — each Gerstner wave fades out where the
  stretched grid can no longer sample it (~5 samples/wavelength); from very high
  altitude the far field is normal-mapped rather than displaced.
- **Planar reflection is a single flat mirror at y=0** — correct for the ocean plane,
  but tall waves do not distort reflection *positions* (only a slope-based UV warp).
- **Two pure-sine swells can read as slightly synthetic** in coherent glitter bands at
  long range from altitude; damped but not fully decorrelated.
- **Underwater god rays are billboards**, not volumetrics — convincing in stills and
  gentle motion, not a true participating-media solution.
- **The caustics are procedural Worley approximations**, not refracted-light caustics.
- **SwiftShader interactive rate requires the `low` tier** (~8 fps at 640×360 in the
  verification container); `medium`/`high` are meant for real GPUs.
