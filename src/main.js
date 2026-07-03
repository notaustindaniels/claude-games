// OpenOcean v2 — placeholder scene. Exists only so verify.mjs can be built
// and proven end-to-end (REBUILD.md startup step 2) before water code lands.
// Expected verify result against this scene: every gate FAILS. Replace me.
// The __oo block below is harness plumbing (VERIFY.md contract), not water code.
import * as THREE from 'three/webgpu'

const params = new URLSearchParams(location.search)
const VERIFY = params.get('verify') === '1'
const BACKEND = params.get('backend') || 'auto'

const hud = document.getElementById('hud')
if (VERIFY) hud.style.display = 'none'

const renderer = new THREE.WebGPURenderer({
  antialias: true,
  forceWebGL: BACKEND === 'webgl' || (BACKEND === 'auto' && !navigator.gpu),
})
renderer.setSize(innerWidth, innerHeight)
renderer.setPixelRatio(1)
renderer.setClearColor(0xff00ff, 1) // magenta: G3 void-hunting default
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 5000)
camera.position.set(0, 3, 8)
camera.lookAt(0, 0, 0)

// A lone placeholder "sea": a flat disc, deliberately inadequate.
const disc = new THREE.Mesh(
  new THREE.CircleGeometry(60, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x1a4d5e, roughness: 0.35 })
)
scene.add(disc)
scene.add(new THREE.DirectionalLight(0xffffff, 2))
scene.add(new THREE.AmbientLight(0x334455, 0.6))

let simT = 0
let failed = null

window.__oo = {
  ready: false,
  get failed () { return failed },
  backend: () => (renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl'),
  time: () => simT,
  async pump (dt) {
    const steps = Math.max(1, Math.round(dt * 60))
    simT += steps / 60
    await renderer.renderAsync(scene, camera)
  },
  async setPreset () { /* placeholder: no presets */ },
  setCamera (pos, look) {
    camera.position.set(pos[0], pos[1], pos[2])
    const dir = new THREE.Vector3(look[0] - pos[0], look[1] - pos[1], look[2] - pos[2]).normalize()
    camera.up.set(0, 1, 0)
    if (Math.abs(dir.y) > 0.999) camera.up.set(0, 0, -1)
    camera.lookAt(look[0], look[1], look[2])
  },
  getConstants: () => ({ seaLevel: 0, seabedBaseY: -28, causticRadius: 48 }),
  getStats: async () => null,
  getSeabedAt: () => null,
  getFlowAt: async () => null,
  getCausticInfo: () => null,
}

async function init () {
  try {
    await renderer.init()
  } catch (e) {
    failed = 'renderer init: ' + e.message
    hud.style.display = 'block'
    hud.textContent = 'Backend unavailable: ' + e.message
    return
  }
  if (VERIFY) {
    await renderer.renderAsync(scene, camera)
    window.__oo.ready = true
  } else {
    const t0 = performance.now()
    renderer.setAnimationLoop(() => {
      simT = (performance.now() - t0) / 1000
      hud.textContent = `OpenOcean v2 scaffold | t=${simT.toFixed(2)}s | backend=${window.__oo.backend()}`
      renderer.render(scene, camera)
    })
  }
}
init()
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})
