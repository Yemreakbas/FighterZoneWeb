import { ARENA, ATTACKS, BODY, CHARACTERS, COMBO_BREAK, CROUCH_ATTACK_DROP, INPUT_BUFFER, MATCH, PHYSICS, PROJECTILE, SWEEP } from './config.js';

// Pure simulation of a single fighter. State is plain JSON-friendly data so
// the host can serialize it straight into network snapshots. No Three.js here.
//
// Actions: idle | walk | crouch | jump | block | punch | kick | special | throw | hit
//          | thrown (airborne after being thrown) | swept (knocked off the feet by a sweep)
//          | ko | win | dazed (FINISH HIM) | fatality

export const EMPTY_INPUT = Object.freeze({
  left: false, right: false, down: false, block: false,
  jump: false, punch: false, kick: false, special: false,
});

const stats = (f) => CHARACTERS[f.char] || CHARACTERS[0];

export function createFighter(x, facing, char = 0) {
  return {
    char,              // index into CHARACTERS
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
    cooldown: 0,       // seconds until the special move is ready again
    drop: 0,           // seconds left falling through platforms (down + jump)
    chain: 0,          // hits taken in a row without recovering (combo breaker)
    guard: 0,          // seconds left untouchable after a combo breaker
    buffer: null,      // { type, age } attack pressed while busy
  };
}

const BUSY = new Set(['punch', 'kick', 'special', 'throw', 'hit', 'thrown', 'swept', 'ko', 'win', 'dazed', 'fatality']);
// States a grounded opponent can be grabbed from (not in hit- or blockstun).
const THROWABLE = new Set(['idle', 'walk', 'crouch', 'block']);

export function isAttacking(f) {
  return f.action === 'punch' || f.action === 'kick';
}

/** A kick started from a crouch on the ground: hits low and knocks down. */
export function isSweep(f) {
  return f.action === 'kick' && f.crouch && f.grounded;
}

/** Knocked into the air by a throw or a sweep, until landing. */
export function isKnockedDown(f) {
  return f.action === 'thrown' || f.action === 'swept';
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
  if (type === 'special') f.cooldown = ATTACKS.special.cooldown;
  f.action = type;
  f.t = 0;
  f.attackHit = false;
  f.buffer = null;
  if (f.grounded) f.vx = 0;
  else f.airAttack = true;
}

/**
 * During hit-stop nothing moves, but attack presses are remembered so they
 * are not lost to the freeze. Shared by the host and client prediction.
 */
export function bufferPress(f, input) {
  const move = input.special ? 'special' : input.punch ? 'punch' : input.kick ? 'kick' : null;
  if (move) f.buffer = { type: move, age: 0 };
}

/**
 * Advance one fixed tick. `input` is EMPTY_INPUT-shaped; `opp` is only read
 * (for facing direction).
 */
export function stepFighter(f, input, opp, dt) {
  f.t += dt;
  f.cooldown = Math.max(0, f.cooldown - dt);
  f.drop = Math.max(0, f.drop - dt);
  f.guard = Math.max(0, f.guard - dt);
  if (f.action !== 'hit') f.chain = 0;

  // Remember attack presses that arrive while the fighter cannot act yet.
  const pressedMove = input.special ? 'special' : input.punch ? 'punch' : input.kick ? 'kick' : null;
  if (pressedMove) f.buffer = { type: pressedMove, age: 0 };
  else if (f.buffer && (f.buffer.age += dt) > INPUT_BUFFER) f.buffer = null;

  if (f.action === 'hit') {
    f.stun -= dt;
    if (f.stun <= 0 && f.grounded) setAction(f, 'idle');
  } else if (f.action === 'block' && f.stun > 0) {
    f.stun -= dt; // blockstun: locked in block
  } else if (isAttacking(f) || f.action === 'special' || f.action === 'throw') {
    const a = ATTACKS[f.action];
    const recovery = a.recovery + (isSweep(f) ? SWEEP.extraRecovery : 0);
    if (f.t >= a.startup + a.active + recovery) {
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

  // Down + jump on a platform drops through it.
  if (input.jump && input.down && !input.block && f.y > ARENA.groundY) {
    f.drop = ARENA.dropThrough;
    f.grounded = false;
    f.crouch = false;
    f.vy = 0;
    setAction(f, 'jump');
    f.airAttack = false;
    return;
  }

  if (input.jump && !input.down && !input.block) {
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    f.vy = PHYSICS.jumpVelocity;
    f.vx = dir * PHYSICS.jumpForwardSpeed * stats(f).speed;
    f.grounded = false;
    f.airAttack = false;
    f.crouch = false;
    setAction(f, 'jump');
    return;
  }

  f.crouch = input.down;

  // A special pressed while it is recharging does nothing.
  if (f.buffer?.type === 'special' && f.cooldown > 0) f.buffer = null;

  if (f.buffer) {
    // Forward + punch next to a grabbable opponent becomes a throw.
    const forward = f.facing > 0 ? input.right : input.left;
    const grab = f.buffer.type === 'punch' && forward && canBeThrown(opp) && sameLevel(f, opp)
      && Math.abs(opp.x - f.x) <= ATTACKS.throw.reach;
    if (f.buffer.type === 'special' || grab) f.crouch = false; // always done standing
    startAttack(f, grab ? 'throw' : f.buffer.type);
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
  f.vx = dir * PHYSICS.walkSpeed * stats(f).speed * (backwards ? PHYSICS.backWalkFactor : 1);
  setAction(f, dir ? 'walk' : 'idle');
}

function integrate(f, dt) {
  // A thrown fighter keeps its toss speed until it lands.
  if (f.action === 'hit' || f.action === 'ko' || f.action === 'block' || f.action === 'dazed') {
    f.vx *= Math.exp(-PHYSICS.knockbackDecay * dt);
  }

  // Riding a moving platform: carried by its motion this tick.
  if (f.grounded && f.y > ARENA.groundY) {
    const i = platformsBefore.findIndex((p) => onSurface(p, f.x, f.y));
    if (i >= 0) f.x += platformsNow[i].x0 - platformsBefore[i].x0;
  }

  // Walking off a platform's edge starts a fall.
  if (f.grounded && f.y > ARENA.groundY && !platformAt(f.x, f.y)) {
    f.grounded = false;
    f.crouch = false;
    if (!BUSY.has(f.action)) setAction(f, 'jump');
  }

  const prevY = f.y;
  if (!f.grounded) f.vy += PHYSICS.gravity * dt;
  f.x += f.vx * dt;
  f.y += f.vy * dt;

  const floor = landingHeight(f, prevY);
  if (f.y <= floor) {
    const wasAirborne = !f.grounded;
    f.y = floor;
    f.vy = 0;
    f.grounded = true;
    if (wasAirborne) {
      f.airAttack = false;
      if (isKnockedDown(f)) {
        // Hitting the floor: a short stagger before getting back up.
        f.stun = f.action === 'swept' ? SWEEP.landStun : ATTACKS.throw.landStun;
        f.vx = 0;
        f.action = 'hit';
        f.t = 0;
      }
      // Landing cancels an aerial attack and ends the jump.
      if (f.action === 'jump' || isAttacking(f)) {
        f.vx = 0;
        setAction(f, 'idle');
      }
    }
  }

  f.x = Math.max(-ARENA.halfWidth, Math.min(ARENA.halfWidth, f.x));
}

/** Platform layout at match time `clock` (seconds): movers slide along X. */
export function platformsAt(clock) {
  return ARENA.platforms.map((p) => {
    const dx = p.move ? p.move.amp * Math.sin((2 * Math.PI * clock) / p.move.period) : 0;
    return { x0: p.x0 + dx, x1: p.x1 + dx, y: p.y };
  });
}

// Platform positions at the start and end of the tick being simulated. The
// match (and client prediction) sets them before stepping fighters.
let platformsBefore = platformsAt(0);
let platformsNow = platformsBefore;

/** Advance the shared platform layout from `before` to `now` for this tick. */
export function setPlatforms(before, now) {
  platformsBefore = before;
  platformsNow = now;
}

const onSurface = (p, x, y) => x >= p.x0 && x <= p.x1 && Math.abs(p.y - y) < 1e-6;

/** The platform whose surface is at height `y` under `x`, if any. */
function platformAt(x, y) {
  return platformsNow.find((p) => onSurface(p, x, y));
}

/**
 * Highest surface the fighter can land on this tick: a platform it was above
 * (or on) last tick and is now at or below, while falling and not dropping
 * through; otherwise the floor.
 */
function landingHeight(f, prevY) {
  let floor = ARENA.groundY;
  if (f.vy > 0 || f.drop > 0) return floor;
  for (const p of platformsNow) {
    if (p.y > floor && f.x >= p.x0 && f.x <= p.x1 && prevY >= p.y - 1e-6) floor = p.y;
  }
  return floor;
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
  const contact = findHit(attacker, defender);
  return contact && applyContact(contact);
}

/**
 * Detection only, no state changes: returns a contact or null. The match
 * detects both fighters' contacts first and applies them afterwards, so two
 * attacks landing on the same tick trade instead of the first one
 * cancelling the second.
 */
export function findHit(attacker, defender) {
  if (!isActiveFrame(attacker) || attacker.attackHit) return null;
  if (defender.action === 'ko' || defender.guard > 0) return null;

  const hb = hitbox(attacker);
  const hu = hurtbox(defender);
  if (!overlaps(hb, hu)) return null;

  return {
    attacker,
    defender,
    move: attacker.action,
    sweep: isSweep(attacker),
    dir: attacker.facing,
    // Spark position: centre of the hitbox/hurtbox intersection.
    x: (Math.max(hb.x0, hu.x0) + Math.min(hb.x1, hu.x1)) / 2,
    y: (Math.max(hb.y0, hu.y0) + Math.min(hb.y1, hu.y1)) / 2,
  };
}

/** Apply a contact from findHit. Returns the hit event. */
export function applyContact({ attacker, defender, move, sweep, dir, x, y }) {
  attacker.attackHit = true;
  const power = stats(attacker).power;
  if (sweep) {
    const blocked = applySweep(dir, defender, power);
    return { type: 'hit', blocked, heavy: true, sweep: defender.action === 'swept', x, y };
  }
  const blocked = applyHit(ATTACKS[move], dir, defender, power, attacker);
  return { type: 'hit', blocked, heavy: move === 'kick', x, y };
}

/**
 * A sweep is only stopped by a crouching block. Otherwise it takes the legs
 * out: a small pop into the air that lands as a knockdown. Fighters already
 * airborne just take a normal kick (juggle).
 */
function applySweep(dir, defender, power) {
  const lowBlock = defender.action === 'block' && defender.crouch && defender.facing === -dir;
  if (lowBlock || !defender.grounded) return applyHit(ATTACKS.kick, dir, defender, power);
  defender.chain = 0;
  defender.hp = Math.max(0, defender.hp - SWEEP.damage * power);
  defender.action = 'swept';
  defender.t = 0;
  defender.stun = 0;
  defender.crouch = false;
  defender.buffer = null;
  defender.grounded = false;
  defender.vy = SWEEP.popVy;
  defender.vx = dir * SWEEP.slideVx;
  return false;
}

/**
 * Apply attack data `a` travelling in direction `dir` (+1/-1) to the
 * defender. A block only works on the ground while facing the incoming
 * attack. Returns true if it was blocked. The hit that completes a chain
 * of COMBO_BREAK.maxChain triggers the combo breaker (see config).
 */
function applyHit(a, dir, defender, power = 1, attacker = null) {
  const blocked = defender.action === 'block' && defender.grounded && defender.facing === -dir;
  const stunned = defender.action === 'hit' && defender.stun > 0;

  if (blocked) {
    defender.hp = Math.max(0, defender.hp - a.chip * power);
    defender.stun = a.blockstun;
    defender.vx = dir * a.knockback * 0.4;
  } else {
    defender.hp = Math.max(0, defender.hp - a.damage * power);
    defender.action = 'hit';
    defender.t = 0;
    defender.stun = a.hitstun;
    defender.vx = dir * a.knockback;
    defender.buffer = null;
    if (!defender.grounded) defender.vy = Math.max(defender.vy, 3); // juggle pop
    defender.chain = stunned ? defender.chain + 1 : 1;
    if (defender.chain >= COMBO_BREAK.maxChain) {
      defender.chain = 0;
      defender.stun = Math.min(defender.stun, COMBO_BREAK.stun);
      defender.guard = COMBO_BREAK.guard;
      defender.vx = dir * COMBO_BREAK.push;
      // Pinned in a corner the defender can't fly back, so the attacker
      // is always shoved away too.
      if (attacker) attacker.vx = -dir * COMBO_BREAK.attackerPush;
    }
  }
  return blocked;
}

// ---------------------------------------------------------------------------
// Throws
// ---------------------------------------------------------------------------

function canBeThrown(f) {
  return f.grounded && f.guard <= 0 && THROWABLE.has(f.action) && !(f.action === 'block' && f.stun > 0);
}

/** Both standing on the same surface (floor or the same platform). */
const sameLevel = (a, b) => Math.abs(a.y - b.y) < 0.3;

/**
 * Detection only: returns a throw contact if `attacker`'s grab is live and
 * `defender` is in reach and grabbable at this moment, otherwise null.
 */
export function findThrow(attacker, defender) {
  if (attacker.action !== 'throw' || attacker.attackHit) return null;
  const a = ATTACKS.throw;
  if (attacker.t < a.startup || attacker.t >= a.startup + a.active) return null;
  if (!canBeThrown(defender) || !sameLevel(attacker, defender) || Math.abs(defender.x - attacker.x) > a.reach) return null;
  return { attacker, defender };
}

/** Apply a contact from findThrow: damage and toss over the shoulder. */
export function applyThrow({ attacker, defender }) {
  const a = ATTACKS.throw;
  attacker.attackHit = true;
  defender.hp = Math.max(0, defender.hp - a.damage * stats(attacker).power);
  defender.action = 'thrown';
  defender.t = 0;
  defender.stun = 0;
  defender.crouch = false;
  defender.buffer = null;
  defender.grounded = false;
  defender.vy = a.tossVy;
  defender.vx = -attacker.facing * a.tossVx;
  return {
    type: 'hit', blocked: false, heavy: true, throw: true,
    x: (attacker.x + defender.x) / 2, y: 1.2,
  };
}

// ---------------------------------------------------------------------------
// Projectiles: { owner, x, y, vx, life, power }. The projectile's box is a square
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
    vx: f.facing * stats(f).projectileSpeed,
    life: PROJECTILE.lifetime,
    power: stats(f).power,
  };
}

export function projectileBox(p) {
  const r = PROJECTILE.radius;
  return { x0: p.x - r, x1: p.x + r, y0: p.y - r, y1: p.y + r };
}

/** Resolve a projectile against its target. Returns a hit event or null. */
export function projectileHit(p, defender) {
  if (defender.action === 'ko' || defender.guard > 0) return null;
  if (!overlaps(projectileBox(p), hurtbox(defender))) return null;
  const blocked = applyHit(ATTACKS.special, Math.sign(p.vx), defender, p.power);
  return { type: 'hit', blocked, heavy: true, x: p.x, y: p.y };
}

/** Keep fighters from walking through each other. */
export function separate(a, b) {
  const dx = b.x - a.x;
  if (Math.abs(a.y - b.y) > BODY.height * 0.6) return; // one is jumping over
  if (isKnockedDown(a) || isKnockedDown(b)) return; // flying over / sliding past
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
