// GPU-sim verification scenario: steps the GPU FFT ocean, compares cascade 0
// against the CPU reference implementation (same seed/band), and displays the
// raw field textures. The harness asserts window.__OO.verify.ok.
import * as THREE from 'three/webgpu';
import { Fn, texture, uv, vec4, vec3, float, positionLocal } from 'three/tsl';
import { GPUOceanSim } from '../lib/gpu-sim.js';
import { foamLaceData } from '../lib/foamlace.js';

function num(params, key, dflt) {
  const v = params.get(key);
  return v === null ? dflt : Number(v);
}

export async function init({ renderer, params }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101418);
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 3.2);

  const laceTexture = new THREE.DataTexture(
    foamLaceData(256, 9001), 256, 256, THREE.RGBAFormat, THREE.UnsignedByteType
  );
  laceTexture.wrapS = laceTexture.wrapT = THREE.RepeatWrapping;
  laceTexture.needsUpdate = true;

  const sim = new GPUOceanSim({
    renderer,
    N: num(params, 'fftsize', 256),
    seed: num(params, 'seed', 1337),
    cascades: [
      { tileSize: 256, bandMinLambda: 29.5, bandMaxLambda: Infinity },
      { tileSize: 59, bandMinLambda: 6.5, bandMaxLambda: 29.5 },
      { tileSize: 13, bandMinLambda: 0, bandMaxLambda: 6.5 },
    ],
    windSpeed: num(params, 'windspeed', 10.5),
    windDirectionRad: 30 * Math.PI / 180,
    fetch: 300000,
    directionality: 8,
    smallWaveCutoff: 0.008,
    amplitudeScale: 1,
    choppiness: 1.25,
    foamDecay: 5,
    foamBias: 0.6,
    foamGain: 6,
    swell: [],
    ditherTexture: laceTexture,
  });
  await sim.init();

  // Display quads: disp0 / norm0 / disp2 / foam.
  const quads = [
    { tex: sim.dispTextures[0], scale: 0.25, bias: 0.5, pos: [-1.05, 0.55] },
    { tex: sim.normTextures[0], scale: 0.5, bias: 0.5, pos: [1.05, 0.55] },
    { tex: sim.dispTextures[2], scale: 2.0, bias: 0.5, pos: [-1.05, -0.55] },
    { tex: sim.foamTexture, scale: 1.0, bias: 0.0, pos: [1.05, -0.55] },
  ];
  for (const q of quads) {
    const mat = new THREE.MeshBasicNodeMaterial();
    const t = texture(q.tex);
    mat.colorNode = Fn(() => vec4(t.sample(uv()).xyz.mul(q.scale).add(q.bias), 1))();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.0), mat);
    mesh.position.set(q.pos[0], q.pos[1], 0);
    scene.add(mesh);
  }

  let verified = false;
  let unitDone = false;

  async function update(dt, simTime) {
    await sim.step(simTime, dt);
    if (!unitDone && window.__OO.frames >= 4) {
      unitDone = true;
      // Full 2D IFFT vs CPU reference on random data (f32 storage): ~3e-4
      // relative accumulation over 16 stages is healthy.
      const t = await sim.testIFFT();
      window.__OO.ifftTest = { rmsRel: t.rmsRel, maxRel: t.maxRel };
      if (t.rmsRel > 2e-3 && params.get('strict') !== '0') {
        window.__OO.errors.push(`GPU IFFT unit test failed: rmsRel=${t.rmsRel.toExponential(3)} hyp=${JSON.stringify(t.hyp)}`);
      }
    }
    if (!verified && window.__OO.frames >= 10) {
      verified = true;
      // Whole pipeline (evolve + IFFT + post, half-float storage) vs the
      // CPU worker reference at the same seed/band/time.
      const v = await sim.verifyAgainstCPU(simTime);
      const ok = v.rms < Math.max(0.02 * v.refRms, 0.004);
      window.__OO.verify = { ...v, ok };
      if (!ok && params.get('strict') !== '0') {
        window.__OO.errors.push(
          `GPU/CPU FFT mismatch: rms=${v.rms.toExponential(3)} refRms=${v.refRms.toExponential(3)} maxAbs=${v.maxAbs.toExponential(3)} variants=${JSON.stringify(v.variants)}`
        );
      }
    }
    window.__OO.stats = { simMs: +sim.lastStepMs.toFixed(1), verify: window.__OO.verify };
  }

  function hudExtra() {
    const v = window.__OO.verify;
    return v
      ? `verify ok=${v.ok} rms=${v.rms.toExponential(2)} refRms=${v.refRms.toExponential(2)} maxAbs=${v.maxAbs.toExponential(2)}`
      : 'verifying…';
  }

  return { scene, camera, update, hudExtra };
}
