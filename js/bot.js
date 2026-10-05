import { ATTACKS, BODY, BOT_DIFFICULTIES, BOT_LEVELS, DEFAULT_DIFFICULTY, PICKUPS } from './config.js';
import { EMPTY_INPUT, isAttacking, isSweep, platformsAt } from './fighter.js';
import { defaultTeams, targetOf } from './game.js';

// AI opponent. Produces the same input shape as a human player, so it plugs
// into the authoritative simulation exactly like a remote/local controller.
// Skill climbs with the round number within the chosen difficulty's range.

const PUNCH_RANGE = ATTACKS.punch.reach - 0.1;
const KICK_RANGE = ATTACKS.kick.reach - 0.1;
const THROW_RANGE = ATTACKS.throw.reach - 0.1;
// Intents the bot holds until `intentUntil` instead of re-deciding.
const DEFENCES = new Set(['block', 'lowblock', 'crouch']);

// A jump clears about 3.08 units; platforms within this rise can be climbed.
const MAX_CLIMB = 2.95;

/**
 * How to follow `goal` onto a higher platform. Platforms are solid, so the
 * climb starts next to an edge of the next reachable platform (preferring
 * the one the goal is on) and jumps toward it. Returns { x, dir } (stand at
 * x, jump in direction dir) or null if nothing is reachable.
 */
function climbSpot(me, goal, clock) {
  const all = platformsAt(clock);
  const reachable = all.filter((p) => p.y > me.y + 0.3 && p.y <= me.y + MAX_CLIMB);
  if (!reachable.length) return null;
  const centre = (p) => (p.x0 + p.x1) / 2;
  const p = reachable.find((q) => goal.x >= q.x0 && goal.x <= q.x1)
    || reachable.sort((a, b) => Math.abs(centre(a) - goal.x) - Math.abs(centre(b) - goal.x))[0];
  // Approach from the side we are on (or the nearer edge when underneath).
  const fromLeft = me.x < centre(p);
  let x = fromLeft ? p.x0 - 0.6 : p.x1 + 0.6;
  // Up on a platform ourselves: the take-off spot must be on it.
  const own = all.find((q) => Math.abs(q.y - me.y) < 1e-6 && me.x >= q.x0 && me.x <= q.x1);
  if (own) x = Math.max(own.x0 + 0.2, Math.min(own.x1 - 0.2, x));
  return { x, dir: fromLeft ? 1 : -1 };
}

/** BOT_LEVELS entry for a difficulty (BOT_DIFFICULTIES index) and round (1-based). */
export function botLevel(difficulty, round) {
  const d = BOT_DIFFICULTIES[difficulty] || BOT_DIFFICULTIES[DEFAULT_DIFFICULTY];
  return BOT_LEVELS[Math.min(d.start + Math.max(0, round - 1), d.cap)];
}

export function createBot(index, difficulty = DEFAULT_DIFFICULTY) {
  let time = 0;
  let nextDecision = 0;
  let intent = 'hold';   // approach | retreat | hold | block | lowblock | crouch
  let intentUntil = 0;
  let queued = [];       // [{ type, at }] scheduled button presses (combos)
  let lastOpp = { action: 'idle', t: 0 };
  let reactedToProjectile = false; // one dodge decision per incoming projectile
  let finishPlan = null;           // { fatality, thrown } while winning a FINISH HIM

  const rand = Math.random;

  function press(type, delay = 0) {
    queued.push({ type, at: time + delay });
  }

  function decide(state, opp, lvl, dist) {
    nextDecision = time + lvl.reaction * (0.7 + rand() * 0.6);
    if (DEFENCES.has(intent) && time < intentUntil) return; // committed to a defence

    // Anti-air: kick a falling opponent that is about to land on us.
    if (!opp.grounded && opp.vy < 0 && dist < KICK_RANGE + 0.3 && rand() < lvl.aggression) {
      press('kick');
      return;
    }

    if (dist > KICK_RANGE) {
      // Zoning: throw a projectile from mid/long range.
      const ownOut = state.projectiles.some((p) => p.owner === index);
      const ready = state.fighters[index].cooldown <= 0;
      if (dist > 3.5 && !ownOut && ready && rand() < lvl.aggression * 0.3) {
        intent = 'hold';
        press('special');
        return;
      }
      const r = rand();
      if (dist < 4.5 && r < 0.06 + lvl.aggression * 0.08) press('jump');
      intent = r < 0.25 + lvl.aggression * 0.7 ? 'approach' : r < 0.9 ? 'hold' : 'retreat';
      return;
    }

    // A turtling opponent gets grabbed (block doesn't stop a throw) or, if
    // they block standing, swept (only a crouching block stops a sweep).
    const turtling = opp.grounded && (opp.action === 'block' || opp.action === 'crouch');
    const highBlock = opp.action === 'block' && !opp.crouch;
    if (turtling && highBlock && dist <= KICK_RANGE && rand() < lvl.aggression * 0.35) {
      intent = 'crouch';
      intentUntil = time + 0.25;
      press('kick', 0.03); // crouch first so the kick starts low
      return;
    }
    if (turtling && rand() < lvl.aggression * 0.7) {
      intent = dist <= THROW_RANGE ? 'hold' : 'approach';
      press('throw', dist <= THROW_RANGE ? 0 : 0.15);
      return;
    }

    if (rand() < lvl.aggression) {
      const type = dist <= PUNCH_RANGE && rand() < 0.6 ? 'punch' : 'kick';
      // Occasionally attack from a crouch (hits low, ducks high punches).
      intent = rand() < 0.2 ? 'crouch' : 'hold';
      intentUntil = time + 0.4;
      press(type);
      if (rand() < lvl.combo) {
        const a = ATTACKS[type];
        // Press the follow-up near the end of the active window; the input
        // buffer carries it into the next attack once recovery finishes.
        const next = rand() < 0.5 ? 'punch' : 'kick';
        press(next, a.startup + a.active + 0.04);
        if (rand() < lvl.combo * 0.5) press('kick', a.startup + a.active + a.recovery + 0.2);
      }
    } else {
      intent = rand() < 0.35 ? 'retreat' : 'hold';
    }
  }

  function think(state, dt) {
    time += dt;
    const input = { ...EMPTY_INPUT };
    const me = state.fighters[index];
    const teams = state.teams || defaultTeams(state.fighters.length);
    const opp = state.fighters[targetOf(state.fighters, teams, index)];

    if (state.phase === 'finish') return finish(state, me, opp, input);
    finishPlan = null;

    if (state.phase !== 'fight' || me.action === 'ko') {
      queued = [];
      intent = 'hold';
      lastOpp = { action: opp.action, t: opp.t };
      return input;
    }

    const lvl = botLevel(difficulty, state.round);
    const dist = Math.abs(opp.x - me.x);
    const toward = Math.sign(opp.x - me.x) || me.facing;

    // A new swing started (different attack, or the same attack restarted).
    const newSwing = isAttacking(opp) && (opp.action !== lastOpp.action || opp.t < lastOpp.t);
    lastOpp = { action: opp.action, t: opp.t };
    if (newSwing && dist < KICK_RANGE + 0.6 && me.grounded && rand() < lvl.block) {
      const a = ATTACKS[opp.action];
      intent = isSweep(opp) ? 'lowblock' : 'block';
      intentUntil = time + a.startup + a.active + 0.1;
      queued = [];
    }

    // Incoming projectile: duck under it, hop over it or block, with the
    // level's odds. Which dodge works depends on the projectile's height.
    const incoming = state.projectiles.find((p) => teams[p.owner] !== teams[index]
      && Math.sign(me.x - p.x) === Math.sign(p.vx) && Math.abs(me.x - p.x) < 3.5
      && Math.abs(p.y - me.y - 1.2) < 1.2);
    if (!incoming) {
      reactedToProjectile = false;
    } else if (!reactedToProjectile && me.grounded) {
      reactedToProjectile = true;
      if (rand() < lvl.block + 0.1) {
        const rel = incoming.y - me.y;
        const r = incoming.r ?? 0.22;
        const eta = Math.abs(me.x - incoming.x) / Math.abs(incoming.vx || 9);
        const duckable = rel - r > BODY.crouchHeight;
        const hoppable = rel + r < 1.3;
        queued = [];
        if (hoppable && rand() < 0.7) {
          // Leave the ground just before it arrives.
          intent = 'hold';
          press('jump', Math.max(0, eta - 0.25));
        } else {
          intent = duckable && rand() < 0.5 ? 'crouch' : 'block';
          intentUntil = time + eta + 0.25;
        }
      }
    }

    // Where to go: a power-up worth having when no enemy is in our face,
    // otherwise the opponent. A crystal is treated as standing on its platform.
    const pk = state.pickup;
    const wantPickup = pk && dist > KICK_RANGE + 1
      && (pk.kind === 'health' ? me.hp < 75 : me.cooldown > 1);
    const goal = wantPickup ? { x: pk.x, y: pk.y - PICKUPS.hover, grounded: true } : opp;
    if (wantPickup && Math.abs(goal.y - me.y) < 0.5 && me.grounded && !(DEFENCES.has(intent) && time < intentUntil)) {
      queued = [];
      if (Math.abs(goal.x - me.x) > 0.2) input[goal.x > me.x ? 'right' : 'left'] = true;
      return input;
    }

    // Goal on another level: climb up after it or drop down to it.
    if (me.grounded && goal.grounded && !(DEFENCES.has(intent) && time < intentUntil)) {
      const dy = goal.y - me.y;
      const goalDist = Math.abs(goal.x - me.x);
      const goalToward = Math.sign(goal.x - me.x) || me.facing;
      if (dy > 0.5) {
        const spot = climbSpot(me, goal, state.clock || 0);
        if (spot !== null) {
          queued = [];
          if (Math.abs(spot.x - me.x) > 0.25) input[spot.x > me.x ? 'right' : 'left'] = true;
          else if (time >= nextDecision) {
            input.jump = true;
            input[spot.dir > 0 ? 'right' : 'left'] = true;
            nextDecision = time + lvl.reaction;
          }
          return input;
        }
      } else if (dy < -0.5 && goalDist > 0.4) {
        // Down: walk off the edge toward the goal.
        queued = [];
        input[goalToward > 0 ? 'right' : 'left'] = true;
        return input;
      }
    }

    if (time >= nextDecision) decide(state, opp, lvl, dist);
    if (DEFENCES.has(intent) && time >= intentUntil) intent = 'hold';

    // Fire scheduled presses (one per tick so each lands in its own frame).
    const due = queued.findIndex((q) => time >= q.at);
    if (due >= 0) {
      const { type } = queued.splice(due, 1)[0];
      if (type === 'throw') {
        // Forward + punch; only a throw if still in reach, otherwise a punch.
        input.punch = true;
        input[toward > 0 ? 'right' : 'left'] = true;
      } else {
        input[type] = true;
      }
    }

    switch (intent) {
      case 'approach':
        // Walk in bursts: slower levels move a smaller fraction of the time.
        if ((time % 1) < lvl.speed) input[toward > 0 ? 'right' : 'left'] = true;        if (dist < PUNCH_RANGE) intent = 'hold';
        break;
      case 'retreat':
        input[toward > 0 ? 'left' : 'right'] = true;
        break;
      case 'block':
        input.block = true;
        break;
      case 'lowblock':
        input.block = true;
        input.down = true;
        break;
      case 'crouch':
        input.down = true;
        break;
    }
    return input;
  }

  /**
   * FINISH HIM as the winner: harder bots go for the fatality more often.
   * Line up at projectile range and throw a single special.
   */
  function finish(state, me, opp, input) {
    if (state.roundWinner !== index) return input;
    const lvl = botLevel(difficulty, state.round);
    finishPlan ??= { fatality: rand() < 0.35 + lvl.aggression * 0.5, thrown: false };
    if (!finishPlan.fatality || finishPlan.thrown) return input;

    const dist = Math.abs(opp.x - me.x);
    const toward = Math.sign(opp.x - me.x) || me.facing;
    if (dist > 4) input[toward > 0 ? 'right' : 'left'] = true;
    else if (dist < 2) input[toward > 0 ? 'left' : 'right'] = true;
    else if (me.grounded && (me.action === 'idle' || me.action === 'walk')) {
      input.special = true;
      finishPlan.thrown = true;
    }
    return input;
  }

  return { think };
}
