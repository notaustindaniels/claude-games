// Demo seabed: analytic heightfield (island + shallow bank + deep floor),
// built both as a mesh and as a heightfield texture the water material uses
// for depth-based absorption and contact foam.
import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, float, positionWorld, mix, saturate, smoothstep, dot, min,
  normalize, normalLocal, uniform, mul, cameraPosition, oneMinus, exp,
} from 'three/tsl';
import { causticsNode } from '../lib/index.js';

export const SEABED_BOUNDS = [-700, -700, 1400, 1400]; // minX, minZ, sizeX, sizeZ

export function seabedHeight(x, z) {
  const g = (cx, cz, r) => {
    const dx = x - cx;
    const dz = z - cz;
    return Math.exp(-(dx * dx + dz * dz) / (2 * r * r));
  };
  let h = -42;
  h += 60 * g(170, -230, 115); // island (breaks the surface)
  h += 26 * g(-320, 260, 180); // shallow turquoise bank (peak ≈ -14)
  h += 32 * g(-40, 120, 130); // nearshore shelf NW of origin (peak ≈ -5)
  // gentle dunes for caustic/absorption interest
  h += 1.6 * Math.sin(x * 0.05) * Math.sin(z * 0.043 + 1.7);
  return h;
}

/** Heightfield texture for the water material (R = height). */
export function makeSeabedTexture() {
  const [minX, minZ, sizeX, sizeZ] = SEABED_BOUNDS;
  const TN = 256;
  const data = new Float32Array(TN * TN * 4);
  for (let j = 0; j < TN; j++) {
    for (let i = 0; i < TN; i++) {
      const x = minX + ((i + 0.5) / TN) * sizeX;
      const z = minZ + ((j + 0.5) / TN) * sizeZ;
      data[(j * TN + i) * 4] = seabedHeight(x, z);
    }
  }
  const texture = new THREE.DataTexture(data, TN, TN, THREE.RGBAFormat, THREE.FloatType);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return { texture, bounds: SEABED_BOUNDS, deepY: -42 };
}

export function makeSeabedMesh(ocean, opts = {}) {
  const [minX, minZ, sizeX, sizeZ] = SEABED_BOUNDS;
  const sunDirUniform = ocean.uniforms.sunDir;
  const SEG = 220;
  const geo = new THREE.PlaneGeometry(sizeX, sizeZ, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v) + minX + sizeX / 2;
    const z = pos.getZ(v) + minZ + sizeZ / 2;
    pos.setY(v, seabedHeight(x, z));
  }
  geo.computeVertexNormals();

  const useRefracted = !!ocean.causticsSample && !opts.procCaustics;

  const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
  const time = ocean.uniforms.time;
  mat.colorNode = ocean.wrapUnderwaterFog(
    () => {
      const wp = positionWorld;
      // Sand → grass gradient above water, sand below.
      const sand = vec3(0.72, 0.66, 0.5);
      const grass = vec3(0.30, 0.42, 0.22);
      const rock = vec3(0.45, 0.42, 0.38);
      const aboveMix = smoothstep(float(0.4), float(6.0), wp.y);
      const baseCol = mix(sand, mix(rock, grass, smoothstep(float(4), float(10), wp.y)), aboveMix);
      // Lambert-ish shading from geometry normal.
      const ndl = saturate(dot(normalize(normalLocal), sunDirUniform)).mul(0.75).add(0.3);
      const depth = float(0).sub(wp.y);
      const causStrength = smoothstep(float(-0.5), float(1.5), depth)
        .mul(smoothstep(float(30), float(6), depth));
      // Downwelling attenuation: sunlight reaching the bed has crossed the
      // water column once, so submerged sand shifts teal with depth (the
      // pink dry-sand albedo must not survive at 5 m down).
      const downAtt = exp(vec3(0.30, 0.09, 0.075).mul(depth.mul(1.2)).negate());
      const colAtt = mix(vec3(1), downAtt, smoothstep(float(-0.3), float(0.8), depth));
      const lit = baseCol.mul(ndl).mul(colAtt);
      if (useRefracted) {
        // Refracted-ray caustic map (≈1 neutral). The surplus light is
        // attenuated per-channel with depth (red dies first) so deep
        // caustics turn blue-green instead of staying white.
        const F = min(ocean.causticsSample(wp), 3.5);
        const att = exp(vec3(0.30, 0.09, 0.075).mul(depth.mul(0.6)).negate());
        const causLight = vec3(1).add(F.sub(1).mul(att).mul(causStrength).mul(1.6));
        return lit.mul(causLight);
      }
      // Old procedural Worley web (kept for the Q3 comparison shot).
      const caus = causticsNode(wp.xz, time, float(0.45)).mul(causStrength);
      return lit.mul(caus.mul(0.5).add(0.82));
    }
  );

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'seabed';
  return mesh;
}
