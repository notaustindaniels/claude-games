// Radix-2 complex FFT used by the ocean simulation worker.
// Plain module (no DOM/three deps) so it can be unit-tested in node.

export function makePlan(N) {
  const bits = Math.round(Math.log2(N));
  if (1 << bits !== N) throw new Error('FFT size must be a power of two');
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    let x = i;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  // Per-stage twiddles for the INVERSE transform: e^{+i 2π k / len}.
  const stages = [];
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const cos = new Float64Array(half);
    const sin = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const a = (2 * Math.PI * k) / len;
      cos[k] = Math.cos(a);
      sin[k] = Math.sin(a);
    }
    stages.push({ len, half, cos, sin });
  }
  return { N, bits, rev, stages };
}

/**
 * In-place unnormalized inverse FFT of plan.N complex values stored
 * interleaved (re, im) in `data`, starting at complex offset `off`,
 * complex stride `stride`. Unnormalized: matches h(x) = Σ H(k) e^{+ikx}.
 */
export function ifft(plan, data, off, stride) {
  const { N, rev, stages } = plan;
  const s2 = stride * 2;
  const base = off * 2;
  // Bit-reversal permutation.
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) {
      const ia = base + i * s2;
      const ja = base + j * s2;
      let t = data[ia];
      data[ia] = data[ja];
      data[ja] = t;
      t = data[ia + 1];
      data[ia + 1] = data[ja + 1];
      data[ja + 1] = t;
    }
  }
  for (let s = 0; s < stages.length; s++) {
    const { len, half, cos, sin } = stages[s];
    for (let start = 0; start < N; start += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k];
        const wi = sin[k];
        const ia = base + (start + k) * s2;
        const ib = base + (start + k + half) * s2;
        const br = data[ib];
        const bi = data[ib + 1];
        const tr = br * wr - bi * wi;
        const ti = br * wi + bi * wr;
        data[ib] = data[ia] - tr;
        data[ib + 1] = data[ia + 1] - ti;
        data[ia] += tr;
        data[ia + 1] += ti;
      }
    }
  }
}

/** In-place unnormalized 2D inverse FFT of an N×N interleaved complex grid. */
export function ifft2d(plan, data) {
  const N = plan.N;
  for (let row = 0; row < N; row++) ifft(plan, data, row * N, 1);
  for (let col = 0; col < N; col++) ifft(plan, data, col, N);
}
