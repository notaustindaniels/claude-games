// Ocean verification scenario (stub until the ocean library lands).
import * as THREE from 'three/webgpu';

export async function init({ renderer, params }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101820);
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 10, 30);
  camera.lookAt(0, 0, 0);
  return { scene, camera, update() {} };
}
