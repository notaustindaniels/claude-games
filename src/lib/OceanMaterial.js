// The ocean surface material (TSL). Custom-lit MeshBasicNodeMaterial:
// FFT displacement + Gerstner swell in the vertex stage; Fresnel/GGX/
// absorption/foam/reflection shading in the fragment stage. Works on the
// WebGPU backend and the WebGL2 fallback identically.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, texture, positionLocal, cameraPosition, varying, float, vec2,
  vec3, normalize, dot, max, min, clamp, saturate, mix, exp, pow, abs, sin,
  cos, reflect, refract, smoothstep, oneMinus, length, mx_noise_float, select,
  frontFacing, reflector, fwidth, attribute, dFdx, dFdy,
} from 'three/tsl';
import { MAX_SWELL } from './gerstner.js';
import { causticsNode } from './caustics.js';

export function makeOceanUniforms(cfg) {
  const w = cfg.water;
  return {
    time: uniform(0),
    meshOffset: uniform(new THREE.Vector2(0, 0)),
    // Cascade tile sizes / texel sizes (metres). x = structural cascade
    // (foam space), y = mid, z = fine chop.
    tiles: uniform(new THREE.Vector3(cfg.sim.tileSize, 59, 13)),
    texels: uniform(new THREE.Vector3(cfg.sim.tileSize / 256, 59 / 256, 13 / 256)),
    // Swell: per-wave vec4(dirX, dirZ, amp, k) + q/omega packed per component.
    swellA: uniform(new THREE.Vector4(1, 0, 0, 1)),
    swellB: uniform(new THREE.Vector4(1, 0, 0, 1)),
    swellC: uniform(new THREE.Vector4(1, 0, 0, 1)),
    swellQ: uniform(new THREE.Vector3(0, 0, 0)),
    swellOmega: uniform(new THREE.Vector3(0, 0, 0)),
    // Sun / sky.
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    sunColor: uniform(new THREE.Color(1, 0.98, 0.92)),
    sunIntensity: uniform(1),
    zenith: uniform(new THREE.Color(cfg.sky.zenith)),
    horizon: uniform(new THREE.Color(cfg.sky.horizon)),
    haze: uniform(new THREE.Color(cfg.sky.haze)),
    // Wind (unit vector, for foam streak anisotropy).
    windDir: uniform(new THREE.Vector2(1, 0)),
    // Water body.
    absorption: uniform(new THREE.Vector3(...w.absorption)),
    scatterColor: uniform(new THREE.Color(w.scatterColor)),
    sssColor: uniform(new THREE.Color(w.sssColor)),
    sssStrength: uniform(w.sssStrength),
    roughness: uniform(w.roughness),
    detailNormal: uniform(w.detailNormal),
    // Foam.
    foamColor: uniform(new THREE.Color(0xf4f8f9)),
    ambientFoam: uniform(w.ambientFoam),
    contactFoamDepth: uniform(w.contactFoamDepth),
    // Seabed (heightfield texture R channel, world-rect mapping).
    seabedBounds: uniform(new THREE.Vector4(-500, -500, 1000, 1000)),
    seabedDeep: uniform(-45),
    // Distance fades.
    dispFadeStart: uniform(400),
    dispFadeEnd: uniform(1600),
    fogStart: uniform(2500),
    fogEnd: uniform(9000),
    // Reflection.
    reflectionStrength: uniform(1),
    reflDistortion: uniform(0.05),
    // Underwater.
    uwFogColor: uniform(new THREE.Color(0x0b3d54)),
    uwFogDensity: uniform(0.028),
    camSubmerged: uniform(0),
  };
}

/** Push preset-derived values into the uniform bag (swell in sim form). */
export function applyConfigToUniforms(u, cfg, swellSim, N = 256) {
  const w = cfg.water;
  u.windDir.value.set(
    Math.cos(cfg.sim.windDirectionRad ?? 0),
    Math.sin(cfg.sim.windDirectionRad ?? 0)
  );
  u.tiles.value.set(cfg.sim.tileSize, 59, 13);
  u.texels.value.set(cfg.sim.tileSize / N, 59 / N, 13 / N);
  const packs = [u.swellA, u.swellB, u.swellC];
  for (let i = 0; i < MAX_SWELL; i++) {
    const s = swellSim[i];
    packs[i].value.set(s.dirX, s.dirZ, s.amp, s.k);
    u.swellQ.value.setComponent(i, s.q);
    u.swellOmega.value.setComponent(i, s.omega);
  }
  u.absorption.value.set(...w.absorption);
  u.scatterColor.value.set(w.scatterColor);
  u.sssColor.value.set(w.sssColor);
  u.sssStrength.value = w.sssStrength;
  u.roughness.value = w.roughness;
  u.detailNormal.value = w.detailNormal;
  u.ambientFoam.value = w.ambientFoam;
  u.contactFoamDepth.value = w.contactFoamDepth;
  u.zenith.value.set(cfg.sky.zenith);
  u.horizon.value.set(cfg.sky.horizon);
  u.haze.value.set(cfg.sky.haze);
  u.sunIntensity.value = cfg.sky.sunIntensity;
}

const SWIZ = ['x', 'y', 'z'];

/**
 * Surface-field evaluators shared by the water material and the caustics
 * pass. IMPORTANT: pass each material its OWN uniform bag `u` — shared float
 * uniform nodes silently read 0 in second materials on the WebGL2 fallback.
 */
export function makeFieldFns(u, dispTex, normTex) {
  const swellPacks = [u.swellA, u.swellB, u.swellC];

  // sampleSize: local metres the caller can resolve; waves shorter than
  // that fade out before aliasing.
  const swellWaveFade = (p, sampleSize) => {
    const lambda = float(2 * Math.PI).div(p.w);
    return oneMinus(smoothstep(lambda.mul(0.07), lambda.mul(0.16), sampleSize));
  };

  const swellDisp = Fn(([wxz, sampleSize]) => {
    const disp = vec3(0).toVar();
    for (let i = 0; i < MAX_SWELL; i++) {
      const p = swellPacks[i];
      const q = u.swellQ[SWIZ[i]];
      const om = u.swellOmega[SWIZ[i]];
      const phase = p.w.mul(p.x.mul(wxz.x).add(p.y.mul(wxz.y))).sub(om.mul(u.time));
      const c = cos(phase);
      const s = sin(phase);
      const fadeW = swellWaveFade(p, sampleSize);
      disp.addAssign(vec3(
        p.x.mul(q).mul(p.z).mul(c),
        p.z.mul(s),
        p.y.mul(q).mul(p.z).mul(c)
      ).mul(fadeW));
    }
    return disp;
  });

  const swellSlopes = Fn(([wxz, sampleSize]) => {
    const nx = float(0).toVar();
    const nz = float(0).toVar();
    const ny = float(1).toVar();
    for (let i = 0; i < MAX_SWELL; i++) {
      const p = swellPacks[i];
      const q = u.swellQ[SWIZ[i]];
      const om = u.swellOmega[SWIZ[i]];
      const phase = p.w.mul(p.x.mul(wxz.x).add(p.y.mul(wxz.y))).sub(om.mul(u.time));
      const c = cos(phase);
      const s = sin(phase);
      const ka = p.w.mul(p.z).mul(swellWaveFade(p, sampleSize));
      nx.addAssign(p.x.mul(ka).mul(c));
      nz.addAssign(p.y.mul(ka).mul(c));
      ny.subAssign(q.mul(ka).mul(s));
    }
    const inv = float(1).div(max(ny, 0.35));
    return vec2(nx.mul(inv), nz.mul(inv));
  });

  // Combined FFT displacement across cascades. Each cascade fades out when
  // the local grid spacing can no longer represent its WAVELENGTH BAND
  // (λ/3 rule) — texel size is the wrong criterion (a 2.7 m mesh renders
  // 30 m waves regardless of texture resolution). Band edges are literals
  // (cascade 0's top edge derives from its tile size).
  const SW = ['x', 'y', 'z'];
  const BAND_MIN = [29.5, 6.5, 0.45];
  const fftDisp = Fn(([wxz, sampleSize]) => {
    const disp = vec3(0).toVar();
    for (let c = 0; c < dispTex.length; c++) {
      // NOTE: literal edges only — uniform-derived smoothstep edges read 0
      // in the vertex stage on the WebGL2 fallback.
      const fade = oneMinus(smoothstep(float(BAND_MIN[c] / 5), float(BAND_MIN[c] / 2.5), sampleSize));
      disp.addAssign(dispTex[c].sample(wxz.div(u.tiles[SW[c]])).xyz.mul(fade));
    }
    return disp;
  });

  // Combined slopes across cascades; `fade` scales the whole result, the
  // per-cascade footprint kill handles minification. The fine cascade is
  // scaled by detailNormal so calm presets read glassier.
  const fftSlopes = Fn(([wxz, footprint, fade]) => {
    const sl = vec2(0).toVar();
    for (let c = 0; c < normTex.length; c++) {
      const texel = u.texels[SW[c]];
      const keep = oneMinus(smoothstep(texel.mul(0.5), texel.mul(3.0), footprint));
      const n = normTex[c].sample(wxz.div(u.tiles[SW[c]]));
      const w = c === 2 ? keep.mul(u.detailNormal.mul(2.4)) : keep;
      sl.addAssign(vec2(
        n.x.negate().div(max(n.y, 0.2)),
        n.z.negate().div(max(n.y, 0.2))
      ).mul(w));
    }
    return sl.mul(fade);
  });

  return { swellDisp, swellSlopes, fftDisp, fftSlopes };
}

/**
 * Build the water material.
 * deps: {
 *   sim: OceanSim,
 *   skyColorFn: TSL Fn(dir) → color,
 *   seabedTexture: THREE.Texture | null,
 *   reflection: { enabled, resolutionScale, onReflector(node) } | null,
 * }
 */
export function makeOceanMaterial(u, deps) {
  const { sim, skyColorFn, seabedTexture } = deps;
  // lite: strip per-fragment noise (detail normals, ambient/contact foam
  // texture, in-water caustics) — the dominant fragment cost in software
  // rasterizers. Crest foam, Fresnel, absorption and swell remain.
  const lite = !!deps.lite;
  const dispTex = sim.dispTextures.map((t) => texture(t));
  const normTex = sim.normTextures.map((t) => texture(t));
  const foamTex = texture(sim.foamTexture);
  const seabedTex = seabedTexture ? texture(seabedTexture) : null;
  const laceTex = deps.laceTexture ? texture(deps.laceTexture) : null;

  const material = new THREE.MeshBasicNodeMaterial({ fog: false });
  material.side = THREE.DoubleSide;

  const { swellDisp, swellSlopes, fftDisp, fftSlopes } =
    makeFieldFns(u, dispTex, normTex);

  // ---- Vertex stage ----
  const worldXZ = positionLocal.xz.add(u.meshOffset);
  const gridSpacing = attribute('spacing', 'float');
  // Each displacement source fades before the local grid density
  // undersamples it (moiré/chevron artifacts otherwise). Swell geometry
  // additionally damps with camera distance — from altitude the twin swell
  // trains read as synthetic interference bands.
  const vertCamDist = length(vec3(worldXZ.x, 0, worldXZ.y).sub(cameraPosition));
  const swellDistDamp = mix(float(1.0), float(0.25), smoothstep(float(600), float(1800), vertCamDist));
  const totalD = fftDisp(worldXZ, gridSpacing)
    .add(swellDisp(worldXZ, gridSpacing).mul(swellDistDamp));

  material.positionNode = positionLocal.add(totalD);

  const vWorldPos = varying(vec3(worldXZ.x.add(totalD.x), totalD.y, worldXZ.y.add(totalD.z)));
  const vRefXZ = varying(worldXZ); // pre-displacement reference for texture UVs
  const vWaveHeight = varying(totalD.y);

  const seabedHeight = Fn(([wxz]) => {
    if (!seabedTex) return vec3(u.seabedDeep).x;
    const b = u.seabedBounds;
    const suv = wxz.sub(vec2(b.x, b.y)).div(vec2(b.z, b.w));
    const inside = suv.x.greaterThan(0.001)
      .and(suv.x.lessThan(0.999))
      .and(suv.y.greaterThan(0.001))
      .and(suv.y.lessThan(0.999));
    const h = seabedTex.sample(clamp(suv, 0, 1)).r;
    return select(inside, h, u.seabedDeep);
  });

  // ---- Fragment stage ----
  material.colorNode = Fn(() => {
    const wxz = vRefXZ;
    // Fades must be per-fragment: the far grid triangles are hundreds of
    // metres long, and vertex-interpolated fades stay nonzero far beyond
    // their intended range, leaking aliased normal samples to the horizon.
    const camDistF = length(vWorldPos.sub(cameraPosition));
    const camDist = camDistF;

    // Where a pixel's ground footprint exceeds a cascade's texel, that
    // cascade's high-frequency content aliases into per-pixel speckle —
    // there are no float-texture mips on the fallback backend. This is
    // manual mip logic: fwidth gives metres-per-pixel; each cascade fades
    // out as the footprint crosses its texel (inside fftSlopes), and the
    // noisy shading terms follow the mid cascade's kill.
    // Isotropic footprint (mean derivative length): max(fwidth x, fwidth z)
    // kinks along the lines where the argmax flips, which draws a radial fan
    // of cascade-fade bands across high-altitude views.
    const footprint = length(dFdx(vWorldPos.xz)).add(length(dFdy(vWorldPos.xz))).mul(0.5);
    const detailKill = smoothstep(u.texels.y.mul(0.5), u.texels.y.mul(3.0), footprint);
    const distRough = detailKill;

    // Normal assembly: per-cascade FFT slopes + swell slopes. The fine
    // cascade replaces the old procedural detail-normal noise.
    const sFFT = fftSlopes(wxz, footprint, float(1));
    // Far swell slopes stay resolvable but two pure sines read as synthetic
    // chevron bands from altitude — decorrelate by damping with distance.
    const sSwell = swellSlopes(wxz, footprint)
      .mul(mix(float(1.0), float(0.22), smoothstep(float(600), float(2000), camDistF)));
    const slopes = sFFT.add(sSwell);
    const nUp = normalize(vec3(slopes.x.negate(), 1, slopes.y.negate()));

    const V = normalize(cameraPosition.sub(vWorldPos));
    const NdotV = saturate(dot(nUp, V));

    // Foam amount: GPU-advected persistent foam (cascade-0 space) + ambient
    // windrow foam + shoreline contact band.
    // The half-float foam field has no mips on the fallback backend and
    // advection writes texel-scale structure into it, so a single sample
    // speckles once the pixel footprint reaches the texel: take a 4-tap
    // diagonal box blur scaled by footprint (a manual mip).
    const foamBlurR = footprint.mul(0.4).add(u.texels.x.mul(0.25));
    const foamSim = foamTex.sample(wxz.add(vec2(foamBlurR, foamBlurR)).div(u.tiles.x)).x
      .add(foamTex.sample(wxz.add(vec2(foamBlurR.negate(), foamBlurR)).div(u.tiles.x)).x)
      .add(foamTex.sample(wxz.add(vec2(foamBlurR, foamBlurR.negate())).div(u.tiles.x)).x)
      .add(foamTex.sample(wxz.add(vec2(foamBlurR.negate(), foamBlurR.negate())).div(u.tiles.x)).x)
      .mul(0.25);
    let ambFoam = float(0);
    if (!lite) {
      const ambPat = mx_noise_float(vec3(wxz.mul(0.055), u.time.mul(0.05)))
        .add(mx_noise_float(vec3(wxz.mul(0.14).add(7.3), u.time.mul(0.08))).mul(0.5));
      ambFoam = smoothstep(float(0.55), float(1.1), ambPat).mul(u.ambientFoam.mul(2.5));
    }
    const bedY = seabedHeight(wxz);
    const waterDepth = max(vWorldPos.y.sub(bedY), 0.0);
    const contactPulse = sin(u.time.mul(1.7).sub(waterDepth.mul(2.2))).mul(0.5).add(0.5);
    const contactNoise = lite
      ? float(0.5)
      : mx_noise_float(vec3(wxz.mul(0.35), u.time.mul(0.22))).mul(0.5).add(0.5);
    const contactFoam = oneMinus(smoothstep(float(0), u.contactFoamDepth, waterDepth))
      .mul(contactNoise.mul(0.7).add(contactPulse.mul(0.5)))
      .mul(1.4);
    // The foam field texture has no mips on the fallback backend; fade it
    // out once the pixel footprint exceeds its texel (later than the normal
    // detail kill — foam blobs are metres wide and survive further).
    const foamKill = smoothstep(u.texels.x.mul(5.0), u.texels.x.mul(24.0), footprint);
    // Shape the field: cut the low-value haze that advection smears across
    // whole convergence bands (it binarizes into dust), keep the mat cores.
    const foamShaped = saturate(foamSim.mul(1.3).sub(0.09));
    const foamAmt = saturate(foamShaped.add(contactFoam)).mul(oneMinus(foamKill));

    // Lace coverage: threshold the breakup texture by foam amount, so a
    // saturated mat is solid-with-holes, and decaying/stretching foam tears
    // into a connected filament web (matches the reference foam structure).
    // Ambient windrow foam stays SOFT (translucent streaks) — thresholding
    // its low values binarizes into speckle dust.
    let foam;
    let foamShade = float(1);
    if (laceTex) {
      // Anisotropic lace UVs: real foam streaks elongate along the wind
      // (windrows, stretched mats), so stretch the pattern 2.3× along it.
      const wd = u.windDir;
      const laceP = vec2(
        wxz.x.mul(wd.x).add(wxz.y.mul(wd.y)).div(2.3),
        wxz.y.mul(wd.x).sub(wxz.x.mul(wd.y))
      );
      const lace1 = laceTex.sample(laceP.div(3.1)).r;
      const lace2 = laceTex.sample(laceP.div(11.9).add(vec2(0.37, 0.11))).r;
      const coarse = laceTex.sample(laceP.div(29.0).add(vec2(0.71, 0.53))).g;
      // Near-field centimetre bubbles, blended in only while resolvable.
      const lace0 = laceTex.sample(laceP.div(1.05).add(vec2(0.83, 0.29))).r;
      const fineW = oneMinus(smoothstep(float(0.012), float(0.06), footprint)).mul(0.38);
      const laceBase = lace1.mul(0.58).add(lace2.mul(0.42));
      const lace = laceBase.mul(oneMinus(fineW)).add(lace0.mul(fineW))
        .add(coarse.sub(0.5).mul(0.16));
      const th = oneMinus(foamAmt).mul(0.92);
      const cov = smoothstep(th, th.add(0.17), lace);
      const laced = cov.mul(smoothstep(float(0.05), float(0.16), foamAmt));
      const ambient = ambFoam.mul(lace.mul(0.5).add(0.35)).mul(oneMinus(detailKill.mul(0.7)));
      foam = max(laced, saturate(ambient));
      // Bubble-scale shading: holes read slightly darker than the film.
      foamShade = mix(float(0.76), float(1.04), lace).add(foamAmt.mul(0.05));
    } else {
      foam = saturate(foamAmt.add(ambFoam).mul(1.1))
        .mul(smoothstep(float(0.05), float(0.4), foamAmt.add(ambFoam)));
    }

    // Fresnel (Schlick, F0 = 0.02). Stays smooth at distance because the
    // slopes feeding nUp are already flattened by detailKill.
    const fres = float(0.02).add(pow(oneMinus(NdotV), float(5.0)).mul(0.98))
      .mul(mix(float(1.0), float(0.6), distRough));

    // Reflection: planar reflector when enabled, procedural sky otherwise.
    const reflDir0 = reflect(V.negate(), nUp);
    const reflDir = vec3(reflDir0.x, max(reflDir0.y, 0.015), reflDir0.z);
    let reflColor = skyColorFn(reflDir);
    if (deps.reflection?.enabled) {
      const mirror = reflector({ bounces: false });
      mirror.reflector.resolutionScale = deps.reflection.resolutionScale ?? 0.5;
      mirror.uvNode = mirror.uvNode.add(slopes.mul(u.reflDistortion));
      deps.reflection.onReflector(mirror);
      reflColor = mirror.rgb;
    }

    // Refraction / water body: Beer-Lambert through estimated path length.
    const slant = waterDepth.div(max(abs(V.y), 0.12));
    const path = waterDepth.add(min(slant, waterDepth.mul(8).add(6)));
    const trans = exp(u.absorption.mul(path.negate()));
    const caus = lite
      ? float(0)
      : causticsNode(wxz, u.time, float(0.35))
          .mul(oneMinus(smoothstep(float(0.5), float(6.0), waterDepth)));
    const sunFactor = saturate(u.sunDir.y.mul(2.5)).mul(u.sunIntensity);
    const sandColor = vec3(0.76, 0.7, 0.58).mul(caus.mul(0.55).add(0.75));
    const bodyColor = mix(u.scatterColor, sandColor.mul(sunFactor.mul(0.85).add(0.15)), trans);

    // Subsurface scattering on backlit wave flanks.
    const sunHoriz = normalize(vec3(u.sunDir.x, 0, u.sunDir.z));
    const towardSun = saturate(dot(V.negate(), sunHoriz));
    const heightBoost = mix(saturate(vWaveHeight.mul(0.35).add(0.4)), float(0.45), detailKill);
    const grazing = pow(oneMinus(NdotV), float(2.0));
    const sss = u.sssColor.mul(
      pow(towardSun, float(3.0)).mul(heightBoost).mul(u.sssStrength)
        .mul(grazing.mul(0.85).add(0.15)).mul(sunFactor)
    ).mul(oneMinus(distRough.mul(0.75)));

    // Specular sun glint (GGX distribution + Schlick fresnel, simple vis).
    const L = u.sunDir;
    const H = normalize(V.add(L));
    const NdotH = saturate(dot(nUp, H));
    const NdotL = saturate(dot(nUp, L));
    const a = clamp(mix(u.roughness, float(0.3), distRough), 0.02, 0.5);
    const a2 = a.mul(a);
    const dDen = NdotH.mul(NdotH).mul(a2.sub(1)).add(1);
    const D = a2.div(dDen.mul(dDen).mul(Math.PI));
    const FH = float(0.02).add(pow(oneMinus(saturate(dot(V, H))), float(5.0)).mul(0.98));
    const spec = u.sunColor.mul(D.mul(FH).mul(NdotL).mul(0.25).mul(u.sunIntensity));

    // Compose (above-water).
    let water = mix(bodyColor.add(sss), reflColor, fres.mul(u.reflectionStrength));
    if (laceTex) {
      // Translucent foam film: where foam amount exists but the lace mat has
      // torn away, the surface keeps a milky green-white stain (the
      // reference foam always shows this stage between mat and clear water).
      const film = smoothstep(float(0.12), float(0.6), foamAmt)
        .mul(oneMinus(foam)).mul(0.28);
      const filmColor = u.foamColor.mul(vec3(0.8, 0.92, 0.96))
        .mul(NdotL.mul(0.6).add(0.4)).mul(max(u.sunIntensity, 0.4));
      water = mix(water, filmColor, film);
    }
    const foamLight = u.foamColor.mul(foamShade)
      .mul(NdotL.mul(0.75).add(0.48)).mul(max(u.sunIntensity, 0.4));
    const above = mix(water, foamLight, foam).add(spec.mul(oneMinus(foam)));

    // Underside (camera underwater looking up at the surface).
    const upDot = saturate(dot(V.negate(), nUp)); // V points down toward camera
    const snell = smoothstep(float(0.6), float(0.8), upDot);
    // Through the Snell window the view refracts into the sky — perturbed by
    // the wave normal so crests shimmer; outside it the surface is a dim
    // mirror whose brightness follows the sun-facing slope, so wave
    // structure stays readable from below instead of flat murk.
    const refr = refract(V.negate(), nUp.negate(), float(1.333));
    const refrValid = dot(refr, refr).greaterThan(0.0001);
    const skyDir = select(refrValid, normalize(refr), vec3(V.x.negate(), abs(V.y), V.z.negate()));
    const skyThrough = skyColorFn(skyDir);
    const slopeSun = saturate(slopes.x.mul(u.sunDir.x).add(slopes.y.mul(u.sunDir.z)).mul(-1.6).add(0.5));
    const tirShade = u.uwFogColor.mul(slopeSun.mul(0.7).add(0.4));
    const belowBase = mix(tirShade, skyThrough.mul(0.85), snell);
    const below = mix(belowBase, u.foamColor.mul(0.55), foam.mul(0.6));
    const belowFogged = mix(below, u.uwFogColor, oneMinus(exp(camDist.mul(u.uwFogDensity).negate())));

    // Aerial perspective toward the horizon (above only). Steep down-looks
    // pass through less low-altitude haze than grazing ones.
    const slantScale = oneMinus(abs(V.y).mul(0.75));
    const fogF = smoothstep(u.fogStart, u.fogEnd, camDist.mul(slantScale));
    const horizonCol = skyColorFn(normalize(vec3(V.x.negate(), 0.015, V.z.negate())));
    const aboveFogged = mix(above, horizonCol, fogF);

    // A submerged camera must get the underwater treatment even for
    // front-facing far triangles (displaced geometry can present its top
    // face from below, which would otherwise render bright horizon fog).
    const useAbove = frontFacing.and(u.camSubmerged.lessThan(0.5));
    return select(useAbove, aboveFogged, belowFogged);
  })();

  return material;
}
