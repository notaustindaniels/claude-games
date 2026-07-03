// Preset definitions — spectrum AND optics AND sky AND sun (R7).
// Tuned against reference/: blackflag = ref_04/05/06/12/14/15/17/24,
// storm = ref_07 + ref_26, seaofthieves = stylized banded blues (ref_12 anchor).

export const PRESET_NAMES = ['blackflag', 'storm', 'seaofthieves']

export const PRESETS = {
  blackflag: {
    // spectrum
    wind: 8.5, fetch: 160e3, gamma: 2.4, dirSpread: 11, windDir: 0.4636, // atan2(1,2): on-axis for the low-k lattice
    chop: 1.15, ampMul: 1.0, seed: 1337, current: 2.6,
    // optics
    absorb: [0.22, 0.036, 0.028],      // 1/m — red dies fast: turquoise
    scatter: [0.012, 0.11, 0.13],      // in-water scatter tint
    scatterBoost: 0.9,
    deepColor: [0.012, 0.14, 0.18],
    foamTint: [0.92, 0.96, 0.97],
    roughBase: 0.028,
    foam: { tau: 5.0, jThr: 0.62, inj: 2.2, ambient: 0.028, lace: 1.0 },
    // sun / sky
    sunAzimuth: 0.0, sunElevation: 62 * Math.PI / 180,
    sunColor: [1.0, 0.95, 0.84], sunIntensity: 1.35,
    zenith: [0.132, 0.32, 0.60], horizon: [0.62, 0.74, 0.83],
    cloudCover: 0.42, cloudSharp: 0.22, cloudScale: 1.0, skyBoost: 1.0,
    hazeColor: [0.62, 0.74, 0.83],
    painterly: 0.0, band: 0.0,
    fogDist: 2600,
  },
  storm: {
    wind: 18.5, fetch: 420e3, gamma: 3.3, dirSpread: 2.2, windDir: 0.72,
    chop: 1.5, ampMul: 0.92, seed: 4242, current: 2.8,
    absorb: [0.14, 0.075, 0.066],
    scatter: [0.085, 0.180, 0.165],    // aerated storm grey-green (ref_26)
    scatterBoost: 1.55,
    deepColor: [0.055, 0.105, 0.098],
    foamTint: [0.82, 0.86, 0.86],
    roughBase: 0.075,
    foam: { tau: 6.0, jThr: 0.80, inj: 2.15, ambient: 0.085, lace: 1.0 },
    sunAzimuth: 0.0, sunElevation: 30 * Math.PI / 180,
    sunColor: [0.80, 0.82, 0.83], sunIntensity: 0.85,
    zenith: [0.20, 0.23, 0.26], horizon: [0.42, 0.45, 0.47],
    cloudCover: 0.93, cloudSharp: 0.22, cloudScale: 2.0, skyBoost: 0.78,
    hazeColor: [0.38, 0.42, 0.44],
    painterly: 0.0, band: 0.0,
    fogDist: 3400,
  },
  seaofthieves: {
    wind: 10.5, fetch: 140e3, gamma: 2.0, dirSpread: 5, windDir: -0.5,
    chop: 1.5, ampMul: 1.05, seed: 777, current: 2.4,
    absorb: [0.42, 0.075, 0.05],
    scatter: [0.02, 0.16, 0.19],       // saturated stylized blues
    scatterBoost: 1.35,
    deepColor: [0.008, 0.19, 0.30],
    foamTint: [0.97, 0.99, 1.0],
    roughBase: 0.03,
    foam: { tau: 6.0, jThr: 0.58, inj: 2.4, ambient: 0.05, lace: 0.55 },
    sunAzimuth: 0.0, sunElevation: 55 * Math.PI / 180,
    sunColor: [1.0, 0.97, 0.88], sunIntensity: 1.5,
    zenith: [0.10, 0.34, 0.72], horizon: [0.55, 0.80, 0.92],
    cloudCover: 0.55, cloudSharp: 0.5, cloudScale: 1.35, skyBoost: 1.15,
    hazeColor: [0.55, 0.78, 0.90],
    painterly: 1.0, band: 1.0,        // banded blues + crisp painterly clouds
    fogDist: 3200,
  },
}

// world constants shared with verify.mjs (asserted by G4)
export const SEA_LEVEL = 0
export const SEABED_BASE_Y = -28
export const CAUSTIC_RADIUS = 48
