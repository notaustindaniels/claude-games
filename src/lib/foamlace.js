// Tileable foam-structure ("lace") texture. One scalar field whose high
// values form a connected web (bubble walls / filaments) and whose low
// values are holes: thresholding it at rising levels tears a solid mat into
// a shredded web, then sparse filaments — which is how decaying foam breaks
// up. R = multi-octave lace, G = coarse mat variation for spatial threshold
// wobble. Pure data generator kept THREE-free so node scripts can preview it.
import { makeRandom } from './spectrum.js';

/** Toroidal worley F1/F2 (distances to two nearest jittered points). */
function worley2(u, v, P, pts, out) {
  const cu = Math.floor(u * P);
  const cv = Math.floor(v * P);
  let b1 = 1e9;
  let b2 = 1e9;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const ci = (cu + di + P) % P;
      const cj = (cv + dj + P) % P;
      const o = (cj * P + ci) * 2;
      // point position in cell units, unwrapped to the neighborhood
      const px = cu + di + pts[o];
      const py = cv + dj + pts[o + 1];
      const dx = (u * P - px);
      const dy = (v * P - py);
      const d = dx * dx + dy * dy;
      if (d < b1) {
        b2 = b1;
        b1 = d;
      } else if (d < b2) {
        b2 = d;
      }
    }
  }
  out[0] = Math.sqrt(b1); // in cell units
  out[1] = Math.sqrt(b2);
  return out;
}

/** Periodic value-noise (bilinear, P×P lattice) in [0,1]. */
function periodicNoise(u, v, P, lat) {
  const x = u * P;
  const y = v * P;
  const i0 = Math.floor(x) % P;
  const j0 = Math.floor(y) % P;
  const i1 = (i0 + 1) % P;
  const j1 = (j0 + 1) % P;
  const fx = x - Math.floor(x);
  const fy = y - Math.floor(y);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = lat[j0 * P + i0];
  const b = lat[j0 * P + i1];
  const c = lat[j1 * P + i0];
  const d = lat[j1 * P + i1];
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export function foamLaceData(size = 256, seed = 9001) {
  const rng = makeRandom(seed);
  const makePts = (P) => {
    const pts = new Float32Array(P * P * 2);
    for (let i = 0; i < P * P; i++) {
      pts[i * 2] = rng.uniform();
      pts[i * 2 + 1] = rng.uniform();
    }
    return pts;
  };
  const makeLat = (P) => {
    const lat = new Float32Array(P * P);
    for (let i = 0; i < P * P; i++) lat[i] = rng.uniform();
    return lat;
  };
  // Bubble octaves: period, weight, hole radius (cell units).
  const octaves = [
    { P: 6, w: 0.42, r: 0.62, pts: makePts(6) },
    { P: 12, w: 0.33, r: 0.55, pts: makePts(12) },
    { P: 24, w: 0.25, r: 0.5, pts: makePts(24) },
  ];
  // Crack-web octaves (F2−F1 → 0 on cell borders): the connected filament
  // skeleton that must own the TOP of the histogram so it is the last thing
  // to survive as foam decays.
  const cracks = [
    { P: 5, w: 0.6, s: 0.55, pts: makePts(5) },
    { P: 11, w: 0.4, s: 0.5, pts: makePts(11) },
  ];
  const coarseLat = makeLat(4);
  const warpLatU = makeLat(5);
  const warpLatV = makeLat(5);

  const f12 = [0, 0];
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let u = (i + 0.5) / size;
      let v = (j + 0.5) / size;
      // Domain warp so cell walls wander instead of reading as a lattice.
      const wu = (periodicNoise(u, v, 5, warpLatU) - 0.5) * 0.08;
      const wv = (periodicNoise(u, v, 5, warpLatV) - 0.5) * 0.08;
      u = (u + wu + 1) % 1;
      v = (v + wv + 1) % 1;
      let bubbles = 0;
      let wsum = 0;
      for (const o of octaves) {
        // Distance to hole center → 0 in holes, ~1 between them.
        worley2(u, v, o.P, o.pts, f12);
        const wall = Math.min(1, Math.max(0, f12[0] / o.r));
        bubbles += o.w * wall * wall * (3 - 2 * wall);
        wsum += o.w;
      }
      bubbles /= wsum;
      let web = 0;
      let csum = 0;
      for (const c of cracks) {
        worley2(u, v, c.P, c.pts, f12);
        const line = 1 - Math.min(1, (f12[1] - f12[0]) / c.s);
        web += c.w * line * line;
        csum += c.w;
      }
      web /= csum;
      // Bubbles fill [0, ~0.62]; the crack web pushes borders toward 1.
      let lace = bubbles * 0.62 + web * 0.38 * (0.4 + 0.6 * bubbles);
      lace = Math.min(1, Math.max(0, (lace - 0.06) / 0.9));
      const coarse = periodicNoise(u, v, 4, coarseLat);
      const p = (j * size + i) * 4;
      data[p] = Math.round(lace * 255);
      data[p + 1] = Math.round(coarse * 255);
      data[p + 2] = 0;
      data[p + 3] = 255;
    }
  }
  return data;
}
