// OpenOcean v2 — demo app + verify hooks (VERIFY.md __oo contract).
import * as THREE from 'three/webgpu'
import { createOcean, PRESET_NAMES } from './ocean/index.js'

const params = new URLSearchParams(location.search)
const VERIFY = params.get('verify') === '1'
const BACKEND = params.get('backend') || 'auto'
const PRESET = params.get('preset') || 'blackflag'

const hud = document.getElementById('hud')
if (VERIFY) hud.style.display = 'none'

const renderer = new THREE.WebGPURenderer({
  antialias: true,
  forceWebGL: BACKEND === 'webgl' || (BACKEND === 'auto' && !navigator.gpu),
})
renderer.setSize(innerWidth, innerHeight)
renderer.setPixelRatio(1)
renderer.setClearColor(0xff00ff, 1) // magenta stays on: G3 hunts voids
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 12000)
camera.position.set(0, 8, 30)
camera.lookAt(60, 0, 0)

let ocean = null
let simFailed = null
let flatConstants = []

window.__oo = {
  ready: false,
  get failed () { return simFailed },
  backend: () => (renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl'),
  time: () => (ocean ? ocean.time : 0),
  async pump (dt) {
    if (!ocean) return
    const steps = Math.max(1, Math.round(dt * 60))
    for (let i = 0; i < steps; i++) ocean.update(1 / 60)
    ocean.render()
    await new Promise(r => setTimeout(r, 4))
  },
  async setPreset (name) { await ocean.setPreset(name) },
  setCamera (pos, look) {
    camera.position.set(pos[0], pos[1], pos[2])
    const dir = new THREE.Vector3(look[0] - pos[0], look[1] - pos[1], look[2] - pos[2]).normalize()
    camera.up.set(0, 1, 0)
    if (Math.abs(dir.y) > 0.999) camera.up.set(0, 0, -1)
    camera.lookAt(look[0], look[1], look[2])
    camera.updateMatrixWorld()
  },
  getConstants: () => ocean ? ocean.constants : null,
  async getStats () {
    if (!ocean) return null
    const st = await ocean.probes.heightStats(0, 0, 512)
    const shafts = ocean.shafts.shaftInfo(null)
    for (const sh of shafts) {
      const b = sh.apex ? [sh.apex[0] + sh.axis[0] * (sh.topY - sh.bottomY), sh.bottomY] : null
      void b
      sh.floorY = await ocean.probes.seabedAt(sh.apex[0], sh.apex[2])
    }
    return {
      hs: st.hs,
      minSurfaceY: st.minSurfaceY,
      maxSurfaceY: st.maxSurfaceY,
      maxSeabedTop: st.maxSeabedTop,
      shafts,
      sunDir: ocean.sunDirWorld(),
      flatConstants,
    }
  },
  getSeabedAt: null,         // replaced below (async probe)
  async getFlowAt (x, z) { return ocean ? ocean.fft.realizedFlow() : null },
  getCausticInfo: () => ocean ? ocean.caustics.info() : null,
  getSwellPeriod: () => ocean ? ocean.swellPeriod() : null,
}

async function init () {
  try {
    await renderer.init()
    ocean = createOcean(renderer, scene, camera, {})
    await ocean.setPreset(PRESET)
    window.__oo.getSeabedAt = null // probes are async; expose promise-based
    window.__oo.getSeabedAt = (x, z) => ocean.probes.seabedAt(x, z)
    // No shader in this build renders a flat interior fill: every water/foam/
    // sky term is modulated per-pixel (lighting, lace, swell). The declared
    // constant list is therefore empty; G6's auto flat-block detector remains
    // the active hunt for v1-style churn discs (see progress.html pass 2).
    flatConstants = []
  } catch (e) {
    simFailed = 'init: ' + (e && e.message || e)
    hud.style.display = 'block'
    hud.textContent = 'Init failed: ' + simFailed
    console.error(e)
    return
  }
  window.__ooOcean = { ocean, renderer }
  if (params.get('hidesurface') === '1') ocean.surface.mesh.visible = false
  if (params.get('hideseabed') === '1') ocean.seabed.mesh.visible = false
  if (params.get('nopost') === '1') {
    ocean.render = () => renderer.render(scene, camera)
  }
  if (params.get('debugtex')) {
    const { texture: texN, uv: uvN, Fn: FnN, vec4: vec4N, float: floatN } = await import('three/tsl')
    const which = params.get('debugtex')
    const t = which.startsWith('deriv') ? ocean.fft.derivTex[+which.slice(-1)] : ocean.fft.dispTex[+which.slice(-1)]
    const dm = new THREE.MeshBasicNodeMaterial()
    const sc = +(params.get('texscale') || 1)
    dm.colorNode = FnN(() => vec4N(texN(t, uvN()).level(0).rgb.mul(floatN(sc)).add(0.5), 1))()
    const dq = new THREE.QuadMesh(dm)
    ocean.render = () => { renderer.setRenderTarget(null); dq.render(renderer) }
  }
  if (VERIFY) {
    ocean.update(1 / 60)
    ocean.render()
    window.__oo.ready = true
  } else {
    setupControls()
    setupUI()
    let last = performance.now()
    renderer.setAnimationLoop(() => {
      const now = performance.now()
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      ocean.update(dt)
      ocean.render()
      hud.textContent = `OpenOcean v2 | ${ocean.preset} | t=${ocean.time.toFixed(1)}s | backend=${window.__oo.backend()}` +
        '\ndrag look · WASD move (shift fast) · scroll dolly'
    })
  }
}

// preset / quality / backend UI (R8)
function setupUI () {
  const bar = document.createElement('div')
  bar.style.cssText = 'position:fixed;top:10px;right:10px;display:flex;gap:6px;' +
    'font:12px ui-monospace,monospace;color:#cfe;background:rgba(0,20,30,.6);padding:6px 8px;border-radius:6px'
  const mkSel = (label, opts, cur, onch) => {
    const w = document.createElement('label')
    w.textContent = label + ' '
    const sel = document.createElement('select')
    for (const o of opts) {
      const el = document.createElement('option')
      el.value = o; el.textContent = o; if (o === cur) el.selected = true
      sel.appendChild(el)
    }
    sel.onchange = () => onch(sel.value)
    w.appendChild(sel)
    return w
  }
  bar.appendChild(mkSel('preset', PRESET_NAMES, PRESET, v => ocean.setPreset(v)))
  bar.appendChild(mkSel('quality', ['full', 'balanced', 'performance'], 'full', v => {
    renderer.setPixelRatio(v === 'full' ? 1 : v === 'balanced' ? 0.75 : 0.5)
    renderer.setSize(innerWidth, innerHeight)
  }))
  bar.appendChild(mkSel('backend', ['webgl', 'webgpu'], window.__oo.backend(), v => {
    const u = new URL(location.href); u.searchParams.set('backend', v); location.href = u
  }))
  document.body.appendChild(bar)
}

// free-fly camera (drag look + WASD + scroll dolly), above and below water
function setupControls () {
  let yaw = Math.atan2(-60, -(-30)); let pitch = 0.05
  const look = () => {
    const d = new THREE.Vector3(
      Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw))
    camera.lookAt(camera.position.clone().add(d))
  }
  yaw = 0.2; look()
  let dragging = false
  addEventListener('mousedown', () => { dragging = true })
  addEventListener('mouseup', () => { dragging = false })
  addEventListener('mousemove', e => {
    if (!dragging) return
    yaw += e.movementX * 0.0028
    pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * 0.0028))
    look()
  })
  addEventListener('wheel', e => {
    const d = new THREE.Vector3(); camera.getWorldDirection(d)
    camera.position.addScaledVector(d, -e.deltaY * 0.05)
  })
  const keys = {}
  addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true
    if (e.key === '1') ocean.setPreset('blackflag')
    if (e.key === '2') ocean.setPreset('storm')
    if (e.key === '3') ocean.setPreset('seaofthieves')
  })
  addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false })
  setInterval(() => {
    const d = new THREE.Vector3(); camera.getWorldDirection(d)
    const r = new THREE.Vector3().crossVectors(d, camera.up).normalize()
    const sp = keys.shift ? 3.2 : 0.8
    if (keys.w) camera.position.addScaledVector(d, sp)
    if (keys.s) camera.position.addScaledVector(d, -sp)
    if (keys.a) camera.position.addScaledVector(r, -sp)
    if (keys.d) camera.position.addScaledVector(r, sp)
  }, 16)
}

init()
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})
