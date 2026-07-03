// Post pass: per-pixel waterline (near-plane point tested against the real
// displaced surface height — no hard cut at the waterline, M6), underwater
// depth fog + downwelling color, and above-water aerial haze that fades the
// far ocean into the horizon (never a mesh edge — G3).
import * as THREE from 'three/webgpu'
import {
  Fn, float, vec2, vec3, vec4, uniform, mix, max, min, smoothstep, normalize,
  dot, exp, clamp, screenUV, pass, cameraPosition, select, abs, positionWorld,
} from 'three/tsl'
import { SEA_LEVEL } from './presets.js'

export function createUnderwaterPost (renderer, scene, camera, fft, sky) {
  const U = {
    deepColor: uniform(new THREE.Color(0.01, 0.1, 0.14)),
    fogUnder: uniform(0.035),
    fogDist: uniform(2600),
    hazeColor: uniform(new THREE.Color(0.6, 0.74, 0.83)),
    sunTint: uniform(new THREE.Color(1, 1, 1)),
    camPos: uniform(new THREE.Vector3(0, 0, 0)),
    camUp: uniform(new THREE.Vector3(0, 1, 0)),
    camRight: uniform(new THREE.Vector3(1, 0, 0)),
    camFwd: uniform(new THREE.Vector3(0, 0, -1)),
    tanHalfFov: uniform(0.52),
    aspect: uniform(16 / 9),
    near: uniform(0.1),
  }

  const post = new THREE.PostProcessing(renderer)
  const scenePass = pass(scene, camera)
  const color = scenePass.getTextureNode('output')
  const viewZ = scenePass.getViewZNode()

  const DEBUG = new URLSearchParams(location.search).get('postdebug')
  post.outputNode = Fn(() => {
    const ndc = vec2(screenUV.x, float(1).sub(screenUV.y)).mul(2).sub(1) // screenUV v=0 is top in this pass
    const dir = normalize(
      U.camFwd
        .add(U.camRight.mul(ndc.x.mul(U.tanHalfFov).mul(U.aspect)))
        .add(U.camUp.mul(ndc.y.mul(U.tanHalfFov)))
    )
    const cosA = max(dot(dir, U.camFwd), 1e-4)
    const dist = viewZ.negate().div(cosA)              // world-space distance along ray
    const distC = min(dist, 40000)
    // near-plane world point decides above/below for this pixel
    const np = U.camPos.add(dir.mul(U.near.add(0.012).div(cosA)))
    const surfH = (DEBUG === '8' ? float(0) : fft.heightAt(np.xz)).add(SEA_LEVEL)
    const under = np.y.lessThan(surfH)
    const src = color.rgb.toVar()

    // underwater: distance fog toward a depth-shaded water color
    const pixY = U.camPos.y.add(dir.y.mul(distC)).max(-45)
    const downwell = exp(min(pixY, 0).mul(0.055))
    const fogCol = U.deepColor.mul(downwell).mul(U.sunTint)
    const f = float(1).sub(exp(distC.mul(U.fogUnder).negate()))
    const underCol = mix(src, fogCol, f)

    // above water: gentle aerial haze into the horizon color
    const fa = float(1).sub(exp(distC.div(U.fogDist).negate().mul(1.1)))
    const aboveCol = mix(src, U.hazeColor, fa.mul(smoothstep(0.0, 0.15, fa)).mul(0.9))

    // waterline band: slight darkening right at the interface
    const band = float(1).sub(smoothstep(0.0, 0.10, abs(np.y.sub(surfH))))
    const out = select(under, underCol, aboveCol).mul(float(1).sub(band.mul(0.18)))
    if (DEBUG === '1') return vec4(vec3(distC.div(3000)), 1)
    if (DEBUG === '2') return vec4(select(under, vec3(1, 0, 0), vec3(0, 1, 0)), 1)
    if (DEBUG === '3') return vec4(src, 1)
    if (DEBUG === '9') return vec4(vec3(dir.y.mul(5).add(0.5)), 1)
    if (DEBUG === '10') return vec4(vec3(np.y.sub(surfH).mul(8).add(0.5)), 1)
    if (DEBUG === '4') return vec4(aboveCol, 1)
    if (DEBUG === '5') return vec4(underCol, 1)
    if (DEBUG === '6') return vec4(U.hazeColor, 1)
    if (DEBUG === '7') return vec4(vec3(fa), 1)
    return vec4(out, 1)
  })()

  function update () {
    U.camPos.value.copy(camera.position)
    const e = camera.matrixWorld.elements
    U.camRight.value.set(e[0], e[1], e[2]).normalize()
    U.camUp.value.set(e[4], e[5], e[6]).normalize()
    U.camFwd.value.set(-e[8], -e[9], -e[10]).normalize()
    U.tanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
    U.aspect.value = camera.aspect
    U.near.value = camera.near
  }
  function applyPreset (p) {
    U.deepColor.value.setRGB(...p.deepColor)
    U.hazeColor.value.setRGB(...p.hazeColor)
    U.fogDist.value = p.fogDist
    U.fogUnder.value = p.wind > 15 ? 0.042 : 0.014
    U.sunTint.value.setRGB(...p.sunColor).multiplyScalar(Math.min(p.sunIntensity, 1.2))
  }
  return { post, update, applyPreset, U }
}
