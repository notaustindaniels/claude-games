// Foam system (R4): Jacobian-fold injection into a persistent, advected,
// decaying accumulation texture (camera-following world window), shaded in
// the surface material through CC0 lace masks (Foam002/003, see ASSETS.md).
import * as THREE from 'three/webgpu'
import {
  Fn, float, vec2, vec3, vec4, uv, uniform, texture, smoothstep, exp, clamp,
  max, min, step,
} from 'three/tsl'

export const FOAM_SIZE = 1024
export const FOAM_SPAN = 512 // meters

export function createFoam (renderer, fft) {
  const mkRT = () => {
    const rt = new THREE.RenderTarget(FOAM_SIZE, FOAM_SIZE, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    })
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping
    return rt
  }
  const rtA = mkRT(); const rtB = mkRT()

  const U = {
    center: uniform(new THREE.Vector2(0, 0)),
    prevCenter: uniform(new THREE.Vector2(0, 0)),
    dt: uniform(1 / 60),
    tau: uniform(6.0),
    jThr: uniform(0.86),
    injRate: uniform(3.0),
    chop: uniform(1.2),
    drift: uniform(new THREE.Vector2(0.6, 0.25)), // m/s, wind-aligned pattern drift
  }

  function updateMaterial (srcTex) {
    const m = new THREE.MeshBasicNodeMaterial()
    m.fragmentNode = Fn(() => {
      const wxz = uv().sub(0.5).mul(FOAM_SPAN).add(U.center)
      // advect: fetch where this water was one step ago, in the prev window
      const from = wxz.sub(U.drift.mul(U.dt))
      const puv = from.sub(U.prevCenter).div(FOAM_SPAN).add(0.5)
      const inside = step(0.001, puv.x).mul(step(puv.x, 0.999)).mul(step(0.001, puv.y)).mul(step(puv.y, 0.999))
      const prev = texture(srcTex, puv).x.mul(inside)
      // jacobian of the combined displaced surface at this world point
      const jxx = float(1).toVar(); const jzz = float(1).toVar(); const jxz = float(0).toVar()
      for (let c = 0; c < 3; c++) {
        const jc = fft.sampleDispLod0(c, wxz).w
        const dv = fft.sampleDeriv(c, wxz, jc)
        jxx.addAssign(dv.jxx.mul(U.chop))
        jzz.addAssign(dv.jzz.mul(U.chop))
        jxz.addAssign(dv.jxz.mul(U.chop))
      }
      const J = jxx.mul(jzz).sub(jxz.mul(jxz))
      const inj = smoothstep(U.jThr, U.jThr.sub(0.55), J).mul(U.injRate).mul(U.dt)
      const decayed = prev.mul(exp(U.dt.negate().div(U.tau)))
      const foam = clamp(decayed.add(inj), 0, 1.0)
      return vec4(foam, J, 0, 1)
    })()
    return new THREE.QuadMesh(m)
  }
  const updateQuad = updateMaterial(rtB.texture) // reads prev state in B, writes A
  const copyMat = new THREE.MeshBasicNodeMaterial()
  copyMat.fragmentNode = Fn(() => texture(rtA.texture, uv()))()
  const copyQuad = new THREE.QuadMesh(copyMat)

  const texelSnap = FOAM_SPAN / FOAM_SIZE

  function update (dt, camX, camZ) {
    U.dt.value = Math.min(dt, 1 / 20)
    U.prevCenter.value.copy(U.center.value)
    U.center.value.set(
      Math.round(camX / texelSnap) * texelSnap,
      Math.round(camZ / texelSnap) * texelSnap)
    const prev = renderer.getRenderTarget()
    renderer.setRenderTarget(rtA)
    updateQuad.render(renderer)
    renderer.setRenderTarget(rtB)
    copyQuad.render(renderer)
    renderer.setRenderTarget(prev)
  }

  function applyPreset (p) {
    U.tau.value = p.foam.tau
    U.jThr.value = p.foam.jThr
    U.injRate.value = p.foam.inj
    U.chop.value = p.chop
    const cp = Math.sqrt(9.81 * 60 / (2 * Math.PI)) // phase speed of the mid cascade band
    const cur = p.current ?? 0
    U.drift.value.set(Math.cos(p.windDir), Math.sin(p.windDir)).multiplyScalar(cp * 0.22 + cur)
  }

  return {
    texture: rtA.texture,
    rtA, rtB,
    U,
    span: FOAM_SPAN,
    update,
    applyPreset,
    flowAt: () => [U.drift.value.x, U.drift.value.y],
  }
}
