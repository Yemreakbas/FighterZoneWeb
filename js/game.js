import { MATCH, ROUND_FLOW } from './config.js';
import { EMPTY_INPUT, createFighter, resolveHit, separate, stepFighter } from './fighter.js';

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
  };
  let events = [];

  const emit = (e) => events.push(e);

  function resetRound() {
    state.fighters = [createFighter(-START_X, 1), createFighter(START_X, -1)];
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

    const crossed = (mark) => prevPhaseT < mark && state.phaseT >= mark;

    if (state.phase === 'intro') {
      if (crossed(ROUND_FLOW.introAnnounce)) emit({ type: 'announce', text: 'FIGHT!', ms: 700 });
      if (state.phaseT >= ROUND_FLOW.introTotal) {
        state.phase = 'fight';
        state.phaseT = 0;
      }
    } else if (state.phase === 'fight') {
      // Resolve both attacks before checking KO so trades are possible.
      for (const [atk, def, target] of [[a, b, 1], [b, a, 0]]) {
        const hit = resolveHit(atk, def);
        if (hit) emit({ ...hit, target });
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

  /** Returns and clears events produced since the last call. */
  function drainEvents() {
    const out = events;
    events = [];
    return out;
  }

  resetRound();
  return { state, step, drainEvents };
}
