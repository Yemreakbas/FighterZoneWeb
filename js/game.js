import { ARENA, HITSTOP, MATCH, ROUND_FLOW, TRAINING } from './config.js';
import {
  EMPTY_INPUT, applyContact, applyThrow, bufferPress, createFighter, findHit, findThrow, hurtbox, isKnockedDown, overlaps, projectileBox,
  projectileHit, separate, spawnProjectile, stepFighter,
} from './fighter.js';

// Authoritative match simulation: rounds, timer, combat resolution.
// Runs on the host (or locally in solo mode) at a fixed tick. Everything the
// renderer or a remote client needs is in `state` plus the drained events.
//
// Phases: intro -> fight -> [finish] -> roundEnd -> (intro | over)
// `finish` is the FINISH HIM window after the match-deciding K.O.
//
// Training matches never end: no timer, no K.O., health refills after each
// combo and `damage` events report the combo's running total.

const START_X = 2.5;

/** `chars` are indices into CHARACTERS for player 1 and 2; `arena` into ARENAS. */
export function createMatch(names = ['OYUNCU 1', 'OYUNCU 2'], chars = [0, 1], arena = 0, { training = false } = {}) {
  const state = {
    training,
    names,
    chars,
    arena,
    round: 1,
    timer: MATCH.roundTime,
    phase: 'intro',
    phaseT: 0,
    wins: [0, 0],
    roundWinner: -1, // -1 = none yet, 2 = draw
    winner: -1,      // match winner once phase === 'over'
    fighters: [],
    projectiles: [],
    hitstop: 0,      // seconds of impact freeze remaining
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
    // Hit-stop: freeze the whole fight briefly so clean hits feel heavy.
    state.hitstop = Math.max(state.hitstop, hit.heavy ? HITSTOP.heavy : HITSTOP.light);
    combo[attacker] = wasStunned ? combo[attacker] + 1 : 1;
    if (combo[attacker] >= 2) emit({ type: 'combo', attacker, count: combo[attacker] });
  }

  function resetRound() {
    state.fighters = [createFighter(-START_X, 1, chars[0]), createFighter(START_X, -1, chars[1])];
    state.projectiles = [];
    combo = [0, 0];
    state.timer = MATCH.roundTime;
    state.phase = 'intro';
    state.phaseT = 0;
    state.roundWinner = -1;
    emit({ type: 'announce', text: training ? 'ANTRENMAN' : `ROUND ${state.round}`, ms: ROUND_FLOW.introAnnounce * 1000 });
    trainee = [0, 1].map(() => ({ lastHp: MATCH.maxHp, quiet: 0, dealt: 0 }));
  }

  // Training bookkeeping per fighter: damage since the last refill.
  let trainee = [];

  function trainingRefill(dt) {
    state.fighters.forEach((f, i) => {
      const t = trainee[i];
      if (f.hp < t.lastHp) {
        t.dealt += t.lastHp - f.hp;
        t.quiet = 0;
        emit({ type: 'damage', target: i, total: Math.round(t.dealt) });
      } else {
        t.quiet += dt;
      }
      const recovering = f.action === 'hit' || isKnockedDown(f);
      if (f.hp <= 0 || (t.quiet >= TRAINING.refillDelay && !recovering)) {
        f.hp = MATCH.maxHp;
        if (t.quiet >= TRAINING.refillDelay) t.dealt = 0;
      }
      t.lastHp = f.hp;
    });
  }

  function endRound(winner, text) {
    state.phase = 'roundEnd';
    state.phaseT = 0;
    state.roundWinner = winner;
    if (winner === 0 || winner === 1) state.wins[winner]++;
    emit({ type: 'announce', text, ms: 1800 });
  }

  /** Match-deciding K.O.: the loser stays up, dazed, for FINISH HIM. */
  function startFinish(winner) {
    const loser = state.fighters[1 - winner];
    loser.action = 'dazed';
    loser.t = 0;
    loser.hp = 0;
    loser.vx = 0;
    loser.buffer = null;
    state.fighters[winner].buffer = null; // no stray mashed attack into the finish
    state.wins[winner]++;
    state.roundWinner = winner;
    state.phase = 'finish';
    state.phaseT = 0;
    state.projectiles = [];
    emit({ type: 'finish', winner });
    emit({ type: 'announce', text: 'FINISH HIM!', ms: 2500, style: 'blood' });
  }

  /** Leave the finish window into the normal round-end flow (wins already counted). */
  function closeFinish(extraHold) {
    state.phase = 'roundEnd';
    state.phaseT = -extraHold; // negative start delays the win pose/announce
  }

  function knockOut(f) {
    f.action = 'ko';
    f.t = 0;
    f.hp = 0;
  }

  function step(inputs, dt) {
    const [a, b] = state.fighters;

    if (state.hitstop > 0) {
      state.hitstop = Math.max(0, state.hitstop - dt);
      // Nothing moves; presses are buffered (the buffer only ages while
      // the fight runs).
      if (state.phase === 'fight') state.fighters.forEach((f, i) => bufferPress(f, inputs[i]));
      return;
    }

    const prevPhaseT = state.phaseT;
    state.phaseT += dt;

    // Players control their fighters during the fight; in the finish window
    // only the winner moves.
    const live = state.phase === 'fight';
    const controls = (i) => live || (state.phase === 'finish' && i === state.roundWinner);
    const airborneThrown = state.fighters.map(isKnockedDown);
    stepFighter(a, controls(0) ? inputs[0] : EMPTY_INPUT, b, dt);
    stepFighter(b, controls(1) ? inputs[1] : EMPTY_INPUT, a, dt);
    state.fighters.forEach((f, i) => {
      if (airborneThrown[i] && f.grounded) emit({ type: 'slam', target: i, x: f.x });
    });
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
      // Throws resolve after strikes: a fighter just hit is no longer
      // grabbable, and a thrower who got hit has lost the grab.
      for (const [atk, def, target] of [[a, b, 1], [b, a, 0]]) {
        const grab = findThrow(atk, def);
        if (grab) landed(target, applyThrow(grab), false);
      }

      if (training) {
        trainingRefill(dt);
        return;
      }

      state.timer = Math.max(0, state.timer - dt);
      const koA = a.hp <= 0;
      const koB = b.hp <= 0;
      const winner = koA && koB ? 2 : koA ? 1 : 0;
      if ((koA !== koB) && state.wins[winner] + 1 >= MATCH.roundsToWin) {
        startFinish(winner);
      } else if (koA || koB) {
        if (koA) knockOut(a);
        if (koB) knockOut(b);
        emit({ type: 'ko' });
        endRound(winner, koA && koB ? 'DOUBLE K.O.' : 'K.O.');
      } else if (state.timer <= 0) {
        endRound(a.hp === b.hp ? 2 : a.hp > b.hp ? 0 : 1, 'TIME');
      }
    } else if (state.phase === 'finish') {
      // A special move (projectile) on the dazed loser is a FATALITY. Normal
      // hits only make them stagger: players keep mashing after a K.O. and
      // must not waste the finish by accident. Time running out drops them.
      const w = state.roundWinner;
      const winner = state.fighters[w];
      const loser = state.fighters[1 - w];
      const proj = state.projectiles.find((p) => p.owner === w && overlaps(projectileBox(p), hurtbox(loser)));
      const melee = !proj && findHit(winner, loser);
      if (proj) {
        proj.life = 0;
        loser.action = 'fatality';
        loser.t = 0;
        loser.vx = 0;
        emit({ type: 'fatality', target: 1 - w, x: loser.x, y: loser.y });
        emit({ type: 'announce', text: 'FATALITY', ms: 2400, style: 'blood' });
        closeFinish(ROUND_FLOW.fatalityHold);
      } else if (melee) {
        winner.attackHit = true;
        emit({ type: 'hit', blocked: false, heavy: melee.move === 'kick', x: melee.x, y: melee.y, target: 1 - w });
        loser.vx = winner.facing * 2.5; // stagger back, still dazed
      }
      if (state.phase === 'finish' && state.phaseT >= ROUND_FLOW.finishTime) {
        knockOut(loser);
        closeFinish(0);
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
