// Underwater helpers: a full-screen overlay for the waterline crossing and
// deep tint, plus a TSL fog wrapper consumers apply to submerged materials.
import * as THREE from 'three/webgpu';
import {
  Fn, vec3, vec4, float, mix, exp, oneMinus, smoothstep, saturate,
  positionLocal, positionWorld, cameraPosition, length, uniform,
} from 'three/tsl';

/**
 * Full-screen overlay blended in as the camera crosses the surface (no hard
 * cut) and sustained as a mild tint while submerged. Render with the scene;
 * it draws last with no depth test.
 */
export function makeUnderwaterOverlay(u) {
  const submergence = uniform(0); // 0 above → 1 fully below (smooth band)
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  // Near the crossing the whole view washes with water color; once fully
  // under, it settles to a light persistent tint (the water material and
  // scene fog do the rest).
  const crossing = submergence.mul(oneMinus(submergence)).mul(4); // peaks at 0.5
  const alpha = saturate(crossing.mul(0.85).add(submergence.mul(0.22)));
  mat.colorNode = vec4(u.uwFogColor, alpha);
  mat.vertexNode = vec4(positionLocal.xy, 0.9999, 1);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 9999;
  return { mesh, submergence };
}

/**
 * Wrap a material color node with underwater depth fog toward the water fog
 * color. `enabled` is a uniform the ocean drives (camera submerged).
 */
export function makeUnderwaterFogWrapper(u) {
  const enabled = uniform(0);
  const wrap = (colorNode) => Fn(() => {
    const dist = length(positionWorld.sub(cameraPosition));
    const f = oneMinus(exp(dist.mul(u.uwFogDensity).negate()));
    return mix(colorNode, vec3(u.uwFogColor), f.mul(enabled));
  })();
  return { wrap, enabled };
}
