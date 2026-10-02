import * as THREE from 'three';

// Short-lived hit sparks from a small reusable pool (no per-hit allocation).

const POOL_SIZE = 8;
const LIFETIME = 0.22;

export function createEffects(scene) {
  const geo = new THREE.IcosahedronGeometry(0.16, 0);
  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    scene.add(m);
    pool.push({ mesh: m, age: LIFETIME, size: 1 });
  }
  let cursor = 0;

  const flashLight = new THREE.PointLight(0xffe0a0, 0, 6);
  scene.add(flashLight);

  function spark(x, y, { blocked = false, heavy = false } = {}) {
    const s = pool[cursor];
    cursor = (cursor + 1) % POOL_SIZE;
    s.age = 0;
    s.size = heavy ? 1.6 : 1;
    s.mesh.material.color.set(blocked ? 0x66ccff : heavy ? 0xff7a1a : 0xffe066);
    s.mesh.position.set(x, y, 0.3);
    s.mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    s.mesh.visible = true;

    flashLight.color.copy(s.mesh.material.color);
    flashLight.position.set(x, y, 1);
    flashLight.intensity = heavy ? 18 : 10;
  }

  function update(dt) {
    for (const s of pool) {
      if (!s.mesh.visible) continue;
      s.age += dt;
      const k = s.age / LIFETIME;
      if (k >= 1) { s.mesh.visible = false; continue; }
      s.mesh.scale.setScalar(s.size * (0.6 + k * 2.2));
      s.mesh.material.opacity = 1 - k;
      s.mesh.rotation.z += dt * 10;
    }
    flashLight.intensity *= Math.exp(-25 * dt);
  }

  return { spark, update };
}
