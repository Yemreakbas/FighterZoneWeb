import { ARENA, ATTACKS, BODY, CROUCH_ATTACK_DROP, INPUT_BUFFER, MATCH, PHYSICS, PROJECTILE } from './config.js';

// Pure simulation of a single fighter. State is plain JSON-friendly data so
// the host can serialize it straight into network snapshots. No Three.js here.
//
// Actions: idle | walk | crouch | jump | block | punch | kick | special | hit | ko | win

export const EMPTY_INPUT = Object.freeze({
  left: false, right: false, down: false, block: false,
  jump: false, punch: false, kick: false, special: false,
});

export function createFighter(x, facing) {
  return {
    x, y: 0, vx: 0, vy: 0,
    facing,            // +1 looks toward +X, -1 toward -X
    hp: MATCH.maxHp,
    action: 'idle',
    t: 0,              // seconds spent in the current action
    crouch: false,     // attack/block performed from a crouch
    grounded: true,
    stun: 0,           // remaining hit/block stun
    attackHit: false,  // current attack already connected / projectile already fired
    airAttack: false,  // one aerial attack per jump
    buffer: null,      // { type, age } attack pressed while busy
  };
}

const BUSY = new Set(['punch', 'kick', 'special', 'hit', 'ko', 'win']);

export function isAttacking(f) {
  return f.action === 'punch' || f.action === 'kick';
}

/** True while the current attack's hitbox is live. */
export function isActiveFrame(f) {
  if (!isAttacking(f)) return false;
  const a = ATTACKS[f.action];
  return f.t >= a.startup && f.t < a.startup + a.active;
}

function setAction(f, action) {
  if (f.action !== action) {
    f.action = action;
    f.t = 0;
  }
}

function startAttack(f, type) {
  f.action = type;
  f.t = 0;
  f.attackHit = false;
  f.buffer = null;
  if (f.grounded) f.vx = 0;
  else f.airAttack = true;
}

/**
 * Advance one fixed tick. `input` is EMPTY_INPUT-shaped; `opp` is only read
 * (for facing direction).
 */
export function stepFighter(f, input, opp, dt) {
  f.t += dt;

  // Remember attack presses that arrive while the fighter cannot act yet.
  const pressedMove = input.special ? 'special' : input.punch ? 'punch' : input.kick ? 'kick' : null;
  if (pressedMove) f.buffer = { type: pressedMove, age: 0 };
  else if (f.buffer && (f.buffer.age += dt) > INPUT_BUFFER) f.buffer = null;

  if (f.action === 'hit') {
    f.stun -= dt;
    if (f.stun <= 0 && f.grounded) setAction(f, 'idle');
  } else if (f.action === 'block' && f.stun > 0) {
    f.stun -= dt; // blockstun: locked in block
  } else if (isAttacking(f) || f.action === 'special') {
    const a = ATTACKS[f.action];
    if (f.t >= a.startup + a.active + a.recovery) {
      setAction(f, f.grounded ? (f.crouch ? 'crouch' : 'idle') : 'jump');
    }
  }

  if (!BUSY.has(f.action) && !(f.action === 'block' && f.stun > 0)) {
    control(f, input, opp);
  }

  integrate(f, dt);
}

function control(f, input, opp) {
  if (!f.grounded) {
    // Specials are ground-only; aerial punch/kick once per jump.
    if (f.buffer && f.buffer.type !== 'special' && !f.airAttack) startAttack(f, f.buffer.type);
    return;
  }

  // Grounded fighters always turn to face the opponent.
  if (opp.x !== f.x) f.facing = Math.sign(opp.x - f.x);

  if (input.jump && !input.down && !input.block) {
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    f.vy = PHYSICS.jumpVelocity;
    f.vx = dir * PHYSICS.jumpForwardSpeed;
    f.grounded = false;
    f.airAttack = false;
    f.crouch = false;
    setAction(f, 'jump');
    return;
  }

  f.crouch = input.down;

  if (f.buffer) {
    if (f.buffer.type === 'special') f.crouch = false; // always thrown standing
    startAttack(f, f.buffer.type);
    return;
  }
  if (input.block) {
    f.vx = 0;
    setAction(f, 'block');
    return;
  }
  if (input.down) {
    f.vx = 0;
    setAction(f, 'crouch');
    return;
  }

  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const backwards = dir !== 0 && dir !== f.facing;
  f.vx = dir * PHYSICS.walkSpeed * (backwards ? PHYSICS.backWalkFactor : 1);
  setAction(f, dir ? 'walk' : 'idle');
}

function integrate(f, dt) {
  if (f.action === 'hit' || f.action === 'ko' || f.action === 'block') {
    f.vx *= Math.exp(-PHYSICS.knockbackDecay * dt);
  }

  if (!f.grounded) f.vy += PHYSICS.gravity * dt;
  f.x += f.vx * dt;
  f.y += f.vy * dt;

  if (f.y <= ARENA.groundY) {
    const wasAirborne = !f.grounded;
    f.y = ARENA.groundY;
    f.vy = 0;
    f.grounded = true;
    if (wasAirborne) {
      f.airAttack = false;
      // Landing cancels an aerial attack and ends the jump.
      if (f.action === 'jump' || isAttacking(f)) {
        f.vx = 0;
        setAction(f, 'idle');
      }
    }
  }

  f.x = Math.max(-ARENA.halfWidth, Math.min(ARENA.halfWidth, f.x));
}

// ---------------------------------------------------------------------------
// Collision boxes. All boxes are AABBs in the X/Y fighting plane:
// { x0, x1, y0, y1 } with x0 < x1 and y0 < y1. Depth (Z) is ignored because
// both fighters always stand on the same plane.
// ---------------------------------------------------------------------------

export function hurtbox(f) {
  const low = f.grounded && (f.action === 'crouch' || f.crouch);
  return {
    x0: f.x - BODY.width / 2,
    x1: f.x + BODY.width / 2,
    y0: f.y,
    y1: f.y + (low ? BODY.crouchHeight : BODY.height),
  };
}

/**
 * The attack hitbox starts just inside the attacker's body (so point-blank
 * hits still register) and extends `reach` units in the facing direction.
 * Crouching attacks are shifted down so they can hit crouching opponents,
 * while standing punches (hitY 1.3+) pass over a crouched hurtbox (top 1.15).
 */
export function hitbox(f) {
  const a = ATTACKS[f.action];
  const near = f.x + f.facing * 0.2;
  const far = f.x + f.facing * a.reach;
  const drop = f.crouch && f.grounded ? CROUCH_ATTACK_DROP : 0;
  return {
    x0: Math.min(near, far),
    x1: Math.max(near, far),
    y0: f.y + a.hitY[0] - drop,
    y1: f.y + a.hitY[1] - drop,
  };
}

export function overlaps(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/** Resolve `attacker`'s melee attack on `defender`. Returns a hit event or null. */
export function resolveHit(attacker, defender) {
  if (!isActiveFrame(attacker) || attacker.attackHit) return null;
  if (defender.action === 'ko') return null;

  const hb = hitbox(attacker);
  const hu = hurtbox(defender);
  if (!overlaps(hb, hu)) return null;

  attacker.attackHit = true;
  const blocked = applyHit(ATTACKS[attacker.action], attacker.facing, defender);

  // Spark position: centre of the hitbox/hurtbox intersection.
  return {
    type: 'hit',
    blocked,
    heavy: attacker.action === 'kick',
    x: (Math.max(hb.x0, hu.x0) + Math.min(hb.x1, hu.x1)) / 2,
    y: (Math.max(hb.y0, hu.y0) + Math.min(hb.y1, hu.y1)) / 2,
  };
}

/**
 * Apply attack data `a` travelling in direction `dir` (+1/-1) to the
 * defender. A block only works on the ground while facing the incoming
 * attack. Returns true if it was blocked.
 */
function applyHit(a, dir, defender) {
  const blocked = defender.action === 'block' && defender.grounded && defender.facing === -dir;

  if (blocked) {
    defender.hp = Math.max(0, defender.hp - a.chip);
    defender.stun = a.blockstun;
    defender.vx = dir * a.knockback * 0.4;
  } else {
    defender.hp = Math.max(0, defender.hp - a.damage);
    defender.action = 'hit';
    defender.t = 0;
    defender.stun = a.hitstun;
    defender.vx = dir * a.knockback;
    defender.buffer = null;
    if (!defender.grounded) defender.vy = Math.max(defender.vy, 3); // juggle pop
  }
  return blocked;
}

// ---------------------------------------------------------------------------
// Projectiles: { owner, x, y, vx, life }. The projectile's box is a square
// of side 2*radius around its centre.
// ---------------------------------------------------------------------------

/** If `f` reached the release frame of its special, return a new projectile. */
export function spawnProjectile(f, owner) {
  if (f.action !== 'special' || f.attackHit || f.t < ATTACKS.special.startup) return null;
  f.attackHit = true;
  return {
    owner,
    x: f.x + f.facing * PROJECTILE.spawnOffset,
    y: f.y + PROJECTILE.height,
    vx: f.facing * PROJECTILE.speed,
    life: PROJECTILE.lifetime,
  };
}

export function projectileBox(p) {
  const r = PROJECTILE.radius;
  return { x0: p.x - r, x1: p.x + r, y0: p.y - r, y1: p.y + r };
}

/** Resolve a projectile against its target. Returns a hit event or null. */
export function projectileHit(p, defender) {
  if (defender.action === 'ko') return null;
  if (!overlaps(projectileBox(p), hurtbox(defender))) return null;
  const blocked = applyHit(ATTACKS.special, Math.sign(p.vx), defender);
  return { type: 'hit', blocked, heavy: true, x: p.x, y: p.y };
}

/** Keep fighters from walking through each other. */
export function separate(a, b) {
  const dx = b.x - a.x;
  if (Math.abs(a.y - b.y) > BODY.height * 0.6) return; // one is jumping over
  if (Math.abs(dx) >= PHYSICS.minSeparation) return;

  const dir = dx === 0 ? -a.facing || 1 : Math.sign(dx);
  const push = (PHYSICS.minSeparation - Math.abs(dx)) / 2;
  a.x -= dir * push;
  b.x += dir * push;

  // Pinned against a wall: the other fighter absorbs the rest of the push.
  pinToWall(a, b);
  pinToWall(b, a);
}

function pinToWall(pinned, other) {
  const over = Math.abs(pinned.x) - ARENA.halfWidth;
  if (over <= 0) return;
  const wall = Math.sign(pinned.x);
  pinned.x = wall * ARENA.halfWidth;
  other.x -= wall * over;
}
