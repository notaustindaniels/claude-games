// Procedural per-preset sky: zenith/horizon gradient, sun disc + glow,
// hash-noise cumulus (painterly mode sharpens shapes for seaofthieves),
// shared as a TSL direction→color function so water reflections match.
import * as THREE from 'three/webgpu'
import {
  Fn, float, vec2, vec3, vec4, uniform, mix, pow, max, min, smoothstep, fract,
  sin, dot, floor, exp, normalize, positionLocal, select, abs,
} from 'three/tsl'

const hash2 = Fn(([p]) => {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453))
})
const vnoise = Fn(([p]) => {
  const i = floor(p); const f = fract(p)
  const u = f.mul(f).mul(float(3).sub(f.mul(2)))
  const a = hash2(i)
  const b = hash2(i.add(vec2(1, 0)))
  const c = hash2(i.add(vec2(0, 1)))
  const d = hash2(i.add(vec2(1, 1)))
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y)
})
const fbm4 = Fn(([p]) => {
  const v = vnoise(p).mul(0.5)
    .add(vnoise(p.mul(2.03).add(19.7)).mul(0.25))
    .add(vnoise(p.mul(4.11).add(51.3)).mul(0.125))
    .add(vnoise(p.mul(8.19).add(7.1)).mul(0.0625))
  return v.div(0.9375)
})

export function createSky (scene) {
  const U = {
    zenith: uniform(new THREE.Color(0.1, 0.3, 0.6)),
    horizon: uniform(new THREE.Color(0.6, 0.75, 0.85)),
    sunDir: uniform(new THREE.Vector3(1, 0.7, 0)),   // toward the sun
    sunColor: uniform(new THREE.Color(1, 0.95, 0.85)),
    sunIntensity: uniform(1.2),
    cloudCover: uniform(0.4),
    cloudSharp: uniform(0.2),
    cloudScale: uniform(1.0),
    skyBoost: uniform(1.0),
    painterly: uniform(0.0),
    time: uniform(0),
  }

  // dir (unit, world) -> radiance
  const skyColor = Fn(([dir]) => {
    const y = dir.y
    const t = max(y, 0).pow(0.58)
    const base = mix(U.horizon, U.zenith, t).toVar()
    // below horizon: keep a plausible dimming (never seen directly above water)
    base.assign(mix(base.mul(0.55), base, smoothstep(-0.25, 0.02, y)))
    // sun disc + glow
    const d = dot(dir, normalize(U.sunDir))
    const disc = smoothstep(0.9993, 0.99965, d)
    const glow = pow(max(d, 0), 320).mul(0.55).add(pow(max(d, 0), 24).mul(0.12))
    // clouds on a plane at h=1400 (only above horizon)
    const proj = dir.xz.div(max(y, 0.035)).mul(1.4)
    const q = proj.mul(U.cloudScale).add(vec2(U.time.mul(0.006), U.time.mul(0.0023)))
    const n = fbm4(q).toVar()
    // shape: coverage threshold, painterly = crisper edge + second layer
    const edge0 = float(1).sub(U.cloudCover)
    const soft = mix(float(0.42).sub(U.cloudSharp.mul(0.36)), 0.10, U.painterly)
    const cl = smoothstep(edge0, edge0.add(soft), n).toVar()
    const puff = smoothstep(edge0.add(0.12), edge0.add(soft.mul(0.5)).add(0.12), fbm4(q.mul(2.7).add(31.7))).mul(0.5)
    cl.assign(min(cl.add(puff.mul(U.painterly)), 1))
    const horizonFade = smoothstep(0.012, 0.16, y)
    cl.mulAssign(horizonFade)
    // cloud color: lit by sun amount + darker bottoms with cover
    const sunLit = max(dot(normalize(U.sunDir), vec3(0, 1, 0)), 0).mul(0.5).add(0.5)
    const cloudBright = mix(float(1.02).mul(sunLit), float(0.5).mul(sunLit).add(0.18), U.cloudCover)
    const cloudCol = vec3(cloudBright).mul(mix(vec3(1), U.sunColor, 0.35))
    const col = mix(base, cloudCol, cl.mul(0.92)).toVar()
    col.addAssign(U.sunColor.mul(disc.mul(U.sunIntensity).mul(3).add(glow.mul(U.sunIntensity))).mul(float(1).sub(cl.mul(0.85))))
    return col.mul(U.skyBoost)
  })

  const geo = new THREE.SphereGeometry(4600, 48, 32)
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false })
  mat.colorNode = Fn(() => vec4(skyColor(normalize(positionLocal)), 1))()
  const dome = new THREE.Mesh(geo, mat)
  dome.frustumCulled = false
  dome.renderOrder = -10
  scene.add(dome)

  function applyPreset (p) {
    U.zenith.value.setRGB(...p.zenith)
    U.horizon.value.setRGB(...p.horizon)
    U.sunColor.value.setRGB(...p.sunColor)
    U.sunIntensity.value = p.sunIntensity
    U.cloudCover.value = p.cloudCover
    U.cloudSharp.value = p.cloudSharp
    U.cloudScale.value = p.cloudScale
    U.skyBoost.value = p.skyBoost
    U.painterly.value = p.painterly
    const el = p.sunElevation, az = p.sunAzimuth
    U.sunDir.value.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az))
  }

  return { dome, skyColor, U, applyPreset }
}
