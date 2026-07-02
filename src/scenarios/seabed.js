// Demo seabed: analytic heightfield (island + shallow bank + deep floor),
// built both as a mesh and as a heightfield texture the water material uses
// for depth-based absorption and contact foam.
import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, float, positionWorld, mix, saturate, smoothstep, dot,
  normalize, normalLocal, uniform, mul,
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
  h += 26 * g(-260, 140, 210); // shallow turquoise bank (peak ≈ -16)
  h += 34 * g(60, -40, 150); // nearshore shelf by the origin (peak ≈ -8)
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

export function makeSeabedMesh(ocean) {
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

  const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
  const time = ocean.uniforms.time;
  mat.colorNode = ocean.wrapUnderwaterFog(
    Fn(() => {
      const wp = positionWorld;
      // Sand → grass gradient above water, sand below.
      const sand = vec3(0.72, 0.66, 0.5);
      const grass = vec3(0.30, 0.42, 0.22);
      const rock = vec3(0.45, 0.42, 0.38);
      const aboveMix = smoothstep(float(0.4), float(6.0), wp.y);
      const baseCol = mix(sand, mix(rock, grass, smoothstep(float(4), float(10), wp.y)), aboveMix);
      // Lambert-ish shading from geometry normal.
      const ndl = saturate(dot(normalize(normalLocal), sunDirUniform)).mul(0.75).add(0.3);
      // Animated caustics, fading out with depth and gone above water.
      const depth = float(0).sub(wp.y);
      const causStrength = smoothstep(float(-0.5), float(1.5), depth)
        .mul(smoothstep(float(26), float(4), depth));
      const caus = causticsNode(wp.xz, time, float(0.45)).mul(causStrength);
      return baseCol.mul(ndl).mul(caus.mul(0.9).add(1.0));
    })()
  );

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'seabed';
  return mesh;
}
