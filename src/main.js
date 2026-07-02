// OpenOcean demo/verification app.
// Scenario is selected with ?scenario=<name>; the headless harness drives this
// page and reads the window.__OO contract to know when to capture screenshots.
import * as THREE from 'three/webgpu';

const params = new URLSearchParams(location.search);

window.__OO = {
  ready: false,
  frames: 0,
  simTime: 0,
  backend: 'none',
  errors: [],
  params: Object.fromEntries(params.entries()),
};

window.addEventListener('error', (e) => {
  window.__OO.errors.push(String(e.message || e));
});
window.addEventListener('unhandledrejection', (e) => {
  window.__OO.errors.push('unhandledrejection: ' + String(e.reason));
});

const SCENARIOS = {
  cube: () => import('./scenarios/cube.js'),
  ocean: () => import('./scenarios/ocean.js'),
  gpusim: () => import('./scenarios/gpusim.js'),
};

async function start() {
  const name = params.get('scenario') || 'ocean';
  const loader = SCENARIOS[name];
  if (!loader) throw new Error(`Unknown scenario: ${name}`);

  // Target WebGPU, but fall back to the WebGL2 backend when the adapter or
  // device is unavailable/broken (common in headless/software rendering).
  let forceWebGL = params.get('forcewebgl') === '1';
  if (!forceWebGL) {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      const device = adapter ? await adapter.requestDevice() : null;
      if (!device) forceWebGL = true;
      else device.destroy?.();
    } catch {
      forceWebGL = true;
    }
  }

  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    forceWebGL,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  window.__OO.backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';

  const mod = await loader();
  // Each scenario returns { scene, camera, update(dt, simTime) }.
  const ctx = await mod.init({ renderer, params });

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    ctx.camera.aspect = window.innerWidth / window.innerHeight;
    ctx.camera.updateProjectionMatrix();
  });

  // ?fixeddt=1 → deterministic fixed timestep (default 1/60 s, override with ?dt=).
  const fixedDt = params.get('fixeddt') === '1' ? Number(params.get('dt') || 1 / 60) : null;
  const hud = document.getElementById('hud');
  const clock = new THREE.Clock();
  let simTime = Number(params.get('t0') || 0);

  async function frame() {
    const dt = fixedDt !== null ? fixedDt : Math.min(clock.getDelta(), 0.1);
    simTime += dt;
    try {
      await ctx.update?.(dt, simTime);
      await renderer.renderAsync(ctx.scene, ctx.camera);
    } catch (err) {
      window.__OO.errors.push(String(err?.stack || err));
      throw err;
    }
    window.__OO.frames++;
    window.__OO.simTime = simTime;
    if (hud && params.get('hud') !== '0') {
      hud.textContent = `${name} | ${window.__OO.backend} | t=${simTime.toFixed(2)}s | frames=${window.__OO.frames}${ctx.hudExtra ? '\n' + ctx.hudExtra() : ''}`;
    }
    requestAnimationFrame(frame);
  }

  window.__OO.ready = true;
  requestAnimationFrame(frame);
}

start().catch((err) => {
  window.__OO.errors.push(String(err?.stack || err));
  console.error(err);
});
