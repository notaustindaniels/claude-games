// Demo props: lighthouse (planar-reflection proof), floating crate
// (multi-point buoyancy: pitch & roll), bobbing buoy (single-point mode).
import * as THREE from 'three/webgpu';

export function makeLighthouse() {
  const g = new THREE.Group();
  const mats = {
    white: new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.7 }),
    red: new THREE.MeshStandardMaterial({ color: 0xb52323, roughness: 0.7 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x22262a, roughness: 0.5 }),
    lamp: new THREE.MeshStandardMaterial({
      color: 0xfff2c0, emissive: 0xffe28a, emissiveIntensity: 2.2, roughness: 0.3,
    }),
  };
  // Striped tower.
  const bands = 5;
  const towerH = 26;
  for (let i = 0; i < bands; i++) {
    const h = towerH / bands;
    const r0 = 5.2 - (i / bands) * 1.8;
    const r1 = 5.2 - ((i + 1) / bands) * 1.8;
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(r1, r0, h, 24),
      i % 2 ? mats.red : mats.white
    );
    seg.position.y = h * (i + 0.5);
    g.add(seg);
  }
  // Gallery + lamp room + cap.
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.4, 1.2, 24), mats.dark);
  gallery.position.y = towerH + 0.6;
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 3.4, 16), mats.lamp);
  lamp.position.y = towerH + 3;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(3.2, 2.6, 16), mats.red);
  cap.position.y = towerH + 6;
  g.add(gallery, lamp, cap);
  return g;
}

export function makeCrate(size = 7) {
  const crate = new THREE.Mesh(
    new THREE.BoxGeometry(size, size * 0.55, size),
    new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.8 })
  );
  crate.userData.halfX = size / 2;
  crate.userData.halfZ = size / 2;
  return crate;
}

export function makeBuoy() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(1.6, 20, 14),
    new THREE.MeshStandardMaterial({ color: 0xd8401f, roughness: 0.5 })
  );
  body.scale.y = 0.8;
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.16, 3.4, 8),
    new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.5 })
  );
  mast.position.y = 2.2;
  const light = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 12, 8),
    new THREE.MeshStandardMaterial({
      color: 0xffe28a, emissive: 0xffc040, emissiveIntensity: 2, roughness: 0.4,
    })
  );
  light.position.y = 4.0;
  g.add(body, mast, light);
  return g;
}

const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/** Multi-point buoyancy: sample under the footprint, apply pitch & roll. */
export function floatCrate(ocean, crate, t) {
  const { x, z } = crate.position;
  const hx = crate.userData.halfX * 0.8;
  const hz = crate.userData.halfZ * 0.8;
  const hC = ocean.getHeightAt(x, z);
  const hE = ocean.getHeightAt(x + hx, z);
  const hW = ocean.getHeightAt(x - hx, z);
  const hN = ocean.getHeightAt(x, z + hz);
  const hS = ocean.getHeightAt(x, z - hz);
  crate.position.y = (hC + hE + hW + hN + hS) / 5 + 0.35;
  // Pitch/roll from height differences across the footprint.
  _n.set(-(hE - hW) / (2 * hx), 1, -(hN - hS) / (2 * hz)).normalize();
  _q.setFromUnitVectors(_up, _n);
  crate.quaternion.slerp(_q, 0.5);
  crate.rotation.y += 0; // keep yaw
}

/** Single-point buoyancy: bob only, slight normal-driven sway. */
export function floatBuoy(ocean, buoy) {
  const { x, z } = buoy.position;
  buoy.position.y = ocean.getHeightAt(x, z) - 0.35;
  ocean.getNormalAt(x, z, _n);
  _q.setFromUnitVectors(_up, _n);
  buoy.quaternion.slerp(_q, 0.12); // moored: follows the surface loosely
}
