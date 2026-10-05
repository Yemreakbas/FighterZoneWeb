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

  // Shockwave: a flat ring that expands from each clean hit.
  const RING_LIFE = 0.28;
  const ringGeo = new THREE.RingGeometry(0.7, 0.85, 32);
  const rings = Array.from({ length: 6 }, () => {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    m.visible = false;
    scene.add(m);
    return { mesh: m, age: RING_LIFE, size: 1 };
  });
  let ringCursor = 0;

  function spark(x, y, { blocked = false, heavy = false } = {}) {
    if (!blocked) {
      const r = rings[ringCursor];
      ringCursor = (ringCursor + 1) % rings.length;
      r.age = 0;
      r.size = heavy ? 1.4 : 0.9;
      r.mesh.material.color.set(heavy ? 0xff9a3a : 0xfff0a0);
      r.mesh.position.set(x, y, 0.35);
      r.mesh.rotation.set(0, 0, Math.random() * Math.PI);
      r.mesh.visible = true;
    }
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
    for (const r of rings) {
      if (!r.mesh.visible) continue;
      r.age += dt;
      const k = r.age / RING_LIFE;
      if (k >= 1) { r.mesh.visible = false; continue; }
      r.mesh.scale.setScalar(r.size * (0.25 + k * 0.9));
      r.mesh.material.opacity = 0.9 * (1 - k);
    }
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

  // Dust: a ring of puffs that roll outward along the floor and fade.
  const DUST_COUNT = 14;
  const DUST_LIFE = 0.7;
  const dustGeo = new THREE.SphereGeometry(1, 8, 6);
  const dust = Array.from({ length: DUST_COUNT }, () => {
    const mesh = new THREE.Mesh(dustGeo, new THREE.MeshBasicMaterial({
      color: 0xc8b49a, transparent: true, depthWrite: false,
    }));
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, vx: 0, vz: 0, vy: 0, age: DUST_LIFE, size: 0.2 };
  });

  /** Impact on a surface at `x` (height `y`); `strength` scales spread and puff size. */
  function dustBurst(x, strength = 1, y = 0) {
    dust.forEach((d, i) => {
      const side = i % 2 === 0 ? 1 : -1;
      d.age = 0;
      d.size = (0.14 + Math.random() * 0.14) * strength;
      d.vx = side * (1.5 + Math.random() * 3) * strength;
      d.vz = (Math.random() - 0.5) * 2;
      d.vy = 0.4 + Math.random() * 1.2;
      d.mesh.position.set(x + side * Math.random() * 0.3, y + 0.08, (Math.random() - 0.5) * 0.4);
      d.mesh.visible = true;
    });
  }

  function updateDust(dt) {
    for (const d of dust) {
      if (!d.mesh.visible) continue;
      d.age += dt;
      const k = d.age / DUST_LIFE;
      if (k >= 1) { d.mesh.visible = false; continue; }
      const drag = Math.exp(-4 * dt);
      d.vx *= drag;
      d.vz *= drag;
      d.vy *= drag;
      d.mesh.position.x += d.vx * dt;
      d.mesh.position.y += d.vy * dt;
      d.mesh.position.z += d.vz * dt;
      d.mesh.scale.set(d.size * (1 + k * 1.6), d.size * (0.5 + k * 0.8), d.size * (1 + k * 1.6));
      d.mesh.material.opacity = 0.4 * (1 - k);
    }
  }

  // Projectiles: up to one per fighter (4 in a team fight), coloured by owner.
  const ORB_COLORS = [0xff5a3a, 0x3aa8ff, 0xff5a3a, 0x3aa8ff];
  const orbGeo = new THREE.SphereGeometry(1, 16, 12);
  const orbs = ORB_COLORS.map((color) => {
    const group = new THREE.Group();
    const glow = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const core = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    core.scale.setScalar(0.12);
    glow.scale.setScalar(0.26);
    // No point light per orb: up to four extra lights would cost every lit
    // pixel on screen. The additive glow carries the effect.
    group.add(glow, core);
    scene.add(group);
    return { glow, core, group };
  });
  const showOrb = (o, on) => {
    o.glow.visible = o.core.visible = on;
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
      // Size follows the projectile; a low wave hugging the floor is flattened.
      const r = p.r ?? 0.22;
      const flat = p.y < 0.6 ? 0.55 : 1;
      const pulse = 1.18 + Math.sin(orbTime * 30) * 0.18;
      o.glow.scale.set(r * pulse * (flat < 1 ? 1.6 : 1), r * pulse * flat, r * pulse);
      o.core.scale.set(r * 0.55, r * 0.55 * flat, r * 0.55);
    }
  }

  function setProjectileColor(owner, color) {
    const o = orbs[owner];
    if (!o) return;
    o.glow.material.color.setHex(color);
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

  // Power-up crystal: a spinning gem with an additive halo, green for
  // health, blue for special charge.
  const PICKUP_COLORS = { health: 0x4dff88, charge: 0x4db8ff };
  const gemMat = new THREE.MeshBasicMaterial({ color: 0x4dff88 });
  const haloMat = new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
  const gem = new THREE.Group();
  gem.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.24, 0), gemMat));
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), haloMat);
  gem.add(halo);
  gem.visible = false;
  scene.add(gem);
  let gemTime = 0;

  /** Mirror the simulation's pickup ({ kind, x, y } or null). */
  function syncPickup(p, dt) {
    gem.visible = !!p;
    if (!p) return;
    gemTime += dt;
    const color = PICKUP_COLORS[p.kind] ?? PICKUP_COLORS.health;
    gemMat.color.setHex(color);
    haloMat.color.setHex(color);
    gem.position.set(p.x, p.y + Math.sin(gemTime * 3) * 0.08, 0);
    gem.rotation.y = gemTime * 2.2;
    halo.scale.setScalar(1 + Math.sin(gemTime * 6) * 0.1);
  }

  /** Remove leftover pieces (new round / leaving the match). */
  function clearPieces() {
    for (const p of pieces) p.mesh.visible = false;
    for (const d of dust) d.mesh.visible = false;
  }

  return {
    spark,
    dust: dustBurst,
    update(dt) { update(dt); updateDust(dt); updatePieces(dt); },
    syncProjectiles,
    syncPickup,
    setProjectileColor,
    explode,
    clearPieces,
  };
}
