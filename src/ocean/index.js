// OpenOcean v2 public API (R8): createOcean(renderer, scene, camera, opts)
import * as THREE from 'three/webgpu'
import { PRESETS, PRESET_NAMES, SEA_LEVEL, SEABED_BASE_Y, CAUSTIC_RADIUS } from './presets.js'
import { createFFT } from './fft.js'
import { createSky } from './sky.js'
import { createSeabed } from './seabed.js'
import { createSurface } from './surface.js'
import { createUnderwaterPost } from './underwater.js'
import { createFoam } from './foam.js'
import { createCaustics } from './caustics.js'
import { createShafts } from './shafts.js'
import { createProps } from './props.js'
import { createProbes } from './probes.js'

export { PRESETS, PRESET_NAMES, SEA_LEVEL, SEABED_BASE_Y, CAUSTIC_RADIUS }

export function createOcean (renderer, scene, camera, opts = {}) {
  const fft = createFFT(renderer)
  const sky = createSky(scene)
  const foam = createFoam(renderer, fft)
  const caustics = createCaustics(renderer, fft, sky)
  // planar reflection jack: filled by props, consumed by the water surface
  const reflJack = {
    rt: new THREE.RenderTarget(640, 360, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    }),
    vp: null, // set by surface import of uniform; assigned below
  }
  const surface = createSurface(scene, fft, sky, foam, caustics, reflJack)
  const seabed = createSeabed(scene, sky, {
    absorb: surface.U.absorb,
    sunTint: surface.U.sunTint,
  }, caustics)
  const shafts = createShafts(scene, caustics, sky)
  const post = createUnderwaterPost(renderer, scene, camera, fft, sky)
  const probes = createProbes(renderer, fft)
  const props = createProps(renderer, scene, camera, probes, reflJack)

  let simT = 0
  let presetName = null
  let preset = null

  async function setPreset (name) {
    presetName = name
    preset = PRESETS[name]
    if (!preset) throw new Error('unknown preset ' + name)
    await fft.setPreset(preset)
    sky.applyPreset(preset)
    foam.applyPreset(preset)
    caustics.applyPreset(preset)
    shafts.applyPreset(preset)
    surface.applyPreset(preset, fft.getStats())
    post.applyPreset(preset)
  }

  let frameNo = 0
  function update (dt) {
    simT += dt
    surface.U.time.value = simT
    fft.update(simT)
    foam.update(dt, camera.position.x, camera.position.z)
    caustics.update(camera.position.x, camera.position.z)
    shafts.update(camera)
    props.updateReflection()
    if ((frameNo++ & 1) === 0) props.updateFloating(simT)
    surface.update(camera)
    seabed.update(camera)
    sky.dome.position.copy(camera.position)
    post.update()
  }

  function render () {
    post.post.render()
  }

  function sunDirWorld () {
    const s = sky.U.sunDir.value
    return [-s.x, -s.y, -s.z] // direction FROM sun TOWARD the scene
  }

  return {
    fft, sky, surface, seabed, post, probes, foam, caustics, shafts, props,
    setPreset,
    update,
    render,
    get time () { return simT },
    get preset () { return presetName },
    get presetData () { return preset },
    sunDirWorld,
    constants: { seaLevel: SEA_LEVEL, seabedBaseY: SEABED_BASE_Y, causticRadius: CAUSTIC_RADIUS },
  }
}
