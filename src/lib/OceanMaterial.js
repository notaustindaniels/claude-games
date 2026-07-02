// The ocean surface material (TSL). Custom-lit MeshBasicNodeMaterial:
// FFT displacement + Gerstner swell in the vertex stage; Fresnel/GGX/
// absorption/foam/reflection shading in the fragment stage. Works on the
// WebGPU backend and the WebGL2 fallback identically.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, texture, positionLocal, cameraPosition, varying, float, vec2,
  vec3, normalize, dot, max, min, clamp, saturate, mix, exp, pow, abs, sin,
  cos, reflect, smoothstep, oneMinus, length, mx_noise_float, select,
  frontFacing, reflector, fwidth, attribute,
} from 'three/tsl';
import { MAX_SWELL } from './gerstner.js';
import { causticsNode } from './caustics.js';

export function makeOceanUniforms(cfg) {
  const w = cfg.water;
  return {
    time: uniform(0),
    meshOffset: uniform(new THREE.Vector2(0, 0)),
    tileSize: uniform(cfg.sim.tileSize),
    fftTexel: uniform(cfg.sim.tileSize / 256),
    secScale: uniform(cfg.secondary.scale),
    secAmp: uniform(cfg.secondary.weight * cfg.secondary.scale * 0.5),
    secNormWeight: uniform(cfg.secondary.weight),
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
export function applyConfigToUniforms(u, cfg, swellSim) {
  const w = cfg.water;
  u.tileSize.value = cfg.sim.tileSize;
  u.secScale.value = cfg.secondary.scale;
  u.secAmp.value = cfg.secondary.weight * cfg.secondary.scale * 0.5;
  u.secNormWeight.value = cfg.secondary.weight;
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
  const dispTex = texture(sim.dispTexture);
  const normTex = texture(sim.normTexture);
  const seabedTex = seabedTexture ? texture(seabedTexture) : null;

  const material = new THREE.MeshBasicNodeMaterial({ fog: false });
  material.side = THREE.DoubleSide;

  // ---- Swell displacement (must mirror gerstner.js evalSwell) ----
  const swellPacks = [u.swellA, u.swellB, u.swellC];

  // sampleSize: local metres the caller can resolve (grid spacing in the
  // vertex stage, pixel footprint in the fragment stage). Each swell wave
  // fades out before it aliases against that sampling density.
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

  // ---- FFT sampling, two scales (mirrors OceanSim.sampleDisplacement) ----
  const secUV = Fn(([wxz]) => {
    const t2 = u.tileSize.mul(u.secScale);
    return wxz.add(vec2(t2.mul(0.31), t2.mul(0.71))).div(t2);
  });

  // ---- Vertex stage ----
  const worldXZ = positionLocal.xz.add(u.meshOffset);
  const gridSpacing = attribute('spacing', 'float');
  // Fade each displacement source before the local grid density undersamples
  // it (moiré/chevron artifacts otherwise). FFT chop needs a few texels per
  // vertex; the secondary (stretched) sample survives 3.17× further; swell
  // fades per-wave against its own wavelength.
  const fftVertFade = oneMinus(smoothstep(u.fftTexel.mul(2.0), u.fftTexel.mul(10.0), gridSpacing));
  const secVertFade = oneMinus(smoothstep(u.fftTexel.mul(2.0).mul(u.secScale), u.fftTexel.mul(10.0).mul(u.secScale), gridSpacing));
  const fftD = dispTex.sample(worldXZ.div(u.tileSize)).xyz.mul(fftVertFade)
    .add(dispTex.sample(secUV(worldXZ)).xyz.mul(u.secAmp).mul(secVertFade));
  const totalD = fftD.add(swellDisp(worldXZ, gridSpacing));

  material.positionNode = positionLocal.add(totalD);

  const vWorldPos = varying(vec3(worldXZ.x.add(totalD.x), totalD.y, worldXZ.y.add(totalD.z)));
  const vRefXZ = varying(worldXZ); // pre-displacement reference for texture UVs
  const vWaveHeight = varying(totalD.y);

  // ---- Fragment helpers ----
  const fftSlopes = Fn(([wxz, fade]) => {
    const n1 = normTex.sample(wxz.div(u.tileSize));
    const n2 = normTex.sample(secUV(wxz));
    const s1x = n1.x.negate().div(max(n1.y, 0.2));
    const s1z = n1.z.negate().div(max(n1.y, 0.2));
    const s2x = n2.x.negate().div(max(n2.y, 0.2)).mul(u.secNormWeight);
    const s2z = n2.z.negate().div(max(n2.y, 0.2)).mul(u.secNormWeight);
    return vec2(s1x.add(s2x), s1z.add(s2z)).mul(fade);
  });

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

    // Where a pixel's ground footprint exceeds the FFT texel, every
    // high-frequency term (minified texture normals, noise foam, per-vertex
    // wave height) aliases into per-pixel speckle — there are no
    // float-texture mips on the fallback backend. This is manual mip logic:
    // fwidth gives metres-per-pixel; converge everything noisy to smooth
    // distant-sea values as the footprint crosses the texel size.
    const footprint = max(fwidth(vWorldPos.x), fwidth(vWorldPos.z));
    const detailKill = smoothstep(u.fftTexel.mul(0.5), u.fftTexel.mul(3.0), footprint);
    const distRough = detailKill;
    const keepDetail = oneMinus(detailKill);

    // Normal assembly: FFT slopes (two scales) + swell slopes + micro detail.
    const sFFT = fftSlopes(wxz, keepDetail);
    // Far swell slopes stay resolvable but two pure sines read as synthetic
    // chevron bands from altitude — decorrelate by damping with distance.
    const sSwell = swellSlopes(wxz, footprint)
      .mul(mix(float(1.0), float(0.22), smoothstep(float(600), float(2000), camDistF)));
    let slopes = sFFT.add(sSwell);
    if (!lite) {
      const detailAmp = u.detailNormal.mul(keepDetail);
      const dn1 = mx_noise_float(vec3(wxz.mul(0.9), u.time.mul(0.7))).mul(detailAmp);
      const dn2 = mx_noise_float(vec3(wxz.mul(2.3).add(31.7), u.time.mul(0.9))).mul(detailAmp.mul(0.6));
      slopes = slopes.add(vec2(dn1, dn2));
    }
    const nUp = normalize(vec3(slopes.x.negate(), 1, slopes.y.negate()));

    const V = normalize(cameraPosition.sub(vWorldPos));
    const NdotV = saturate(dot(nUp, V));

    // Foam mask: persistent sim foam + ambient noise foam + shoreline contact.
    const foamSim = normTex.sample(wxz.div(u.tileSize)).w
      .add(normTex.sample(secUV(wxz)).w.mul(0.45));
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
    const foamRaw = saturate(foamSim.add(ambFoam).add(contactFoam)).mul(oneMinus(detailKill));
    // Fine pattern so foam reads as texture, not paint.
    const foamPat = lite
      ? float(0.5)
      : mx_noise_float(vec3(wxz.mul(1.4), u.time.mul(0.3))).mul(0.5).add(0.5);
    const foam = saturate(foamRaw.mul(foamPat.mul(0.6).add(0.55)).mul(1.25)).mul(
      smoothstep(float(0.06), float(0.5), foamRaw)
    );

    // Fresnel (Schlick, F0 = 0.02). Stays smooth at distance because the
    // slopes feeding nUp are already flattened by detailKill.
    const fres = float(0.02).add(pow(oneMinus(NdotV), float(5.0)).mul(0.98));

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
    const water = mix(bodyColor.add(sss), reflColor, fres.mul(u.reflectionStrength));
    const foamLight = u.foamColor.mul(NdotL.mul(0.85).add(0.35)).mul(max(u.sunIntensity, 0.4));
    const above = mix(water, foamLight, foam).add(spec.mul(oneMinus(foam)));

    // Underside (camera underwater looking up at the surface).
    const upDot = saturate(dot(V.negate(), nUp)); // V points down toward camera
    const snell = smoothstep(float(0.62), float(0.82), upDot);
    const skyThrough = skyColorFn(vec3(V.x.negate(), abs(V.y), V.z.negate()));
    const belowBase = mix(u.uwFogColor.mul(0.7), skyThrough.mul(0.85), snell);
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
