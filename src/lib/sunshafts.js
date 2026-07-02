// Underwater sun shafts (W9 atmosphere feature): a fan of tall additive
// billboards under the surface, aligned to the sun azimuth, animated by
// noise so the light columns waver like real crepuscular shafts.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, float, vec3, vec4, positionWorld, smoothstep,
  saturate, mx_noise_float, uv, pow,
} from 'three/tsl';

export function makeSunShafts(u) {
  const intensity = uniform(0); // driven by submergence
  const group = new THREE.Group();
  group.name = 'OpenOceanSunShafts';

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  mat.colorNode = Fn(() => {
    const uvv = uv();
    // Vertical falloff: bright near the surface, fading with depth.
    const vertical = smoothstep(float(0.0), float(0.35), uvv.y).mul(
      smoothstep(float(1.0), float(0.75), uvv.y).mul(0.5).add(0.5)
    );
    // Horizontal soft edges + animated wavering columns.
    const edge = smoothstep(float(0), float(0.18), uvv.x)
      .mul(smoothstep(float(1), float(0.82), uvv.x));
    const columns = mx_noise_float(
      vec3(uvv.x.mul(6.0).add(positionWorld.x.mul(0.02)), u.time.mul(0.25), positionWorld.z.mul(0.02))
    ).mul(0.5).add(0.5);
    const glow = vertical.mul(edge).mul(pow(saturate(columns), float(2.0)));
    const col = vec3(0.45, 0.75, 0.85).mul(u.sunColor);
    return vec4(col, glow.mul(intensity).mul(0.28));
  })();

  // A loose ring of narrow vertical quads at varied azimuths, far enough out
  // that the camera never sits inside a slab of glow.
  const H = 30;
  const W = 11;
  for (let i = 0; i < 9; i++) {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
    const a = (i / 9) * Math.PI;
    const r = 26 + (i % 3) * 14;
    quad.rotation.y = a;
    quad.position.set(
      Math.sin((i / 9) * Math.PI * 2) * r,
      -H / 2 + 1.0,
      Math.cos((i / 9) * Math.PI * 2) * r
    );
    quad.renderOrder = 500;
    quad.frustumCulled = false;
    group.add(quad);
  }
  return { group, intensity };
}
