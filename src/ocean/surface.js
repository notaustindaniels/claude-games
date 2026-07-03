// Ocean surface: camera-following polar grid displaced by the FFT cascades.
// Shading is fully custom in TSL: Fresnel, GGX sun glint, analytic-sky +
// planar reflections, refracted-floor transmission with absorption/scatter,
// foam hook, and the R2 variance→roughness far-field pipeline.
import * as THREE from 'three/webgpu'
import {
  Fn, float, vec2, vec3, vec4, uniform, texture, mix, pow, max, min, abs,
  smoothstep, normalize, dot, reflect, refract, exp, sqrt, length, clamp,
  positionLocal, positionWorld, cameraPosition, frontFacing, select, sin, floor, step,
} from 'three/tsl'
import { seabedHeightAt, seabedAlbedoAt } from './seabed.js'
import { SEA_LEVEL } from './presets.js'

function polarGridGeometry (rings = 168, sectors = 360, r0 = 0.5, r1 = 6000) {
  const verts = []; const idx = []
  for (let i = 0; i < rings; i++) {
    const r = r0 * Math.pow(r1 / r0, i / (rings - 1))
    for (let j = 0; j < sectors; j++) {
      const a = j / sectors * Math.PI * 2
      verts.push(Math.cos(a) * r, 0, Math.sin(a) * r)
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < sectors; j++) {
      const j2 = (j + 1) % sectors
      const a = i * sectors + j, b = i * sectors + j2
      const c = (i + 1) * sectors + j, d = (i + 1) * sectors + j2
      idx.push(a, b, c, b, d, c) // CCW from +Y: front faces point up
    }
  }
  // center fan
  const centerIndex = verts.length / 3
  verts.push(0, 0, 0)
  for (let j = 0; j < sectors; j++) {
    idx.push(centerIndex, j, (j + 1) % sectors)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  g.setIndex(idx)
  return g
}

export function createSurface (scene, fft, sky, foam, caustics, reflJack) {
  const texLoader = new THREE.TextureLoader()
  const lace1 = texLoader.load('assets/foam002_color.jpg')
  const lace2 = texLoader.load('assets/foam003_color.jpg')
  for (const t of [lace1, lace2]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.colorSpace = THREE.NoColorSpace
  }
  const U = {
    snap: uniform(new THREE.Vector2(0, 0)),
    chop: uniform(1.2),
    absorb: uniform(new THREE.Vector3(0.3, 0.06, 0.05)),
    scatter: uniform(new THREE.Color(0.01, 0.1, 0.12)),
    scatterBoost: uniform(1.0),
    deepColor: uniform(new THREE.Color(0.01, 0.12, 0.16)),
    foamTint: uniform(new THREE.Color(0.9, 0.95, 0.96)),
    roughBase: uniform(0.03),
    slopeVar: uniform(new THREE.Vector3(0, 0, 0)), // per-cascade band slope variance (R2)
    sunTint: uniform(new THREE.Color(1, 1, 1)),   // sun color * intensity for water terms
    skyAmb: uniform(new THREE.Color(0.5, 0.6, 0.7)), // horizon skylight for the water body
    band: uniform(0),
    camUnder: uniform(0),
    foamAmbient: uniform(0.05),
    foamLace: uniform(1.0),
    time: uniform(0),
  }

  const uMirrorVP = uniform(new THREE.Matrix4())
  if (reflJack) reflJack.vp = uMirrorVP

  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide })

  // cascade fade distances (also drive the roughness compensation)
  const FADE = [[2600, 4200], [900, 1600], [160, 330]]
  const fadeAt = (i, dist) => float(1).sub(smoothstep(FADE[i][0], FADE[i][1], dist))

  mat.positionNode = Fn(() => {
    const w = positionLocal.xz.add(U.snap)
    const dist = length(positionLocal.xz)
    // taper horizontal chop right at the camera: a chop-folded triangle must
    // never sweep across the eye point (it reads as a giant dark/сand wedge)
    const chopFade = smoothstep(4.0, 24.0, dist)
    const d = vec3(0).toVar()
    for (let c = 0; c < 3; c++) {
      const s = fft.sampleDispLod0(c, w)
      const f = fadeAt(c, dist)
      d.addAssign(vec3(s.x.mul(U.chop).mul(chopFade), s.y, s.z.mul(U.chop).mul(chopFade)).mul(f))
    }
    return positionLocal.add(d)
  })()

  // slope + jacobian from the derivative textures (fragment stage, auto-LOD)
  const surfData = Fn(([w, dist]) => {
    const sx = float(0).toVar(); const sz = float(0).toVar()
    const jxx = float(1).toVar(); const jzz = float(1).toVar(); const jxz = float(0).toVar()
    const rough2 = U.roughBase.mul(U.roughBase).toVar()
    for (let c = 0; c < 3; c++) {
      const f = fadeAt(c, dist)
      const jc = fft.sampleDisp(c, w).w
      const dv = fft.sampleDeriv(c, w, jc)
      sx.addAssign(dv.slope.x.mul(f)); sz.addAssign(dv.slope.y.mul(f))
      jxx.addAssign(dv.jxx.mul(U.chop).mul(f))
      jzz.addAssign(dv.jzz.mul(U.chop).mul(f))
      jxz.addAssign(dv.jxz.mul(U.chop).mul(f))
      // variance→roughness: what the fade removes returns as micro-roughness
      const sv = c === 0 ? U.slopeVar.x : c === 1 ? U.slopeVar.y : U.slopeVar.z
      rough2.addAssign(sv.mul(float(1).sub(f)).mul(0.16))
    }
    const jac = jxx.mul(jzz).sub(jxz.mul(jxz))
    return vec4(sx, sz, jac, sqrt(rough2))
  })

  const ggxGlint = Fn(([n, v, l, rough]) => {
    const h = normalize(v.add(l))
    const ndh = max(dot(n, h), 0)
    const ndl = max(dot(n, l), 0)
    const ndv = max(dot(n, v), 1e-3)
    const a = max(rough, 0.015)
    const a2 = a.mul(a)
    const dnm = ndh.mul(ndh).mul(a2.sub(1)).add(1)
    const D = a2.div(dnm.mul(dnm).mul(Math.PI))
    const k = a.add(1).mul(a.add(1)).div(8)
    const G = ndl.div(ndl.mul(float(1).sub(k)).add(k))
      .mul(ndv.div(ndv.mul(float(1).sub(k)).add(k)))
    return D.mul(G).mul(ndl).div(ndv.mul(4).add(0.1))
  })

  const fuvV = () => positionWorld.xz.sub(foam.U.center).div(foam.span).add(0.5)

  mat.colorNode = Fn(() => {
    const w = positionWorld.xz
    const P = positionWorld
    const dist = length(P.xz.sub(cameraPosition.xz))
    const V = normalize(cameraPosition.sub(P))
    const waterLight = U.sunTint.mul(0.62).add(U.skyAmb.mul(0.58))
    const sd = surfData(w, dist)
    const n = normalize(vec3(sd.x.negate(), 1, sd.y.negate())).toVar()
    const rough = sd.w
    const sunD = normalize(sky.U.sunDir)

    // ---------- above-water shading ----------
    const nUp = n
    const cosV = max(dot(nUp, V), 1e-3)
    const F = float(0.02).add(pow(float(1).sub(cosV), 5).mul(0.98))
    const R = reflect(V.negate(), nUp).toVar()
    R.y = abs(R.y) // keep reflections skyward on steep flanks
    const skyReflBase = sky.skyColor(normalize(R))
    // planar prop reflection (alpha 0 where no prop), perturbed by the normals
    const clipR = uMirrorVP.mul(vec4(P, 1))
    const ruv = clipR.xy.div(max(clipR.w, 1e-4)).mul(0.5).add(0.5).add(n.xz.mul(0.06))
    const inR = step(0.001, ruv.x).mul(step(ruv.x, 0.999)).mul(step(0.001, ruv.y)).mul(step(ruv.y, 0.999)).mul(step(0.0, clipR.w))
    const planar = reflJack ? texture(reflJack.rt.texture, clamp(ruv, 0, 1)) : vec4(0)
    const skyRefl = mix(skyReflBase, planar.rgb, planar.a.mul(inR).mul(0.9))
    const glint = ggxGlint(nUp, V, sunD, rough).mul(U.sunTint).mul(sky.U.sunIntensity)

    // transmission: refract to the floor, absorb along the path, add scatter
    const refr = normalize(refract(V.negate(), nUp, 1 / 1.333))
    const floorY = seabedHeightAt(w)
    const tRay = max(P.y.sub(floorY), 0.5).div(max(refr.y.negate(), 0.08))
    const tPath = min(tRay, 220)
    const floorP = w.add(refr.xz.mul(tPath))
    const alb = seabedAlbedoAt(floorP)
    const att = exp(U.absorb.mul(tPath.add(max(float(0).sub(floorY), 0)).mul(1.0)).negate())
    const cau = caustics ? caustics.lightAt(floorP, clamp(exp(max(float(0).sub(floorY), 0).mul(-0.02)).mul(1.15), 0.25, 1)) : float(1)
    const floorCol = alb.mul(cau).mul(att).mul(max(dot(sunD, vec3(0, 1, 0)), 0).mul(0.8).add(0.2)).mul(waterLight)
    // in-water scatter: stronger looking down-sun through wave flanks + with wave height
    const hgt = P.y.sub(SEA_LEVEL)
    const sunFwd = max(dot(sunD.xz, V.xz.negate()), 0)
    const crestGlow = smoothstep(0.4, 2.6, hgt).mul(sunFwd).mul(1.35)
    const scat = U.scatter.mul(
      float(0.42).add(max(hgt, 0).mul(0.16)).add(sunFwd.mul(0.18)).add(crestGlow)
    ).mul(U.scatterBoost).mul(waterLight)
    const inscatter = float(1).sub(exp(U.absorb.mul(tPath.mul(0.9)).negate()))
    // swell-correlated color variation: deep water is never one flat color
    const swellMod = float(1).add(clamp(hgt.mul(0.11), -0.2, 0.28))
      .add(texture(foam.texture, fuvV()).x.mul(0.10))
    let trans = mix(floorCol, U.scatter.mul(U.scatterBoost).mul(0.55).mul(waterLight), inscatter).add(scat.mul(inscatter))
    const slopeTint = float(1).add(sd.x.add(sd.y).mul(0.42)).clamp(0.62, 1.45)
    trans = trans.mul(swellMod).mul(slopeTint)
    // stylized depth banding (seaofthieves): quantize the FLOOR depth so bands
    // terrace with the seabed instead of ringing around the camera
    const fDepth = clamp(float(0).sub(floorY), 0, 40)
    const q = fDepth.div(7.5)
    const bandQ = floor(q).add(smoothstep(0.3, 0.7, q.fract())).div(5.333).clamp(0, 1)
    trans = mix(trans, mix(U.scatter.mul(U.scatterBoost).mul(1.15), U.deepColor, bandQ).mul(waterLight), U.band.mul(0.28))

    const above = mix(trans, skyRefl, F).add(glint).toVar()

    // ---------- foam (R4): accumulation + whitecaps + ambient, lace-shaped ----------
    const fuv = w.sub(foam.U.center).div(foam.span).add(0.5)
    const finside = smoothstep(0.0, 0.02, fuv.x).mul(smoothstep(1.0, 0.98, fuv.x))
      .mul(smoothstep(0.0, 0.02, fuv.y)).mul(smoothstep(1.0, 0.98, fuv.y))
    const accum = texture(foam.texture, fuv).x.mul(finside)
    const wc = smoothstep(foam.U.jThr, foam.U.jThr.sub(0.75), sd.z) // instantaneous crest fold
    // far whitecaps: fold events from a fixed-LOD jacobian (auto-LOD averages them away)
    const jf = float(1).toVar('jfar'); const jfzz = float(1).toVar('jfzz'); const jfxz = float(0).toVar('jfxz')
    for (let c = 0; c < 3; c++) {
      const jj = fft.sampleJacLevel(c, w, 1.5)
      jf.addAssign(jj.jxx.mul(U.chop)); jfzz.addAssign(jj.jzz.mul(U.chop)); jfxz.addAssign(jj.jxz.mul(U.chop))
    }
    const jacFar = jf.mul(jfzz).sub(jfxz.mul(jfxz))
    // jitter the threshold so mip-quantized fold events never read as a
    // lattice, and fade the term out before tile periodicity could show (M5)
    const jitter = texture(lace2, w.div(3.3).add(vec2(0.19, 0.67))).x.mul(0.22).sub(0.11)
    const wcFar = smoothstep(foam.U.jThr.add(jitter), foam.U.jThr.add(jitter).sub(0.16), jacFar)
      .mul(smoothstep(55, 160, dist)).mul(float(1).sub(smoothstep(240, 380, dist)))
    const l1 = texture(lace1, w.div(14.5)).x
    const l2 = texture(lace2, w.div(5.8).add(vec2(0.37, 0.11))).x
    const l3 = texture(lace1, w.div(31.7).add(vec2(0.71, 0.43))).x
    const ambBase = U.foamAmbient.mul(smoothstep(0.35, 0.95, l3.mul(0.6).add(l1.mul(0.4))))
    const foamRaw = max(max(accum.mul(1.35), wc.mul(0.85)), wcFar).add(ambBase)
    // lace shaping: stretching (low foam) tears into filaments via the masks
    const laceRaw = mix(float(1), l1.mul(0.55).add(l2.mul(0.45)), U.foamLace)
    // dense foam reads as connected sheets (ref_26); lace tears only the edges
    const lace = mix(laceRaw, float(1), smoothstep(0.55, 0.95, foamRaw))
    const bodyHi = mix(float(0.68), float(0.40), smoothstep(45, 220, dist))
    const body = smoothstep(0.24, bodyHi, foamRaw.mul(lace.mul(0.75).add(0.25)))
    const filaments = smoothstep(0.10, 0.28, foamRaw.mul(l2)).mul(0.45)
    // residue micro-foam: storm seas carry speckled foam history everywhere
    const micro = U.foamAmbient.mul(l2.mul(0.7).add(l3.mul(0.5))).mul(smoothstep(0.05, 0.5, foamRaw.add(U.foamAmbient)))
    const foamA = clamp(body.add(filaments.mul(float(1).sub(body))).add(micro), 0, 1)
    const foamNdl = max(dot(nUp, sunD), 0).mul(0.72).add(0.30)
    const wlLum = waterLight.r.mul(0.30).add(waterLight.g.mul(0.45)).add(waterLight.b.mul(0.25))
    const foamCol = U.foamTint.mul(foamNdl).mul(vec3(wlLum).mul(0.66).add(vec3(0.30)))
    above.assign(mix(above, foamCol, foamA.mul(0.96)))

    // ---------- below-water shading (surface seen from underneath) ----------
    const nDn = n.negate()
    const cosU = max(dot(nDn, V), 1e-3)
    const sinT = sqrt(max(float(1).sub(cosU.mul(cosU)), 0)).mul(1.333)
    const snell = smoothstep(1.0, 0.94, sinT) // 1 inside the window, 0 in TIR
    const refrUp = normalize(refract(V.negate(), nDn, 1.333))
    const skyThrough = sky.skyColor(refrUp).mul(0.9)
    const deepMirror = U.deepColor.mul(0.85).mul(waterLight)
    const Fu = float(0.02).add(pow(float(1).sub(cosU), 5).mul(0.98))
    const below = mix(deepMirror, mix(skyThrough, deepMirror, Fu), snell)
      .add(ggxGlint(nDn, V, vec3(sunD.x.negate(), sunD.y, sunD.z.negate()).mul(vec3(1, -1, 1)), rough.add(0.05)).mul(U.sunTint).mul(0.25))

    const camUnderNow = cameraPosition.y.lessThan(fft.heightAt(cameraPosition.xz).add(SEA_LEVEL))
    return vec4(select(camUnderNow, below, above), 1)
  })()

  const geo = polarGridGeometry()
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  scene.add(mesh)

  function update (cam) {
    U.snap.value.set(cam.position.x, cam.position.z)
    mesh.position.x = cam.position.x
    mesh.position.z = cam.position.z
    mesh.position.y = SEA_LEVEL
  }

  function applyPreset (p, stats) {
    U.chop.value = p.chop
    U.absorb.value.set(...p.absorb)
    U.scatter.value.setRGB(...p.scatter)
    U.scatterBoost.value = p.scatterBoost
    U.deepColor.value.setRGB(...p.deepColor)
    U.foamTint.value.setRGB(...p.foamTint)
    U.roughBase.value = p.roughBase
    U.band.value = p.band
    U.foamAmbient.value = p.foam.ambient
    U.foamLace.value = p.foam.lace
    U.skyAmb.value.setRGB(...p.horizon).multiplyScalar(p.skyBoost)
    U.sunTint.value.setRGB(...p.sunColor).multiplyScalar(p.sunIntensity)
    U.slopeVar.value.set(stats[0].slopeVar, stats[1].slopeVar, stats[2].slopeVar)
  }

  return { mesh, U, update, applyPreset }
}
