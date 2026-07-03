// Props (R3): a floating buoy + simple ship primitive, and a planar
// reflection pass that renders ONLY the props mirrored about y=0 into an
// RGBA target (alpha 0 elsewhere). The water blends this over its analytic
// sky reflection, perturbed by the displaced normals.
import * as THREE from 'three/webgpu'

export function createProps (renderer, scene, camera, probes, reflJack) {
  const group = new THREE.Group()
  scene.add(group)

  // buoy: red can with a small mast — placed to be visible in M1/M3
  const buoy = new THREE.Group()
  const can = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.7, 1.6, 20),
    new THREE.MeshStandardMaterial({ color: 0xb03028, roughness: 0.5, metalness: 0.1 }))
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.45, 0.9, 16),
    new THREE.MeshStandardMaterial({ color: 0xd8d0c0, roughness: 0.6 }))
  cone.position.y = 1.2
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 2.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.7 }))
  mast.position.y = 2.2
  buoy.add(can, cone, mast)
  buoy.position.set(40, 0.2, 9)
  group.add(buoy)

  // ship primitive: hull + two masts (far silhouette)
  const ship = new THREE.Group()
  const hull = new THREE.Mesh(
    new THREE.BoxGeometry(14, 3.4, 4.6),
    new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.85 }))
  hull.position.y = 0.9
  const bow = new THREE.Mesh(
    new THREE.ConeGeometry(2.3, 5, 4),
    new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.85 }))
  bow.rotation.z = -Math.PI / 2
  bow.position.set(9.5, 0.9, 0)
  const m1 = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.3, 16, 8),
    new THREE.MeshStandardMaterial({ color: 0x2f2318, roughness: 0.8 }))
  m1.position.set(2.5, 9, 0)
  const m2 = m1.clone(); m2.position.set(-3.5, 8, 0); m2.scale.y = 0.85
  const sail = new THREE.Mesh(
    new THREE.PlaneGeometry(6.5, 7),
    new THREE.MeshStandardMaterial({ color: 0xd9d2c2, roughness: 0.9, side: THREE.DoubleSide }))
  sail.position.set(2.5, 9.5, 0)
  ship.add(hull, bow, m1, m2, sail)
  ship.position.set(150, 0.4, -55)
  ship.rotation.y = 0.5
  group.add(ship)

  // key light so std materials read (scene has no other lights)
  const sun = new THREE.DirectionalLight(0xffffff, 2.2)
  sun.position.set(200, 180, 30)
  const amb = new THREE.AmbientLight(0x8faabb, 0.75)
  scene.add(sun, amb)

  // ---- planar reflection: props only, mirrored about y = 0
  const rt = reflJack.rt
  const mirrorCam = new THREE.PerspectiveCamera()
  const S = new THREE.Matrix4().makeScale(1, -1, 1)
  const mirrorVP = new THREE.Matrix4()

  function updateReflection () {
    mirrorCam.copy(camera)
    mirrorCam.matrixAutoUpdate = false
    mirrorCam.matrixWorld.copy(camera.matrixWorld).premultiply(S)
    mirrorCam.matrixWorldInverse.copy(mirrorCam.matrixWorld).invert()
    mirrorCam.projectionMatrix.copy(camera.projectionMatrix)
    mirrorVP.multiplyMatrices(mirrorCam.projectionMatrix, mirrorCam.matrixWorldInverse)
    if (reflJack.vp) reflJack.vp.value.copy(mirrorVP)

    const prevRT = renderer.getRenderTarget()
    const prevClear = new THREE.Color()
    renderer.getClearColor(prevClear); const prevA = renderer.getClearAlpha()
    renderer.setClearColor(0x000000, 0)
    // hide everything but props for this pass
    const vis = []
    scene.traverse(o => {
      if (o.isMesh || o.isGroup) {
        if (o !== group && o.parent === scene) { vis.push([o, o.visible]); o.visible = false }
      }
    })
    const flip = renderer.coordinateSystem // culling handled by mirrored winding: use override
    renderer.setRenderTarget(rt)
    renderer.render(scene, mirrorCam)
    for (const [o, v] of vis) o.visible = v
    renderer.setClearColor(prevClear, prevA)
    renderer.setRenderTarget(prevRT)
    void flip
  }

  async function updateFloating (t) {
    // buoy bobs on the real surface (probe readback, one-frame latency is fine)
    try {
      const s = await probes.heightStats(buoy.position.x, buoy.position.z, 0.001)
      buoy.position.y = s.meanSurfaceY + 0.15
      buoy.rotation.z = Math.sin(t * 0.9) * 0.09
      buoy.rotation.x = Math.cos(t * 0.7) * 0.07
      const s2 = await probes.heightStats(ship.position.x, ship.position.z, 8)
      ship.position.y = s2.meanSurfaceY + 0.2
      ship.rotation.z = Math.sin(t * 0.5 + 1) * 0.05
    } catch { /* readback can fail during teardown */ }
  }

  return { group, buoy, ship, rt, mirrorVP, updateReflection, updateFloating }
}
