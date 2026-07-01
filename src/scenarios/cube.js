// Harness proof scenario: a lit spinning cube over a ground plane.
// Exists so the headless screenshot pipeline is verified before any water code.
import * as THREE from 'three/webgpu';

export async function init({ renderer, params }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x203040);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.set(3, 2.5, 4);
  camera.lookAt(0, 0.5, 0);

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(5, 8, 3);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x8899aa, 0.6));

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xff6600, roughness: 0.4 })
  );
  cube.position.y = 0.5;
  scene.add(cube);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardMaterial({ color: 0x336633, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  function update(dt, simTime) {
    cube.rotation.y = simTime * 0.9;
    cube.rotation.x = simTime * 0.5;
  }

  return { scene, camera, update };
}
