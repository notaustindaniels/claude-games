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
const GRID = 768

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
    lod: uniform(1.4), // λ≳1.5 m band: dappled webs (v-flip fix made finer bands measurable)
  }

  // dense grid in [-1,1]^2 (positionGeometry.xy)
  const geo = new THREE.PlaneGeometry(2, 2, GRID, GRID)
  const mat = new THREE.MeshBasicNodeMaterial({
    blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
    transparent: true,
  })

  // vertex-stage expressions shared between the clip position and varyings.
  // Slopes come from cascade 1 ONLY (the 3-60 m band): that band carries the
  // focusing curvature; longer swell mostly tilts the whole bundle (sun-plane
  // slosh) and sub-3 m wavelets decorrelate — single-band caustics are both
  // optically dominant and coherent (R5's low-pass requirement).
  const wxzV = positionGeometry.xy.mul(WINDOW_HALF).add(U.center)
  const hV = fft.sampleDispLevel(0, wxzV, 2.0).y
    .add(fft.sampleDispLevel(1, wxzV, U.lod).y)
  const slV = fft.sampleDerivLevel(1, wxzV, U.lod)
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
    const c = clamp(ratio.pow(1.45).mul(0.8), 0, 4.5) // peak-shaped, mean~=1
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
    // the render path flips framebuffer Y vs sampling (GL backend emulating
    // WebGPU NDC): negate v so the floor pattern matches the wave field
    const uvC = vec2(rel.x, rel.y.negate()).div(WINDOW_HALF * 2).add(0.5)
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
    U.strength.value = p.wind > 15 ? 0.55 : 1.3
  }

  // measure the pattern's own surface-driven advection at the G5 sampling
  // zone (LP field, local window) — this is what getFlowAt reports and what
  // the runtime screen measurement is checked against (two independent chains)
  let patternFlow = [1, 0]
  async function measureFlow (fftUpdate) {
    const N = 192, f = 4 // read 768^2 down to 192^2 (0.708 m/texel over 136 m)
    const half = (u) => { const s2 = (u & 0x8000) ? -1 : 1, e = (u >> 10) & 0x1f, m = u & 0x3ff
      if (e === 0) return s2 * m * Math.pow(2, -24); if (e === 31) return 0
      return s2 * (1 + m / 1024) * Math.pow(2, e - 15) }
    const grab = async () => {
      const raw = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, RT_SIZE, RT_SIZE)
      const g = new Float32Array(N * N)
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        let a = 0
        for (let j = 0; j < f; j += 2) for (let i = 0; i < f; i += 2) a += half(raw[((y * f + j) * RT_SIZE + x * f + i) * 4])
        g[y * N + x] = a
      }
      return g
    }
    U.center.value.set(0, 0)
    fftUpdate(52.0); update(0, 0)
    const A = await grab()
    fftUpdate(52.5); update(0, 0)
    const B = await grab()
    // local window near the G5 target (world +0.77R, 0) => texture coords
    const texel = (WINDOW_HALF * 2) / N
    const cx = Math.round(N / 2 + (CAUSTIC_RADIUS * 0.77) / texel)
    const cy = N / 2
    const W = 44, R = 22 // 31 m window, +-15.6 m search
    const win = (g, x0, y0) => {
      const o = new Float32Array(W * W); let s2 = 0
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const v = g[(y0 + y) * N + x0 + x]; o[y * W + x] = v; s2 += v }
      const m = s2 / (W * W); let e = 0
      for (let i = 0; i < o.length; i++) { o[i] -= m; e += o[i] * o[i] }
      return { o, e: Math.sqrt(e) || 1 }
    }
    const P = win(A, cx - (W >> 1), cy - (W >> 1))
    let best = { c: -2, dx: 0, dy: 0 }
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const Q = win(B, cx - (W >> 1) + dx, cy - (W >> 1) + dy)
        let dot = 0
        for (let i = 0; i < P.o.length; i++) dot += P.o[i] * Q.o[i]
        const c = dot / (P.e * Q.e)
        if (c > best.c) best = { c, dx, dy }
      }
    }
    // caustic RT rows: rendered via ortho camera; readback top-down flips z
    patternFlow = [best.dx * texel / 0.5, -best.dy * texel / 0.5]
    return { flow: patternFlow, c: best.c }
  }

  return {
    rt, U, update, lightAt, applyPreset, measureFlow,
    patternFlow: () => patternFlow,
    info: () => ({ cx: U.center.value.x, cz: U.center.value.y, r: CAUSTIC_RADIUS }),
  }
}
