// Regression tests for the pure simulation modules (no browser, no npm).
// Run from the project root:  node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ARENA, ARENAS, ATTACKS, CHARACTERS, MATCH, NET, PHYSICS, TICK } from '../js/config.js';
import { EMPTY_INPUT } from '../js/fighter.js';
import { createMatch } from '../js/game.js';
import { createBot } from '../js/bot.js';
import {
  createInputQueue, createInterpolator, decodeAuthority, decodeInput, encodeInput,
  encodeSnapshot, targetDelay,
} from '../js/netsync.js';
import { createPredictor } from '../js/prediction.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A match already in the fight phase, fighters placed at the given X. */
function fightAt(x0, x1, chars = [1, 1]) {
  const m = createMatch(['A', 'B'], chars); // AYAZ: neutral 1.0 multipliers
  while (m.state.phase !== 'fight') m.step([EMPTY_INPUT, EMPTY_INPUT], TICK);
  m.drainEvents();
  m.state.fighters[0].x = x0;
  m.state.fighters[1].x = x1;
  return m;
}

/** Run `ticks` steps; `inputs(t)` returns [p1, p2] partial inputs. */
function run(m, ticks, inputs = () => [{}, {}]) {
  const events = [];
  for (let t = 0; t < ticks; t++) {
    const [a, b] = inputs(t);
    m.step([{ ...EMPTY_INPUT, ...a }, { ...EMPTY_INPUT, ...b }], TICK);
    events.push(...m.drainEvents());
  }
  return events;
}

const hits = (events) => events.filter((e) => e.type === 'hit');
const press = (key) => (t) => [t === 0 ? { [key]: true } : {}, {}];

// ---------------------------------------------------------------------------
// Melee
// ---------------------------------------------------------------------------

test('standing punch hits a standing opponent for full damage', () => {
  const m = fightAt(0, 1);
  const ev = hits(run(m, 30, press('punch')));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].blocked, false);
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp - ATTACKS.punch.damage);
});

test('crouching ducks under a standing punch', () => {
  const m = fightAt(0, 1);
  const ev = hits(run(m, 30, (t) => [t === 0 ? { punch: true } : {}, { down: true }]));
  assert.equal(ev.length, 0);
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp);
});

test('crouching kick hits a crouching opponent', () => {
  const m = fightAt(0, 1.2);
  const ev = hits(run(m, 40, (t) => [{ down: true, kick: t === 1 }, { down: true }]));
  assert.equal(ev.length, 1);
});

test('blocking reduces damage to chip and only while facing the attacker', () => {
  const m = fightAt(0, 1);
  run(m, 30, (t) => [t === 0 ? { kick: true } : {}, { block: true }]);
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp - ATTACKS.kick.chip);
});

test('simultaneous attacks trade instead of the first cancelling the second', () => {
  const m = fightAt(0, 1);
  const ev = hits(run(m, 30, (t) => (t === 0 ? [{ punch: true }, { punch: true }] : [{}, {}])));
  assert.equal(ev.length, 2);
  assert.equal(m.state.fighters[0].hp, MATCH.maxHp - ATTACKS.punch.damage);
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp - ATTACKS.punch.damage);
});

test('punch chains count as a combo', () => {
  const m = fightAt(0, 0.9);
  // Mash punch every 4 ticks; the input buffer carries presses into the next swing.
  const ev = run(m, 120, (t) => [t % 4 === 0 && t < 72 ? { punch: true } : {}, {}]);
  const combos = ev.filter((e) => e.type === 'combo').map((e) => e.count);
  assert.ok(combos.includes(2), `expected a 2-hit combo, got ${combos}`);
});

test('character power scales damage', () => {
  const m = fightAt(0, 1, [0, 1]); // KOR (power 1.15) vs AYAZ
  run(m, 30, press('punch'));
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp - ATTACKS.punch.damage * 1.15);
});

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------

test('projectile hits a standing opponent', () => {
  const m = fightAt(0, 5);
  const ev = run(m, 120, press('special'));
  assert.equal(ev.filter((e) => e.type === 'fireball').length, 1);
  assert.equal(hits(ev).length, 1);
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp - ATTACKS.special.damage);
});

test('projectile flies over a crouching opponent', () => {
  const m = fightAt(0, 5);
  run(m, 120, (t) => [t === 0 ? { special: true } : {}, { down: true }]);
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp);
});

test('opposing projectiles cancel each other', () => {
  const m = fightAt(-4, 4);
  run(m, 120, (t) => (t === 0 ? [{ special: true }, { special: true }] : [{}, {}]));
  assert.equal(m.state.fighters[0].hp, MATCH.maxHp);
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp);
  assert.equal(m.state.projectiles.length, 0);
});

test('only one projectile per fighter on screen', () => {
  const m = fightAt(-8, 8);
  run(m, 60, (t) => [t % 10 === 0 ? { special: true } : {}, {}]);
  assert.ok(m.state.projectiles.filter((p) => p.owner === 0).length <= 1);
});

// ---------------------------------------------------------------------------
// Physics, hit-stop, match flow
// ---------------------------------------------------------------------------

test('fighters never overlap or leave the arena', () => {
  const m = fightAt(-1, 1);
  run(m, 300, () => [{ right: true }, { left: true }]);
  const [a, b] = m.state.fighters;
  assert.ok(Math.abs(a.x - b.x) >= PHYSICS.minSeparation - 1e-9);
  for (const f of m.state.fighters) assert.ok(Math.abs(f.x) <= ARENA.halfWidth);
});

test('hit-stop freezes movement right after a clean hit', () => {
  const m = fightAt(0, 1);
  const ev = [];
  let t = 0;
  while (!hits(ev).length && t < 30) ev.push(...run(m, 1, () => [t++ === 0 ? { punch: true } : {}, {}]));
  assert.ok(m.state.hitstop > 0, 'hit-stop should be active');
  const x = m.state.fighters[1].x;
  run(m, 2);
  assert.equal(m.state.fighters[1].x, x);
});

test('bot vs bot matches always finish with a winner', () => {
  for (let i = 0; i < 3; i++) {
    const m = createMatch(['A', 'B'], [i % 3, (i + 1) % 3]);
    const bots = [createBot(0), createBot(1)];
    let ticks = 0;
    while (m.state.phase !== 'over' && ticks < 60 * 60 * 10) {
      m.step(bots.map((b) => b.think(m.state, TICK)), TICK);
      m.drainEvents();
      ticks++;
    }
    assert.equal(m.state.phase, 'over');
    assert.ok(m.state.winner === 0 || m.state.winner === 1);
    for (const f of m.state.fighters) assert.ok(Number.isFinite(f.x) && Number.isFinite(f.hp));
  }
});

// ---------------------------------------------------------------------------
// Network snapshots
// ---------------------------------------------------------------------------

test('snapshots round-trip through the interpolator', () => {
  const m = fightAt(-2, 2);
  const interp = createInterpolator();
  interp.push(JSON.parse(JSON.stringify(encodeSnapshot(m.state, 10, []))));
  const out = interp.sample();
  assert.ok(out);
  assert.equal(out.state.phase, 'fight');
  assert.deepEqual(out.state.chars, [1, 1]);
  assert.equal(out.positions[0].x, -2);
  assert.ok(JSON.stringify(encodeSnapshot(m.state, 10, [])).length < 600, 'packet should stay small');
});

test('malformed snapshots are rejected', () => {
  const interp = createInterpolator();
  interp.push({ t: 's', k: 1, s: { f: 'nope', p: 'fight' } });
  interp.push({ t: 's', k: 2, s: { f: [{}, {}], p: 'hacked' } });
  interp.push({ t: 's', k: -5, s: null });
  assert.equal(interp.sample(), null);
});

test('hostile field values are sanitised', () => {
  const interp = createInterpolator();
  interp.push({
    t: 's', k: 3,
    s: { p: 'fight', ch: [99, -1], f: [{ x: 'a', a: '<img>', hp: Infinity }, { x: 1 }], pr: [{ o: 7, x: NaN }] },
  });
  const { state } = interp.sample();
  assert.deepEqual(state.chars, [0, 0]);
  assert.equal(state.fighters[0].x, 0);
  assert.equal(state.fighters[0].action, 'idle');
  assert.equal(state.fighters[0].hp, 0);
  assert.equal(state.projectiles[0].owner, 0);
});

// ---------------------------------------------------------------------------
// Adaptive interpolation delay (fake clock)
// ---------------------------------------------------------------------------

test('target delay stays within the configured bounds', () => {
  assert.equal(targetDelay(0), NET.interpMinMs);
  assert.equal(targetDelay(1000), NET.interpMaxMs);
  assert.ok(targetDelay(10) > targetDelay(0));
});

/** Feed 30 Hz snapshots with the given per-packet lateness; return settled delay. */
function settleDelay(lateness) {
  const realNow = performance.now;
  let clock = 0;
  performance.now = () => clock;
  try {
    const m = fightAt(-2, 2);
    const interp = createInterpolator();
    for (let i = 0; i < 600; i++) {
      const tick = (i + 1) * NET.snapshotEvery;
      clock = tick * TICK * 1000 + 40 + lateness(i); // 40 ms base latency
      interp.push(JSON.parse(JSON.stringify(encodeSnapshot(m.state, tick, []))));
      interp.sample();
    }
    return interp.delay;
  } finally {
    performance.now = realNow;
  }
}

test('steady connection settles near the minimum delay', () => {
  assert.ok(settleDelay(() => 0) < NET.interpMinMs + 5);
});

test('jittery connection raises the delay', () => {
  const steady = settleDelay(() => 0);
  const jittery = settleDelay((i) => (i % 3 === 0 ? 30 : 0));
  assert.ok(jittery > steady + 20, `steady ${steady}, jittery ${jittery}`);
  assert.ok(jittery <= NET.interpMaxMs);
});

// ---------------------------------------------------------------------------
// Client prediction (host + client wired through a fake network)
// ---------------------------------------------------------------------------

test('input bitmask round-trips', () => {
  const input = { ...EMPTY_INPUT, left: true, block: true, special: true };
  assert.deepEqual(decodeInput(encodeInput(input)), input);
});

test('input queue ignores stale/malformed packets and never drops presses', () => {
  const q = createInputQueue(2);
  q.push({ s: 1, k: encodeInput({ punch: true }) });
  q.push({ s: 1, k: 0 });           // duplicate seq
  q.push({ s: 'x', k: 0 });         // malformed
  q.push({ s: 2, k: 999 });         // out of range
  q.push({ s: 3, k: 0 });
  q.push({ s: 4, k: 0 });
  // Over capacity: seq 1 is merged away but its punch survives.
  const first = q.take();
  assert.equal(first.punch, true);
  assert.equal(q.ack, 3);
});

/**
 * Host match + client predictor connected by a network with `latency` ticks
 * each way. `script(t)` is the client's input at client tick t.
 */
function onlineGame(latency, ticks, script, onTick = () => {}) {
  const m = fightAt(-2, 2);
  const queue = createInputQueue();
  const pred = createPredictor();
  const toHost = [];
  const toClient = [];
  for (let t = 0; t < ticks; t++) {
    const input = { ...EMPTY_INPUT, ...script(t) };
    const seq = pred.input(input);
    toHost.push({ at: t + latency, msg: { t: 'in', s: seq, k: encodeInput(input) } });

    while (toHost.length && toHost[0].at <= t) queue.push(toHost.shift().msg);
    m.step([EMPTY_INPUT, queue.take()], TICK);
    m.drainEvents();
    if (t % NET.snapshotEvery === 0) {
      const packet = JSON.parse(JSON.stringify(encodeSnapshot(m.state, t + 1, [], queue.ack)));
      toClient.push({ at: t + latency, msg: packet });
    }
    while (toClient.length && toClient[0].at <= t) pred.reconcile(decodeAuthority(toClient.shift().msg));
    onTick(t, m, pred);
  }
  return { m, pred };
}

test('prediction moves the local fighter on the same tick as the keypress', () => {
  let predictedX;
  let hostX;
  onlineGame(6, 40, (t) => (t >= 30 ? { right: true } : {}), (t, m, pred) => {
    if (t === 30) {
      predictedX = pred.view(0).fighter.x;
      hostX = m.state.fighters[1].x;
    }
  });
  assert.ok(predictedX > 2, `predicted fighter should already move (x=${predictedX})`);
  assert.equal(hostX, 2, 'host has not received the input yet');
});

test('prediction starts attacks instantly', () => {
  let action;
  onlineGame(6, 32, (t) => (t === 30 ? { punch: true } : {}), (t, m, pred) => {
    if (t === 30) action = pred.view(0).fighter.action;
  });
  assert.equal(action, 'punch');
});

test('prediction converges to the host state once input stops', () => {
  const { m, pred } = onlineGame(6, 140, (t) => (t >= 30 && t < 70 ? { right: true } : t === 75 ? { jump: true } : {}));
  const host = m.state.fighters[1];
  const predicted = pred.view(1).fighter;
  assert.ok(Math.abs(predicted.x - host.x) < 1e-6, `x: predicted ${predicted.x} vs host ${host.x}`);
  assert.ok(Math.abs(predicted.y - host.y) < 1e-6);
  assert.equal(predicted.action, host.action);
  // Only inputs still in flight remain: round trip + one snapshot interval.
  const inFlight = 2 * 6 + NET.snapshotEvery + 1;
  assert.ok(pred.pendingCount <= inFlight, `pending ${pred.pendingCount} > ${inFlight}`);
});

test('hostile authority packets are sanitised', () => {
  const auth = decodeAuthority({
    t: 's', k: 1, a: -3,
    me: { x: 'evil', a: 'teleport', b: ['nuke', 1], ch: 42 },
    s: { p: 'fight', hs: -1, f: [{}, {}] },
  });
  assert.equal(auth.ack, 0);
  assert.equal(auth.me.x, 0);
  assert.equal(auth.me.action, 'idle');
  assert.equal(auth.me.buffer, null);
  assert.equal(auth.me.char, 0);
  assert.equal(auth.hitstop, 0);
});

// ---------------------------------------------------------------------------
// FINISH HIM / FATALITY
// ---------------------------------------------------------------------------

/** Player 1 one hit away from winning the match; returns events after the KO. */
function matchPoint() {
  const m = fightAt(0, 1);
  m.state.wins = [1, 0];
  m.state.fighters[1].hp = 1;
  const ev = run(m, 30, press('punch'));
  return { m, ev };
}

test('the match-deciding K.O. opens the FINISH HIM window', () => {
  const { m, ev } = matchPoint();
  assert.equal(m.state.phase, 'finish');
  assert.equal(m.state.fighters[1].action, 'dazed');
  assert.ok(ev.some((e) => e.type === 'announce' && e.text === 'FINISH HIM!'));
  assert.deepEqual(m.state.wins, [2, 0]);
});

test('a non-deciding K.O. does not open the finish window', () => {
  const m = fightAt(0, 1);
  m.state.fighters[1].hp = 1;
  run(m, 30, press('punch'));
  assert.equal(m.state.phase, 'roundEnd');
});

test('a special move during FINISH HIM is a FATALITY', () => {
  const { m } = matchPoint();
  m.state.fighters[0].x = -2; // projectile range
  const ev = run(m, 90, press('special'));
  assert.ok(ev.some((e) => e.type === 'fatality' && e.target === 1));
  assert.equal(m.state.fighters[1].action, 'fatality');
  run(m, 60 * 6);
  assert.equal(m.state.phase, 'over');
  assert.equal(m.state.winner, 0);
});

test('normal hits only stagger the dazed loser; the timeout drops them', () => {
  // Mashing straight after the K.O. must not waste the finish.
  const melee = matchPoint().m;
  const ev = run(melee, 60, (t) => [t % 6 === 0 ? { punch: true } : { right: true }, {}]);
  assert.ok(!ev.some((e) => e.type === 'fatality'));
  assert.equal(melee.state.phase, 'finish');
  assert.equal(melee.state.fighters[1].action, 'dazed');

  const idle = matchPoint().m;
  run(idle, 60 * 5);
  assert.equal(idle.state.fighters[1].action, 'ko');
  run(idle, 60 * 4);
  assert.equal(idle.state.phase, 'over');
});

test('only the winner can act during FINISH HIM', () => {
  const { m } = matchPoint();
  const x = m.state.fighters[1].x;
  run(m, 30, () => [{}, { left: true, punch: true }]);
  assert.equal(m.state.fighters[1].x, x);
  assert.equal(m.state.fighters[1].action, 'dazed');
});

test('a fatality is still possible after mashing into the dazed loser', () => {
  const { m } = matchPoint();
  run(m, 30, (t) => [t % 7 === 0 ? { punch: true } : { right: true }, {}]);
  run(m, 30, () => [{ left: true }, {}]);
  const ev = run(m, 90, press('special'));
  assert.ok(ev.some((e) => e.type === 'fatality'));
});

// ---------------------------------------------------------------------------
// Content: characters and arenas
// ---------------------------------------------------------------------------

test('arena and every character survive the network round trip', () => {
  for (let c = 0; c < CHARACTERS.length; c++) {
    const m = createMatch(['A', 'B'], [c, (c + 1) % CHARACTERS.length], ARENAS.length - 1);
    const interp = createInterpolator();
    interp.push(JSON.parse(JSON.stringify(encodeSnapshot(m.state, 1, []))));
    const { state } = interp.sample();
    assert.deepEqual(state.chars, [c, (c + 1) % CHARACTERS.length]);
    assert.equal(state.arena, ARENAS.length - 1);
  }
});

test('an out-of-range arena from the network falls back to the first', () => {
  const m = createMatch();
  const packet = JSON.parse(JSON.stringify(encodeSnapshot(m.state, 1, [])));
  packet.s.ar = 99;
  const interp = createInterpolator();
  interp.push(packet);
  assert.equal(interp.sample().state.arena, 0);
});
