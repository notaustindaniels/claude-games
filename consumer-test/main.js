// Minimal consumer of the OpenOcean public API (R8): a second project that
// renders the ocean purely through createOcean().
import * as THREE from 'three/webgpu'
import { createOcean } from '../src/ocean/index.js'

const renderer = new THREE.WebGPURenderer({
  antialias: true,
  forceWebGL: new URLSearchParams(location.search).get('backend') !== 'webgpu',
})
renderer.setSize(innerWidth, innerHeight)
renderer.setPixelRatio(1)
renderer.setClearColor(0xff00ff, 1)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 12000)
camera.position.set(-14, 6, 22)
camera.lookAt(80, 0, -30)

window.__consumer = { ready: false }

async function init () {
  const ocean = createOcean(renderer, scene, camera, {})
  await renderer.init()
  await ocean.setPreset('blackflag')
  for (let i = 0; i < 180; i++) ocean.update(1 / 60) // settle 3 s of sea
  ocean.render()
  window.__consumer.ready = true
  renderer.setAnimationLoop(() => {
    ocean.update(1 / 60)
    ocean.render()
  })
}
init()
