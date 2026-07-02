// Animated procedural caustics (two counter-scrolling Worley layers,
// sharpened). Used on the demo seabed and exported for consumers.
import {
  Fn, float, vec2, vec3, pow, saturate, min, mx_worley_noise_float, oneMinus,
} from 'three/tsl';

/**
 * causticsNode(worldXZ, time, scale) → float intensity [0..~1.5].
 */
export const causticsNode = Fn(([worldXZ, t, scale]) => {
  const p = worldXZ.mul(scale);
  const w1 = mx_worley_noise_float(vec3(p.add(vec2(t.mul(0.14), t.mul(0.09))), t.mul(0.21)));
  const w2 = mx_worley_noise_float(vec3(p.mul(1.53).add(vec2(t.mul(-0.11), t.mul(0.13))), t.mul(0.17).add(4.7)));
  const c1 = pow(saturate(oneMinus(w1)), float(3.0));
  const c2 = pow(saturate(oneMinus(w2)), float(3.0));
  // Multiplying the layers keeps only coincident bright filaments — the
  // characteristic caustic web — while suppressing broad blobs.
  const web = pow(saturate(min(c1.add(0.12), c2.add(0.12))), float(2.0));
  return web.mul(2.2);
});
