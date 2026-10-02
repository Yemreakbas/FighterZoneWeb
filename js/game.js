import { ARENA, MATCH, ROUND_FLOW } from './config.js';
import {
  EMPTY_INPUT, applyContact, createFighter, findHit, overlaps, projectileBox,
  projectileHit, separate, spawnProjectile, stepFighter,
} from './fighter.js';

// Authoritative match simulation: rounds, timer, combat resolution.
// Runs on the host (or locally in solo mode) at a fixed tick. Everything the
// renderer or a remote client needs is in `state` plus the drained events.
//
// Phases: intro -> fight -> roundEnd -> (intro | over)

const START_X = 2.5;

export function createMatch(names = ['OYUNCU 1', 'OYUNCU 2']) {
  const state = {
    names,
    round: 1,
    timer: MATCH.roundTime,
    phase: 'intro',
    phaseT: 0,
    wins: [0, 0],
    roundWinner: -1, // -1 = none yet, 2 = draw
    winner: -1,      // match winner once phase === 'over'
    fighters: [],
    projectiles: [],
  };
  let events = [];

  const emit = (e) => events.push(e);

  // Clean hits in the attacker's current combo. A hit counts toward the
  // combo only if it lands while the defender is still in hitstun.
  let combo = [0, 0];

  function landed(target, hit, wasStunned) {
    const attacker = 1 - target;
    emit({ ...hit, target });
    if (hit.blocked) {
      combo[attacker] = 0;
      return;
    }
    combo[attacker] = wasStunned ? combo[attacker] + 1 : 1;
    if (combo[attacker] >= 2) emit({ type: 'combo', attacker, count: combo[attacker] });
  }

  function resetRound() {
    state.fighters = [createFighter(-START_X, 1), createFighter(START_X, -1)];
    state.projectiles = [];
    combo = [0, 0];
    state.timer = MATCH.roundTime;
    state.phase = 'intro';
    state.phaseT = 0;
    state.roundWinner = -1;
    emit({ type: 'announce', text: `ROUND ${state.round}`, ms: ROUND_FLOW.introAnnounce * 1000 });
  }

  function endRound(winner, text) {
    state.phase = 'roundEnd';
    state.phaseT = 0;
    state.roundWinner = winner;
    if (winner === 0 || winner === 1) state.wins[winner]++;
    emit({ type: 'announce', text, ms: 1800 });
  }

  function knockOut(f) {
    f.action = 'ko';
    f.t = 0;
    f.hp = 0;
  }

  function step(inputs, dt) {
    const [a, b] = state.fighters;
    const prevPhaseT = state.phaseT;
    state.phaseT += dt;

    // Players only control their fighters during the fight phase.
    const live = state.phase === 'fight';
    stepFighter(a, live ? inputs[0] : EMPTY_INPUT, b, dt);
    stepFighter(b, live ? inputs[1] : EMPTY_INPUT, a, dt);
    separate(a, b);
    stepProjectiles(dt, live);

    const crossed = (mark) => prevPhaseT < mark && state.phaseT >= mark;

    if (state.phase === 'intro') {
      if (crossed(ROUND_FLOW.introAnnounce)) emit({ type: 'announce', text: 'FIGHT!', ms: 700 });
      if (state.phaseT >= ROUND_FLOW.introTotal) {
        state.phase = 'fight';
        state.phaseT = 0;
      }
    } else if (state.phase === 'fight') {
      // Detect both contacts before applying either, so simultaneous
      // attacks trade, then check KO.
      const contacts = [[a, b, 1], [b, a, 0]]
        .map(([atk, def, target]) => ({ contact: findHit(atk, def), target, wasStunned: def.action === 'hit' }))
        .filter((c) => c.contact);
      for (const { contact, target, wasStunned } of contacts) {
        landed(target, applyContact(contact), wasStunned);
      }

      state.timer = Math.max(0, state.timer - dt);
      const koA = a.hp <= 0;
      const koB = b.hp <= 0;
      if (koA || koB) {
        if (koA) knockOut(a);
        if (koB) knockOut(b);
        emit({ type: 'ko' });
        endRound(koA && koB ? 2 : koA ? 1 : 0, koA && koB ? 'DOUBLE K.O.' : 'K.O.');
      } else if (state.timer <= 0) {
        endRound(a.hp === b.hp ? 2 : a.hp > b.hp ? 0 : 1, 'TIME');
      }
    } else if (state.phase === 'roundEnd') {
      const w = state.roundWinner;
      if (crossed(ROUND_FLOW.koToWinPose)) {
        if (w === 0 || w === 1) {
          const f = state.fighters[w];
          f.action = 'win';
          f.t = 0;
          f.vx = 0;
        }
        emit({ type: 'announce', text: w === 2 ? 'BERABERE' : `${state.names[w]} KAZANDI`, ms: 1600 });
      }
      if (state.phaseT >= ROUND_FLOW.roundEndTotal) {
        const champion = state.wins.findIndex((n) => n >= MATCH.roundsToWin);
        if (champion >= 0) {
          state.phase = 'over';
          state.phaseT = 0;
          state.winner = champion;
          emit({ type: 'over', winner: champion });
        } else {
          state.round++;
          resetRound();
        }
      }
    }
  }

  /**
   * Spawn, move and collide projectiles. They only deal damage while the
   * fight is live; after a K.O. they keep flying harmlessly off screen.
   */
  function stepProjectiles(dt, live) {
    state.fighters.forEach((f, i) => {
      // spawnProjectile marks the move as fired either way, so a special
      // thrown while the previous projectile is still on screen fizzles
      // instead of firing late.
      const p = spawnProjectile(f, i);
      if (p && !state.projectiles.some((q) => q.owner === i)) {
        state.projectiles.push(p);
        emit({ type: 'fireball', owner: i });
      }
    });

    const limit = ARENA.halfWidth + 2;
    for (const p of state.projectiles) {
      p.x += p.vx * dt;
      p.life -= dt;
    }

    // Opposing projectiles cancel each other out.
    const [p0, p1] = [0, 1].map((o) => state.projectiles.find((p) => p.owner === o));
    if (p0 && p1 && overlaps(projectileBox(p0), projectileBox(p1))) {
      p0.life = p1.life = 0;
      emit({ type: 'hit', blocked: true, heavy: true, x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2, target: -1 });
    }

    if (live) {
      for (const p of state.projectiles) {
        if (p.life <= 0) continue;
        const target = 1 - p.owner;
        const wasStunned = state.fighters[target].action === 'hit';
        const hit = projectileHit(p, state.fighters[target]);
        if (hit) {
          p.life = 0;
          landed(target, hit, wasStunned);
        }
      }
    }

    state.projectiles = state.projectiles.filter((p) => p.life > 0 && Math.abs(p.x) < limit);
  }

  /** Returns and clears events produced since the last call. */
  function drainEvents() {
    const out = events;
    events = [];
    return out;
  }

  resetRound();
  return { state, step, drainEvents };
}
