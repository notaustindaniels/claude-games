// OpenOcean v2 — placeholder scene. Exists only so verify.mjs can be built
// and proven end-to-end (REBUILD.md startup step 2) before water code lands.
// Expected verify result against this scene: every gate FAILS. Replace me.
import * as THREE from 'three/webgpu'

const hud = document.getElementById('hud')
const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setSize(innerWidth, innerHeight)
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

let t0 = performance.now()
async function init () {
  try { await renderer.init() } catch (e) {
    hud.textContent = 'WebGPU unavailable: ' + e.message + '\n(fallback path is part of R-work)'
  }
  renderer.setAnimationLoop(() => {
    const t = (performance.now() - t0) / 1000
    hud.textContent = `OpenOcean v2 scaffold | t=${t.toFixed(2)}s | backend=${renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl'}`
    renderer.render(scene, camera)
  })
}
init()
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})
