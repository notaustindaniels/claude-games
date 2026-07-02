// Ocean FFT simulation worker.
// Synthesizes the time-evolved wave field from the initial spectrum and
// returns two RGBA float grids per step:
//   dispA: [λ·Dx, height, λ·Dz, jacobian]
//   normB: [nx, ny, nz, persistentFoam]
// The foam channel is a real simulation: injected at Jacobian folds,
// advected semi-Lagrangian by the surface horizontal velocity (finite
// difference of the displacement field) plus a downwind drift, decaying
// over seconds.
import { makePlan, ifft2d } from './fft.js';
import { buildInitialSpectrum, makeRandom } from './spectrum.js';

let N = 0;
let plan = null;
let state = null;

/** Bilinear wrapped gather from a scalar N×N field. */
function sampleWrap(arr, u, v) {
  u -= Math.floor(u / N) * N;
  v -= Math.floor(v / N) * N;
  let i0 = Math.floor(u) % N;
  let j0 = Math.floor(v) % N;
  const fu = u - Math.floor(u);
  const fv = v - Math.floor(v);
  const i1 = (i0 + 1) % N;
  const j1 = (j0 + 1) % N;
  return (
    arr[j0 * N + i0] * (1 - fu) * (1 - fv) +
    arr[j0 * N + i1] * fu * (1 - fv) +
    arr[j1 * N + i0] * (1 - fu) * fv +
    arr[j1 * N + i1] * fu * fv
  );
}

function init(options) {
  N = options.N;
  plan = makePlan(N);
  const { h0, omega } = buildInitialSpectrum(options);

  // Precompute conj(h0(-k)) so the time evolution is a flat loop.
  const h0mConj = new Float32Array(2 * N * N);
  for (let j = 0; j < N; j++) {
    const jm = (N - j) % N;
    for (let i = 0; i < N; i++) {
      const im = (N - i) % N;
      const src = (jm * N + im) * 2;
      const dst = (j * N + i) * 2;
      h0mConj[dst] = h0[src];
      h0mConj[dst + 1] = -h0[src + 1];
    }
  }

  // Complex packing factors: each output grid is F(k)·h~(k,t) with
  //   C1 = h + i·Dx        → F1 = 1 − kx/k            (real)
  //   C2 = Dz + i·∂h/∂x    → F2 = −kx + i·kz/k
  //   C3 = ∂h/∂z + i·∂Dx/∂x → F3 = i·(kz − kx²/k)
  //   C4 = ∂Dz/∂z + i·∂Dx/∂z → F4 = −kz²/k − i·kx·kz/k
  // (Dx = i·kx/k·h etc.; A + iB collapses to one complex factor per grid.)
  const F = new Float32Array(8 * N * N);
  const dk = (2 * Math.PI) / options.tileSize;
  for (let j = 0; j < N; j++) {
    const kz = (j < N / 2 ? j : j - N) * dk;
    for (let i = 0; i < N; i++) {
      const kx = (i < N / 2 ? i : i - N) * dk;
      const k = Math.hypot(kx, kz) || 1;
      const o = (j * N + i) * 8;
      F[o + 0] = 1 - kx / k; // F1 re
      F[o + 1] = 0; //           F1 im
      F[o + 2] = -kx; //         F2 re
      F[o + 3] = kz / k; //      F2 im
      F[o + 4] = 0; //           F3 re
      F[o + 5] = kz - (kx * kx) / k; // F3 im
      F[o + 6] = -(kz * kz) / k; //     F4 re
      F[o + 7] = -(kx * kz) / k; //     F4 im
    }
  }

  // Static per-texel injection dither: whitecap events are patchy in
  // reality; uniform J-band injection reads as painted stripes.
  const rng = makeRandom((options.seed ?? 1337) ^ 0x5f0a);
  const dither = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) dither[i] = 0.55 + 0.9 * rng.uniform();

  state = {
    options,
    h0,
    h0mConj,
    omega,
    F,
    grids: [0, 1, 2, 3].map(() => new Float32Array(2 * N * N)),
    foam: new Float32Array(N * N),
    foamNext: new Float32Array(N * N),
    prevDx: new Float32Array(N * N),
    prevDz: new Float32Array(N * N),
    hasPrev: false,
    dither,
    pool: [],
  };
}

function step(t, dt, recycled) {
  const { h0, h0mConj, omega, F, grids, options } = state;
  const NN = N * N;
  const lambda = options.choppiness ?? 1.2;
  const [g1, g2, g3, g4] = grids;

  for (let idx = 0; idx < NN; idx++) {
    const w = omega[idx] * t;
    const c = Math.cos(w);
    const s = Math.sin(w);
    const i2 = idx * 2;
    // h~(k,t) = h0 e^{iωt} + conj(h0(-k)) e^{-iωt}
    const hr = h0[i2] * c - h0[i2 + 1] * s + h0mConj[i2] * c + h0mConj[i2 + 1] * s;
    const hi = h0[i2] * s + h0[i2 + 1] * c - h0mConj[i2] * s + h0mConj[i2 + 1] * c;
    const o = idx * 8;
    // C = F · h~ for each packed grid
    g1[i2] = F[o] * hr - F[o + 1] * hi;
    g1[i2 + 1] = F[o] * hi + F[o + 1] * hr;
    g2[i2] = F[o + 2] * hr - F[o + 3] * hi;
    g2[i2 + 1] = F[o + 2] * hi + F[o + 3] * hr;
    g3[i2] = F[o + 4] * hr - F[o + 5] * hi;
    g3[i2 + 1] = F[o + 4] * hi + F[o + 5] * hr;
    g4[i2] = F[o + 6] * hr - F[o + 7] * hi;
    g4[i2 + 1] = F[o + 6] * hi + F[o + 7] * hr;
  }

  ifft2d(plan, g1);
  ifft2d(plan, g2);
  ifft2d(plan, g3);
  ifft2d(plan, g4);

  // ---- Foam advection (before injection): carry the accumulated field
  // along the surface horizontal velocity. Velocity = finite difference of
  // λ·D between steps (the material flow that stretches/converges foam),
  // plus a downwind drift (real foam streams at ~3% of wind speed).
  {
    const { foam, foamNext, prevDx, prevDz } = state;
    const dtSafe = Math.max(dt, 1e-3);
    const advGain = options.foamAdvect ?? 1.0;
    const drift = (options.foamDrift ?? 0.03) * (options.windSpeed ?? 8);
    const wdir = options.windDirection ?? 0;
    const driftX = Math.cos(wdir) * drift;
    const driftZ = Math.sin(wdir) * drift;
    const toTexel = N / options.tileSize;
    if (state.hasPrev && advGain > 0) {
      for (let idx = 0; idx < NN; idx++) {
        const i2 = idx * 2;
        const Dx = lambda * g1[i2 + 1];
        const Dz = lambda * g2[i2];
        // Clamp the orbital term: preset/time jumps otherwise teleport foam.
        let vx = Math.max(-6, Math.min(6, (Dx - prevDx[idx]) / dtSafe)) * advGain + driftX;
        let vz = Math.max(-6, Math.min(6, (Dz - prevDz[idx]) / dtSafe)) * advGain + driftZ;
        prevDx[idx] = Dx;
        prevDz[idx] = Dz;
        const i = idx % N;
        const j = (idx / N) | 0;
        foamNext[idx] = sampleWrap(foam, i - vx * dt * toTexel, j - vz * dt * toTexel);
      }
      state.foam = foamNext;
      state.foamNext = foam;
    } else {
      for (let idx = 0; idx < NN; idx++) {
        const i2 = idx * 2;
        prevDx[idx] = lambda * g1[i2 + 1];
        prevDz[idx] = lambda * g2[i2];
      }
      state.hasPrev = true;
    }
  }

  const foam = state.foam;
  const dither = state.dither;
  const dispA = recycled?.[0]?.length === NN * 4 ? recycled[0] : new Float32Array(NN * 4);
  const normB = recycled?.[1]?.length === NN * 4 ? recycled[1] : new Float32Array(NN * 4);

  const foamDecay = Math.exp(-dt / (options.foamDecay ?? 5.0));
  const foamBias = options.foamBias ?? 0.65; // J below this injects foam
  const foamGain = options.foamGain ?? 6.0;

  for (let idx = 0; idx < NN; idx++) {
    const i2 = idx * 2;
    const h = g1[i2];
    const Dx = g1[i2 + 1];
    const Dz = g2[i2];
    const dhdx = g2[i2 + 1];
    const dhdz = g3[i2];
    const dDxdx = g3[i2 + 1];
    const dDzdz = g4[i2];
    const dDxdz = g4[i2 + 1];

    const jxx = 1 + lambda * dDxdx;
    const jzz = 1 + lambda * dDzdz;
    const jxz = lambda * dDxdz;
    const J = jxx * jzz - jxz * jxz;

    // Persistent foam: exponential decay + dithered injection where the
    // surface folds (advection already applied above). Injection is
    // logistic (∝ 1−f): mats approach saturation softly instead of slamming
    // whole fold zones to solid white.
    let f = foam[idx] * foamDecay;
    const inj = Math.max(0, foamBias - J) * foamGain * dt * dither[idx];
    f = Math.min(1, f + inj * (1 - f));
    foam[idx] = f;

    // Slopes corrected for horizontal displacement compression.
    const sx = dhdx / Math.max(0.25, jxx);
    const sz = dhdz / Math.max(0.25, jzz);
    const invLen = 1 / Math.hypot(sx, 1, sz);

    const i4 = idx * 4;
    dispA[i4] = lambda * Dx;
    dispA[i4 + 1] = h;
    dispA[i4 + 2] = lambda * Dz;
    dispA[i4 + 3] = J;
    normB[i4] = -sx * invLen;
    normB[i4 + 1] = invLen;
    normB[i4 + 2] = -sz * invLen;
    normB[i4 + 3] = f;
  }

  return { dispA, normB };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    init(msg.options);
    self.postMessage({ type: 'ready' });
  } else if (msg.type === 'reinit') {
    init({ ...state.options, ...msg.options });
    self.postMessage({ type: 'ready' });
  } else if (msg.type === 'setFoam') {
    // Live foam parameter change WITHOUT resetting the accumulated foam
    // field (used to demonstrate persistent-foam decay).
    Object.assign(state.options, msg.options);
  } else if (msg.type === 'step') {
    const { dispA, normB } = step(msg.t, msg.dt, msg.recycled);
    self.postMessage({ type: 'fields', t: msg.t, dispA, normB }, [dispA.buffer, normB.buffer]);
  }
};
