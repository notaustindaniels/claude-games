// Directional ocean wave spectra (JONSWAP and Phillips) on the FFT k-grid.
// Derived from published formulations: Tessendorf 2001 ("Simulating Ocean
// Water"), Hasselmann et al. 1973 (JONSWAP), Horvath 2015 (directional
// spectra for graphics). No proprietary code.

const G = 9.81;

function smooth01(x) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Deterministic PRNG (mulberry32) + Box-Muller gaussian pairs. */
export function makeRandom(seed) {
  let a = seed >>> 0;
  const uniform = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    uniform,
    gaussianPair() {
      let u1 = uniform();
      if (u1 < 1e-12) u1 = 1e-12;
      const u2 = uniform();
      const r = Math.sqrt(-2 * Math.log(u1));
      return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
    },
  };
}

/** JONSWAP frequency spectrum S(ω) with fetch-dependent α and peak ω. */
function jonswap(omega, windSpeed, fetch) {
  const U = Math.max(windSpeed, 0.1);
  // Cap fetch at the fully-developed limit (g·F/U² ≈ 2.3e4) — JONSWAP
  // extrapolated past it produces unphysically large seas for light winds.
  const F = Math.min(Math.max(fetch, 1000), (2.3e4 * U * U) / G);
  const alpha = 0.076 * Math.pow((U * U) / (F * G), 0.22);
  const omegaP = 22 * Math.pow((G * G) / (U * F), 1 / 3);
  const sigma = omega <= omegaP ? 0.07 : 0.09;
  const r = Math.exp(-((omega - omegaP) ** 2) / (2 * sigma * sigma * omegaP * omegaP));
  const gamma = 3.3;
  return (
    ((alpha * G * G) / omega ** 5) *
    Math.exp(-1.25 * Math.pow(omegaP / omega, 4)) *
    Math.pow(gamma, r)
  );
}

/** Phillips spectrum P(k) (Tessendorf form), directional term applied by caller. */
function phillips(k, windSpeed) {
  const L = (windSpeed * windSpeed) / G;
  const k2 = k * k;
  return Math.exp(-1 / (k2 * L * L)) / (k2 * k2);
}

/**
 * Directional spreading: cos-power lobe around the wind direction with a
 * small isotropic floor, and strong suppression of upwind-travelling waves.
 */
function spreading(theta, windTheta, sharpness) {
  let d = theta - windTheta;
  // wrap to [-π, π]
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const c = Math.cos(d / 2);
  let s = Math.pow(Math.abs(c), 2 * sharpness);
  if (Math.cos(d) < 0) s *= 0.06; // waves against the wind are rare
  return s + 0.02;
}

/**
 * Build the initial spectrum h0 on the wrapped k-grid.
 * Returns { h0: Float32Array(2*N*N) interleaved complex, omega: Float32Array(N*N) }.
 * k index convention: ki = 2π * wrap(i) / L, wrap(i) = i < N/2 ? i : i - N.
 */
export function buildInitialSpectrum(opts) {
  const {
    N,
    tileSize,
    seed = 1337,
    windSpeed = 8,
    windDirection = 0, // radians, direction waves travel toward
    fetch = 300000, // metres
    spectrum = 'jonswap',
    directionality = 8, // cos-power sharpness
    smallWaveCutoff = 0.01, // metres; suppress sub-texel chop
    amplitudeScale = 1,
    // Cascade band limits (wavelength, metres): energy outside
    // (bandMinLambda, bandMaxLambda] is excluded, with ~12% feather, so
    // multiple cascades partition the spectrum without double counting.
    bandMinLambda = 0,
    bandMaxLambda = Infinity,
  } = opts;

  const rng = makeRandom(seed);
  const h0 = new Float32Array(2 * N * N);
  const omega = new Float32Array(N * N);
  const dk = (2 * Math.PI) / tileSize;

  // Normalize the directional spreading numerically so ∫D(θ)dθ = 1.
  let spreadNorm = 0;
  const M = 512;
  for (let m = 0; m < M; m++) {
    spreadNorm += spreading((m / M) * 2 * Math.PI - Math.PI, 0, directionality);
  }
  spreadNorm *= (2 * Math.PI) / M;

  for (let j = 0; j < N; j++) {
    const jw = j < N / 2 ? j : j - N;
    const kz = jw * dk;
    for (let i = 0; i < N; i++) {
      const iw = i < N / 2 ? i : i - N;
      const kx = iw * dk;
      const idx = j * N + i;
      // Consume the gaussian pair BEFORE the k==0 early-out so the random
      // stream stays aligned regardless of grid position (determinism).
      const [gr, gi] = rng.gaussianPair();
      const k = Math.hypot(kx, kz);
      if (k < 1e-6) {
        h0[idx * 2] = 0;
        h0[idx * 2 + 1] = 0;
        omega[idx] = 0;
        continue;
      }
      const w = Math.sqrt(G * k); // deep-water dispersion
      omega[idx] = w;
      const theta = Math.atan2(kz, kx);
      let energy;
      if (spectrum === 'phillips') {
        energy = phillips(k, windSpeed) * 0.0008;
      } else {
        // S(ω) → E(k) 2D density: S(ω) · D(θ) · (dω/dk) / k, dω/dk = g/(2ω)
        energy = (jonswap(w, windSpeed, fetch) * (G / (2 * w))) / k;
      }
      energy *= spreading(theta, windDirection, directionality) / spreadNorm;
      // Suppress waves shorter than the cutoff (and hence texel aliasing).
      energy *= Math.exp(-k * k * smallWaveCutoff * smallWaveCutoff);
      // Cascade band partition (smooth ~12% feather at each edge).
      if (bandMinLambda > 0 || bandMaxLambda < Infinity) {
        const lambda = (2 * Math.PI) / k;
        const fadeIn = smooth01((bandMaxLambda - lambda) / (bandMaxLambda * 0.12));
        const fadeOut = smooth01((lambda - bandMinLambda) / (bandMinLambda * 0.12 + 1e-9));
        energy *= (bandMaxLambda < Infinity ? fadeIn : 1) * (bandMinLambda > 0 ? fadeOut : 1);
      }
      // Discrete amplitude chosen so E[|h~(k,t)|²] = E(k)·Δk² and the summed
      // variance matches the spectrum integral (h~ sums ±k contributions).
      const amp = Math.sqrt(Math.max(energy * dk * dk, 0) / 2) * amplitudeScale;
      h0[idx * 2] = (gr * amp) / Math.SQRT2;
      h0[idx * 2 + 1] = (gi * amp) / Math.SQRT2;
    }
  }
  return { h0, omega };
}
