// Unbounded seabed: camera-following disk, flat trench (−28 m) within ~150 m
// of the world origin (keeps M9/M10 sampling predictable), rolling hills
// beyond. Height function is TSL-only; CPU never needs to mirror it (probes
// read it back through a render target).
import * as THREE from 'three/webgpu'
import {
  Fn, float, vec2, vec3, vec4, uniform, mix, max, min, smoothstep, fract, sin,
  dot, floor, normalize, positionLocal, exp, length, clamp,
} from 'three/tsl'
import { SEABED_BASE_Y } from './presets.js'

const hash2 = Fn(([p]) => fract(sin(dot(p, vec2(269.5, 183.3))).mul(43758.5453)))
const vnoise = Fn(([p]) => {
  const i = floor(p); const f = fract(p)
  const u = f.mul(f).mul(float(3).sub(f.mul(2)))
  return mix(
    mix(hash2(i), hash2(i.add(vec2(1, 0))), u.x),
    mix(hash2(i.add(vec2(0, 1))), hash2(i.add(vec2(1, 1))), u.x), u.y)
})

// world xz -> seabed height (y)
export const seabedHeightAt = Fn(([wxz]) => {
  const n = vnoise(wxz.mul(1 / 210)).mul(0.62)
    .add(vnoise(wxz.mul(1 / 61).add(37.2)).mul(0.28))
    .add(vnoise(wxz.mul(1 / 17.3).add(11.9)).mul(0.10))
  const hills = n.mul(n).mul(15.5)
  const mask = smoothstep(80, 520, length(wxz))
  const dunes = vnoise(wxz.mul(1 / 6.1).add(3.3)).mul(0.45)
  return float(SEABED_BASE_Y).add(hills.mul(mask)).add(dunes)
})

// world xz -> sand albedo (shared with the water material for the
// refracted-floor readable-seabed path)
export const seabedAlbedoAt = Fn(([wxz]) => {
  const g = vnoise(wxz.mul(1 / 3.1)).mul(0.5).add(vnoise(wxz.mul(1 / 0.83).add(9.1)).mul(0.5))
  const ripples = sin(wxz.x.mul(1.9).add(vnoise(wxz.mul(0.2)).mul(6))).mul(0.5).add(0.5)
  const sand = mix(vec3(0.72, 0.66, 0.52), vec3(0.55, 0.50, 0.38), g)
  const dark = mix(sand, vec3(0.36, 0.36, 0.30), smoothstep(0.62, 0.95, g).mul(0.7))
  return dark.mul(ripples.mul(0.14).add(0.86))
})

export function createSeabed (scene, sky, waterU, caustics) {
  const SIZE = 15000, SEG = 320
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG).rotateX(-Math.PI / 2)
  const mat = new THREE.MeshBasicNodeMaterial()
  const uSnap = uniform(new THREE.Vector2(0, 0))

  const wxz = Fn(() => positionLocal.xz.add(uSnap))

  mat.positionNode = Fn(() => {
    const w = wxz()
    return vec3(positionLocal.x, seabedHeightAt(w), positionLocal.z)
  })()

  mat.colorNode = Fn(() => {
    const w = wxz()
    const alb = seabedAlbedoAt(w)
    const y = seabedHeightAt(w)
    // slope shading from the height field (cheap central differences)
    const e = float(2.0)
    const hx = seabedHeightAt(w.add(vec2(e, 0))).sub(seabedHeightAt(w.sub(vec2(e, 0)))).div(e.mul(2))
    const hz = seabedHeightAt(w.add(vec2(0, e))).sub(seabedHeightAt(w.sub(vec2(0, e)))).div(e.mul(2))
    const n = normalize(vec3(hx.negate(), 1, hz.negate()))
    const sunD = normalize(sky.U.sunDir)
    const ndl = max(dot(n, sunD), 0).mul(0.75).add(0.25)
    // downwelling attenuation with depth (per-preset absorption)
    const depth = max(float(0).sub(y), 0)
    const att = exp(waterU.absorb.mul(depth.mul(1.35)).negate())
    const cauFade = clamp(exp(depth.mul(-0.012)).mul(1.25), 0.3, 1)
    const cau = caustics.lightAt(w, cauFade)
    return vec4(alb.mul(ndl).mul(cau).mul(att.mul(1.35).add(0.028)).mul(waterU.sunTint), 1)
  })()

  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  scene.add(mesh)

  function update (cam) {
    // snap to a coarse grid so vertices don't swim against the height field
    const s = 46.875 // SIZE/SEG
    uSnap.value.set(Math.round(cam.position.x / s) * s, Math.round(cam.position.z / s) * s)
    mesh.position.x = uSnap.value.x
    mesh.position.z = uSnap.value.y
  }
  // note: geometry positions are local; shader adds uSnap for the noise field
  // but mesh.position also moves — so subtract it back in wxz to avoid double
  // counting: positionLocal is pre-transform, so wxz = local + snap is the
  // world position exactly when mesh.position == snap. Height must be applied
  // in local Y (mesh has no Y offset), which positionNode does.

  return { mesh, update, uSnap }
}
