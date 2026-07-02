// Free-fly camera + preset dropdown for the explorable demo.
// Drag = look, WASD = move, Q/E = down/up, Shift = boost, wheel = speed.
// Input-driven only: with no user input the camera stays exactly where the
// URL params put it, so harness determinism is unaffected.
import * as THREE from 'three/webgpu';

export function attachFreeFly(camera, dom) {
  const state = {
    yaw: 0,
    pitch: 0,
    keys: new Set(),
    speed: 10,
    dragging: false,
  };
  // Initialize yaw/pitch from the camera's current orientation.
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  state.yaw = e.y;
  state.pitch = e.x;

  dom.addEventListener('pointerdown', (ev) => {
    state.dragging = true;
    dom.setPointerCapture?.(ev.pointerId);
  });
  dom.addEventListener('pointerup', () => (state.dragging = false));
  dom.addEventListener('pointermove', (ev) => {
    if (!state.dragging) return;
    state.yaw -= ev.movementX * 0.0032;
    state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch - ev.movementY * 0.0032));
    camera.quaternion.setFromEuler(new THREE.Euler(state.pitch, state.yaw, 0, 'YXZ'));
  });
  window.addEventListener('keydown', (ev) => state.keys.add(ev.code));
  window.addEventListener('keyup', (ev) => state.keys.delete(ev.code));
  window.addEventListener('wheel', (ev) => {
    state.speed = Math.max(1, Math.min(200, state.speed * (ev.deltaY > 0 ? 0.9 : 1.12)));
  });

  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();

  return {
    state,
    update(dt) {
      if (state.keys.size === 0) return;
      const k = state.keys;
      const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1;
      const v = state.speed * boost * dt;
      camera.getWorldDirection(fwd);
      right.crossVectors(fwd, camera.up).normalize();
      if (k.has('KeyW')) camera.position.addScaledVector(fwd, v);
      if (k.has('KeyS')) camera.position.addScaledVector(fwd, -v);
      if (k.has('KeyA')) camera.position.addScaledVector(right, -v);
      if (k.has('KeyD')) camera.position.addScaledVector(right, v);
      if (k.has('KeyQ')) camera.position.y -= v;
      if (k.has('KeyE')) camera.position.y += v;
    },
  };
}

export function attachPresetPicker(ocean, onSwitch) {
  const sel = document.createElement('select');
  sel.id = 'preset-picker';
  sel.style.cssText =
    'position:fixed;top:10px;right:10px;z-index:20;font:13px monospace;padding:4px 6px;' +
    'background:#10202e;color:#cfe6f5;border:1px solid #3a5a72;border-radius:4px;';
  for (const name of ocean.presets) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === ocean.config.name) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', async () => {
    sel.disabled = true;
    await ocean.setPreset(sel.value);
    onSwitch?.(sel.value);
    sel.disabled = false;
  });
  document.body.appendChild(sel);
  return sel;
}
