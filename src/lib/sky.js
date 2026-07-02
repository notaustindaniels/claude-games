// Procedural gradient sky shared by the background dome, the water's
// environment reflection fallback, and the sun disc. Deliberately analytic
// (no HDRIs) so renders are deterministic and self-contained.
import * as THREE from 'three/webgpu';
import {
  Fn, float, mix, pow, saturate, dot, normalize, exp, smoothstep, max,
  positionLocal,
} from 'three/tsl';

/**
 * skyColor(dir) TSL function factory.
 * u: { sunDir, zenith, horizon, haze, sunColor, sunIntensity } uniform nodes.
 */
export function makeSkyColorFn(u) {
  return Fn(([dirRaw]) => {
    const dir = normalize(dirRaw);
    const y = dir.y;
    const up = saturate(y);
    // Base gradient: haze at the horizon through horizon color to zenith.
    const grad = mix(u.horizon, u.zenith, pow(up, float(0.55)));
    const nearHorizon = exp(y.abs().mul(-9.0));
    const base = mix(grad, u.haze, nearHorizon.mul(0.85));
    // Below the horizon: sea haze, slightly darker.
    const below = mix(u.horizon.mul(0.55), u.haze.mul(0.85), exp(y.abs().mul(-14.0)));
    const sky = mix(below, base, smoothstep(float(-0.02), float(0.02), y));
    // Sun disc + halo.
    const cosSun = saturate(dot(dir, u.sunDir));
    const disc = smoothstep(float(0.9994), float(0.99985), cosSun);
    const halo = pow(cosSun, float(320.0)).mul(0.75)
      .add(pow(cosSun, float(24.0)).mul(0.14));
    const sunGlow = u.sunColor.mul(disc.mul(28.0).add(halo).mul(u.sunIntensity));
    return sky.add(sunGlow).mul(max(u.sunIntensity, float(0.35)));
  });
}

/** Background dome mesh using the same sky function. */
export function makeSkyDome(skyColorFn, radius = 15000) {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false });
  mat.depthWrite = false; // water fogged to sky color may lie beyond the dome
  mat.colorNode = skyColorFn(normalize(positionLocal));
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}
