// Underwater volumetric sun shafts (R6): real scene geometry — elongated
// cylinders spanning from above the surface down through the seabed, axes
// aligned to the REFRACTED sun vector (gate G4b reads them back from here).
// Intensity is modulated by the caustic pattern at each shaft's entry point,
// so shafts flicker with the waves. No billboards.
import * as THREE from 'three/webgpu'
import {
  Fn, float, vec2, vec3, vec4, uniform, positionGeometry, positionWorld,
  normalize, smoothstep, max, min, clamp, length, cameraPosition,
} from 'three/tsl'
import { SEABED_BASE_Y } from './presets.js'

const CELLS = []
for (let gx = -2; gx <= 2; gx++) for (let gz = -2; gz <= 2; gz++) if ((gx + gz + 400) % 2 !== 0) CELLS.push([gx, gz])
const COUNT = CELLS.length
const TOP_Y = 2.5
const BOTTOM_Y = SEABED_BASE_Y - 7   // always pierces the floor

export function createShafts (scene, caustics, sky) {
  const U = {
    intensity: uniform(0.55),
    sunTint: uniform(new THREE.Color(1, 1, 1)),
    camY: uniform(0),
  }
  const group = new THREE.Group()
  group.renderOrder = 5
  scene.add(group)

  const len = TOP_Y - BOTTOM_Y
  const geo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true)

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  })
  mat.colorNode = Fn(() => {
    // radial falloff from the cylinder axis (local xz of unit cylinder)
    const rad = length(positionGeometry.xz)
    const radial = smoothstep(1.0, 0.15, rad)
    // vertical falloff: fade in below the surface, fade toward the floor
    const y = positionWorld.y
    const vert = smoothstep(0.5, -3.5, y).mul(smoothstep(BOTTOM_Y, BOTTOM_Y + 14, y))
    // caustic flicker at the entry point
    const flick = caustics.lightAt(positionWorld.xz, float(1)).sub(0.55).mul(0.8).clamp(0.1, 1.6)
    // only meaningful when the camera is submerged
    const camFade = smoothstep(0.5, -2.5, U.camY)
    const a = radial.mul(vert).mul(flick).mul(U.intensity).mul(camFade)
    return vec4(U.sunTint.mul(a), a.mul(0.5))
  })()

  const meshes = []
  for (let i = 0; i < COUNT; i++) {
    const m = new THREE.Mesh(geo, mat)
    m.frustumCulled = false
    group.add(m)
    meshes.push(m)
  }

  const CELL = 26
  const q = new THREE.Quaternion()
  const yAxis = new THREE.Vector3(0, 1, 0)
  const axis = new THREE.Vector3(0, -1, 0)

  function refractedSun () {
    const s = sky.U.sunDir.value // toward the sun
    const d = new THREE.Vector3(-s.x, -s.y, -s.z).normalize() // travel direction
    const cosI = -d.y
    const sinI = Math.hypot(d.x, d.z)
    const sinT = sinI / 1.333
    const cosT = Math.sqrt(Math.max(1 - sinT * sinT, 0))
    const hx = sinI > 1e-6 ? d.x / sinI : 0
    const hz = sinI > 1e-6 ? d.z / sinI : 0
    return new THREE.Vector3(hx * sinT, -cosT, hz * sinT).normalize()
  }

  function update (cam) {
    U.camY.value = cam.position.y
    axis.copy(refractedSun())
    q.setFromUnitVectors(yAxis, axis.clone().negate()) // cylinder +Y toward the light
    const cx = Math.round(cam.position.x / CELL) * CELL
    const cz = Math.round(cam.position.z / CELL) * CELL
    for (let i = 0; i < COUNT; i++) {
      const [gx, gz] = CELLS[i]
      const px = cx + gx * CELL + (Math.sin((cx + gx * 131) * 12.9898) * 43758.5453 % 1) * 9
      const pz = cz + gz * CELL + (Math.sin((cz + gz * 269) * 78.233) * 12578.1459 % 1) * 9
      const m = meshes[i]
      const midY = (TOP_Y + BOTTOM_Y) / 2
      // apex on the surface plane; center placed so the tilted cylinder
      // spans surface -> floor along the refracted axis
      m.position.set(px + axis.x * (midY - TOP_Y) / axis.y, midY, pz + axis.z * (midY - TOP_Y) / axis.y)
      m.quaternion.copy(q)
      const r = 1.6 + ((px * 7 + pz * 13) % 5 + 5) % 5 * 0.5
      m.scale.set(r, len / (Math.abs(axis.y) + 1e-3), r)
      m.userData.entry = [px, pz]
    }
  }

  function applyPreset (p) {
    U.intensity.value = p.wind > 15 ? 0.16 : (p.painterly > 0.5 ? 0.5 : 0.4)
    U.sunTint.value.setRGB(...p.sunColor).multiplyScalar(Math.min(p.sunIntensity, 1.3))
  }

  // G4b readback: honest scene-graph values
  function shaftInfo (seabedAtFn) {
    return meshes.map(m => {
      const a = new THREE.Vector3(0, 1, 0).applyQuaternion(m.quaternion).multiplyScalar(-1)
      const half = m.scale.y / 2
      const top = m.position.clone().addScaledVector(a, -half)
      const bottom = m.position.clone().addScaledVector(a, half)
      return {
        apex: [top.x, top.y, top.z],
        axis: [a.x, a.y, a.z],
        topY: top.y,
        bottomY: bottom.y,
        floorY: seabedAtFn ? seabedAtFn(bottom.x, bottom.z) : null,
      }
    })
  }

  return { group, update, applyPreset, shaftInfo, U }
}
