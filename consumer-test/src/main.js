// OpenOcean quickstart — matches the README (< 15 lines of user code).
import * as THREE from 'three/webgpu';
import { createOcean } from 'openocean';

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 40000);
camera.position.set(0, 12, 0);
camera.lookAt(120, 0, -220);
const ocean = await createOcean({ scene, camera, renderer, preset: 'breeze' });
const clock = new THREE.Clock();
renderer.setAnimationLoop(async () => {
  await ocean.update(clock.getDelta());
  await renderer.renderAsync(scene, camera);
});
