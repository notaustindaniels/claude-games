# OpenOcean v2

FFT-cascade ocean for three.js WebGPURenderer (WebGPU-first, WebGL2 fallback),
written entirely in TSL. Three presets: `blackflag`, `storm`, `seaofthieves`.

**three is pinned to exactly `0.181.0`** (TSL/WebGPU API moves between minors).

## Quickstart

```js
// npm i three@0.181.0   — then:
import * as THREE from 'three/webgpu'
import { createOcean } from './src/ocean/index.js'

const renderer = new THREE.WebGPURenderer()          // add to DOM, size it
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 12000)
const ocean = createOcean(renderer, scene, camera, {})
await renderer.init()
await ocean.setPreset('blackflag')                   // or 'storm', 'seaofthieves'
renderer.setAnimationLoop(() => { ocean.update(1 / 60); ocean.render() })
```

## Demo

`npm install && npm run dev` — free-fly camera: drag to look, WASD to move
(Shift = fast), scroll to dolly, works above and below water. UI in the top
bar: preset / quality / backend. `?backend=webgl` forces the fallback.

## Verification

`node verify.mjs` — the adversarial harness from VERIFY.md: renders the
camera matrix M1–M10 × 3 presets and a 24-frame sweep headless, computes
gates G1–G6, and writes committed evidence to `shots/`. See `REBUILD.md`,
`VERIFY.md`, and `progress.html` for the full contract and build log.

Environment note: verification in this repo ran on the WebGL backend —
WebGPU is unavailable in this machine's headless (and headed) Chromium;
verify.mjs re-probes every pass and logs the limitation. The codebase is
WebGPU-first (TSL node materials + TSL compute for the JONSWAP spectrum);
the per-frame FFT runs as TSL RTT passes, identical on both backends.

## Structure

- `src/ocean/` — the library (`index.js` is the public API)
- `src/main.js` — demo app + `__oo` verification hooks
- `consumer-test/` — minimal second project consuming the public API
- `reference/` — target stills + the Wallace caustics study (see NOTICE)
- `ASSETS.md` — CC0 texture ledger (ambientCG Foam002/003)
