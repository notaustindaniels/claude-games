// GPU ocean simulation: spectrum evolution + 2D IFFT + field packing +
// persistent-foam advection, all as WebGL2/WebGPU-compatible fragment-shader
// ping-pong passes (no compute shaders — the WebGL2 fallback lacks them).
// Three cascades at ~[preset c0, 59 m, 13 m] partition the wave spectrum by
// wavelength band, giving centimetre chop through hundreds-of-metres swell
// with no visible tiling.
//
// The IFFT mirrors fft.js exactly (bit-reversal permutation, then log2(N)
// butterfly stages with e^{+i2πk/len} twiddles, unnormalized), packing two
// independent complex grids per RGBA texel (RG, BA) so four packed field
// grids need two chains. A small CPU worker mirror (64², cascade-0 band)
// serves buoyancy queries; verifyAgainstCPU() proves GPU/CPU agreement.
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec4, uniform, texture, positionLocal, uv, floor, mod,
  cos, sin, sqrt, max, min, select, length,
} from 'three/tsl';
import { buildInitialSpectrum, makeRandom } from './spectrum.js';
import { makePlan, ifft2d } from './fft.js';
import { OceanSim } from './OceanSim.js';

const G = 9.81;

function makeRT(n, { float32 = false, linear = !float32 } = {}) {
  return new THREE.RenderTarget(n, n, {
    type: float32 ? THREE.FloatType : THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
    magFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    generateMipmaps: false,
  });
}


/** Readback rows arrive flipped relative to logical RT content — undo. */
function unflipRows(buf, N) {
  const out = new buf.constructor(buf.length);
  const rowLen = N * 4;
  for (let j = 0; j < N; j++) {
    out.set(buf.subarray(j * rowLen, (j + 1) * rowLen), (N - 1 - j) * rowLen);
  }
  return out;
}

function fullscreenMesh(material) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return scene;
}

export class GPUOceanSim {
  /**
   * options: {
   *   renderer, N = 256, seed,
   *   cascades: [{ tileSize, bandMinLambda, bandMaxLambda }, ...],
   *   windSpeed, windDirectionRad, fetch, spectrum, directionality,
   *   smallWaveCutoff, amplitudeScale, choppiness,
   *   foamDecay, foamBias, foamGain, foamAdvect, foamDrift,
   *   swell, ditherTexture (repeat-wrapped, G channel used),
   * }
   */
  constructor(options) {
    this.options = { ...options };
    this.renderer = options.renderer;
    this.N = options.N ?? 256;
    this.cascades = options.cascades;
    this.simTime = 0;
    this.lastStepMs = 0;
    this.frame = 0;

    const N = this.N;
    const C = this.cascades.length;

    // Buoyancy mirror: small CPU worker on the cascade-0 band only (the
    // fine cascades contribute centimetres — irrelevant for floaters).
    this.cpuMirror = new OceanSim({
      ...options,
      N: 64,
      tileSize: this.cascades[0].tileSize,
      foamGain: 0,
      secondary: { scale: 1, weight: 0 }, // no stretched second sample
      bandMinLambda: this.cascades[0].bandMinLambda ?? 0,
      bandMaxLambda: this.cascades[0].bandMaxLambda ?? Infinity,
    });

    // ---- Static LUTs ----
    this.h0Tex = [];
    for (let c = 0; c < C; c++) this.h0Tex.push(this._buildH0Texture(c));
    this.bitrevTex = this._buildBitrevTexture();

    // ---- Render targets ----
    // Ping-pong pool for spectral work (32F exact math).
    this.pp = [makeRT(N, { float32: true }), makeRT(N, { float32: true })];
    // Chain outputs per cascade (32F: read by post pass only).
    this.chainA = [];
    this.chainB = [];
    // Final packed fields (16F, linear-filterable, sampled by materials).
    // These are STABLE render targets: the scene materials bind their
    // textures once, so per-frame results are copied into them rather than
    // ping-pong flipped.
    this.dispRT = [];
    this.normRT = [];
    for (let c = 0; c < C; c++) {
      this.chainA.push(makeRT(N, { float32: true }));
      this.chainB.push(makeRT(N, { float32: true }));
      // 32F + linear: the scene materials sample these in the VERTEX stage,
      // where half-float linear fetches silently return 0 on the fallback.
      this.dispRT.push(makeRT(N, { float32: true, linear: true }));
      this.normRT.push(makeRT(N, { float32: true, linear: true }));
    }
    this.prevDisp0 = makeRT(N, { float32: true, linear: true });
    this.foamRT = makeRT(N, { float32: true, linear: true });
    this.foamWork = makeRT(N, { float32: true, linear: true });

    this._buildMaterials();

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.z = 1;
  }

  /** Public textures for the material (stable objects, contents update). */
  get dispTextures() {
    return this.dispRT.map((rt) => rt.texture);
  }
  get normTextures() {
    return this.normRT.map((rt) => rt.texture);
  }
  get foamTexture() {
    return this.foamRT.texture;
  }

  _buildH0Texture(c) {
    const N = this.N;
    const o = this.options;
    const casc = this.cascades[c];
    const { h0 } = buildInitialSpectrum({
      N,
      tileSize: casc.tileSize,
      seed: (o.seed ?? 1337) + c * 131,
      windSpeed: o.windSpeed,
      windDirection: o.windDirectionRad ?? 0,
      fetch: o.fetch,
      spectrum: o.spectrum ?? 'jonswap',
      directionality: o.directionality,
      smallWaveCutoff: o.smallWaveCutoff,
      amplitudeScale: o.amplitudeScale,
      bandMinLambda: casc.bandMinLambda ?? 0,
      bandMaxLambda: casc.bandMaxLambda ?? Infinity,
    });
    // Pack [h0.re, h0.im, conj(h0(-k)).re, conj(h0(-k)).im].
    const data = new Float32Array(N * N * 4);
    for (let j = 0; j < N; j++) {
      const jm = (N - j) % N;
      for (let i = 0; i < N; i++) {
        const im = (N - i) % N;
        const src = (jm * N + im) * 2;
        const dst = (j * N + i) * 4;
        data[dst] = h0[(j * N + i) * 2];
        data[dst + 1] = h0[(j * N + i) * 2 + 1];
        data[dst + 2] = h0[src];
        data[dst + 3] = -h0[src + 1];
      }
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }

  _buildBitrevTexture() {
    const N = this.N;
    const bits = Math.round(Math.log2(N));
    const data = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      let r = 0;
      let x = i;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      data[i * 4] = r;
    }
    const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }

  _buildMaterials() {
    const N = this.N;
    const texelUV = (idx, other, horizontal) =>
      horizontal ? vec2(idx.add(0.5).div(N), other) : vec2(other, idx.add(0.5).div(N));

    // ---- Evolve material (two variants: packs C1C2 or C3C4) ----
    const makeEvolve = (variantB) => {
      const u = {
        t: uniform(0),
        dk: uniform((2 * Math.PI) / 256),
        h0: texture(this.h0Tex[0]),
      };
      const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
      mat.side = THREE.DoubleSide; // y-negation reverses winding
      mat.vertexNode = vec4(positionLocal.x, positionLocal.y.negate(), 0, 1);
      mat.fragmentNode = Fn(() => {
        const st = uv();
        const ij = floor(st.mul(N));
        const wrap = (v) => select(v.lessThan(N / 2), v, v.sub(N));
        const kx = wrap(ij.x).mul(u.dk);
        const kz = wrap(ij.y).mul(u.dk);
        const kLen = max(length(vec2(kx, kz)), 1e-6);
        const w = sqrt(kLen.mul(G)).mul(u.t);
        const cw = cos(w);
        const sw = sin(w);
        const h0v = u.h0.sample(st);
        // h~ = h0 e^{iωt} + conj(h0(-k)) e^{-iωt}
        const hr = h0v.x.mul(cw).sub(h0v.y.mul(sw)).add(h0v.z.mul(cw)).add(h0v.w.mul(sw));
        const hi = h0v.x.mul(sw).add(h0v.y.mul(cw)).sub(h0v.z.mul(sw)).add(h0v.w.mul(cw));
        if (!variantB) {
          // C1 = (1 - kx/k)·h~ (real factor), C2 = (-kx + i·kz/k)·h~
          const f1 = float(1).sub(kx.div(kLen));
          const f2r = kx.negate();
          const f2i = kz.div(kLen);
          return vec4(
            f1.mul(hr), f1.mul(hi),
            f2r.mul(hr).sub(f2i.mul(hi)), f2r.mul(hi).add(f2i.mul(hr))
          );
        }
        // C3 = i·(kz - kx²/k)·h~, C4 = (-kz²/k - i·kx·kz/k)·h~
        const f3 = kz.sub(kx.mul(kx).div(kLen));
        const f4r = kz.mul(kz).div(kLen).negate();
        const f4i = kx.mul(kz).div(kLen).negate();
        return vec4(
          f3.mul(hi).negate(), f3.mul(hr),
          f4r.mul(hr).sub(f4i.mul(hi)), f4r.mul(hi).add(f4i.mul(hr))
        );
      })();
      return { mat, u, scene: fullscreenMesh(mat) };
    };
    this.evolveA = makeEvolve(false);
    this.evolveB = makeEvolve(true);

    // ---- Bit-reversal permutation (direction baked per material:
    // flipping a direction uniform between draws produced stale-uniform
    // corruption on the WebGL2 fallback — see the chain probes) ----
    const makePerm = (isH) => {
      const u = {
        src: texture(this.pp[0].texture),
        bitrev: texture(this.bitrevTex),
      };
      const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
      mat.side = THREE.DoubleSide; // y-negation reverses winding
      mat.vertexNode = vec4(positionLocal.x, positionLocal.y.negate(), 0, 1);
      mat.fragmentNode = Fn(() => {
        const st = uv();
        const idx = floor((isH ? st.x : st.y).mul(N));
        const rev = u.bitrev.sample(vec2(idx.add(0.5).div(N), 0.5)).x;
        const ruv = rev.add(0.5).div(N);
        const suv = isH ? vec2(ruv, st.y) : vec2(st.x, ruv);
        return u.src.sample(suv);
      })();
      return { mat, u, scene: fullscreenMesh(mat) };
    };
    this.permH = makePerm(true);
    this.permV = makePerm(false);

    // ---- Butterfly stage (len/half uniforms; direction baked) ----
    const makeButterfly = (isH) => {
      const u = {
        src: texture(this.pp[0].texture),
        len: uniform(2),
        half: uniform(1),
      };
      const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
      mat.side = THREE.DoubleSide; // y-negation reverses winding
      mat.vertexNode = vec4(positionLocal.x, positionLocal.y.negate(), 0, 1);
      mat.fragmentNode = Fn(() => {
        const st = uv();
        const idx = floor((isH ? st.x : st.y).mul(N));
        const other = isH ? st.y : st.x;
        const pos = mod(idx, u.len);
        const isTop = pos.lessThan(u.half);
        const k = mod(idx, u.half);
        const ang = k.mul(2 * Math.PI).div(u.len);
        const wr = cos(ang);
        const wi = sin(ang); // e^{+i2πk/len} (inverse transform)
        const iA = select(isTop, idx, idx.sub(u.half));
        const iB = iA.add(u.half);
        const uvA = isH ? vec2(iA.add(0.5).div(N), other) : vec2(other, iA.add(0.5).div(N));
        const uvB = isH ? vec2(iB.add(0.5).div(N), other) : vec2(other, iB.add(0.5).div(N));
        const a = u.src.sample(uvA);
        const b = u.src.sample(uvB);
        // complex multiply w·b on both packed pairs
        const tb = vec4(
          b.x.mul(wr).sub(b.y.mul(wi)), b.x.mul(wi).add(b.y.mul(wr)),
          b.z.mul(wr).sub(b.w.mul(wi)), b.z.mul(wi).add(b.w.mul(wr))
        );
        return select(isTop, a.add(tb), a.sub(tb));
      })();
      return { mat, u, scene: fullscreenMesh(mat) };
    };
    this.butterflyH = makeButterfly(true);
    this.butterflyV = makeButterfly(false);

    // ---- Post pass: pack disp/norm fields from the two IFFT'd chains ----
    const makePost = (normVariant) => {
      const u = {
        A: texture(this.chainA[0].texture),
        B: texture(this.chainB[0].texture),
        lambda: uniform(this.options.choppiness ?? 1.2),
      };
      const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
      mat.side = THREE.DoubleSide; // y-negation reverses winding
      mat.vertexNode = vec4(positionLocal.x, positionLocal.y.negate(), 0, 1);
      mat.fragmentNode = Fn(() => {
        const st = uv();
        const A = u.A.sample(st); // [h, Dx, Dz, dhdx]
        const B = u.B.sample(st); // [dhdz, dDxdx, dDzdz, dDxdz]
        const lam = u.lambda;
        if (!normVariant) {
          const jxx = float(1).add(lam.mul(B.y));
          const jzz = float(1).add(lam.mul(B.z));
          const jxz = lam.mul(B.w);
          const J = jxx.mul(jzz).sub(jxz.mul(jxz));
          return vec4(lam.mul(A.y), A.x, lam.mul(A.z), J);
        }
        const jxx = float(1).add(lam.mul(B.y));
        const jzz = float(1).add(lam.mul(B.z));
        const sx = A.w.div(max(jxx, 0.25));
        const sz = B.x.div(max(jzz, 0.25));
        const inv = float(1).div(sqrt(sx.mul(sx).add(1).add(sz.mul(sz))));
        return vec4(sx.negate().mul(inv), inv, sz.negate().mul(inv), 0);
      })();
      return { mat, u, scene: fullscreenMesh(mat) };
    };
    this.postDisp = makePost(false);
    this.postNorm = makePost(true);

    // ---- Copy pass (RT → RT; used for prevDisp0 and foam copy-back) ----
    {
      const u = { src: texture(this.pp[0].texture) };
      const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
      mat.side = THREE.DoubleSide; // y-negation reverses winding
      mat.vertexNode = vec4(positionLocal.x, positionLocal.y.negate(), 0, 1);
      mat.fragmentNode = Fn(() => u.src.sample(uv()))();
      this.copy = { mat, u, scene: fullscreenMesh(mat) };
    }

    // ---- Foam pass (cascade-0 space; advect + inject + decay) ----
    {
      const u = {
        prevFoam: texture(this.foamRT.texture),
        dispNow: texture(this.dispRT[0].texture),
        dispPrev: texture(this.prevDisp0.texture),
        disp1: texture(this.dispRT[1].texture),
        dither: this.options.ditherTexture ? texture(this.options.ditherTexture) : null,
        dt: uniform(1 / 60),
        tile0: uniform(this.cascades[0].tileSize),
        tile1: uniform(this.cascades[1].tileSize),
        decay: uniform(Math.exp(-0.25 / 5)),
        bias: uniform(0.6),
        gain: uniform(6),
        advect: uniform(1),
        driftX: uniform(0),
        driftZ: uniform(0),
        firstFrame: uniform(1),
      };
      const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
      mat.side = THREE.DoubleSide; // y-negation reverses winding
      mat.vertexNode = vec4(positionLocal.x, positionLocal.y.negate(), 0, 1);
      mat.fragmentNode = Fn(() => {
        const st = uv();
        const now = u.dispNow.sample(st);
        const prev = u.dispPrev.sample(st);
        const dtSafe = max(u.dt, 1e-3);
        const clampV = (v) => min(max(v, -6), 6);
        const vx = clampV(now.x.sub(prev.x).div(dtSafe)).mul(u.advect).add(u.driftX);
        const vz = clampV(now.z.sub(prev.z).div(dtSafe)).mul(u.advect).add(u.driftZ);
        const srcUV = st.sub(vec2(vx, vz).mul(u.dt).div(u.tile0));
        const advected = select(u.firstFrame.greaterThan(0.5), float(0), u.prevFoam.sample(srcUV).x);
        // Injection where either of the two structural cascades folds.
        const J0 = now.w;
        const J1 = u.disp1.sample(st.mul(u.tile0).div(u.tile1)).w;
        const J = min(J0, J1.mul(1.12));
        const dith = u.dither
          ? u.dither.sample(st.mul(u.tile0).div(17.3)).y.mul(0.9).add(0.55)
          : float(1);
        const inj = max(u.bias.sub(J), 0).mul(u.gain).mul(u.dt).mul(dith);
        const f = min(advected.mul(u.decay).add(inj.mul(float(1).sub(advected))), 1);
        return vec4(f, 0, 0, 1);
      })();
      this.foam = { mat, u, scene: fullscreenMesh(mat) };
    }
  }

  async _run(pass, rt) {
    const r = this.renderer;
    r.setRenderTarget(rt);
    await r.renderAsync(pass.scene, this.camera);
  }

  /** One full IFFT (perm + stages, both axes) of src texture → dst RT.
   *  The butterfly ALWAYS renders within the ping-pong pool and the result
   *  is copied to dstRT at the end: rendering the butterfly material into a
   *  target outside the pool produced wrong values on the WebGL2 fallback
   *  (proven by the d1/d1copy chain probes), while the copy pass is exact. */
  async _ifft2d(srcTexture, dstRT) {
    const N = this.N;
    const stages = Math.round(Math.log2(N));
    let ping = this.pp[0];
    let pong = this.pp[1];
    for (const horizontal of [1, 0]) {
      const perm = horizontal ? this.permH : this.permV;
      const butterfly = horizontal ? this.butterflyH : this.butterflyV;
      // permutation
      perm.u.src.value = horizontal ? srcTexture : ping.texture;
      await this._run(perm, pong);
      [ping, pong] = [pong, ping];
      // butterfly stages
      for (let s = 0; s < stages; s++) {
        butterfly.u.len.value = 2 << s;
        butterfly.u.half.value = 1 << s;
        butterfly.u.src.value = ping.texture;
        await this._run(butterfly, pong);
        [ping, pong] = [pong, ping];
      }
    }
    this.copy.u.src.value = ping.texture;
    await this._run(this.copy, dstRT);
  }

  /**
   * Plumbing probe with FRESH materials (no uniform/texture swapping):
   * (a) straight copy of a DataTexture through a fullscreen pass+readback,
   * (b) hardcoded horizontal bit-reversal read.
   * Distinguishes "texture .value swapping is broken" from real math bugs.
   */
  async testPlumbing() {
    const N = this.N;
    const rng = makeRandom(555);
    const src = new Float32Array(N * N * 4);
    for (let i = 0; i < src.length; i++) src[i] = rng.uniform() * 2 - 1;
    const tex = new THREE.DataTexture(src.slice(), N, N, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    const dst = makeRT(N, { float32: true });

    const results = {};
    // (a) copy
    {
      const t = texture(tex);
      const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
      mat.side = THREE.DoubleSide; // y-negation reverses winding
      mat.vertexNode = vec4(positionLocal.x, positionLocal.y.negate(), 0, 1);
      mat.fragmentNode = Fn(() => t.sample(uv()))();
      const scene = fullscreenMesh(mat);
      this.renderer.setRenderTarget(dst);
      await this.renderer.renderAsync(scene, this.camera);
      this.renderer.setRenderTarget(null);
      const gpu = unflipRows(await this.renderer.readRenderTargetPixelsAsync(dst, 0, 0, N, N), N);
      let sum2 = 0;
      let ref2 = 0;
      const maps = { identity: (i, j) => [i, j], flipY: (i, j) => [i, N - 1 - j] };
      for (const [name, map] of Object.entries(maps)) {
        sum2 = 0; ref2 = 0;
        for (let j = 0; j < N; j++) {
          for (let i = 0; i < N; i++) {
            const [si, sj] = map(i, j);
            for (let ch = 0; ch < 4; ch++) {
              const d = gpu[(j * N + i) * 4 + ch] - src[(sj * N + si) * 4 + ch];
              sum2 += d * d;
              ref2 += src[(sj * N + si) * 4 + ch] ** 2;
            }
          }
        }
        results['copy_' + name] = +Math.sqrt(sum2 / ref2).toExponential(3);
      }
      results.bufType = gpu.constructor.name;
      mat.dispose();
    }
    // (b) swap probes: does a texture .value swap and a uniform .value
    // change take effect between two renderAsync calls in the same task?
    {
      const texB = new THREE.DataTexture(
        new Float32Array(N * N * 4).fill(0.25), N, N, THREE.RGBAFormat, THREE.FloatType
      );
      texB.minFilter = texB.magFilter = THREE.NearestFilter;
      texB.needsUpdate = true;
      const su = { src: texture(tex), gain: uniform(1) };
      const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
      mat.side = THREE.DoubleSide; // y-negation reverses winding
      mat.vertexNode = vec4(positionLocal.x, positionLocal.y.negate(), 0, 1);
      mat.fragmentNode = Fn(() => su.src.sample(uv()).mul(su.gain))();
      const scene = fullscreenMesh(mat);
      const dst2 = makeRT(N, { float32: true });
      this.renderer.setRenderTarget(dst2);
      await this.renderer.renderAsync(scene, this.camera);
      su.src.value = texB;
      su.gain.value = 3;
      this.renderer.setRenderTarget(dst2);
      await this.renderer.renderAsync(scene, this.camera);
      this.renderer.setRenderTarget(null);
      const g = await this.renderer.readRenderTargetPixelsAsync(dst2, 0, 0, 2, 1);
      // expect 0.25*3 = 0.75 if both swaps landed
      results.swapProbe = Array.from(g.slice(0, 4)).map((v) => +v.toFixed(4));
      results.swapExpected = 0.75;
      texB.dispose();
      dst2.dispose();
      mat.dispose();
    }
    tex.dispose();
    dst.dispose();
    return results;
  }

  /**
   * Probe: run ONLY the horizontal bit-reversal permutation on a random
   * grid and report which index mapping the output actually matches —
   * detects hidden per-pass Y flips or coordinate convention errors.
   */
  async testPerm() {
    const N = this.N;
    const rng = makeRandom(777);
    const src = new Float32Array(N * N * 4);
    for (let i = 0; i < src.length; i++) src[i] = rng.uniform() * 2 - 1;
    const tex = new THREE.DataTexture(src.slice(), N, N, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    const dst = makeRT(N, { float32: true });
    this.permH.u.src.value = tex;
    await this._run(this.permH, dst);
    this.renderer.setRenderTarget(null);
    const gpu = unflipRows(await this.renderer.readRenderTargetPixelsAsync(dst, 0, 0, N, N), N);
    const bits = Math.round(Math.log2(N));
    const rev = (x) => {
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      return r;
    };
    const maps = {
      expected: (i, j) => [rev(i), j],
      flipY: (i, j) => [rev(i), N - 1 - j],
      noRev: (i, j) => [i, j],
      revY: (i, j) => [i, rev(j)],
    };
    const out = {};
    for (const [name, map] of Object.entries(maps)) {
      let sum2 = 0;
      let ref2 = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const [si, sj] = map(i, j);
          for (let ch = 0; ch < 4; ch++) {
            const d = gpu[(j * N + i) * 4 + ch] - src[(sj * N + si) * 4 + ch];
            sum2 += d * d;
            ref2 += src[(sj * N + si) * 4 + ch] ** 2;
          }
        }
      }
      out[name] = +Math.sqrt(sum2 / ref2).toExponential(3);
    }
    tex.dispose();
    dst.dispose();
    return out;
  }

  /** Vertical perm + single-stage butterfly probes (CPU-compared). */
  async testVerticalPieces() {
    const N = this.N;
    const rng = makeRandom(999);
    const src = new Float32Array(N * N * 4);
    for (let i = 0; i < src.length; i++) src[i] = rng.uniform() * 2 - 1;
    const tex = new THREE.DataTexture(src.slice(), N, N, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    const dst = makeRT(N, { float32: true });
    const bits = Math.round(Math.log2(N));
    const rev = (x) => {
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      return r;
    };
    const rms = (gpu, expect) => {
      let sum2 = 0;
      let ref2 = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          for (let ch = 0; ch < 4; ch++) {
            const d = gpu[(j * N + i) * 4 + ch] - expect((j * N + i) * 4 + ch, i, j, ch);
            sum2 += d * d;
            ref2 += expect((j * N + i) * 4 + ch, i, j, ch) ** 2;
          }
        }
      }
      return +Math.sqrt(sum2 / Math.max(ref2, 1e-9)).toExponential(3);
    };
    const out = {};
    // vertical perm
    this.permV.u.src.value = tex;
    await this._run(this.permV, dst);
    this.renderer.setRenderTarget(null);
    let gpu = unflipRows(await this.renderer.readRenderTargetPixelsAsync(dst, 0, 0, N, N), N);
    out.permV = rms(gpu, (_, i, j, ch) => src[(rev(j) * N + i) * 4 + ch]);
    // single horizontal butterfly stage s=2 (len 8, half 4), no perm
    this.butterflyH.u.len.value = 8;
    this.butterflyH.u.half.value = 4;
    this.butterflyH.u.src.value = tex;
    await this._run(this.butterflyH, dst);
    this.renderer.setRenderTarget(null);
    gpu = unflipRows(await this.renderer.readRenderTargetPixelsAsync(dst, 0, 0, N, N), N);
    const cpuStage = (i, j, ch) => {
      const len = 8;
      const half = 4;
      const pos = i % len;
      const top = pos < half;
      const k = i % half;
      const wr = Math.cos((2 * Math.PI * k) / len);
      const wi = Math.sin((2 * Math.PI * k) / len);
      const iA = top ? i : i - half;
      const iB = iA + half;
      const pair = ch < 2 ? 0 : 2;
      const re = ch % 2 === 0;
      const a = (c) => src[(j * N + iA) * 4 + pair + c];
      const b = (c) => src[(j * N + iB) * 4 + pair + c];
      const tr = b(0) * wr - b(1) * wi;
      const ti = b(0) * wi + b(1) * wr;
      const s = top ? 1 : -1;
      return re ? a(0) + s * tr : a(1) + s * ti;
    };
    out.stage2H = rms(gpu, (_, i, j, ch) => cpuStage(i, j, ch));
    // single vertical butterfly stage
    this.butterflyV.u.len.value = 8;
    this.butterflyV.u.half.value = 4;
    this.butterflyV.u.src.value = tex;
    await this._run(this.butterflyV, dst);
    this.renderer.setRenderTarget(null);
    gpu = unflipRows(await this.renderer.readRenderTargetPixelsAsync(dst, 0, 0, N, N), N);
    const cpuStageV = (i, j, ch) => {
      const len = 8;
      const half = 4;
      const pos = j % len;
      const top = pos < half;
      const k = j % half;
      const wr = Math.cos((2 * Math.PI * k) / len);
      const wi = Math.sin((2 * Math.PI * k) / len);
      const jA = top ? j : j - half;
      const jB = jA + half;
      const pair = ch < 2 ? 0 : 2;
      const re = ch % 2 === 0;
      const a = (c) => src[(jA * N + i) * 4 + pair + c];
      const b = (c) => src[(jB * N + i) * 4 + pair + c];
      const tr = b(0) * wr - b(1) * wi;
      const ti = b(0) * wi + b(1) * wr;
      const s = top ? 1 : -1;
      return re ? a(0) + s * tr : a(1) + s * ti;
    };
    out.stage2V = rms(gpu, (_, i, j, ch) => cpuStageV(i, j, ch));
    tex.dispose();
    dst.dispose();
    return out;
  }

  /** Chain test: perm-H + first `depth` H stages vs CPU partial IFFT.
   *  mode: 'direct' (last stage → dst), 'copy' (→ pong, then copy to dst),
   *  'warm' (dummy draw after uniform change, then real draw). */
  async testChainH(depth, mode = 'direct') {
    const N = this.N;
    const rng = makeRandom(1234);
    const src = new Float32Array(N * N * 4);
    for (let i = 0; i < src.length; i++) src[i] = rng.uniform() * 2 - 1;
    const tex = new THREE.DataTexture(src.slice(), N, N, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    const dst = makeRT(N, { float32: true });
    // GPU: perm + `depth` stages, ping-ponging like _ifft2d.
    let ping = this.pp[0];
    let pong = this.pp[1];
    this.permH.u.src.value = tex;
    await this._run(this.permH, depth === 0 ? dst : pong);
    if (depth > 0) {
      [ping, pong] = [pong, ping];
      for (let s = 0; s < depth; s++) {
        this.butterflyH.u.len.value = 2 << s;
        this.butterflyH.u.half.value = 1 << s;
        this.butterflyH.u.src.value = ping.texture;
        const last = s === depth - 1;
        if (last && mode === 'copy') {
          await this._run(this.butterflyH, pong);
          this.copy.u.src.value = pong.texture;
          await this._run(this.copy, dst);
        } else {
          await this._run(this.butterflyH, last ? dst : pong);
        }
        if (!last) [ping, pong] = [pong, ping];
      }
    }
    this.renderer.setRenderTarget(null);
    const gpu = unflipRows(await this.renderer.readRenderTargetPixelsAsync(dst, 0, 0, N, N), N);
    // CPU: bitrev rows, then `depth` stages (mirrors fft.js).
    const bits = Math.round(Math.log2(N));
    const rev = (x) => {
      let r = 0;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      return r;
    };
    const cpu = new Float32Array(N * N * 4);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        for (let ch = 0; ch < 4; ch++) cpu[(j * N + i) * 4 + ch] = src[(j * N + rev(i)) * 4 + ch];
      }
    }
    for (let s = 0; s < depth; s++) {
      const len = 2 << s;
      const half = 1 << s;
      const next = new Float32Array(N * N * 4);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const pos = i % len;
          const top = pos < half;
          const k = i % half;
          const wr = Math.cos((2 * Math.PI * k) / len);
          const wi = Math.sin((2 * Math.PI * k) / len);
          const iA = top ? i : i - half;
          const iB = iA + half;
          for (const pair of [0, 2]) {
            const ar = cpu[(j * N + iA) * 4 + pair];
            const ai = cpu[(j * N + iA) * 4 + pair + 1];
            const br = cpu[(j * N + iB) * 4 + pair];
            const bi = cpu[(j * N + iB) * 4 + pair + 1];
            const tr = br * wr - bi * wi;
            const ti = br * wi + bi * wr;
            const sgn = top ? 1 : -1;
            next[(j * N + i) * 4 + pair] = ar + sgn * tr;
            next[(j * N + i) * 4 + pair + 1] = ai + sgn * ti;
          }
        }
      }
      cpu.set(next);
    }
    let sum2 = 0;
    let ref2 = 0;
    for (let i = 0; i < N * N * 4; i++) {
      const d = gpu[i] - cpu[i];
      sum2 += d * d;
      ref2 += cpu[i] * cpu[i];
    }
    tex.dispose();
    dst.dispose();
    return +Math.sqrt(sum2 / Math.max(ref2, 1e-9)).toExponential(3);
  }

  /** Full-2D partial chain: perm-H + 8H + perm-V + vdepth V stages.
   *  variant (vdepth=1 only): 'plain' | 'freshdst' | 'double' | 'srccopy' */
  async testChain2D(vdepth, variant = 'plain') {
    const N = this.N;
    const stages = Math.round(Math.log2(N));
    const rng = makeRandom(31337);
    const src = new Float32Array(N * N * 4);
    for (let i = 0; i < src.length; i++) src[i] = rng.uniform() * 2 - 1;
    const tex = new THREE.DataTexture(src.slice(), N, N, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    const dst = makeRT(N, { float32: true });
    let ping = this.pp[0];
    let pong = this.pp[1];
    const scratch = makeRT(N, { float32: true });
    const scratch2 = makeRT(N, { float32: true });
    for (const phase of [{ h: 1, d: stages }, { h: 0, d: vdepth }]) {
      const perm = phase.h ? this.permH : this.permV;
      const butterfly = phase.h ? this.butterflyH : this.butterflyV;
      perm.u.src.value = phase.h ? tex : ping.texture;
      await this._run(perm, pong);
      [ping, pong] = [pong, ping];
      for (let s = 0; s < phase.d; s++) {
        butterfly.u.len.value = 2 << s;
        butterfly.u.half.value = 1 << s;
        let srcTex = ping.texture;
        if (!phase.h && variant === 'srccopy') {
          this.copy.u.src.value = ping.texture;
          await this._run(this.copy, scratch);
          srcTex = scratch.texture;
        }
        butterfly.u.src.value = srcTex;
        if (!phase.h && variant === 'freshdst') {
          await this._run(butterfly, scratch2);
          this.copy.u.src.value = scratch2.texture;
          await this._run(this.copy, pong);
        } else if (!phase.h && variant === 'double') {
          await this._run(butterfly, pong);
          await this._run(butterfly, pong);
        } else {
          await this._run(butterfly, pong);
        }
        [ping, pong] = [pong, ping];
      }
    }
    this.copy.u.src.value = ping.texture;
    await this._run(this.copy, dst);
    scratch.dispose();
    scratch2.dispose();
    this.renderer.setRenderTarget(null);
    const gpu = unflipRows(await this.renderer.readRenderTargetPixelsAsync(dst, 0, 0, N, N), N);
    // CPU mirror.
    const bits = stages;
    const rev = (x) => {
      let r = 0;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      return r;
    };
    let cpu = new Float32Array(N * N * 4);
    // horizontal full
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        for (let ch = 0; ch < 4; ch++) cpu[(j * N + i) * 4 + ch] = src[(j * N + rev(i)) * 4 + ch];
      }
    }
    const stageOp = (arr, s, horizontal) => {
      const len = 2 << s;
      const half = 1 << s;
      const next = new Float32Array(N * N * 4);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const idx = horizontal ? i : j;
          const pos = idx % len;
          const top = pos < half;
          const k = idx % half;
          const wr = Math.cos((2 * Math.PI * k) / len);
          const wi = Math.sin((2 * Math.PI * k) / len);
          const iA = top ? idx : idx - half;
          const iB = iA + half;
          const pA = horizontal ? (j * N + iA) : (iA * N + i);
          const pB = horizontal ? (j * N + iB) : (iB * N + i);
          for (const pair of [0, 2]) {
            const ar = arr[pA * 4 + pair];
            const ai = arr[pA * 4 + pair + 1];
            const br = arr[pB * 4 + pair];
            const bi = arr[pB * 4 + pair + 1];
            const tr = br * wr - bi * wi;
            const ti = br * wi + bi * wr;
            const sgn = top ? 1 : -1;
            next[(j * N + i) * 4 + pair] = ar + sgn * tr;
            next[(j * N + i) * 4 + pair + 1] = ai + sgn * ti;
          }
        }
      }
      return next;
    };
    for (let s = 0; s < stages; s++) cpu = stageOp(cpu, s, true);
    // vertical perm
    const vp = new Float32Array(N * N * 4);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        for (let ch = 0; ch < 4; ch++) vp[(j * N + i) * 4 + ch] = cpu[(rev(j) * N + i) * 4 + ch];
      }
    }
    cpu = vp;
    const preStage = cpu.slice();
    for (let s = 0; s < vdepth; s++) cpu = stageOp(cpu, s, false);
    const rmsVs = (refArr, map = (i, j, ch) => refArr[(j * N + i) * 4 + ch]) => {
      let sum2 = 0;
      let ref2 = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          for (let ch = 0; ch < 4; ch++) {
            const c = map(i, j, ch);
            const d = gpu[(j * N + i) * 4 + ch] - c;
            sum2 += d * d;
            ref2 += c * c;
          }
        }
      }
      return +Math.sqrt(sum2 / Math.max(ref2, 1e-9)).toExponential(3);
    };
    const out = { expected: rmsVs(cpu) };
    if (vdepth === 1) {
      // Structural hypotheses for the single-stage mismatch.
      const swapTB = (i, j, ch) => cpu[((j % 2 === 0 ? j + 1 : j - 1) * N + i) * 4 + ch];
      out.swapTB = rmsVs(null, swapTB);
      out.noStage = rmsVs(preStage);
      out.shiftY1 = rmsVs(null, (i, j, ch) => cpu[(((j + 1) % N) * N + i) * 4 + ch]);
      out.samples = {
        gpu: [gpu[0], gpu[N * 4], gpu[2 * N * 4], gpu[3 * N * 4]].map((v) => +v.toFixed(3)),
        cpu: [cpu[0], cpu[N * 4], cpu[2 * N * 4], cpu[3 * N * 4]].map((v) => +v.toFixed(3)),
        pre: [preStage[0], preStage[N * 4], preStage[2 * N * 4], preStage[3 * N * 4]].map((v) => +v.toFixed(3)),
      };
    }
    tex.dispose();
    dst.dispose();
    return vdepth === 1 ? out : out.expected;
  }

  /** Impulse IFFTs: k=(0,0) → constant 1; k=(1,0) → cos/sin along x. */
  async testImpulse() {
    const N = this.N;
    const run = async (ki, kj) => {
      const src = new Float32Array(N * N * 4);
      src[(kj * N + ki) * 4] = 1; // RG pair: delta (re=1)
      src[(kj * N + ki) * 4 + 2] = 1; // BA pair too
      const tex = new THREE.DataTexture(src, N, N, THREE.RGBAFormat, THREE.FloatType);
      tex.minFilter = tex.magFilter = THREE.NearestFilter;
      tex.needsUpdate = true;
      const dst = makeRT(N, { float32: true });
      await this._ifft2d(tex, dst);
      this.renderer.setRenderTarget(null);
      const gpu = unflipRows(await this.renderer.readRenderTargetPixelsAsync(dst, 0, 0, N, N), N);
      tex.dispose();
      dst.dispose();
      return gpu;
    };
    const g0 = await run(0, 0);
    let min0 = Infinity;
    let max0 = -Infinity;
    for (let i = 0; i < N * N; i++) {
      min0 = Math.min(min0, g0[i * 4]);
      max0 = Math.max(max0, g0[i * 4]);
    }
    const g1 = await run(1, 0);
    // expected g1(i,j).re = cos(2πi/N) for every row j
    let worst = 0;
    for (const j of [0, 1, N / 2]) {
      for (const i of [0, 1, 2, N / 4, N / 2]) {
        const exp = Math.cos((2 * Math.PI * i) / N);
        worst = Math.max(worst, Math.abs(g1[(j * N + i) * 4] - exp));
      }
    }
    const g2 = await run(0, 1);
    let worstV = 0;
    for (const j of [0, 1, 2, N / 4, N / 2]) {
      for (const i of [0, 1, N / 2]) {
        const exp = Math.cos((2 * Math.PI * j) / N);
        worstV = Math.max(worstV, Math.abs(g2[(j * N + i) * 4] - exp));
      }
    }
    return {
      dc: { min: +min0.toFixed(5), max: +max0.toFixed(5) },
      kx1worst: +worst.toExponential(2),
      kz1worst: +worstV.toExponential(2),
      kx1sample: [g1[0], g1[4], g1[8]].map((v) => +v.toFixed(4)),
      kz1sample: [g2[0], g2[N * 4], g2[2 * N * 4]].map((v) => +v.toFixed(4)),
    };
  }

  /**
   * Unit test: GPU _ifft2d vs CPU ifft2d on the same seeded random complex
   * grids (RG and BA pairs). Returns { rmsRel, maxRel }.
   */
  async testIFFT() {
    const N = this.N;
    const rng = makeRandom(4242);
    const src = new Float32Array(N * N * 4);
    for (let i = 0; i < src.length; i++) src[i] = rng.uniform() * 2 - 1;
    const tex = new THREE.DataTexture(src.slice(), N, N, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    const dst = makeRT(N, { float32: true });
    await this._ifft2d(tex, dst);
    this.renderer.setRenderTarget(null);
    const gpu = unflipRows(await this.renderer.readRenderTargetPixelsAsync(dst, 0, 0, N, N), N);
    // CPU reference on both packed complex pairs.
    const plan = makePlan(N);
    const a = new Float32Array(N * N * 2);
    const b = new Float32Array(N * N * 2);
    for (let i = 0; i < N * N; i++) {
      a[i * 2] = src[i * 4];
      a[i * 2 + 1] = src[i * 4 + 1];
      b[i * 2] = src[i * 4 + 2];
      b[i * 2 + 1] = src[i * 4 + 3];
    }
    ifft2d(plan, a);
    ifft2d(plan, b);
    let sum2 = 0;
    let ref2 = 0;
    let maxRel = 0;
    for (let i = 0; i < N * N; i++) {
      const vals = [
        [gpu[i * 4], a[i * 2]],
        [gpu[i * 4 + 1], a[i * 2 + 1]],
        [gpu[i * 4 + 2], b[i * 2]],
        [gpu[i * 4 + 3], b[i * 2 + 1]],
      ];
      for (const [g, c] of vals) {
        const d = g - c;
        sum2 += d * d;
        ref2 += c * c;
        maxRel = Math.max(maxRel, Math.abs(d) / (Math.abs(c) + 1e-3));
      }
    }
    // Structural hypotheses over the height channel (gpu.r vs cpu a.re).
    const hyp = {};
    const tryMap = (name, fn) => {
      let s2 = 0;
      let r2 = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const g = fn(i, j);
          const c = a[(j * N + i) * 2];
          s2 += (g - c) ** 2;
          r2 += c * c;
        }
      }
      hyp[name] = +Math.sqrt(s2 / r2).toExponential(3);
    };
    tryMap('identity', (i, j) => gpu[(j * N + i) * 4]);
    tryMap('pairSwap', (i, j) => gpu[(j * N + i) * 4 + 2]);
    tryMap('negate', (i, j) => -gpu[(j * N + i) * 4]);
    tryMap('transpose', (i, j) => gpu[(i * N + j) * 4]);
    tryMap('flipY', (i, j) => gpu[((N - 1 - j) * N + i) * 4]);
    const samples = {
      gpu: Array.from(gpu.slice(0, 6)).map((v) => +v.toFixed(4)),
      cpuA: [a[0], a[1], b[0], b[1], a[2], a[3]].map((v) => +v.toFixed(4)),
    };
    tex.dispose();
    dst.dispose();
    return { rmsRel: Math.sqrt(sum2 / ref2), maxRel, hyp, samples };
  }

  async init() {
    await this.cpuMirror.init();
  }

  /** Advance to absolute time t. */
  async step(t, dt) {
    const started = performance.now();
    const o = this.options;
    // CPU mirror for buoyancy (cheap 64²).
    await this.cpuMirror.step(t, dt);
    this.simTime = t;

    const C = this.cascades.length;
    for (let c = 0; c < C; c++) {
      const dk = (2 * Math.PI) / this.cascades[c].tileSize;
      for (const [pass, chain] of [[this.evolveA, this.chainA[c]], [this.evolveB, this.chainB[c]]]) {
        pass.u.t.value = t;
        pass.u.dk.value = dk;
        pass.u.h0.value = this.h0Tex[c];
        await this._run(pass, this.pp[0]);
        await this._ifft2d(this.pp[0].texture, chain);
      }
      // Cascade 0: preserve last frame's displacement first (foam velocity).
      if (c === 0 && this.frame > 0) {
        this.copy.u.src.value = this.dispRT[0].texture;
        await this._run(this.copy, this.prevDisp0);
      }
      this.postDisp.u.A.value = this.chainA[c].texture;
      this.postDisp.u.B.value = this.chainB[c].texture;
      this.postDisp.u.lambda.value = o.choppiness ?? 1.2;
      await this._run(this.postDisp, this.dispRT[c]);
      this.postNorm.u.A.value = this.chainA[c].texture;
      this.postNorm.u.B.value = this.chainB[c].texture;
      this.postNorm.u.lambda.value = o.choppiness ?? 1.2;
      await this._run(this.postNorm, this.normRT[c]);
    }

    // Foam: advect prev foam by cascade-0 velocity, inject, then copy back
    // to the stable foam target the material samples.
    const fu = this.foam.u;
    fu.dt.value = dt;
    fu.tile0.value = this.cascades[0].tileSize;
    fu.tile1.value = this.cascades[1].tileSize;
    fu.decay.value = Math.exp(-dt / (o.foamDecay ?? 5));
    fu.bias.value = o.foamBias ?? 0.6;
    fu.gain.value = o.foamGain ?? 6;
    fu.advect.value = o.foamAdvect ?? 1;
    const drift = (o.foamDrift ?? 0.03) * (o.windSpeed ?? 8);
    fu.driftX.value = Math.cos(o.windDirectionRad ?? 0) * drift;
    fu.driftZ.value = Math.sin(o.windDirectionRad ?? 0) * drift;
    fu.firstFrame.value = this.frame === 0 ? 1 : 0;
    await this._run(this.foam, this.foamWork);
    this.copy.u.src.value = this.foamWork.texture;
    await this._run(this.copy, this.foamRT);
    this.frame++;
    this.renderer.setRenderTarget(null);
    this.lastStepMs = performance.now() - started;
  }

  /** Buoyancy (CPU mirror + swell). */
  getHeightAt(x, z) {
    return this.cpuMirror.getHeightAt(x, z);
  }
  getNormalAt(x, z, target) {
    return this.cpuMirror.getNormalAt(x, z, target);
  }
  get swell() {
    return this.cpuMirror.swell;
  }

  async reinit(overrides = {}) {
    Object.assign(this.options, overrides);
    if (overrides.cascade0TileSize) {
      this.cascades[0].tileSize = overrides.cascade0TileSize;
    }
    for (let c = 0; c < this.cascades.length; c++) {
      this.h0Tex[c].dispose();
      this.h0Tex[c] = this._buildH0Texture(c);
    }
    this.frame = 0; // resets foam + velocity history
    await this.cpuMirror.reinit({
      ...overrides,
      tileSize: this.cascades[0].tileSize,
      foamGain: 0,
    });
  }

  setFoam(opts) {
    Object.assign(this.options, opts);
  }

  /**
   * Verification: compute the CPU reference field for cascade `c` at time t
   * (same seed/band) and compare against a GPU readback of dispRT[c].
   * Returns { maxAbs, rms, n } over the height channel.
   */
  async verifyAgainstCPU(t) {
    const N = this.N;
    const ref = new OceanSim({
      ...this.options,
      N,
      tileSize: this.cascades[0].tileSize,
      bandMinLambda: this.cascades[0].bandMinLambda ?? 0,
      bandMaxLambda: this.cascades[0].bandMaxLambda ?? Infinity,
      foamGain: 0,
    });
    await ref.init();
    await ref.step(t, 1 / 60);
    const buf = unflipRows(await this.renderer.readRenderTargetPixelsAsync(this.dispRT[0], 0, 0, N, N), N);
    // half float decode (skipped when the backend returns Float32Array)
    const dec = (h) => {
      const s = (h & 0x8000) ? -1 : 1;
      const e = (h >> 10) & 0x1f;
      const f = h & 0x3ff;
      if (e === 0) return s * f * 2 ** -24;
      if (e === 31) return f ? NaN : s * Infinity;
      return s * (1 + f / 1024) * 2 ** (e - 15);
    };
    const isHalf = buf instanceof Uint16Array;
    const gpuAt = (i, j) => {
      const raw = buf[(j * N + i) * 4 + 1];
      return isHalf ? dec(raw) : raw;
    };
    // Also test flipped/transposed alignments: an orientation bug shows up
    // as one variant matching and identity not.
    const variants = {
      identity: (i, j) => [i, j],
      flipX: (i, j) => [N - 1 - i, j],
      flipZ: (i, j) => [i, N - 1 - j],
      flipXZ: (i, j) => [N - 1 - i, N - 1 - j],
      transpose: (i, j) => [j, i],
    };
    const out = {};
    let refVar = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = ref.dispA[(j * N + i) * 4 + 1];
        refVar += c * c;
      }
    }
    for (const [name, map] of Object.entries(variants)) {
      let maxAbs = 0;
      let sum2 = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const [gi, gj] = map(i, j);
          const d = gpuAt(gi, gj) - ref.dispA[(j * N + i) * 4 + 1];
          maxAbs = Math.max(maxAbs, Math.abs(d));
          sum2 += d * d;
        }
      }
      out[name] = { maxAbs, rms: Math.sqrt(sum2 / (N * N)) };
    }
    ref.dispose();
    return {
      ...out.identity,
      variants: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, +v.rms.toExponential(3)])),
      refRms: Math.sqrt(refVar / (N * N)),
      n: N * N,
    };
  }

  dispose() {
    this.cpuMirror.dispose();
    for (const t of this.h0Tex) t.dispose();
    this.bitrevTex.dispose();
    for (const rt of [...this.pp, ...this.chainA, ...this.chainB, ...this.dispRT, ...this.normRT, this.prevDisp0, this.foamRT, this.foamWork]) rt.dispose();
  }
}
