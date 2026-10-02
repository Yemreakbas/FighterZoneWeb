import { ATTACKS, BOT_LEVELS } from './config.js';
import { EMPTY_INPUT, isAttacking } from './fighter.js';

// AI opponent. Produces the same input shape as a human player, so it plugs
// into the authoritative simulation exactly like a remote/local controller.
// Difficulty scales with the round number via BOT_LEVELS.

const PUNCH_RANGE = ATTACKS.punch.reach - 0.1;
const KICK_RANGE = ATTACKS.kick.reach - 0.1;

export function createBot(index) {
  let time = 0;
  let nextDecision = 0;
  let intent = 'hold';   // approach | retreat | hold | block | crouch
  let intentUntil = 0;
  let queued = [];       // [{ type, at }] scheduled button presses (combos)
  let lastOpp = { action: 'idle', t: 0 };
  let reactedToProjectile = false; // one dodge decision per incoming projectile

  const rand = Math.random;

  function press(type, delay = 0) {
    queued.push({ type, at: time + delay });
  }

  function decide(state, opp, lvl, dist) {
    nextDecision = time + lvl.reaction * (0.7 + rand() * 0.6);
    if ((intent === 'block' || intent === 'crouch') && time < intentUntil) return; // committed to a defence

    // Anti-air: kick a falling opponent that is about to land on us.
    if (!opp.grounded && opp.vy < 0 && dist < KICK_RANGE + 0.3 && rand() < lvl.aggression) {
      press('kick');
      return;
    }

    if (dist > KICK_RANGE) {
      // Zoning: throw a projectile from mid/long range.
      const ownOut = state.projectiles.some((p) => p.owner === index);
      if (dist > 3.5 && !ownOut && rand() < lvl.aggression * 0.3) {
        intent = 'hold';
        press('special');
        return;
      }
      const r = rand();
      if (dist < 4.5 && r < 0.06 + lvl.aggression * 0.08) press('jump');
      intent = r < 0.25 + lvl.aggression * 0.7 ? 'approach' : r < 0.9 ? 'hold' : 'retreat';
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
    const opp = state.fighters[1 - index];

    if (state.phase !== 'fight' || me.action === 'ko') {
      queued = [];
      intent = 'hold';
      lastOpp = { action: opp.action, t: opp.t };
      return input;
    }

    const lvl = BOT_LEVELS[Math.min(state.round - 1, BOT_LEVELS.length - 1)];
    const dist = Math.abs(opp.x - me.x);
    const toward = Math.sign(opp.x - me.x) || me.facing;

    // A new swing started (different attack, or the same attack restarted).
    const newSwing = isAttacking(opp) && (opp.action !== lastOpp.action || opp.t < lastOpp.t);
    lastOpp = { action: opp.action, t: opp.t };
    if (newSwing && dist < KICK_RANGE + 0.6 && me.grounded && rand() < lvl.block) {
      const a = ATTACKS[opp.action];
      intent = 'block';
      intentUntil = time + a.startup + a.active + 0.1;
      queued = [];
    }

    // Incoming projectile: duck under it or block, with the level's block odds.
    const incoming = state.projectiles.find((p) => p.owner !== index
      && Math.sign(me.x - p.x) === Math.sign(p.vx) && Math.abs(me.x - p.x) < 3.5);
    if (!incoming) {
      reactedToProjectile = false;
    } else if (!reactedToProjectile && me.grounded) {
      reactedToProjectile = true;
      if (rand() < lvl.block + 0.1) {
        intent = rand() < 0.5 ? 'crouch' : 'block';
        intentUntil = time + Math.abs(me.x - incoming.x) / Math.abs(incoming.vx || 9) + 0.25;
        queued = [];
      }
    }

    if (time >= nextDecision) decide(state, opp, lvl, dist);
    if (intent === 'block' && time >= intentUntil) intent = 'hold';
    if (intent === 'crouch' && time >= intentUntil) intent = 'hold';

    // Fire scheduled presses (one per tick so each lands in its own frame).
    const due = queued.findIndex((q) => time >= q.at);
    if (due >= 0) input[queued.splice(due, 1)[0].type] = true;

    switch (intent) {
      case 'approach':
        // Walk in bursts: slower levels move a smaller fraction of the time.
        if ((time % 1) < lvl.speed) input[toward > 0 ? 'right' : 'left'] = true;
        if (dist < PUNCH_RANGE) intent = 'hold';
        break;
      case 'retreat':
        input[toward > 0 ? 'left' : 'right'] = true;
        break;
      case 'block':
        input.block = true;
        break;
      case 'crouch':
        input.down = true;
        break;
    }
    return input;
  }

  return { think };
}
