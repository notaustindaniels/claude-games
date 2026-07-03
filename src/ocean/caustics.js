// Caustics (R5): Wallace refracted-grid technique reimplemented in TSL
// (see reference/webgl-water-study/renderer.js causticsShader; NOTICE.txt —
// technique only, no code). A camera-following region projects a low-passed
// surface grid along per-vertex refracted sun rays onto the floor plane and
// measures triangle-area compression with screen-space derivatives.
// Additive blending accumulates fold overlaps. Outside CAUSTIC_RADIUS the
// pattern's contrast fades into a matched far-field so the boundary is
// seamless (gate G5a); the pattern itself rides the waves (gate G5b).
import * as THREE from 'three/webgpu'
import {
  Fn, float, vec2, vec3, vec4, uniform, varying, normalize, refract, max,
  dFdx, dFdy, length, abs, clamp, positionGeometry, texture, smoothstep, mix,
} from 'three/tsl'
import { CAUSTIC_RADIUS, SEABED_BASE_Y } from './presets.js'

const WINDOW_HALF = 68           // RT world half-extent (region + refraction margin)
const RT_SIZE = 768
const GRID = 384

export function createCaustics (renderer, fft, sky) {
  const rt = new THREE.RenderTarget(RT_SIZE, RT_SIZE, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
  })
  rt.texture.generateMipmaps = true
  rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping

  const U = {
    center: uniform(new THREE.Vector2(0, 0)),
    floorY: uniform(SEABED_BASE_Y),
    strength: uniform(1.0),
    lod: uniform(2.75),
  }

  // dense grid in [-1,1]^2 (positionGeometry.xy)
  const geo = new THREE.PlaneGeometry(2, 2, GRID, GRID)
  const mat = new THREE.MeshBasicNodeMaterial({
    blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
    transparent: true,
  })

  // vertex-stage expressions shared between the clip position and varyings
  const wxzV = positionGeometry.xy.mul(WINDOW_HALF).add(U.center)
  const hV = fft.sampleDispLevel(0, wxzV, U.lod).y
    .add(fft.sampleDispLevel(1, wxzV, U.lod).y)
    .add(fft.sampleDispLevel(2, wxzV, U.lod).y)
  const slV = fft.sampleDerivLevel(0, wxzV, U.lod)
    .add(fft.sampleDerivLevel(1, wxzV, U.lod))
    .add(fft.sampleDerivLevel(2, wxzV, U.lod))
  const nV = normalize(vec3(slV.x.negate(), 1, slV.y.negate()))
  const sunDn = normalize(sky.U.sunDir).negate()
  const refrFlat = normalize(refract(sunDn, vec3(0, 1, 0), 1 / 1.333))
  const refrV = normalize(refract(sunDn, nV, 1 / 1.333))
  const tNew = hV.sub(U.floorY).div(max(refrV.y.negate(), 0.05))
  const tOld = float(0).sub(U.floorY).div(max(refrFlat.y.negate(), 0.05))
  const newPexpr = wxzV.add(refrV.xz.mul(tNew))
  const oldPexpr = wxzV.add(refrFlat.xz.mul(tOld))
  const vOld = varying(oldPexpr)
  const vNew = varying(newPexpr)

  mat.vertexNode = Fn(() => {
    const ndc = newPexpr.sub(U.center).div(WINDOW_HALF)
    return vec4(ndc.x, ndc.y, 0, 1)
  })()

  mat.fragmentNode = Fn(() => {
    const oldArea = length(dFdx(vOld)).mul(length(dFdy(vOld)))
    const newArea = length(dFdx(vNew)).mul(length(dFdy(vNew)))
    const ratio = oldArea.div(max(newArea, 1e-6))
    const c = clamp(ratio.mul(0.34).pow(1.35), 0, 4.0)
    return vec4(c, c, c, 1)
  })()

  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  const causticScene = new THREE.Scene()
  causticScene.add(mesh)
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
  cam.position.z = 5

  // recenter with hysteresis so the boundary is stable between G5's two frames
  const SNAP = 16
  function update (camX, camZ) {
    const gx = Math.round(camX / SNAP) * SNAP
    const gz = Math.round(camZ / SNAP) * SNAP
    if (Math.abs(gx - U.center.value.x) >= SNAP || Math.abs(gz - U.center.value.y) >= SNAP) {
      U.center.value.set(gx, gz)
    }
    const prev = renderer.getRenderTarget()
    renderer.getClearColor(_cc); const _ca = renderer.getClearAlpha()
    renderer.setClearColor(0x000000, 1)
    renderer.setRenderTarget(rt)
    renderer.render(causticScene, cam)
    renderer.setClearColor(_cc, _ca)
    renderer.setRenderTarget(prev)
  }
  const _cc = new THREE.Color()

  // sampling node for receivers (seabed, water transmission, shafts):
  // world xz -> light multiplier (1 = neutral). Seamless contrast fade
  // across the CAUSTIC_RADIUS boundary into a matched far-field.
  const lightAt = Fn(([wxz, depthFade]) => {
    const rel = wxz.sub(U.center)
    const r = length(rel)
    const uvC = rel.div(WINDOW_HALF * 2).add(0.5)
    const raw = texture(rt.texture, clamp(uvC, 0.002, 0.998)).x
    // low-passed self as the far-field pattern (matched statistics)
    const rawLP = texture(rt.texture, clamp(uvC, 0.002, 0.998)).level(3).x
    const inBound = float(1).sub(smoothstep(CAUSTIC_RADIUS * 0.82, CAUSTIC_RADIUS, r))
    const farBound = float(1).sub(smoothstep(CAUSTIC_RADIUS, WINDOW_HALF * 1.9, r))
    const inner = mix(rawLP, raw, inBound)          // full detail inside
    const contrast = mix(float(0.55), float(1), inBound).mul(farBound.mul(0.7).add(0.3))
    const c = float(1).add(inner.sub(1).mul(contrast).mul(depthFade))
    return clamp(c, 0.15, 3.0).mul(U.strength).add(float(1).sub(U.strength))
  })

  function applyPreset (p) {
    U.strength.value = p.wind > 15 ? 0.55 : 1.0
  }

  return {
    rt, U, update, lightAt, applyPreset,
    info: () => ({ cx: U.center.value.x, cz: U.center.value.y, r: CAUSTIC_RADIUS }),
  }
}
