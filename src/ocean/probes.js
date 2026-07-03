// GPU readback probes — the physics side of G4. Values come from render
// targets sampling the same TSL functions the visuals use (no CPU mirrors).
import * as THREE from 'three/webgpu'
import { Fn, float, vec2, vec4, uv, uniform } from 'three/tsl'
import { seabedHeightAt } from './seabed.js'

export function createProbes (renderer, fft) {
  const N = 64
  const uCenter = uniform(new THREE.Vector2(0, 0))
  const uSpan = uniform(512)

  const rt = new THREE.RenderTarget(N, N, {
    type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  })
  const mat = new THREE.MeshBasicNodeMaterial()
  mat.fragmentNode = Fn(() => {
    const w = uv().sub(0.5).mul(uSpan).add(uCenter)
    const h = fft.heightAt(w)
    const sb = seabedHeightAt(w)
    return vec4(h, sb, 0, 1)
  })()
  const quad = new THREE.QuadMesh(mat)

  async function heightStats (centerX = 0, centerZ = 0, span = 512) {
    uCenter.value.set(centerX, centerZ)
    uSpan.value = span
    const prev = renderer.getRenderTarget()
    renderer.setRenderTarget(rt)
    quad.render(renderer)
    renderer.setRenderTarget(prev)
    const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, N, N)
    let minH = Infinity, maxH = -Infinity, sum = 0, sum2 = 0, maxSb = -Infinity
    const n = N * N
    for (let i = 0; i < n; i++) {
      const h = px[i * 4], sb = px[i * 4 + 1]
      if (h < minH) minH = h
      if (h > maxH) maxH = h
      sum += h; sum2 += h * h
      if (sb > maxSb) maxSb = sb
    }
    const mean = sum / n
    const std = Math.sqrt(Math.max(sum2 / n - mean * mean, 0))
    return { hs: 4 * std, minSurfaceY: minH, maxSurfaceY: maxH, meanSurfaceY: mean, maxSeabedTop: maxSb }
  }

  async function seabedAt (x, z) {
    const s = await heightStats(x, z, 0.001)
    return s.maxSeabedTop
  }

  return { heightStats, seabedAt }
}
