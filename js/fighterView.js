import * as THREE from 'three';
import { ATTACKS } from './config.js';

// Visual representation of a fighter built from primitives inside a
// THREE.Group, so it can later be swapped for a GLTF model with the same
// `update(fighterState, ...)` interface. Animation is procedural: each frame
// a target pose is derived from the simulation state and joints ease to it.

const SKIN = 0xd9a37a;
const DARK = 0x1c1c22;

export function createFighterView(scene, color) {
  const mats = {
    skin: new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.7 }),
    cloth: new THREE.MeshStandardMaterial({ color, roughness: 0.55 }),
    dark: new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.8 }),
  };

  const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  const group = (parent, x = 0, y = 0, z = 0) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };

  // Two-segment limb: upper pivot -> lower pivot -> end piece.
  function limb(parent, x, y, len1, len2, r, upperMat, lowerMat, end) {
    const upper = group(parent, x, y);
    upper.add(mesh(new THREE.CylinderGeometry(r, r * 0.85, len1, 10), upperMat, 0, -len1 / 2));
    const lower = group(upper, 0, -len1);
    lower.add(mesh(new THREE.CylinderGeometry(r * 0.85, r * 0.7, len2, 10), lowerMat, 0, -len2 / 2));
    lower.add(end);
    return { upper, lower };
  }

  const root = group(scene);
  const body = group(root);           // facing rotation
  const hips = group(body, 0, 1);     // pelvis pivot, height animated
  hips.add(mesh(new THREE.BoxGeometry(0.42, 0.22, 0.26), mats.cloth));
  hips.add(mesh(new THREE.BoxGeometry(0.46, 0.07, 0.3), mats.dark, 0, 0.12)); // belt

  const spine = group(hips, 0, 0.12);
  spine.add(mesh(new THREE.BoxGeometry(0.56, 0.62, 0.3), mats.skin, 0, 0.36));
  spine.add(mesh(new THREE.BoxGeometry(0.58, 0.2, 0.32), mats.cloth, 0, 0.6)); // shoulder wrap

  const head = group(spine, 0, 0.84);
  head.add(mesh(new THREE.SphereGeometry(0.17, 16, 12), mats.skin, 0, 0.06));
  head.add(mesh(new THREE.CylinderGeometry(0.178, 0.178, 0.1, 16), mats.cloth, 0, 0.08)); // headband
  head.add(mesh(new THREE.BoxGeometry(0.2, 0.05, 0.05), mats.dark, 0, 0.1, 0.16));         // eye slit

  const fist = () => mesh(new THREE.SphereGeometry(0.08, 10, 8), mats.dark, 0, -0.3);
  const foot = () => mesh(new THREE.BoxGeometry(0.13, 0.07, 0.26), mats.dark, 0, -0.45, 0.05);

  // L sits on local +X, R on local -X. Which one is nearer to the camera
  // depends on facing; the near limbs perform the attacks.
  const arms = {
    L: limb(spine, 0.36, 0.62, 0.3, 0.28, 0.065, mats.skin, mats.cloth, fist()),
    R: limb(spine, -0.36, 0.62, 0.3, 0.28, 0.065, mats.skin, mats.cloth, fist()),
  };
  const legs = {
    L: limb(hips, 0.13, -0.06, 0.46, 0.44, 0.09, mats.cloth, mats.cloth, foot()),
    R: limb(hips, -0.13, -0.06, 0.46, 0.44, 0.09, mats.cloth, mats.cloth, foot()),
  };

  // Team-fight markers: a ring on the floor in the team colour and an arrow
  // over the local player's head. Hidden in 1v1.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.55, 32),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  ring.visible = false;
  root.add(ring);
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.13, 0.26, 4),
    new THREE.MeshBasicMaterial({ color: 0xffd23f }),
  );
  arrow.rotation.x = Math.PI; // point down
  arrow.position.y = 2.35;
  arrow.visible = false;
  root.add(arrow);

  // Current (smoothed) pose. Angles in radians; negative X = swing forward.
  const cur = basePose();
  let flashT = 0;
  let animTime = Math.random() * 10;
  let enabled = true;

  function update(f, dt, x, y) {
    animTime += dt;
    root.position.set(x, y, 0);
    // After a fatality the body is replaced by flying pieces (effects.js).
    root.visible = enabled && f.action !== 'fatality';
    arrow.position.y = 2.35 + Math.sin(animTime * 5) * 0.06;

    // Turn mostly sideways but slightly toward the camera for readability.
    const targetYaw = f.facing * Math.PI / 2 * 0.78;
    body.rotation.y += (targetYaw - body.rotation.y) * (1 - Math.exp(-14 * dt));

    const target = computePose(f, animTime);
    const rate = SNAPPY.has(f.action) ? 45 : 18;
    const k = 1 - Math.exp(-rate * dt);
    // A finished flip is the same as no flip: unwrap so landing doesn't spin back.
    if (f.action !== 'thrown' && Math.abs(cur.tilt) > Math.PI) cur.tilt += Math.sign(cur.tilt) * -2 * Math.PI;
    for (const key in cur) cur[key] += (target[key] - cur[key]) * k;

    const near = f.facing > 0 ? 'R' : 'L';
    const far = near === 'R' ? 'L' : 'R';
    hips.position.y = cur.hipsY;
    hips.rotation.x = cur.tilt;
    spine.rotation.x = cur.spineX;
    spine.rotation.y = cur.spineY * f.facing;
    head.rotation.x = cur.headX;
    arms[near].upper.rotation.x = cur.nearShoulder;
    arms[near].lower.rotation.x = cur.nearElbow;
    arms[far].upper.rotation.x = cur.farShoulder;
    arms[far].lower.rotation.x = cur.farElbow;
    legs[near].upper.rotation.x = cur.nearHip;
    legs[near].lower.rotation.x = cur.nearKnee;
    legs[far].upper.rotation.x = cur.farHip;
    legs[far].lower.rotation.x = cur.farKnee;

    // Brief white flash when hit.
    if (flashT > 0) flashT = Math.max(0, flashT - dt);
    const glow = flashT > 0 ? 0.9 : 0;
    for (const m of Object.values(mats)) m.emissive.setScalar(glow);
  }

  return {
    root,
    update,
    flash: () => { flashT = 0.08; },
    setColor: (color) => mats.cloth.color.setHex(color),
    /** Unused views (fighters 3-4 in a 1v1) stay hidden. */
    setEnabled(on) {
      enabled = on;
      if (!on) root.visible = false;
    },
    /** `teamColor` null hides the ring; `local` shows the "you" arrow. */
    setMarker(teamColor, local) {
      ring.visible = teamColor !== null;
      if (teamColor !== null) ring.material.color.setHex(teamColor);
      arrow.visible = local;
    },
  };
}

function basePose() {
  return {
    hipsY: 0.95, tilt: 0, spineX: 0.1, spineY: 0, headX: 0,
    nearShoulder: -0.8, nearElbow: -1.8, farShoulder: -0.4, farElbow: -2.1,
    nearHip: -0.45, nearKnee: 0.6, farHip: 0.15, farKnee: 0.45,
  };
}

// Actions whose pose changes fast enough to need quicker easing.
const SNAPPY = new Set(['punch', 'kick', 'special', 'throw', 'thrown', 'swept']);

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** 0 -> 1 during startup, 1 during active, 1 -> 0 during recovery. */
function extension(type, t) {
  const a = ATTACKS[type];
  if (t < a.startup) return t / a.startup;
  if (t < a.startup + a.active) return 1;
  return 1 - clamp01((t - a.startup - a.active) / a.recovery);
}

function computePose(f, time) {
  const p = basePose();
  const low = f.grounded && (f.crouch || f.action === 'crouch');

  // Idle breathing.
  p.hipsY += Math.sin(time * 4) * 0.015;

  if (f.action === 'walk') {
    const phase = f.x * 4.5;
    const s = Math.sin(phase);
    p.nearHip = -0.3 + s * 0.55;
    p.farHip = -0.3 - s * 0.55;
    p.nearKnee = 0.35 + Math.max(0, -Math.cos(phase)) * 0.8;
    p.farKnee = 0.35 + Math.max(0, Math.cos(phase)) * 0.8;
    p.hipsY = 0.95 + Math.abs(Math.cos(phase)) * 0.03;
  }

  if (low) {
    p.hipsY = 0.55;
    p.nearHip = -1.45; p.nearKnee = 2.2;
    p.farHip = -0.9; p.farKnee = 2.3;
    p.spineX = 0.35;
  } else if (!f.grounded) {
    p.nearHip = -1.2; p.nearKnee = 1.9;
    p.farHip = -0.7; p.farKnee = 2.0;
    p.spineX = 0.2;
  }

  switch (f.action) {
    case 'block':
      p.nearShoulder = -1.45; p.nearElbow = -2.0;
      p.farShoulder = -1.3; p.farElbow = -2.2;
      p.spineX = low ? 0.4 : -0.05;
      p.headX = 0.25;
      break;

    case 'punch': {
      const e = extension('punch', f.t);
      p.nearShoulder = lerp(-0.8, -1.6, e);
      p.nearElbow = lerp(-1.8, -0.05, e);
      p.farShoulder = -0.5; p.farElbow = -2.2;
      p.spineY = e * 0.45;
      p.spineX += e * 0.1;
      break;
    }

    case 'kick': {
      const a = ATTACKS.kick;
      const e = extension('kick', f.t);
      if (low) {
        // Low sweep: the leg stays near the floor.
        p.nearHip = lerp(-1.45, -1.6, e);
        p.nearKnee = lerp(2.2, 0.1, e);
      } else if (f.t < a.startup) {
        // Chamber the knee before snapping the leg out.
        p.nearHip = lerp(-0.45, -1.4, e);
        p.nearKnee = lerp(0.6, 2.0, e);
      } else {
        p.nearHip = lerp(-0.45, -1.55, e);
        p.nearKnee = lerp(0.6, 0.05, e);
      }
      if (f.grounded && !low) { p.farHip = 0.05; p.farKnee = 0.15; }
      p.spineX = (low ? 0.35 : 0.1) - e * 0.4;
      break;
    }

    case 'special': {
      // Draw both hands back to the hip, then thrust them forward.
      const a = ATTACKS.special;
      if (f.t < a.startup) {
        const w = f.t / a.startup;
        p.nearShoulder = p.farShoulder = lerp(-0.8, 0.5, w);
        p.nearElbow = p.farElbow = lerp(-1.8, -1.9, w);
        p.spineY = -w * 0.5;
        p.spineX = 0.1 - w * 0.15;
      } else {
        const e = extension('special', f.t);
        p.nearShoulder = p.farShoulder = lerp(-0.8, -1.55, e);
        p.nearElbow = p.farElbow = lerp(-1.8, -0.1, e);
        p.spineY = e * 0.2;
        p.spineX = 0.1 + e * 0.15;
      }
      p.nearHip = -0.6; p.nearKnee = 0.7; p.farHip = 0.35; p.farKnee = 0.3;
      break;
    }

    case 'throw': {
      // Reach out and grab, then heave the opponent over the shoulder.
      const a = ATTACKS.throw;
      const grab = clamp01(f.t / a.startup);
      const heave = clamp01((f.t - a.startup) / (a.active + a.recovery * 0.4));
      const done = clamp01((f.t - a.startup - a.active - a.recovery * 0.4) / (a.recovery * 0.6));
      const up = heave * (1 - done);
      p.nearShoulder = p.farShoulder = lerp(lerp(-0.8, -1.5, grab), -2.9, up);
      p.nearElbow = p.farElbow = lerp(lerp(-1.8, -0.4, grab), -0.6, up);
      p.spineX = lerp(0.1 + grab * 0.25, -0.45, up);
      p.spineY = -up * 0.6;
      p.nearHip = -0.7; p.nearKnee = 0.8; p.farHip = 0.3; p.farKnee = 0.35;
      p.hipsY = 0.9;
      break;
    }

    case 'thrown': {
      // Tumbling backward through the air, limbs flailing.
      // One full backflip over the toss airtime (2 * tossVy / |gravity|).
      const spin = clamp01(f.t / 0.5);
      p.tilt = -Math.PI * 2 * spin;
      p.hipsY = 0.95;
      p.spineX = -0.4; p.headX = -0.4;
      p.nearShoulder = -2.4 + Math.sin(time * 18) * 0.5; p.nearElbow = -0.4;
      p.farShoulder = -2.0 - Math.sin(time * 18) * 0.5; p.farElbow = -0.5;
      p.nearHip = -0.9; p.nearKnee = 1.0; p.farHip = -0.3; p.farKnee = 0.6;
      break;
    }

    case 'swept': {
      // Legs taken out: feet fly forward, the body falls flat on its back
      // over the short pop's airtime (2 * popVy / |gravity| = 0.3 s).
      const fall = clamp01(f.t / 0.3);
      p.tilt = -Math.PI / 2 * fall;
      p.hipsY = lerp(0.95, 0.35, fall);
      p.spineX = -0.3; p.headX = 0.35;
      p.nearShoulder = -1.2 - fall; p.nearElbow = -0.3;
      p.farShoulder = -0.9 - fall; p.farElbow = -0.4;
      p.nearHip = -1.1; p.nearKnee = 0.2; p.farHip = -0.8; p.farKnee = 0.3;
      break;
    }

    case 'hit':
      p.spineX = -0.55;
      p.headX = -0.5;
      p.nearShoulder = 0.3; p.nearElbow = -0.6;
      p.farShoulder = 0.5; p.farElbow = -0.4;
      p.hipsY -= 0.05;
      break;

    case 'ko': {
      const fall = clamp01(f.t / 0.5);
      p.tilt = -Math.PI / 2 * fall;
      p.hipsY = lerp(0.95, 0.25, fall);
      p.spineX = -0.2; p.headX = -0.3;
      p.nearShoulder = -2.6; p.nearElbow = -0.2;
      p.farShoulder = -2.9; p.farElbow = -0.3;
      p.nearHip = -0.2; p.nearKnee = 0.4;
      p.farHip = -0.05; p.farKnee = 0.1;
      break;
    }

    case 'dazed':
      // Swaying on the spot, arms hanging, head down.
      p.hipsY = 0.9;
      p.spineX = 0.45 + Math.sin(time * 2.2) * 0.08;
      p.spineY = Math.sin(time * 1.6) * 0.35;
      p.headX = 0.5;
      p.nearShoulder = 0.15; p.nearElbow = -0.2;
      p.farShoulder = 0.05; p.farElbow = -0.3;
      p.nearHip = -0.25; p.nearKnee = 0.5; p.farHip = 0.1; p.farKnee = 0.45;
      break;

    case 'win':
      p.farShoulder = -2.9; p.farElbow = -0.3 + Math.sin(time * 8) * 0.15;
      p.nearShoulder = 0.1; p.nearElbow = -1.2;
      p.spineX = -0.1;
      p.hipsY = 0.95 + Math.abs(Math.sin(time * 5)) * 0.05;
      p.nearHip = -0.1; p.nearKnee = 0.1; p.farHip = 0.1; p.farKnee = 0.1;
      break;
  }
  return p;
}
