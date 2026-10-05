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
//
// A match has 2 fighters (1v1) or 4 (2v2). `teams[i]` is fighter i's team
// (0 = left, 1 = right); wins, round and match winners are team indices, which
// in 1v1 equal the fighter indices. Teammates pass through each other and
// can't hurt each other. In a team fight a K.O.'d fighter stays down and the
// round ends when a whole team is down; FINISH HIM is a 1v1-only finale.

const START_X = 2.5;
const TEAMMATE_GAP = 1.6;

export const TEAM_NAMES = ['KIRMIZI TAKIM', 'MAVI TAKIM'];

/** Default teams: first half of the fighters on the left team. */
export const defaultTeams = (n) => Array.from({ length: n }, (_, i) => (i < n / 2 ? 0 : 1));

/** Fighters still in the round (not knocked out). */
export const isUp = (f) => f.action !== 'ko' && f.action !== 'fatality' && f.action !== 'dazed';

/**
 * Index of the enemy fighter `i` should face: the nearest one still up,
 * otherwise the nearest enemy at all. Shared with client prediction.
 */
export function targetOf(fighters, teams, i) {
  const me = fighters[i];
  let best = -1;
  let bestScore = Infinity;
  fighters.forEach((f, j) => {
    if (teams[j] === teams[i]) return;
    const score = Math.abs(f.x - me.x) + Math.abs(f.y - me.y) * 0.5 + (isUp(f) ? 0 : 1000);
    if (score < bestScore) { bestScore = score; best = j; }
  });
  return best < 0 ? (i + 1) % fighters.length : best;
}

/**
 * `chars` are indices into CHARACTERS, one per fighter (2 or 4); `arena` into
 * ARENAS; `teams` defaults to the first half against the second.
 */
export function createMatch(names = ['OYUNCU 1', 'OYUNCU 2'], chars = [0, 1], arena = 0, { training = false, teams } = {}) {
  teams = teams ?? defaultTeams(chars.length);
  const duel = chars.length === 2;
  const state = {
    training,
    names,
    chars,
    teams,
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

  // Clean hits in each attacker's current combo. A hit counts toward the
  // combo only if it lands while the defender is still in hitstun.
  let combo = chars.map(() => 0);

  function landed(attacker, target, hit, wasStunned) {
    emit({ ...hit, target });
    if (hit.blocked) {
      combo[attacker] = 0;
      return;
    }
    // Hit-stop: freeze the whole fight briefly so clean hits feel heavy.
    state.hitstop = Math.max(state.hitstop, hit.heavy ? HITSTOP.heavy : HITSTOP.light);
    combo[attacker] = wasStunned ? combo[attacker] + 1 : 1;
    if (combo[attacker] >= 2) emit({ type: 'combo', attacker, team: teams[attacker], count: combo[attacker] });
  }

  function resetRound() {
    // Each team lines up on its own side, first member nearest the centre.
    const slot = [0, 0];
    state.fighters = chars.map((c, i) => {
      const side = teams[i] === 0 ? -1 : 1;
      const x = side * (START_X + slot[teams[i]]++ * TEAMMATE_GAP);
      return createFighter(x, -side, c);
    });
    state.projectiles = [];
    combo = chars.map(() => 0);
    state.timer = MATCH.roundTime;
    state.phase = 'intro';
    state.phaseT = 0;
    state.roundWinner = -1;
    emit({ type: 'announce', text: training ? 'ANTRENMAN' : `ROUND ${state.round}`, ms: ROUND_FLOW.introAnnounce * 1000 });
    trainee = chars.map(() => ({ lastHp: MATCH.maxHp, quiet: 0, dealt: 0 }));
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
    state.fighters[winner].cooldown = 0;  // the fatality must always be possible
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

  const enemies = (i, j) => teams[i] !== teams[j];

  function step(inputs, dt) {
    const fighters = state.fighters;

    if (state.hitstop > 0) {
      state.hitstop = Math.max(0, state.hitstop - dt);
      // Nothing moves; presses are buffered (the buffer only ages while
      // the fight runs).
      if (state.phase === 'fight') fighters.forEach((f, i) => bufferPress(f, inputs[i] || EMPTY_INPUT));
      return;
    }

    const prevPhaseT = state.phaseT;
    state.phaseT += dt;

    // Players control their fighters during the fight; in the finish window
    // only the winner moves.
    const live = state.phase === 'fight';
    const controls = (i) => live || (state.phase === 'finish' && i === state.roundWinner);
    const airborneThrown = fighters.map(isKnockedDown);
    const targets = fighters.map((_, i) => targetOf(fighters, teams, i));
    fighters.forEach((f, i) => {
      stepFighter(f, controls(i) ? inputs[i] || EMPTY_INPUT : EMPTY_INPUT, fighters[targets[i]], dt);
    });
    fighters.forEach((f, i) => {
      if (airborneThrown[i] && f.grounded) emit({ type: 'slam', target: i, x: f.x });
    });
    // Only opponents push each other apart; teammates may overlap.
    for (let i = 0; i < fighters.length; i++) {
      for (let j = i + 1; j < fighters.length; j++) {
        if (enemies(i, j)) separate(fighters[i], fighters[j]);
      }
    }
    stepProjectiles(dt, live);

    const crossed = (mark) => prevPhaseT < mark && state.phaseT >= mark;

    if (state.phase === 'intro') {
      if (crossed(ROUND_FLOW.introAnnounce)) emit({ type: 'announce', text: 'FIGHT!', ms: 700 });
      if (state.phaseT >= ROUND_FLOW.introTotal) {
        state.phase = 'fight';
        state.phaseT = 0;
      }
    } else if (state.phase === 'fight') {
      // Detect every contact before applying any, so simultaneous attacks
      // trade, then check K.O. An attack connects with at most one fighter:
      // the nearest enemy its hitbox touches.
      const contacts = [];
      fighters.forEach((atk, i) => {
        for (const j of byDistance(i).filter((k) => enemies(i, k))) {
          const contact = findHit(atk, fighters[j]);
          if (contact) {
            contacts.push({ contact, attacker: i, target: j, wasStunned: fighters[j].action === 'hit' });
            break;
          }
        }
      });
      for (const { contact, attacker, target, wasStunned } of contacts) {
        landed(attacker, target, applyContact(contact), wasStunned);
      }
      // Throws resolve after strikes: a fighter just hit is no longer
      // grabbable, and a thrower who got hit has lost the grab.
      fighters.forEach((atk, i) => {
        for (const j of byDistance(i).filter((k) => enemies(i, k))) {
          const grab = findThrow(atk, fighters[j]);
          if (grab) {
            landed(i, j, applyThrow(grab), false);
            break;
          }
        }
      });

      if (training) {
        trainingRefill(dt);
        return;
      }

      state.timer = Math.max(0, state.timer - dt);
      if (duel) checkDuelEnd();
      else checkTeamEnd();
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
        fighters.forEach((f, i) => {
          if (teams[i] !== w || !isUp(f)) return;
          f.action = 'win';
          f.t = 0;
          f.vx = 0;
        });
        emit({ type: 'announce', text: w === 2 ? 'BERABERE' : `${teamName(w)} KAZANDI`, ms: 1600 });
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

  /** Other fighters' indices, nearest to fighter `i` first. */
  function byDistance(i) {
    const me = state.fighters[i];
    return state.fighters
      .map((f, j) => ({ j, d: Math.abs(f.x - me.x) + Math.abs(f.y - me.y) }))
      .filter((o) => o.j !== i)
      .sort((a, b) => a.d - b.d)
      .map((o) => o.j);
  }

  /** In 1v1 a fighter's name; in a team fight the team's name. */
  const teamName = (team) => (duel ? state.names[team] : TEAM_NAMES[team]);

  /** 1v1 K.O. / time-out rules, with FINISH HIM on the match-deciding K.O. */
  function checkDuelEnd() {
    const [a, b] = state.fighters;
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
  }

  /**
   * Team rules: a fighter at 0 HP drops and stays down; the round goes to
   * the team with someone still standing. Time-out compares team health.
   */
  function checkTeamEnd() {
    state.fighters.forEach((f, i) => {
      if (f.hp <= 0 && f.action !== 'ko') {
        knockOut(f);
        emit({ type: 'ko', target: i });
      }
    });
    const standing = [0, 1].map((t) => state.fighters.some((f, i) => teams[i] === t && f.action !== 'ko'));
    if (!standing[0] || !standing[1]) {
      const winner = standing[0] ? 0 : standing[1] ? 1 : 2;
      endRound(winner, winner === 2 ? 'DOUBLE K.O.' : 'K.O.');
    } else if (state.timer <= 0) {
      const hp = [0, 1].map((t) => state.fighters.reduce((sum, f, i) => sum + (teams[i] === t ? f.hp : 0), 0));
      endRound(hp[0] === hp[1] ? 2 : hp[0] > hp[1] ? 0 : 1, 'TIME');
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

    // Opposing teams' projectiles cancel each other out.
    for (const p0 of state.projectiles) {
      for (const p1 of state.projectiles) {
        if (p0.life <= 0 || p1.life <= 0 || !enemies(p0.owner, p1.owner)) continue;
        if (!overlaps(projectileBox(p0), projectileBox(p1))) continue;
        p0.life = p1.life = 0;
        emit({ type: 'hit', blocked: true, heavy: true, x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2, target: -1 });
      }
    }

    if (live) {
      for (const p of state.projectiles) {
        if (p.life <= 0) continue;
        for (const [target, f] of state.fighters.entries()) {
          if (!enemies(p.owner, target) || !isUp(f)) continue;
          const wasStunned = f.action === 'hit';
          const hit = projectileHit(p, f);
          if (hit) {
            p.life = 0;
            landed(p.owner, target, hit, wasStunned);
            break;
          }
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
