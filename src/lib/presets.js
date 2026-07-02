// Named environment presets spanning glassy calm to storm.
// All angles in degrees here (converted by createOcean), distances in metres.

const DEG = Math.PI / 180;

export const PRESETS = {
  glassy: {
    description: 'Mirror-calm dawn water, barely a ripple.',
    sim: {
      tileSize: 96, windSpeed: 1.6, windDirection: 15, fetch: 30000,
      choppiness: 0.6, directionality: 4, smallWaveCutoff: 0.004,
      amplitudeScale: 0.8, foamGain: 0, foamBias: 0.4, foamDecay: 4,
    },
    swell: [{ amplitude: 0.06, wavelength: 90, direction: 40, steepness: 0.25 }],
    secondary: { scale: 3.17, weight: 0.35 },
    water: {
      absorption: [0.32, 0.11, 0.09], scatterColor: 0x06283c,
      sssColor: 0x1a7f8a, sssStrength: 0.25, roughness: 0.035,
      detailNormal: 0.12, ambientFoam: 0, contactFoamDepth: 0.6,
    },
    spray: 0,
    fog: [1800, 9000],
    sky: {
      turbidity: 1.6, sunElevation: 24, sunAzimuth: 135, sunIntensity: 1.0,
      zenith: 0x2c5f9e, horizon: 0xc7dcec, haze: 0xe4ecf2,
    },
  },

  calm: {
    description: 'Light airs, gentle long swell.',
    sim: {
      tileSize: 128, windSpeed: 4, windDirection: 20, fetch: 80000,
      choppiness: 0.85, directionality: 6, smallWaveCutoff: 0.005,
      amplitudeScale: 1, foamGain: 0.5, foamBias: 0.35, foamDecay: 4,
    },
    swell: [{ amplitude: 0.28, wavelength: 110, direction: 45, steepness: 0.4 }],
    secondary: { scale: 3.17, weight: 0.4 },
    water: {
      absorption: [0.3, 0.1, 0.085], scatterColor: 0x073048,
      sssColor: 0x1d8a90, sssStrength: 0.4, roughness: 0.05,
      detailNormal: 0.22, ambientFoam: 0.02, contactFoamDepth: 0.9,
    },
    spray: 0,
    fog: [1400, 8000],
    sky: {
      turbidity: 2, sunElevation: 38, sunAzimuth: 140, sunIntensity: 1.0,
      zenith: 0x2a62a8, horizon: 0xbcd6e8, haze: 0xdfeaf1,
    },
  },

  breeze: {
    description: 'Fresh breeze, scattered small whitecaps.',
    sim: {
      tileSize: 180, windSpeed: 7.5, windDirection: 25, fetch: 150000,
      choppiness: 1.1, directionality: 7, smallWaveCutoff: 0.006,
      amplitudeScale: 1, foamGain: 1.6, foamBias: 0.4, foamDecay: 4.5,
    },
    swell: [{ amplitude: 0.55, wavelength: 140, direction: 50, steepness: 0.45 }],
    secondary: { scale: 3.17, weight: 0.45 },
    water: {
      absorption: [0.3, 0.095, 0.08], scatterColor: 0x083350,
      sssColor: 0x1f9490, sssStrength: 0.45, roughness: 0.07,
      detailNormal: 0.3, ambientFoam: 0.03, contactFoamDepth: 1.2,
    },
    spray: 0.08,
    fog: [1000, 7000],
    sky: {
      turbidity: 2.4, sunElevation: 46, sunAzimuth: 150, sunIntensity: 1.05,
      zenith: 0x2b5f9c, horizon: 0xb5cfe2, haze: 0xd8e4ee,
    },
  },

  moderate: {
    description: 'Moderate open sea, regular whitecaps.',
    sim: {
      tileSize: 256, windSpeed: 10.5, windDirection: 30, fetch: 300000,
      choppiness: 1.25, directionality: 8, smallWaveCutoff: 0.008,
      amplitudeScale: 1, foamGain: 8, foamBias: 0.54, foamDecay: 5,
    },
    swell: [
      { amplitude: 0.9, wavelength: 170, direction: 55, steepness: 0.5 },
      { amplitude: 0.35, wavelength: 90, direction: 15, steepness: 0.4 },
    ],
    secondary: { scale: 3.17, weight: 0.5 },
    water: {
      absorption: [0.3, 0.09, 0.075], scatterColor: 0x0a3652,
      sssColor: 0x27a08e, sssStrength: 0.5, roughness: 0.085,
      detailNormal: 0.34, ambientFoam: 0.05, contactFoamDepth: 1.6,
    },
    spray: 0.18,
    fog: [800, 6000],
    sky: {
      turbidity: 3, sunElevation: 42, sunAzimuth: 155, sunIntensity: 1.05,
      zenith: 0x33689f, horizon: 0xafc6d8, haze: 0xcfdde8,
    },
  },

  rough: {
    description: 'Rough sea, streaky foam, heavy swell.',
    sim: {
      tileSize: 320, windSpeed: 15, windDirection: 35, fetch: 400000,
      choppiness: 1.45, directionality: 6, smallWaveCutoff: 0.01,
      amplitudeScale: 1, foamGain: 10, foamBias: 0.6, foamDecay: 6.5,
    },
    swell: [
      { amplitude: 1.7, wavelength: 220, direction: 60, steepness: 0.55 },
      { amplitude: 0.6, wavelength: 120, direction: 20, steepness: 0.45 },
    ],
    secondary: { scale: 3.17, weight: 0.55 },
    water: {
      absorption: [0.34, 0.1, 0.09], scatterColor: 0x0b3a50,
      sssColor: 0x2fa88c, sssStrength: 0.6, roughness: 0.11,
      detailNormal: 0.38, ambientFoam: 0.09, contactFoamDepth: 2.2,
    },
    spray: 0.55,
    fog: [500, 4200],
    sky: {
      turbidity: 5, sunElevation: 32, sunAzimuth: 160, sunIntensity: 0.95,
      zenith: 0x4a6e8e, horizon: 0xa8b8c4, haze: 0xc2ccd4,
    },
  },

  storm: {
    description: 'Storm-force sea, dense foam, spray-torn crests.',
    sim: {
      tileSize: 420, windSpeed: 21, windDirection: 40, fetch: 500000,
      choppiness: 1.6, directionality: 5, smallWaveCutoff: 0.012,
      amplitudeScale: 1.05, foamGain: 13, foamBias: 0.66, foamDecay: 8,
    },
    swell: [
      { amplitude: 2.6, wavelength: 280, direction: 65, steepness: 0.6 },
      { amplitude: 1.0, wavelength: 150, direction: 25, steepness: 0.5 },
    ],
    secondary: { scale: 3.17, weight: 0.6 },
    water: {
      absorption: [0.38, 0.13, 0.11], scatterColor: 0x11374a,
      sssColor: 0x3aa584, sssStrength: 0.65, roughness: 0.14,
      detailNormal: 0.42, ambientFoam: 0.14, contactFoamDepth: 3,
    },
    spray: 1.0,
    fog: [260, 2400],
    sky: {
      turbidity: 9, sunElevation: 22, sunAzimuth: 165, sunIntensity: 0.7,
      zenith: 0x5c6d7a, horizon: 0x93a0a8, haze: 0xaab4ba,
    },
  },

  sunset: {
    description: 'Low golden sun over a settling evening sea.',
    sim: {
      tileSize: 160, windSpeed: 5.5, windDirection: 10, fetch: 120000,
      choppiness: 1.0, directionality: 6, smallWaveCutoff: 0.005,
      amplitudeScale: 1, foamGain: 1.2, foamBias: 0.45, foamDecay: 4.5,
    },
    swell: [{ amplitude: 0.45, wavelength: 130, direction: 30, steepness: 0.45 }],
    secondary: { scale: 3.17, weight: 0.42 },
    water: {
      absorption: [0.3, 0.105, 0.09], scatterColor: 0x0a2c40,
      sssColor: 0x2b8a7c, sssStrength: 0.5, roughness: 0.055,
      detailNormal: 0.24, ambientFoam: 0.04, contactFoamDepth: 1.0,
    },
    spray: 0.05,
    fog: [900, 6500],
    sky: {
      turbidity: 4, sunElevation: 6, sunAzimuth: 195, sunIntensity: 0.85,
      zenith: 0x35507c, horizon: 0xf2b170, haze: 0xf7cf9a,
    },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);

/** Deep-merge a preset with user overrides into a resolved config. */
export function resolvePreset(name = 'moderate', overrides = {}) {
  const base = PRESETS[name];
  if (!base) throw new Error(`Unknown ocean preset "${name}" (have: ${PRESET_NAMES.join(', ')})`);
  const merged = {
    name,
    spray: overrides.spray ?? base.spray ?? 0,
    fog: overrides.fog ?? base.fog ?? [2500, 9000],
    sim: { ...base.sim, ...(overrides.sim || {}) },
    swell: overrides.swell ?? base.swell,
    secondary: { ...base.secondary, ...(overrides.secondary || {}) },
    water: { ...base.water, ...(overrides.water || {}) },
    sky: { ...base.sky, ...(overrides.sky || {}) },
  };
  merged.sim.windDirectionRad = merged.sim.windDirection * DEG;
  merged.swellRad = merged.swell.map((s) => ({ ...s, direction: (s.direction ?? 0) * DEG }));
  return merged;
}
