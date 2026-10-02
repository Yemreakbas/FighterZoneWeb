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

  // Projectiles: up to one per fighter, coloured by owner.
  const ORB_COLORS = [0xff5a3a, 0x3aa8ff];
  const orbGeo = new THREE.SphereGeometry(1, 16, 12);
  const orbs = ORB_COLORS.map((color) => {
    const group = new THREE.Group();
    const glow = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const core = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    core.scale.setScalar(0.12);
    glow.scale.setScalar(0.26);
    // The light stays in the scene at intensity 0 when unused: toggling a
    // light's visibility changes the light count and forces a shader recompile.
    const light = new THREE.PointLight(color, 0, 5);
    group.add(glow, core, light);
    scene.add(group);
    return { glow, core, light, group };
  });
  const showOrb = (o, on) => {
    o.glow.visible = o.core.visible = on;
    o.light.intensity = on ? 8 : 0;
  };
  orbs.forEach((o) => showOrb(o, false));
  let orbTime = 0;

  /** Mirror the simulation's projectile list (positions already interpolated). */
  function syncProjectiles(list, dt) {
    orbTime += dt;
    orbs.forEach((o, i) => showOrb(o, list.some((p) => p.owner === i)));
    for (const p of list) {
      const o = orbs[p.owner];
      if (!o) continue;
      o.group.position.set(p.x, p.y, 0);
      o.glow.scale.setScalar(0.26 + Math.sin(orbTime * 30) * 0.04);
    }
  }

  function setProjectileColor(owner, color) {
    const o = orbs[owner];
    if (!o) return;
    o.glow.material.color.setHex(color);
    o.light.color.setHex(color);
  }

  // Fatality: the body bursts into tumbling pieces that bounce and settle.
  const PIECES = 18;
  const PIECE_LIFE = 5;
  const pieceGeo = new THREE.BoxGeometry(1, 1, 1);
  const pieces = Array.from({ length: PIECES }, () => {
    const mesh = new THREE.Mesh(pieceGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }));
    mesh.castShadow = true;
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), age: PIECE_LIFE };
  });
  const SKIN = 0xd9a37a;

  function explode(x, y, color) {
    pieces.forEach((p, i) => {
      p.age = 0;
      p.mesh.visible = true;
      p.mesh.material.color.setHex(i % 3 === 0 ? SKIN : color);
      const size = 0.12 + Math.random() * 0.22;
      p.mesh.scale.set(size, size * (0.6 + Math.random()), size);
      p.mesh.position.set(x + (Math.random() - 0.5) * 0.5, y + 0.4 + Math.random() * 1.4, (Math.random() - 0.5) * 0.4);
      p.vel.set((Math.random() - 0.5) * 9, 4 + Math.random() * 7, (Math.random() - 0.5) * 5);
      p.spin.set(Math.random() * 12, Math.random() * 12, Math.random() * 12);
    });
    spark(x, y + 1.2, { heavy: true });
    flashLight.intensity = 40;
  }

  function updatePieces(dt) {
    for (const p of pieces) {
      if (!p.mesh.visible) continue;
      p.age += dt;
      if (p.age >= PIECE_LIFE) { p.mesh.visible = false; continue; }
      p.vel.y -= 25 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      const floor = p.mesh.scale.y / 2;
      if (p.mesh.position.y < floor) {
        // Bounce with heavy damping, then come to rest.
        p.mesh.position.y = floor;
        p.vel.y = Math.abs(p.vel.y) * 0.3;
        p.vel.x *= 0.6;
        p.vel.z *= 0.6;
        p.spin.multiplyScalar(0.5);
      }
    }
  }

  /** Remove leftover pieces (new round / leaving the match). */
  function clearPieces() {
    for (const p of pieces) p.mesh.visible = false;
  }

  return {
    spark,
    update(dt) { update(dt); updatePieces(dt); },
    syncProjectiles,
    setProjectileColor,
    explode,
    clearPieces,
  };
}
