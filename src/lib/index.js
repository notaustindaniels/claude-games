// OpenOcean — standalone FFT ocean rendering system for three.js.
// Public API: createOcean({ renderer, scene, camera, ...options }) → Ocean.
import * as THREE from 'three/webgpu';
import { GPUOceanSim } from './gpu-sim.js';
import { makeSurfaceGeometry } from './OceanSurface.js';
import { makeOceanUniforms, makeOceanMaterial, applyConfigToUniforms } from './OceanMaterial.js';
import { foamLaceData } from './foamlace.js';
import { makeSkyColorFn, makeSkyDome } from './sky.js';
import { makeUnderwaterOverlay, makeUnderwaterFogWrapper } from './underwater.js';
import { makeSunShafts } from './sunshafts.js';
import { resolvePreset, PRESETS, PRESET_NAMES } from './presets.js';
import { causticsNode, makeCausticsPass } from './caustics.js';

export { PRESETS, PRESET_NAMES, causticsNode };

export const QUALITY_TIERS = {
  low: { fftSize: 128, segments: 128, reflection: false, resolutionScale: 0.25 },
  medium: { fftSize: 256, segments: 224, reflection: true, resolutionScale: 0.35 },
  high: { fftSize: 512, segments: 320, reflection: true, resolutionScale: 0.5 },
};

const DEG = Math.PI / 180;

/**
 * Create the ocean and attach it to the scene.
 *
 * const ocean = await createOcean({ renderer, scene, camera, preset: 'moderate' });
 * // per frame:
 * await ocean.update(dt);
 *
 * options: {
 *   preset: 'glassy'|'calm'|'breeze'|'moderate'|'rough'|'storm'|'sunset',
 *   quality: 'low'|'medium'|'high',
 *   seed: number,
 *   sky: true|false           — add the built-in sky dome,
 *   reflections: true|false   — planar reflections of scene objects,
 *   seabed: { texture, bounds: [minX, minZ, sizeX, sizeZ], deepY } | null,
 *   overrides: per-preset deep overrides ({ sim, water, sky, swell, secondary }),
 * }
 */
export async function createOcean(options = {}) {
  const { renderer, scene, camera } = options;
  if (!renderer || !scene || !camera) {
    throw new Error('createOcean requires { renderer, scene, camera }');
  }
  const quality = QUALITY_TIERS[options.quality ?? 'medium'] ?? QUALITY_TIERS.medium;
  let cfg = resolvePreset(options.preset ?? 'moderate', options.overrides ?? {});

  // Foam breakup ("lace") texture — also the sim's injection dither source.
  const laceTexture = new THREE.DataTexture(
    foamLaceData(256, 9001), 256, 256, THREE.RGBAFormat, THREE.UnsignedByteType
  );
  laceTexture.wrapS = laceTexture.wrapT = THREE.RepeatWrapping;
  laceTexture.magFilter = THREE.LinearFilter;
  laceTexture.minFilter = THREE.LinearMipmapLinearFilter;
  laceTexture.generateMipmaps = true;
  laceTexture.colorSpace = THREE.NoColorSpace;
  laceTexture.needsUpdate = true;

  // GPU FFT simulation: three wavelength-banded cascades. Cascade 0 (the
  // structural/foam cascade) uses the preset tile so storm presets keep
  // their long peak waves; the 59 m / 13 m cascades add mid detail and
  // centimetre chop.
  const sim = new GPUOceanSim({
    renderer,
    N: options.fftSize ?? quality.fftSize,
    cascades: [
      { tileSize: cfg.sim.tileSize, bandMinLambda: 29.5 },
      { tileSize: 59, bandMinLambda: 6.5, bandMaxLambda: 29.5 },
      { tileSize: 13, bandMaxLambda: 6.5 },
    ],
    seed: options.seed ?? 1337,
    swell: cfg.swellRad,
    windSpeed: cfg.sim.windSpeed,
    windDirectionRad: cfg.sim.windDirectionRad,
    fetch: cfg.sim.fetch,
    spectrum: options.spectrum ?? 'jonswap',
    directionality: cfg.sim.directionality,
    smallWaveCutoff: cfg.sim.smallWaveCutoff,
    amplitudeScale: cfg.sim.amplitudeScale,
    choppiness: cfg.sim.choppiness,
    foamDecay: cfg.sim.foamDecay,
    foamBias: cfg.sim.foamBias,
    foamGain: cfg.sim.foamGain,
    foamAdvect: cfg.sim.foamAdvect,
    foamDrift: cfg.sim.foamDrift,
    ditherTexture: laceTexture,
  });
  await sim.init();

  const u = makeOceanUniforms(cfg);
  applyConfigToUniforms(u, cfg, sim.swell, sim.N);

  const skyU = {
    sunDir: u.sunDir,
    sunColor: u.sunColor,
    sunIntensity: u.sunIntensity,
    zenith: u.zenith,
    horizon: u.horizon,
    haze: u.haze,
  };
  const skyColorFn = makeSkyColorFn(skyU);

  let skyDome = null;
  if (options.sky !== false) {
    skyDome = makeSkyDome(skyColorFn);
    scene.add(skyDome);
  }

  if (options.seabed) {
    u.seabedBounds.value.set(...options.seabed.bounds);
    u.seabedDeep.value = options.seabed.deepY ?? -45;
  }

  const reflectionEnabled = (options.reflections ?? true) && quality.reflection;
  let reflectorTarget = null;
  const material = makeOceanMaterial(u, {
    sim,
    skyColorFn,
    seabedTexture: options.seabed?.texture ?? null,
    laceTexture,
    lite: (options.quality ?? 'medium') === 'low',
    reflection: reflectionEnabled
      ? {
          enabled: true,
          resolutionScale: quality.resolutionScale,
          onReflector(mirror) {
            mirror.target.rotateX(-Math.PI / 2);
            reflectorTarget = mirror.target;
            surface.add(mirror.target);
          },
        }
      : null,
  });

  const surface = new THREE.Mesh(
    makeSurfaceGeometry({ segments: options.segments ?? quality.segments }),
    material
  );
  surface.frustumCulled = false;
  surface.name = 'OpenOceanSurface';
  scene.add(surface);

  const overlay = makeUnderwaterOverlay(u);
  scene.add(overlay.mesh);
  const fogWrapper = makeUnderwaterFogWrapper(u);
  if (skyDome) {
    // The sky must drown in murk too, or it shows through as bright bands
    // between the seabed edge and the surface when submerged.
    const domeBase = skyDome.material.colorNode;
    skyDome.material.colorNode = fogWrapper.wrap(() => domeBase);
  }

  let sunShafts = null;
  if (options.sunShafts !== false) {
    sunShafts = makeSunShafts(u);
    scene.add(sunShafts.group);
  }

  // Refracted-ray caustics (camera-local map re-rendered per frame).
  let caustics = null;
  let bedAt = () => -40;
  if (options.seabed && options.caustics !== false) {
    const sb = options.seabed;
    const sbData = sb.texture.image.data;
    const sbN = sb.texture.image.width;
    const [bx, bz, bw, bh] = sb.bounds;
    bedAt = (x, z) => {
      const uS = ((x - bx) / bw) * sbN;
      const vS = ((z - bz) / bh) * sbN;
      if (uS < 0 || vS < 0 || uS >= sbN || vS >= sbN) return sb.deepY ?? -40;
      return sbData[((vS | 0) * sbN + (uS | 0)) * 4];
    };
    caustics = makeCausticsPass({ sim });
  }
  const camDirTmp = new THREE.Vector3();
  const causCenterTmp = new THREE.Vector2();

  function applySun(cfgSky) {
    const el = cfgSky.sunElevation * DEG;
    const az = cfgSky.sunAzimuth * DEG;
    u.sunDir.value.set(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az)
    ).normalize();
    // Redden the sun near the horizon.
    const warm = Math.min(1, Math.max(0, 1 - cfgSky.sunElevation / 25));
    u.sunColor.value.setRGB(1, 0.97 - warm * 0.25, 0.9 - warm * 0.5);
  }
  applySun(cfg.sky);

  const ocean = {
    surface,
    sim,
    uniforms: u,
    skyDome,
    material,
    presets: PRESET_NAMES,
    config: cfg,
    stats: { simMs: 0 },

    /** Advance simulation & sync rendering state. Await once per frame. */
    async update(dt, simTime = sim.simTime + dt) {
      await sim.step(simTime, dt);
      this.stats.simMs = sim.lastStepMs;
      u.time.value = simTime;
      surface.position.set(camera.position.x, 0, camera.position.z);
      u.meshOffset.value.set(camera.position.x, camera.position.z);
      if (skyDome) skyDome.position.copy(camera.position);
      // Underwater state: smooth submergence band around the local surface.
      const h = sim.getHeightAt(camera.position.x, camera.position.z);
      const rel = camera.position.y - h;
      const band = 0.35;
      const sub = 1 - Math.min(1, Math.max(0, (rel + band) / (2 * band)));
      overlay.submergence.value = sub;
      fogWrapper.setEnabled(rel < 0 ? 1 : 0);
      u.camSubmerged.value = rel < 0 ? 1 : 0;
      this.underwater = rel < 0;
      this.cameraSurfaceHeight = h;
      if (sunShafts) {
        sunShafts.intensity.value = sub;
        sunShafts.group.visible = sub > 0.02;
        if (sunShafts.group.visible) {
          // Park the shaft fan a little ahead of the camera, offset toward
          // the sun so the shafts read as coming from the light.
          const s = u.sunDir.value;
          sunShafts.group.position.set(
            camera.position.x + s.x * 25,
            0,
            camera.position.z + s.z * 25
          );
        }
      }
      if (caustics) {
        // Center the caustic region a little ahead of the camera; use the
        // local average bed depth as the projection plane.
        camera.getWorldDirection(camDirTmp);
        causCenterTmp.set(
          camera.position.x + camDirTmp.x * 14,
          camera.position.z + camDirTmp.z * 14
        );
        const bedYAvg = Math.min(bedAt(causCenterTmp.x, causCenterTmp.y), -0.6);
        await caustics.update(renderer, u, sim.swell, causCenterTmp, bedYAvg);
      }
    },

    /** TSL: caustic light factor (≈1 neutral) at a world position, or null. */
    causticsSample: caustics ? caustics.sampleAt : null,
    causticsTexture: caustics ? caustics.texture : null,

    /** Water surface height at world (x, z) — CPU, matches the render. */
    getHeightAt(x, z) {
      return sim.getHeightAt(x, z);
    },

    /** Water surface normal at world (x, z). */
    getNormalAt(x, z, target) {
      return sim.getNormalAt(x, z, target);
    },

    /** Switch environment preset (rebuilds the spectrum; resets foam). */
    async setPreset(name, overrides = {}) {
      cfg = resolvePreset(name, overrides);
      this.config = cfg;
      await sim.reinit({
        cascade0TileSize: cfg.sim.tileSize,
        windSpeed: cfg.sim.windSpeed,
        windDirectionRad: cfg.sim.windDirectionRad,
        fetch: cfg.sim.fetch,
        directionality: cfg.sim.directionality,
        smallWaveCutoff: cfg.sim.smallWaveCutoff,
        amplitudeScale: cfg.sim.amplitudeScale,
        choppiness: cfg.sim.choppiness,
        foamDecay: cfg.sim.foamDecay,
        foamBias: cfg.sim.foamBias,
        foamGain: cfg.sim.foamGain,
        foamAdvect: cfg.sim.foamAdvect,
        foamDrift: cfg.sim.foamDrift,
        swell: cfg.swellRad,
      });
      applyConfigToUniforms(u, cfg, sim.swell, sim.N);
      applySun(cfg.sky);
    },

    /** Wrap a TSL color node with the ocean's underwater fog. */
    wrapUnderwaterFog(colorNode) {
      return fogWrapper.wrap(colorNode);
    },

    /** True while the camera is below the water surface. */
    underwater: false,

    dispose() {
      sim.dispose();
      caustics?.dispose();
      surface.geometry.dispose();
      material.dispose();
      scene.remove(surface, overlay.mesh);
      if (skyDome) {
        scene.remove(skyDome);
        skyDome.geometry.dispose();
        skyDome.material.dispose();
      }
    },
  };

  return ocean;
}
