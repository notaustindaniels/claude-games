// GPU FFT wave cascades (R1). JONSWAP spectrum evaluated in a TSL compute
// pass (H0, once per preset); per-frame spectrum evolution + Stockham radix-2
// IFFT + bake run as TSL-authored RTT passes, which behave identically on the
// WebGPU and WebGL backends (the WebGL backend cannot gather in compute —
// verified by spike — so butterflies must be fragment passes).
import * as THREE from 'three/webgpu'
import {
  Fn, float, int, uint, vec2, vec3, vec4, uv, uniform, texture, textureLoad,
  ivec2, instancedArray, instanceIndex, hash, select, cos, sin, sqrt, exp, pow,
  abs, max, min, atan2, PI, smoothstep, floor, mod,
} from 'three/tsl'

export const FFT_N = 256
export const CASCADE_SIZES = [250, 60, 12]
const LOG2N = 8
const G = 9.81

// ---------------------------------------------------------------- butterfly
function bitRev (i, bits) {
  let r = 0
  for (let b = 0; b < bits; b++) { r = (r << 1) | ((i >> b) & 1) }
  return r
}
function makeButterflyTexture () {
  const data = new Float32Array(FFT_N * LOG2N * 4)
  for (let s = 0; s < LOG2N; s++) {
    for (let i = 0; i < FFT_N; i++) {
      const span = 1 << s
      const k = (i * (FFT_N >> (s + 1))) % FFT_N
      const wr = Math.cos(2 * Math.PI * k / FFT_N)
      const wi = Math.sin(2 * Math.PI * k / FFT_N) // +i convention: inverse FFT
      const top = (i % (span * 2)) < span
      let a, b
      if (s === 0) {
        a = bitRev(top ? i : i - 1, LOG2N)
        b = bitRev(top ? i + 1 : i, LOG2N)
      } else {
        a = top ? i : i - span
        b = top ? i + span : i
      }
      const o = (s * FFT_N + i) * 4
      data[o] = wr; data[o + 1] = wi; data[o + 2] = a; data[o + 3] = b
    }
  }
  const t = new THREE.DataTexture(data, FFT_N, LOG2N, THREE.RGBAFormat, THREE.FloatType)
  t.minFilter = t.magFilter = THREE.NearestFilter
  t.needsUpdate = true
  return t
}

// ------------------------------------------------------- JONSWAP (JS mirror)
// Mirrored in the TSL compute below; used on CPU only for band statistics
// (slope variance per cascade for the R2 variance→roughness path).
function jonswapParams (p) {
  const U = p.wind, F = p.fetch
  const alpha = 0.076 * Math.pow(U * U / (F * G), 0.22)
  const wp = 22 * Math.pow(G * G / (U * F), 1 / 3)
  // directional normalization for cos^{2s}((θ-θw)/2)
  let integ = 0
  const s2 = 2 * p.dirSpread
  for (let i = 0; i < 720; i++) {
    const th = (i + 0.5) / 720 * 2 * Math.PI - Math.PI
    integ += Math.pow(Math.max(Math.cos(th / 2), 0), s2) * (2 * Math.PI / 720)
  }
  return { alpha, wp, dirNorm: 1 / integ }
}
function jonswapE (p, jp, kx, kz) {
  const k = Math.hypot(kx, kz)
  if (k < 1e-5) return 0
  const w = Math.sqrt(G * k)
  const sig = w <= jp.wp ? 0.07 : 0.09
  const r = Math.exp(-((w - jp.wp) ** 2) / (2 * sig * sig * jp.wp * jp.wp))
  let S = jp.alpha * G * G / Math.pow(w, 5) * Math.exp(-1.25 * Math.pow(jp.wp / w, 4)) * Math.pow(p.gamma, r)
  const th = Math.atan2(kz, kx) - p.windDir
  const D = jp.dirNorm * Math.pow(Math.max(Math.cos(th / 2), 0), 2 * p.dirSpread)
  const dwdk = G / (2 * w)
  return S * D * dwdk / k
}
// per-cascade slope variance (integral of k²E over the band): feeds R2
export function cascadeStats (p) {
  const jp = jonswapParams(p)
  const out = []
  for (let c = 0; c < 3; c++) {
    const L = CASCADE_SIZES[c]
    const dk = 2 * Math.PI / L
    let m0 = 0, mss = 0
    for (let mz = 0; mz < FFT_N; mz++) {
      for (let mx = 0; mx < FFT_N; mx++) {
        const wx = mx >= FFT_N / 2 ? mx - FFT_N : mx
        const wz = mz >= FFT_N / 2 ? mz - FFT_N : mz
        const kx = wx * dk, kz = wz * dk
        const k = Math.hypot(kx, kz)
        const w = bandWeightJS(c, k)
        if (w <= 0) continue
        const E = jonswapE(p, jp, kx, kz) * w * p.ampMul * p.ampMul
        m0 += E * dk * dk
        mss += k * k * E * dk * dk
      }
    }
    out.push({ m0, slopeVar: mss })
  }
  return out
}
function bandWeightJS (c, k) {
  const hi = c === 2 ? 1e9 : 2 * Math.PI / CASCADE_SIZES[c + 1]
  const lo = 2 * Math.PI / CASCADE_SIZES[c]
  if (k < lo || k >= hi) return 0
  const kNyq = Math.PI * FFT_N / CASCADE_SIZES[c]
  const t = Math.min(1, Math.max(0, (kNyq * 0.9 - k) / (kNyq * 0.25)))
  return t
}

// ---------------------------------------------------------------- factory
export function createFFT (renderer) {
  const A = { w: FFT_N * 2, h: FFT_N * 3 }

  const butterflyTex = makeButterflyTexture()

  const mkAtlasRT = () => {
    const rt = new THREE.RenderTarget(A.w, A.h, {
      type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    })
    return rt
  }
  const ping = mkAtlasRT(); const pong = mkAtlasRT()

  const mkFieldRT = () => {
    const rt = new THREE.RenderTarget(FFT_N, FFT_N, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    })
    rt.texture.wrapS = rt.texture.wrapT = THREE.RepeatWrapping
    rt.texture.minFilter = THREE.LinearMipmapLinearFilter
    rt.texture.magFilter = THREE.LinearFilter
    rt.texture.generateMipmaps = true
    return rt
  }
  const dispRT = [mkFieldRT(), mkFieldRT(), mkFieldRT()]
  const derivRT = [mkFieldRT(), mkFieldRT(), mkFieldRT()]

  // H0 atlas texture (built from the TSL compute pass results)
  const h0Data = new Float32Array(FFT_N * FFT_N * 3 * 4)
  const h0Tex = new THREE.DataTexture(h0Data, FFT_N, FFT_N * 3, THREE.RGBAFormat, THREE.FloatType)
  h0Tex.minFilter = h0Tex.magFilter = THREE.NearestFilter

  // ---------------- H0 compute (JONSWAP spectrum in TSL compute, per cascade)
  const cU = {
    seed: uniform(0), L: uniform(250), U10: uniform(8), fetch: uniform(1.6e5),
    gamma: uniform(2.4), spread: uniform(8), windDir: uniform(0), ampMul: uniform(1),
    alpha: uniform(0.01), wp: uniform(0.5), dirNorm: uniform(0.3),
    kLo: uniform(0.0), kHi: uniform(10.0),
  }
  const h0Buf = instancedArray(FFT_N * FFT_N, 'vec4')

  const gauss2 = Fn(([sd]) => {
    const r1 = max(hash(sd), 1e-6)
    const r2 = hash(sd.add(uint(1299721)))
    const m = sqrt(float(-2).mul(r1.log()))
    return vec2(m.mul(cos(r2.mul(PI).mul(2))), m.mul(sin(r2.mul(PI).mul(2))))
  })
  // amplitude A(k) = sqrt(E(kx,kz) * dk^2) / 2 ; E = S(ω)·D(θ)·(dω/dk)/k
  const ampAt = Fn(([mx, mz]) => {
    const dk = float(2).mul(PI).div(cU.L)
    const wx = select(mx.greaterThanEqual(int(FFT_N / 2)), mx.sub(int(FFT_N)), mx).toFloat()
    const wz = select(mz.greaterThanEqual(int(FFT_N / 2)), mz.sub(int(FFT_N)), mz).toFloat()
    const kx = wx.mul(dk); const kz = wz.mul(dk)
    const k = max(sqrt(kx.mul(kx).add(kz.mul(kz))), 1e-6)
    const w = sqrt(k.mul(G))
    const sig = select(w.lessThanEqual(cU.wp), float(0.07), float(0.09))
    const dw = w.sub(cU.wp)
    const r = exp(dw.mul(dw).negate().div(sig.mul(sig).mul(cU.wp).mul(cU.wp).mul(2)))
    const S = float(G * G).mul(cU.alpha).div(pow(w, 5))
      .mul(exp(float(-1.25).mul(pow(cU.wp.div(w), 4))))
      .mul(pow(cU.gamma, r))
    const th = atan2(kz, kx).sub(cU.windDir)
    const D = pow(max(cos(th.mul(0.5)), 0), cU.spread.mul(2)).mul(cU.dirNorm)
    const dwdk = float(G).mul(0.5).div(w)
    const E = S.mul(D).mul(dwdk).div(k)
    // band limit + nyquist roll-off (linear fade 0.65..0.9 kNyq, mirrored in JS)
    const kNyq = dk.mul(FFT_N / 2)
    const nyq = kNyq.mul(0.9).sub(k).div(kNyq.mul(0.25)).clamp(0, 1)
    const band = select(k.greaterThanEqual(cU.kLo).and(k.lessThan(cU.kHi)), float(1), float(0)).mul(nyq)
    const E2 = E.mul(band).mul(cU.ampMul).mul(cU.ampMul)
    return sqrt(E2.mul(dk).mul(dk)).mul(0.5)
  })
  const h0Compute = Fn(() => {
    const mx = instanceIndex.mod(uint(FFT_N)).toInt()
    const mz = instanceIndex.div(uint(FFT_N)).toInt()
    // -k texel
    const nx = int(FFT_N).sub(mx).mod(int(FFT_N))
    const nz = int(FFT_N).sub(mz).mod(int(FFT_N))
    const sd = uint(0).add(cU.seed).add(instanceIndex.mul(uint(2)))
    const sdm = uint(0).add(cU.seed).add(nz.mul(int(FFT_N)).add(nx).toUint().mul(uint(2)))
    const gk = gauss2(sd).mul(ampAt(mx, mz))
    const gmk = gauss2(sdm).mul(ampAt(nx, nz))
    h0Buf.element(instanceIndex).assign(vec4(gk, gmk))
  })().compute(FFT_N * FFT_N)

  // ----------------------------- evolve pass (H0 + t -> packed spectra atlas)
  const uTime = uniform(0)
  const uL = uniform(new THREE.Vector3(...CASCADE_SIZES))
  const evolveMat = new THREE.MeshBasicNodeMaterial()
  evolveMat.fragmentNode = Fn(() => {
    const g = vec2(uv().x.mul(A.w), uv().y.mul(A.h)).floor()
    const tileX = g.x.div(FFT_N).floor()               // 0 = specA, 1 = specB
    const lx = g.x.mod(FFT_N)
    const casc = g.y.div(FFT_N).floor()
    const ly = g.y.mod(FFT_N)
    const h0 = textureLoad(h0Tex, ivec2(lx.toInt(), g.y.toInt()))
    const L = select(casc.lessThan(1), uL.x, select(casc.lessThan(2), uL.y, uL.z))
    const dk = float(2).mul(PI).div(L)
    const wx = select(lx.greaterThanEqual(FFT_N / 2), lx.sub(FFT_N), lx)
    const wz = select(ly.greaterThanEqual(FFT_N / 2), ly.sub(FFT_N), ly)
    const kx = wx.mul(dk); const kz = wz.mul(dk)
    const k = max(sqrt(kx.mul(kx).add(kz.mul(kz))), 1e-6)
    const w = sqrt(k.mul(G))
    // e^{-iwt} pairing: with the e^{+ikx} inverse transform this makes the
    // D(θ)-weighted waves travel +k̂ — i.e. DOWNWIND (Tessendorf sign trap)
    const c = cos(w.mul(uTime)); const s = sin(w.mul(uTime)).negate()
    // h~ = h0k e^{iwt} + conj(h0mk) e^{-iwt}
    const hr = h0.x.mul(c).sub(h0.y.mul(s)).add(h0.z.mul(c)).sub(h0.w.mul(s))
    const hi = h0.x.mul(s).add(h0.y.mul(c)).sub(h0.z.mul(s)).sub(h0.w.mul(c))
    const kxn = kx.div(k); const kzn = kz.div(k)
    // specA: C1 = h~·(1 − kx/k)  [→ h + i·dx]
    //        C2 = h~·(−kx + i·kz/k) [→ dz + i·dh/dx]
    const c1 = vec2(hr, hi).mul(float(1).sub(kxn))
    const c2r = hr.mul(kx.negate()).sub(hi.mul(kzn))
    const c2i = hr.mul(kzn).add(hi.mul(kx.negate()))
    // specB: C3 = h~·i(kz − kx²/k)  [→ dh/dz + i·d(dx)/dx]
    //        C4 = −h~·(kz² + i·kx·kz)/k [→ d(dz)/dz + i·d(dx)/dz]
    const f3 = kz.sub(kx.mul(kx).div(k))
    const c3 = vec2(hi.negate().mul(f3), hr.mul(f3))
    const f4r = kz.mul(kz).div(k).negate(); const f4i = kx.mul(kz).div(k).negate()
    const c4 = vec2(hr.mul(f4r).sub(hi.mul(f4i)), hr.mul(f4i).add(hi.mul(f4r)))
    return select(tileX.lessThan(1), vec4(c1, c2r, c2i), vec4(c3, c4))
  })()
  const evolveQuad = new THREE.QuadMesh(evolveMat)

  // ------------------------------------------- butterfly passes (ping-pong)
  // stage index baked as a constant per material: no per-draw uniform sync
  function butterflyMaterial (srcTex, horizontal, stage) {
    const m = new THREE.MeshBasicNodeMaterial()
    m.fragmentNode = Fn(() => {
      const g = vec2(uv().x.mul(A.w), uv().y.mul(A.h)).floor()
      const lane = horizontal ? g.x.mod(FFT_N) : g.y.mod(FFT_N)
      const base = horizontal ? g.x.sub(lane) : g.y.sub(lane)
      const bf = textureLoad(butterflyTex, ivec2(lane.toInt(), int(stage)))
      const ia = base.add(bf.z); const ib = base.add(bf.w)
      const pa = horizontal ? ivec2(ia.toInt(), g.y.toInt()) : ivec2(g.x.toInt(), ia.toInt())
      const pb = horizontal ? ivec2(ib.toInt(), g.y.toInt()) : ivec2(g.x.toInt(), ib.toInt())
      const va = textureLoad(srcTex, pa)
      const vb = textureLoad(srcTex, pb)
      const w = bf.xy
      const e1 = va.xy.add(vec2(
        w.x.mul(vb.x).sub(w.y.mul(vb.y)),
        w.x.mul(vb.y).add(w.y.mul(vb.x))))
      const e2 = va.zw.add(vec2(
        w.x.mul(vb.z).sub(w.y.mul(vb.w)),
        w.x.mul(vb.w).add(w.y.mul(vb.z))))
      return vec4(e1, e2)
    })()
    return new THREE.QuadMesh(m)
  }
  // data starts in ping after evolve; stage s of the combined 16-stage chain
  // reads ping when s is even. bfChain[s] = prebuilt quad for that stage.
  const bfChain = []
  for (let s = 0; s < LOG2N * 2; s++) {
    const horizontal = s < LOG2N
    const stageIdx = horizontal ? s : s - LOG2N
    const src = (s % 2 === 0) ? ping.texture : pong.texture
    bfChain.push({ quad: butterflyMaterial(src, horizontal, stageIdx), dst: (s % 2 === 0) ? pong : ping })
  }

  // ------------------------------------------------------------- bake passes
  function bakeMaterial (cascade, kind) {
    const m = new THREE.MeshBasicNodeMaterial()
    m.fragmentNode = Fn(() => {
      const l = vec2(uv().x.mul(FFT_N), uv().y.mul(FFT_N)).floor()
      const rowY = int(cascade * FFT_N).add(l.y.toInt())
      const sa = textureLoad(ping.texture, ivec2(l.x.toInt(), rowY))
      const sb = textureLoad(ping.texture, ivec2(l.x.toInt().add(int(FFT_N)), rowY))
      // specA ifft = (h, dx | dz, dh/dx) ; specB = (dh/dz, ddx/dx | ddz/dz, ddx/dz)
      return kind === 'disp'
        ? vec4(sa.y, sa.x, sa.z, sb.w)     // (dx, h, dz, ddx/dz)
        : vec4(sa.w, sb.x, sb.y, sb.z)     // (dh/dx, dh/dz, ddx/dx, ddz/dz)
    })()
    return new THREE.QuadMesh(m)
  }
  const bakeQuads = []
  for (let c = 0; c < 3; c++) {
    bakeQuads.push({ rt: dispRT[c], quad: bakeMaterial(c, 'disp') })
    bakeQuads.push({ rt: derivRT[c], quad: bakeMaterial(c, 'deriv') })
  }

  // ------------------------------------------------------------------- API
  let stats = null
  let realizedFlow = [1, 0]

  // measure the realized sea's transport: LP height field cross-correlated
  // 0.5 s apart (the honest 'surface flow' — no spectral sign conventions)
  async function measureFlow () {
    const N = 128
    const grab = async () => {
      const raw = await renderer.readRenderTargetPixelsAsync(dispRT[1], 0, 0, FFT_N, FFT_N)
      const half = (u) => { const s2 = (u & 0x8000) ? -1 : 1, e = (u >> 10) & 0x1f, mm = u & 0x3ff
        if (e === 0) return s2 * mm * Math.pow(2, -24); if (e === 31) return 0
        return s2 * (1 + mm / 1024) * Math.pow(2, e - 15) }
      const g = new Float32Array(N * N)
      const f = FFT_N / N
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          let acc = 0
          for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
            acc += half(raw[((y * f + j) * FFT_N + x * f + i) * 4 + 1])
          }
          g[y * N + x] = acc
        }
      }
      return g
    }
    const nccTor = (A, B, R) => {
      const mean = arr => { let s2 = 0; for (const v of arr) s2 += v; return s2 / arr.length }
      const mA = mean(A); const mB = mean(B)
      let eA = 0; for (let i = 0; i < A.length; i++) eA += (A[i] - mA) ** 2
      let best = { c: -2, dx: 0, dy: 0 }
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          let dot = 0; let eB = 0
          for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
              const b = B[((y + dy + N) % N) * N + ((x + dx + N) % N)] - mB
              dot += (A[y * N + x] - mA) * b; eB += b * b
            }
          }
          const c = dot / (Math.sqrt(eA * eB) || 1)
          if (c > best.c) best = { c, dx, dy }
        }
      }
      return best
    }
    update(50.0)
    const A = await grab()
    update(50.5)
    const B = await grab()
    update(51.0)
    const C = await grab()
    const b1 = nccTor(A, B, 10)
    const b2 = nccTor(B, C, 10)
    const texel = CASCADE_SIZES[1] / N
    // readback rows are top-down: dy_readback = -dz_texture
    const fx = (b1.dx + b2.dx) / 2 * texel / 0.5
    const fz = -(b1.dy + b2.dy) / 2 * texel / 0.5
    const wx = fx * RC[1] - fz * RS[1]; const wz = fx * RS[1] + fz * RC[1]
    // the RT-space measurement misses the uniform current (applied at
    // sampling time): the world-frame flow adds it back
    realizedFlow = [wx + uCurrent.value.x, wz + uCurrent.value.y]
    return { flow: realizedFlow, c: Math.min(b1.c, b2.c) }
  }

  async function setPreset (p) {
    const cur = p.current ?? 0
    uCurrent.value.set(Math.cos(p.windDir) * cur, Math.sin(p.windDir) * cur)
    stats = cascadeStats(p)
    const jp = jonswapParams(p)
    for (let c = 0; c < 3; c++) {
      cU.seed.value = p.seed + c * 101
      cU.L.value = CASCADE_SIZES[c]
      cU.U10.value = p.wind
      cU.fetch.value = p.fetch
      cU.gamma.value = p.gamma
      cU.spread.value = p.dirSpread
      cU.windDir.value = p.windDir
      cU.ampMul.value = p.ampMul
      cU.alpha.value = jp.alpha
      cU.wp.value = jp.wp
      cU.dirNorm.value = jp.dirNorm
      cU.kLo.value = 2 * Math.PI / CASCADE_SIZES[c]
      cU.kHi.value = c === 2 ? 1e9 : 2 * Math.PI / CASCADE_SIZES[c + 1]
      renderer.compute(h0Compute)
      const ab = await renderer.getArrayBufferAsync(h0Buf.value)
      h0Data.set(new Float32Array(ab), c * FFT_N * FFT_N * 4)
    }
    h0Tex.needsUpdate = true
    const mf = await measureFlow()
    console.info('[ocean] realized surface flow', mf.flow.map(v => v.toFixed(2)).join(','), 'ncc', mf.c.toFixed(2))
  }

  function update (t) {
    uTime.value = t
    uSimT.value = t
    const prevRT = renderer.getRenderTarget()
    renderer.setRenderTarget(ping)
    evolveQuad.render(renderer)
    // 16 prebuilt stages (8 H + 8 V), strict ping-pong; ends back in ping
    for (const st of bfChain) {
      renderer.setRenderTarget(st.dst)
      st.quad.render(renderer)
    }
    for (const b of bakeQuads) {
      renderer.setRenderTarget(b.rt)
      b.quad.render(renderer)
    }
    renderer.setRenderTarget(prevRT)
  }

  // per-cascade sampling-frame rotation kills cross-tile alignment (M5 tiling)
  const ROT = [0, 0.34, -0.47]
  const RC = ROT.map(a => Math.cos(a)); const RS = ROT.map(a => Math.sin(a))
  // uniform surface current (Stokes/wind drift): the whole wave field — and
  // with it caustics and foam — translates rigidly at uCurrent (m/s)
  const uCurrent = uniform(new THREE.Vector2(0, 0))
  const uSimT = uniform(0)
  // world xz -> cascade-frame uv (current-advected)
  const cascUV = (c, wxz) => {
    const w = wxz.sub(uCurrent.mul(uSimT))
    const x = w.x.mul(RC[c]).add(w.y.mul(RS[c]))
    const z = w.y.mul(RC[c]).sub(w.x.mul(RS[c]))
    return vec2(x, z).div(CASCADE_SIZES[c])
  }
  // cascade-frame vector -> world frame
  const rotVec = (c, v) => vec2(
    v.x.mul(RC[c]).sub(v.y.mul(RS[c])),
    v.x.mul(RS[c]).add(v.y.mul(RC[c])))

  // sampled fields, world-frame: disp = (dxWorld, h, dzWorld, jxzCascade)
  const sampleDispLod0 = (c, wxz) => {
    const s = texture(dispRT[c].texture, cascUV(c, wxz)).level(0)
    const d = rotVec(c, vec2(s.x, s.z))
    return vec4(d.x, s.y, d.y, s.w)
  }
  const sampleDisp = (c, wxz) => {
    const s = texture(dispRT[c].texture, cascUV(c, wxz))
    const d = rotVec(c, vec2(s.x, s.z))
    return vec4(d.x, s.y, d.y, s.w)
  }
  // derivatives: slopes rotate as vectors; the (jxx,jzz,jxz) tensor rotates
  // as R J R^T. Returns {slope:vec2(world), jxx, jzz, jxz (world)}
  const sampleDeriv = (c, wxz, jxzCasc) => {
    const dv = texture(derivRT[c].texture, cascUV(c, wxz))
    const slope = rotVec(c, vec2(dv.x, dv.y))
    const a = dv.z; const b = dv.w; const cc = jxzCasc
    const C = RC[c]; const S = RS[c]
    const jxx = a.mul(C * C).sub(cc.mul(2 * S * C)).add(b.mul(S * S))
    const jzz = a.mul(S * S).add(cc.mul(2 * S * C)).add(b.mul(C * C))
    const jxz = a.sub(b).mul(S * C).add(cc.mul(C * C - S * S))
    return { slope, jxx, jzz, jxz }
  }

  const sampleDispLevel = (c, wxz, lod) => {
    const s = texture(dispRT[c].texture, cascUV(c, wxz)).level(lod)
    const d = rotVec(c, vec2(s.x, s.z))
    return vec4(d.x, s.y, d.y, s.w)
  }
  // low-passed world-frame slope at explicit LOD (caustics input)
  const sampleDerivLevel = (c, wxz, lod) => {
    const dv = texture(derivRT[c].texture, cascUV(c, wxz)).level(lod)
    return rotVec(c, vec2(dv.x, dv.y))
  }
  // jacobian ingredients at explicit LOD (far whitecaps: auto-LOD averages
  // fold events away). Returns {jxx, jzz, jxz} in the world frame.
  const sampleJacLevel = (c, wxz, lod) => {
    const dv = texture(derivRT[c].texture, cascUV(c, wxz)).level(lod)
    const jc = texture(dispRT[c].texture, cascUV(c, wxz)).level(lod).w
    const a = dv.z; const b = dv.w; const cc = jc
    const C = RC[c]; const S = RS[c]
    return {
      jxx: a.mul(C * C).sub(cc.mul(2 * S * C)).add(b.mul(S * S)),
      jzz: a.mul(S * S).add(cc.mul(2 * S * C)).add(b.mul(C * C)),
      jxz: a.sub(b).mul(S * C).add(cc.mul(C * C - S * S)),
    }
  }

  // shared TSL height sampler (post pass, probes, waterline)
  const heightAt = Fn(([wxz]) => {
    const h0v = texture(dispRT[0].texture, cascUV(0, wxz)).level(0).y
    const h1v = texture(dispRT[1].texture, cascUV(1, wxz)).level(0).y
    const h2v = texture(dispRT[2].texture, cascUV(2, wxz)).level(0).y
    return h0v.add(h1v).add(h2v)
  })

  return {
    dispTex: dispRT.map(rt => rt.texture),
    derivTex: derivRT.map(rt => rt.texture),
    sizes: CASCADE_SIZES,
    uL,
    setPreset,
    update,
    heightAt,
    realizedFlow: () => realizedFlow,
    sampleDisp,
    sampleDispLod0,
    sampleDispLevel,
    sampleDeriv,
    sampleDerivLevel,
    sampleJacLevel,
    getStats: () => stats,
    // debug hooks (fftcheck.html)
    __debugH0: () => h0Tex,
    __debugDispRT: c => dispRT[c],
    __debugDerivRT: c => derivRT[c],
    __debugAtlas: () => ping,
    __debugPartial (t, nStages) {
      uTime.value = t
      const prevRT = renderer.getRenderTarget()
      renderer.setRenderTarget(ping)
      evolveQuad.render(renderer)
      let last = ping
      for (let s = 0; s < nStages; s++) {
        const st = bfChain[s]
        renderer.setRenderTarget(st.dst)
        st.quad.render(renderer)
        last = st.dst
      }
      renderer.setRenderTarget(prevRT)
      return last
    },
  }
}
