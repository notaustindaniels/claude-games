// Ocean verification scenario. URL params drive everything the harness
// needs: preset, quality, seed, camera, wind overrides, prop toggles,
// foam-freeze (persistent-foam decay proof), labels.
import * as THREE from 'three/webgpu';
import { createOcean } from '../lib/index.js';
import { makeSeabedTexture, makeSeabedMesh } from './seabed.js';
import { makeLighthouse, makeCrate, makeBuoy, floatCrate, floatBuoy } from './props.js';

function num(params, key, dflt) {
  const v = params.get(key);
  return v === null ? dflt : Number(v);
}

function vec(params, key, dflt) {
  const v = params.get(key);
  if (!v) return dflt;
  const p = v.split(',').map(Number);
  return new THREE.Vector3(p[0], p[1], p[2]);
}

export async function init({ renderer, params }) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    num(params, 'fov', 55),
    window.innerWidth / window.innerHeight,
    0.5,
    20000
  );
  camera.position.copy(vec(params, 'cam', new THREE.Vector3(-38, 14, 64)));
  camera.lookAt(vec(params, 'look', new THREE.Vector3(30, 0, -40)));

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = num(params, 'exposure', 1.05);

  // Wind / sim overrides for W1 evidence shots.
  const overrides = { sim: {}, water: {}, sky: {} };
  if (params.has('windspeed')) overrides.sim.windSpeed = num(params, 'windspeed');
  if (params.has('winddir')) overrides.sim.windDirection = num(params, 'winddir');
  if (params.has('fetch')) overrides.sim.fetch = num(params, 'fetch');
  if (params.has('chop')) overrides.sim.choppiness = num(params, 'chop');
  if (params.has('ampscale')) overrides.sim.amplitudeScale = num(params, 'ampscale');
  if (params.has('tilesize')) overrides.sim.tileSize = num(params, 'tilesize');
  if (params.has('sunel')) overrides.sky.sunElevation = num(params, 'sunel');
  if (params.has('sunaz')) overrides.sky.sunAzimuth = num(params, 'sunaz');
  if (params.get('swell') === '0') overrides.swell = [];
  if (params.has('ambfoam')) overrides.water.ambientFoam = num(params, 'ambfoam');
  if (params.has('foamgain')) overrides.sim.foamGain = num(params, 'foamgain');

  const seabed = params.get('seabed') === '0' ? null : makeSeabedTexture();

  const ocean = await createOcean({
    renderer, scene, camera,
    preset: params.get('preset') || 'moderate',
    quality: params.get('quality') || 'medium',
    seed: num(params, 'seed', 1337),
    spectrum: params.get('spectrum') || 'jonswap',
    reflections: params.get('refl') !== '0',
    sunShafts: params.get('shafts') !== '0',
    seabed,
    overrides,
  });

  // Lights for the standard-material props (water is self-shaded).
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.position.copy(ocean.uniforms.sunDir.value).multiplyScalar(200);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x91a8c0, 0.85));

  const props = { crate: null, buoy: null };
  if (seabed && params.get('seabedmesh') !== '0') {
    scene.add(makeSeabedMesh(ocean, { procCaustics: params.get('proccaustics') === '1' }));
  }
  if (params.get('lighthouse') !== '0') {
    const lh = makeLighthouse();
    lh.position.set(170, 14.5, -230);
    scene.add(lh);
  }
  if (params.get('crate') !== '0') {
    props.crate = makeCrate();
    props.crate.position.set(num(params, 'cratex', -12), 0, num(params, 'cratez', 8));
    scene.add(props.crate);
  }
  if (params.get('buoy') !== '0') {
    props.buoy = makeBuoy();
    props.buoy.position.set(num(params, 'buoyx', 18), 0, num(params, 'buoyz', -6));
    scene.add(props.buoy);
  }

  // Persistent-foam decay proof: at t >= foamfreeze, stop injecting foam
  // (the accumulated field keeps decaying — nothing else changes).
  const foamFreezeAt = params.has('foamfreeze') ? num(params, 'foamfreeze') : null;
  let foamFrozen = false;

  const label = params.get('label');

  async function update(dt, simTime) {
    if (foamFreezeAt !== null && !foamFrozen && simTime >= foamFreezeAt) {
      ocean.sim.setFoam({ foamGain: 0 });
      foamFrozen = true;
    }
    await ocean.update(dt, simTime);
    if (props.crate) floatCrate(ocean, props.crate, simTime);
    if (props.buoy) floatBuoy(ocean, props.buoy);
    window.__OO.stats = {
      simMs: +ocean.stats.simMs.toFixed(2),
      underwater: ocean.underwater,
      camSurfaceH: +ocean.cameraSurfaceHeight?.toFixed(3),
      crateTiltDeg: props.crate
        ? +(props.crate.quaternion.angleTo(new THREE.Quaternion()) * 180 / Math.PI).toFixed(2)
        : null,
    };
  }

  // ?fieldprobe=1: read back the GPU sim's cascade-0 displacement field and
  // report height channel stats (diagnostics).
  if (params.get('fieldprobe') === '1') {
    setTimeout(async () => {
      try {
        const rt = ocean.sim.dispRT[0];
        const N = ocean.sim.N;
        const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, N, N);
        let mn = Infinity;
        let mx = -Infinity;
        let sum2 = 0;
        for (let i = 0; i < N * N; i++) {
          const h = buf[i * 4 + 1];
          mn = Math.min(mn, h);
          mx = Math.max(mx, h);
          sum2 += h * h;
        }
        window.__OO.fieldProbe = {
          min: +mn.toFixed(3), max: +mx.toFixed(3),
          rms: +Math.sqrt(sum2 / (N * N)).toFixed(3),
        };
      } catch (e) {
        window.__OO.fieldProbe = { error: String(e) };
      }
    }, 4000);
  }

  // ?dumpshader=<meshName>: capture the compiled fragment shader for a mesh
  // (diagnostics; read back via window.__OO.shaderDump).
  const dumpName = params.get('dumpshader');
  if (dumpName) {
    setTimeout(async () => {
      const target = scene.getObjectByName(dumpName);
      if (target) {
        const { fragmentShader, vertexShader } = await renderer.debug.getShaderAsync(scene, camera, target);
        window.__OO.shaderDump = { fragmentShader, vertexShader };
      } else {
        window.__OO.shaderDump = { error: 'mesh not found: ' + dumpName };
      }
    }, 3000);
  }

  function hudExtra() {
    const s = window.__OO.stats || {};
    const base = `preset=${ocean.config.name} sim=${s.simMs}ms h=${s.camSurfaceH}${s.underwater ? ' UNDERWATER' : ''}`;
    return label ? `${label}\n${base}` : base;
  }

  return { scene, camera, update, hudExtra, ocean };
}
