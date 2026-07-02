// Caustics.
//
// makeCausticsPass: refracted-ray caustics after the technique studied in
// reference/webgl-water-study/renderer.js (causticsShader) — REIMPLEMENTED
// in TSL from the algorithm, not copied (see NOTICE.txt): render the
// displaced water grid into a caustic map, warping each vertex to its
// refracted-ray landing point on the seabed plane; a varying carries both
// the flat-refraction landing (oldPos) and the true landing (newPos), and
// the fragment intensity is oldArea/newArea via screen-space derivatives —
// triangles that converge get brighter. Ocean adaptations: camera-local
// caustic region re-rendered per frame, locally-flat seabed plane at the
// region's average depth, additive blending so folded sheets add light, and
// depth-dependent blur + absorption at sampling time. No sphere shadow.
//
// causticsNode: the old procedural Worley web (kept for comparison and as a
// cheap fallback for the lite tier).
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uniform, pow, saturate, min, max, clamp, mix,
  mx_worley_noise_float, oneMinus, positionLocal, varying, normalize,
  refract, length, dFdx, dFdy, smoothstep, texture, fwidth,
} from 'three/tsl';
import { makeFieldFns } from './OceanMaterial.js';
import { MAX_SWELL } from './gerstner.js';

const IOR_RATIO = 1 / 1.333; // air → water

/**
 * causticsNode(worldXZ, time, scale) → float intensity [0..~1.5].
 * (procedural; superseded by makeCausticsPass for the demo seabed)
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

/** Fresh uniform bag for one material (shared floats break on fallback). */
function fieldUniforms() {
  return {
    time: uniform(0),
    tiles: uniform(new THREE.Vector3(256, 59, 13)),
    texels: uniform(new THREE.Vector3(1, 59 / 256, 13 / 256)),
    detailNormal: uniform(0.3),
    swellA: uniform(new THREE.Vector4(1, 0, 0, 1)),
    swellB: uniform(new THREE.Vector4(1, 0, 0, 1)),
    swellC: uniform(new THREE.Vector4(1, 0, 0, 1)),
    swellQ: uniform(new THREE.Vector3(0, 0, 0)),
    swellOmega: uniform(new THREE.Vector3(0, 0, 0)),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    regionCenter: uniform(new THREE.Vector2(0, 0)),
    bedY: uniform(-8),
  };
}

function syncFieldUniforms(cu, waterU, swellSim) {
  cu.tiles.value.copy(waterU.tiles.value);
  cu.texels.value.copy(waterU.texels.value);
  cu.detailNormal.value = waterU.detailNormal.value;
  const packs = ['swellA', 'swellB', 'swellC'];
  for (let i = 0; i < MAX_SWELL; i++) {
    cu[packs[i]].value.copy(waterU[packs[i]].value);
  }
  cu.swellQ.value.copy(waterU.swellQ.value);
  cu.swellOmega.value.copy(waterU.swellOmega.value);
}

/**
 * Build the refracted-ray caustic map pass.
 * opts: { sim, mapSize=512, gridSegments=160, regionSize=56, mapExtent=48 }
 * Returns { update(renderer, waterU, swellSim, centerXZ, bedY),
 *           sampleAt: Fn(worldPos → intensity), texture, debugScene }.
 */
export function makeCausticsPass({ sim, mapSize = 768, gridSegments = 256, regionSize = 56, mapExtent = 48 }) {
  const cu = fieldUniforms(); // caustic-grid material's own uniforms
  const su = {
    // sampler-side uniforms (third material — own instances again)
    regionCenter: uniform(new THREE.Vector2(0, 0)),
    bedY: uniform(-8),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
  };
  const mapHalf = mapExtent / 2;

  const rt = new THREE.RenderTarget(mapSize, mapSize, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });

  // Unit grid on XZ in [-0.5, 0.5]².
  const S = gridSegments;
  const verts = new Float32Array((S + 1) * (S + 1) * 3);
  let p = 0;
  for (let j = 0; j <= S; j++) {
    for (let i = 0; i <= S; i++) {
      verts[p++] = i / S - 0.5;
      verts[p++] = 0;
      verts[p++] = j / S - 0.5;
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
      // Alternate the quad diagonal: a uniform split direction turns the
      // per-triangle derivative asymmetry into diagonal dash artifacts in
      // the caustic web.
      if ((i + j) % 2 === 0) {
        index[q++] = a; index[q++] = c; index[q++] = b;
        index[q++] = b; index[q++] = c; index[q++] = d;
      } else {
        index[q++] = a; index[q++] = c; index[q++] = d;
        index[q++] = a; index[q++] = d; index[q++] = b;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));

  const dispTex = sim.dispTextures.map((t) => texture(t));
  const normTex = sim.normTextures.map((t) => texture(t));
  const fields = makeFieldFns(cu, dispTex, normTex);

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  mat.side = THREE.DoubleSide;

  const gridSpacing = float(regionSize / S);
  const wxz = positionLocal.xz.mul(regionSize).add(cu.regionCenter);
  const disp = fields.fftDisp(wxz, gridSpacing).add(fields.swellDisp(wxz, gridSpacing));
  const surfP = vec3(wxz.x.add(disp.x), disp.y, wxz.y.add(disp.z));
  const slopes = fields.fftSlopes(wxz, gridSpacing, float(1)).add(fields.swellSlopes(wxz, gridSpacing));
  const nrm = normalize(vec3(slopes.x.negate(), 1, slopes.y.negate()));

  const inc = cu.sunDir.negate(); // light travel direction
  const rTrue = refract(inc, nrm, float(IOR_RATIO));
  const rFlat = refract(inc, vec3(0, 1, 0), float(IOR_RATIO));
  // Land both rays on the locally-flat seabed plane y = bedY. The true ray
  // starts at the displaced surface point; the reference ray starts at the
  // undisplaced grid point on the mean plane y = 0.
  const tNew = surfP.y.sub(cu.bedY).div(max(rTrue.y.negate(), 0.05));
  const newPos = surfP.add(rTrue.mul(tNew));
  const tOld = cu.bedY.negate().div(max(rFlat.y.negate(), 0.05));
  const oldPos = vec3(wxz.x, 0, wxz.y).add(rFlat.mul(tOld));

  const vOld = varying(oldPos.xz);
  const vNew = varying(newPos.xz);

  // The backend writes render targets row-flipped relative to sampling
  // conventions (proven by the GPU-FFT chain probes) — negate clip-space y
  // so the map's rows match the sampler's uv mapping.
  const ndc = newPos.xz.sub(cu.regionCenter).div(mapHalf);
  mat.vertexNode = vec4(ndc.x, ndc.y.negate(), 0, 1);

  mat.colorNode = Fn(() => {
    // Ratio of the reference (flat-surface) footprint to the true refracted
    // footprint: converging rays → smaller newArea → brighter.
    const oldArea = length(dFdx(vOld)).mul(length(dFdy(vOld)));
    const newArea = length(dFdx(vNew)).mul(length(dFdy(vNew)));
    const inten = clamp(oldArea.div(max(newArea, float(1e-6))), 0.0, 6.0);
    return vec4(inten, inten, inten, 1.0);
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); // unused (vertexNode overrides)
  camera.position.z = 1;

  const mapTex = texture(rt.texture);

  /** TSL: caustic light factor at a world position (≈1 neutral). */
  const sampleAt = Fn(([wp]) => {
    const rF = refract(su.sunDir.negate(), vec3(0, 1, 0), float(IOR_RATIO));
    // Shift the point along the flat-refraction direction onto the plane the
    // map was rendered against (corrects for local bed height ≠ plane).
    const tt = su.bedY.sub(wp.y).div(rF.y);
    const sxz = wp.xz.add(rF.xz.mul(tt));
    const rel = sxz.sub(su.regionCenter);
    const uv = rel.div(mapHalf * 2).add(0.5);
    // Depth-dependent blur: 5 taps widening with depth, and never narrower
    // than the screen footprint (the half-float map has no mips, so grazing
    // views otherwise alias into dotted rows).
    const depth = max(wp.y.negate(), 0.0);
    const foot = max(fwidth(sxz.x), fwidth(sxz.y));
    const r = max(depth.mul(0.045).add(0.08), foot.mul(0.85)).div(mapHalf * 2);
    const c0 = mapTex.sample(uv).r;
    const c1 = mapTex.sample(uv.add(vec2(r, r))).r;
    const c2 = mapTex.sample(uv.add(vec2(r.negate(), r))).r;
    const c3 = mapTex.sample(uv.add(vec2(r, r.negate()))).r;
    const c4 = mapTex.sample(uv.add(vec2(r.negate(), r.negate()))).r;
    const inten = c0.mul(0.36).add(c1.add(c2).add(c3).add(c4).mul(0.16));
    // Fade to neutral 1.0 at the region edge and (softly) with depth.
    const edge = oneMinus(smoothstep(float(0.38), float(0.5), max(uv.x.sub(0.5).abs(), uv.y.sub(0.5).abs())));
    const depthFade = oneMinus(smoothstep(float(14.0), float(30.0), depth));
    return mix(float(1.0), inten, edge.mul(depthFade));
  });

  return {
    texture: rt.texture,
    uniforms: { cu, su },
    sampleAt,
    async update(renderer, waterU, swellSim, centerXZ, bedY) {
      syncFieldUniforms(cu, waterU, swellSim);
      cu.time.value = waterU.time.value;
      cu.sunDir.value.copy(waterU.sunDir.value);
      cu.regionCenter.value.copy(centerXZ);
      cu.bedY.value = bedY;
      su.regionCenter.value.copy(centerXZ);
      su.bedY.value = bedY;
      su.sunDir.value.copy(waterU.sunDir.value);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      await renderer.renderAsync(scene, camera);
      renderer.setRenderTarget(prev);
    },
    dispose() {
      rt.dispose();
      geo.dispose();
      mat.dispose();
    },
  };
}
