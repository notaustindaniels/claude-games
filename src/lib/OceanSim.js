// Main-thread side of the ocean simulation: owns the worker, the GPU
// textures, and CPU-side copies of the latest fields for buoyancy sampling.
import * as THREE from 'three/webgpu';
import { makeSwell, evalSwell } from './gerstner.js';

export class OceanSim {
  constructor(options) {
    this.options = { ...options };
    this.N = options.N;
    this.tileSize = options.tileSize;
    this.secondary = options.secondary ?? { scale: 3.17, weight: 0.45 };
    this.swell = makeSwell(options.swell ?? []);
    this.dispA = null; // Float32Array RGBA: [λDx, h, λDz, J]
    this.normB = null; // Float32Array RGBA: [nx, ny, nz, foam]
    this.simTime = 0;
    this.lastStepMs = 0;
    this._spare = null;
    this._pending = null;
    this._swellTmp = {};

    const N = this.N;
    this.dispTexture = new THREE.DataTexture(
      new Float32Array(N * N * 4), N, N, THREE.RGBAFormat, THREE.FloatType
    );
    this.normTexture = new THREE.DataTexture(
      new Float32Array(N * N * 4), N, N, THREE.RGBAFormat, THREE.FloatType
    );
    for (const tex of [this.dispTexture, this.normTexture]) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
    }

    this.worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this._readyResolvers = [];
    this._fieldResolvers = [];
  }

  init() {
    return this._postAndAwaitReady({ type: 'init', options: this._workerOptions() });
  }

  /** Re-seed / re-spectrum the sim (preset or wind change). Resets foam. */
  reinit(overrides = {}) {
    Object.assign(this.options, overrides);
    if (overrides.tileSize) this.tileSize = overrides.tileSize;
    if (overrides.swell) this.swell = makeSwell(overrides.swell);
    if (overrides.secondary) this.secondary = overrides.secondary;
    return this._postAndAwaitReady({ type: 'reinit', options: this._workerOptions() });
  }

  _workerOptions() {
    const o = this.options;
    return {
      N: this.N,
      tileSize: this.tileSize,
      seed: o.seed ?? 1337,
      windSpeed: o.windSpeed,
      windDirection: o.windDirectionRad ?? 0,
      fetch: o.fetch,
      spectrum: o.spectrum ?? 'jonswap',
      directionality: o.directionality,
      smallWaveCutoff: o.smallWaveCutoff,
      amplitudeScale: o.amplitudeScale,
      choppiness: o.choppiness,
      foamDecay: o.foamDecay,
      foamBias: o.foamBias,
      foamGain: o.foamGain,
      foamAdvect: o.foamAdvect,
      foamDrift: o.foamDrift,
    };
  }

  _postAndAwaitReady(msg) {
    return new Promise((resolve) => {
      this._readyResolvers.push(resolve);
      this.worker.postMessage(msg);
    });
  }

  _onMessage(msg) {
    if (msg.type === 'ready') {
      this._readyResolvers.shift()?.();
    } else if (msg.type === 'fields') {
      this._fieldResolvers.shift()?.(msg);
    }
  }

  /**
   * Advance the simulation to absolute time t (dt used for foam integration)
   * and upload the new fields. Lockstep: resolves when textures are updated.
   */
  async step(t, dt) {
    const started = performance.now();
    const recycled = this._spare;
    this._spare = null;
    const msg = await new Promise((resolve) => {
      this._fieldResolvers.push(resolve);
      this.worker.postMessage(
        { type: 'step', t, dt, recycled },
        recycled ? recycled.map((a) => a.buffer) : []
      );
    });
    // Recycle the previous front buffers on the next step.
    if (this.dispA) this._spare = [this.dispA, this.normB];
    this.dispA = msg.dispA;
    this.normB = msg.normB;
    this.simTime = t;
    this.dispTexture.image.data = this.dispA;
    this.normTexture.image.data = this.normB;
    this.dispTexture.needsUpdate = true;
    this.normTexture.needsUpdate = true;
    this.lastStepMs = performance.now() - started;
  }

  /** Change foam params live without resetting the foam field. */
  setFoam(options) {
    this.worker.postMessage({ type: 'setFoam', options });
  }

  /** Bilinear wrapped fetch of a texel component from an RGBA field. */
  _sample(arr, x, z, tile, channelBase, out3) {
    const N = this.N;
    let u = (x / tile) * N;
    let v = (z / tile) * N;
    u -= Math.floor(u / N) * N;
    v -= Math.floor(v / N) * N;
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const fu = u - i0;
    const fv = v - j0;
    const i1 = (i0 + 1) % N;
    const j1 = (j0 + 1) % N;
    const a = (j0 * N + i0) * 4 + channelBase;
    const b = (j0 * N + i1) * 4 + channelBase;
    const c = (j1 * N + i0) * 4 + channelBase;
    const d = (j1 * N + i1) * 4 + channelBase;
    const w00 = (1 - fu) * (1 - fv);
    const w10 = fu * (1 - fv);
    const w01 = (1 - fu) * fv;
    const w11 = fu * fv;
    out3[0] = arr[a] * w00 + arr[b] * w10 + arr[c] * w01 + arr[d] * w11;
    out3[1] = arr[a + 1] * w00 + arr[b + 1] * w10 + arr[c + 1] * w01 + arr[d + 1] * w11;
    out3[2] = arr[a + 2] * w00 + arr[b + 2] * w10 + arr[c + 2] * w01 + arr[d + 2] * w11;
    return out3;
  }

  /**
   * Combined displacement (FFT primary + FFT secondary scale + swell) at a
   * horizontal reference position. Mirrors the shader exactly.
   */
  sampleDisplacement(x, z, out = [0, 0, 0]) {
    if (!this.dispA) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    const t1 = this.tileSize;
    const sec = this.secondary;
    const tmp = this._tmp3 || (this._tmp3 = [0, 0, 0]);
    this._sample(this.dispA, x, z, t1, 0, tmp);
    let dx = tmp[0];
    let dy = tmp[1];
    let dz = tmp[2];
    const t2 = t1 * sec.scale;
    this._sample(this.dispA, x + t2 * 0.31, z + t2 * 0.71, t2, 0, tmp);
    dx += tmp[0] * sec.weight * sec.scale * 0.5;
    dy += tmp[1] * sec.weight * sec.scale * 0.5;
    dz += tmp[2] * sec.weight * sec.scale * 0.5;
    const sw = evalSwell(this.swell, x, z, this.simTime, this._swellTmp);
    out[0] = dx + sw.dx;
    out[1] = dy + sw.dy;
    out[2] = dz + sw.dz;
    return out;
  }

  /**
   * True surface height above the point (x, z): inverts the horizontal
   * displacement by fixed-point iteration, then returns displaced height.
   */
  getHeightAt(x, z, iterations = 3) {
    let px = x;
    let pz = z;
    const d = this._tmpH || (this._tmpH = [0, 0, 0]);
    for (let i = 0; i < iterations; i++) {
      this.sampleDisplacement(px, pz, d);
      px = x - d[0];
      pz = z - d[2];
    }
    this.sampleDisplacement(px, pz, d);
    return d[1];
  }

  /** Surface normal at (x, z) (approximate: sampled at the reference point). */
  getNormalAt(x, z, target = new THREE.Vector3()) {
    if (!this.normB) return target.set(0, 1, 0);
    const tmp = this._tmpN || (this._tmpN = [0, 0, 0]);
    const t1 = this.tileSize;
    const sec = this.secondary;
    this._sample(this.normB, x, z, t1, 0, tmp);
    let sx = -tmp[0] / Math.max(tmp[1], 0.2);
    let sz = -tmp[2] / Math.max(tmp[1], 0.2);
    const t2 = t1 * sec.scale;
    this._sample(this.normB, x + t2 * 0.31, z + t2 * 0.71, t2, 0, tmp);
    sx += (-tmp[0] / Math.max(tmp[1], 0.2)) * sec.weight;
    sz += (-tmp[2] / Math.max(tmp[1], 0.2)) * sec.weight;
    const sw = evalSwell(this.swell, x, z, this.simTime, this._swellTmp);
    sx += sw.sx;
    sz += sw.sz;
    return target.set(-sx, 1, -sz).normalize();
  }

  dispose() {
    this.worker.terminate();
    this.dispTexture.dispose();
    this.normTexture.dispose();
  }
}
