// GPU crest spray: stateless ballistic particles computed entirely in the
// vertex stage (works on the WebGL2 fallback — no compute). Each particle
// hashes a respawn cycle from (index, cycle counter); at each cycle start it
// picks a camera-local seed point, samples the structural cascades'
// Jacobians there, and only materializes where the surface is breaking
// (J below threshold). Velocity = up + downwind + jitter, then gravity.
// Deterministic in sim time (the seed region quantizes to an 8 m grid).
import * as THREE from 'three/webgpu';

const _dir = new THREE.Vector3();
import {
  float, vec2, vec3, uniform, texture, attribute, hash, fract,
  floor, min, max, saturate, smoothstep, mix, oneMinus, pointUV, length,
} from 'three/tsl';

export function makeSpray({ sim, count = 7000, radius = 90 }) {
  const u = {
    time: uniform(0),
    camXZ: uniform(new THREE.Vector2(0, 0)), // quantized camera anchor
    windDir: uniform(new THREE.Vector2(1, 0)),
    windSpeed: uniform(8),
    intensity: uniform(0), // preset spray amount 0..1
    tile0: uniform(256),
    tile1: uniform(59),
    jThresh: uniform(0.85),
  };
  const dispTex0 = texture(sim.dispTextures[0]);
  const dispTex1 = texture(sim.dispTextures[1]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) seeds[i] = i;
  geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));

  const mat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
  });

  const i = attribute('seed', 'float');
  const T = mix(float(0.8), float(1.6), hash(i.add(3.17)));
  const phase = hash(i.add(7.71));
  const cyc = floor(u.time.div(T).add(phase));
  const lt = fract(u.time.div(T).add(phase)).mul(T); // seconds into cycle
  // Per-cycle hashes.
  const hs = (k) => hash(i.mul(0.731).add(cyc.mul(0.6180339)).add(k));
  const seedPt = u.camXZ.add(vec2(hs(1.3).sub(0.5), hs(2.6).sub(0.5)).mul(radius * 2));
  const d0 = dispTex0.sample(seedPt.div(u.tile0));
  const d1 = dispTex1.sample(seedPt.div(u.tile1));
  const J = min(d0.w, d1.w.mul(1.1));
  // Breaking gate: J below threshold, sharpened; scaled by preset intensity
  // via a per-particle lottery so calmer presets emit fewer particles.
  const lottery = hash(i.add(cyc.mul(1.618)).add(11.31));
  const active = smoothstep(u.jThresh, u.jThresh.sub(0.3), J)
    .mul(saturate(u.intensity.mul(1.9).sub(lottery)));
  const life = T.mul(0.8);
  const alive = active.mul(smoothstep(life, life.mul(0.55), lt));

  const birth = vec3(
    seedPt.x.add(d0.x).add(d1.x),
    d0.y.add(d1.y).add(0.4),
    seedPt.y.add(d0.z).add(d1.z)
  );
  const vel = vec3(
    u.windDir.x.mul(u.windSpeed.mul(0.35)).add(hs(4.4).sub(0.5).mul(3)),
    mix(float(2.2), float(6.0), hs(5.9)),
    u.windDir.y.mul(u.windSpeed.mul(0.35)).add(hs(6.2).sub(0.5).mul(3))
  );
  const pos = birth.add(vel.mul(lt)).add(vec3(0, lt.mul(lt).mul(-4.9), 0));
  mat.positionNode = pos;

  // Size in pixels: world size grows as the puff expands, attenuated by
  // distance manually (robust across backends).
  const camDist = max(length(pos.sub(vec3(u.camXZ.x, 0, u.camXZ.y))), 4);
  const worldSize = mix(float(0.8), float(2.8), hs(8.8)).mul(lt.mul(2.4).add(0.5));
  mat.sizeNode = worldSize.mul(340).div(camDist).mul(smoothstep(float(0.003), float(0.02), alive));

  const puff = oneMinus(smoothstep(float(0.12), float(0.5), pointUV.distance(vec2(0.5))));
  mat.colorNode = vec3(0.92, 0.96, 0.99);
  mat.opacityNode = puff.mul(alive).mul(oneMinus(lt.div(life)).mul(0.55).add(0.2));

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 20;

  return {
    points,
    uniforms: u,
    update(camera, timeValue, cfg) {
      u.time.value = timeValue;
      // Anchor the seed square AHEAD of the camera (most of the visible sea
      // is in front), quantized so the emission field is stable in world
      // space (no swimming with camera motion).
      camera.getWorldDirection(_dir);
      u.camXZ.value.set(
        Math.round((camera.position.x + _dir.x * 55) / 8) * 8,
        Math.round((camera.position.z + _dir.z * 55) / 8) * 8
      );
      u.windDir.value.set(
        Math.cos(cfg.sim.windDirectionRad ?? 0),
        Math.sin(cfg.sim.windDirectionRad ?? 0)
      );
      u.windSpeed.value = cfg.sim.windSpeed ?? 8;
      u.intensity.value = cfg.spray ?? 0;
      u.tile0.value = cfg.sim.tileSize;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
