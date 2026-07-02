// Ocean surface geometry: a camera-following XZ grid with per-axis power
// stretching — dense near the viewer, reaching the horizon at the rim.
import * as THREE from 'three/webgpu';

export function makeSurfaceGeometry({ segments = 256, radius = 30000, innerFraction = 0.01, power = 5 } = {}) {
  const S = segments;
  const verts = new Float32Array((S + 1) * (S + 1) * 3);
  const remap = (t) => {
    // t in [-1, 1] → world, uniform near 0, stretched toward the rim.
    const a = Math.abs(t);
    const f = a * (innerFraction + (1 - innerFraction) * Math.pow(a, power));
    return Math.sign(t) * f * radius;
  };
  // Per-vertex local grid spacing (metres) so the shader can fade any wave
  // component the local mesh density cannot represent (kills moiré).
  const spacing = new Float32Array((S + 1) * (S + 1));
  const cell = (t) => {
    const step = 2 / S;
    return Math.abs(remap(Math.min(t + step, 1)) - remap(t));
  };
  let p = 0;
  let q0 = 0;
  for (let j = 0; j <= S; j++) {
    const tz = (j / S) * 2 - 1;
    const z = remap(tz);
    for (let i = 0; i <= S; i++) {
      const tx = (i / S) * 2 - 1;
      verts[p++] = remap(tx);
      verts[p++] = 0;
      verts[p++] = z;
      spacing[q0++] = Math.max(cell(Math.abs(tx)), cell(Math.abs(tz)));
    }
  }
  const index = new Uint32Array(S * S * 6);
  let q = 0;
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const a = j * (S + 1) + i;
      const b = a + 1;
      const c = a + S + 1;
      const d = c + 1;
      index[q++] = a;
      index[q++] = c;
      index[q++] = b;
      index[q++] = b;
      index[q++] = c;
      index[q++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setAttribute('spacing', new THREE.BufferAttribute(spacing, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  return geo;
}
