// Gerstner swell layer shared between CPU buoyancy sampling and the shader.
// The same component parameters drive both, so getHeightAt() matches what is
// rendered. Up to MAX_SWELL components.

export const MAX_SWELL = 3;
const G = 9.81;

/**
 * Normalize swell component definitions into simulation-ready form.
 * comps: [{ amplitude, wavelength, direction (rad, travel dir), steepness 0..1 }]
 */
export function makeSwell(comps = []) {
  const list = comps.slice(0, MAX_SWELL).map((c) => {
    const k = (2 * Math.PI) / Math.max(c.wavelength, 1);
    const amp = c.amplitude ?? 0;
    return {
      dirX: Math.cos(c.direction ?? 0),
      dirZ: Math.sin(c.direction ?? 0),
      amp,
      k,
      omega: Math.sqrt(G * k),
      // Q chosen so combined steepness stays below folding.
      q: amp > 0 ? Math.min((c.steepness ?? 0.6) / (k * amp * Math.max(comps.length, 1)), 1 / (k * amp)) : 0,
    };
  });
  while (list.length < MAX_SWELL) {
    list.push({ dirX: 1, dirZ: 0, amp: 0, k: 1, omega: 0, q: 0 });
  }
  return list;
}

/**
 * Evaluate swell displacement and slope at (x, z, t).
 * Returns { dx, dy, dz, sx, sz } — sx/sz are surface slopes (∂y/∂x, ∂y/∂z
 * style, suitable for n = normalize(-sx, 1, -sz) accumulation).
 */
export function evalSwell(swell, x, z, t, out = {}) {
  let dx = 0;
  let dy = 0;
  let dz = 0;
  let nx = 0;
  let nz = 0;
  let ny = 1;
  for (let i = 0; i < swell.length; i++) {
    const w = swell[i];
    if (w.amp <= 0) continue;
    const phase = w.k * (w.dirX * x + w.dirZ * z) - w.omega * t;
    const c = Math.cos(phase);
    const s = Math.sin(phase);
    const ka = w.k * w.amp;
    dx += w.dirX * w.q * w.amp * c;
    dz += w.dirZ * w.q * w.amp * c;
    dy += w.amp * s;
    nx += w.dirX * ka * c;
    nz += w.dirZ * ka * c;
    ny -= w.q * ka * s;
  }
  const inv = 1 / Math.max(ny, 0.35);
  out.dx = dx;
  out.dy = dy;
  out.dz = dz;
  out.sx = nx * inv;
  out.sz = nz * inv;
  return out;
}
