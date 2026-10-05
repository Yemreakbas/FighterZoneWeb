// Regression tests for the pure simulation modules (no browser, no npm).
// Run from the project root:  node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ARENA, ARENAS, ATTACKS, BOT_DIFFICULTIES, BOT_LEVELS, CHARACTERS, MATCH, NET, PHYSICS, SWEEP, TICK, TRAINING } from '../js/config.js';
import { EMPTY_INPUT } from '../js/fighter.js';
import { createMatch, targetOf } from '../js/game.js';
import { botLevel, createBot } from '../js/bot.js';
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
// Throws
// ---------------------------------------------------------------------------

// Fighter 0 stands at x=0 facing +X, so "forward" is right.
const grabAt0 = (t) => (t === 0 ? { right: true, punch: true } : {});

test('forward + punch up close throws through a block', () => {
  const m = fightAt(0, 1);
  const ev = run(m, 90, (t) => [grabAt0(t), { block: true }]);
  const [grab] = hits(ev);
  assert.equal(grab?.throw, true);
  assert.equal(grab.blocked, false);
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp - ATTACKS.throw.damage);
  assert.ok(ev.some((e) => e.type === 'slam' && e.target === 1), 'expected a landing slam');
  assert.ok(m.state.fighters[1].x < m.state.fighters[0].x, 'victim lands behind the thrower');
  assert.ok(m.state.fighters[1].grounded);
});

test('forward + punch out of throw range is a normal punch', () => {
  const m = fightAt(0, 2);
  run(m, 1, (t) => [grabAt0(t), {}]);
  assert.equal(m.state.fighters[0].action, 'punch');
});

test('a faster strike beats a throw attempt', () => {
  const m = fightAt(0, 1);
  const ev = hits(run(m, 40, (t) => [grabAt0(t), t === 0 ? { punch: true } : {}]));
  assert.ok(!ev.some((e) => e.throw));
  assert.equal(m.state.fighters[0].hp, MATCH.maxHp - ATTACKS.punch.damage);
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp);
});

test('a throw whiffs on a jumping opponent and leaves the thrower open', () => {
  const m = fightAt(0, 1);
  const a = ATTACKS.throw;
  const recoveryTicks = Math.floor((a.startup + a.active + a.recovery) / TICK) - 2;
  const ev = hits(run(m, recoveryTicks, (t) => [grabAt0(t), t === 0 ? { jump: true } : {}]));
  assert.equal(ev.length, 0);
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp);
  assert.equal(m.state.fighters[0].action, 'throw', 'still recovering from the whiff');
});

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

// Crouch for a tick, then kick from the crouch.
const sweepAt0 = (t) => ({ down: t < 30, kick: t === 1 });

test('a sweep goes through a standing block and knocks the opponent down', () => {
  const m = fightAt(0, 1.2);
  const ev = run(m, 90, (t) => [sweepAt0(t), { block: true }]);
  const [hit] = hits(ev);
  assert.equal(hit?.blocked, false);
  assert.equal(hit.sweep, true);
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp - SWEEP.damage);
  assert.ok(ev.some((e) => e.type === 'slam' && e.target === 1), 'expected the victim to hit the floor');
  assert.ok(m.state.fighters[1].grounded);
});

test('a crouching block stops a sweep', () => {
  const m = fightAt(0, 1.2);
  const ev = hits(run(m, 60, (t) => [sweepAt0(t), { block: true, down: true }]));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].blocked, true);
  assert.ok(!ev[0].sweep);
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp - ATTACKS.kick.chip);
  assert.equal(m.state.fighters[1].action, 'block');
});

test('a crouching block still stops a standing kick', () => {
  const m = fightAt(0, 1);
  const ev = hits(run(m, 40, (t) => [t === 0 ? { kick: true } : {}, { block: true, down: true }]));
  assert.equal(ev[0]?.blocked, true);
});

test('a whiffed sweep recovers later than a standing kick', () => {
  const a = ATTACKS.kick;
  const kickTicks = Math.ceil((a.startup + a.active + a.recovery) / TICK) + 1;
  const kick = fightAt(0, 5);
  run(kick, kickTicks, (t) => [t === 0 ? { kick: true } : {}, {}]);
  assert.notEqual(kick.state.fighters[0].action, 'kick', 'standing kick has recovered');

  const sweep = fightAt(0, 5);
  run(sweep, kickTicks + 1, (t) => [{ down: true, kick: t === 1 }, {}]);
  assert.equal(sweep.state.fighters[0].action, 'kick', 'sweep is still recovering');
});

test('a sweep on a fighter already in the air is just a kick', () => {
  const m = fightAt(0, 1.2);
  // Wind the sweep up, then lift the defender just off the floor so the
  // low hitbox still reaches them as the active window opens.
  run(m, Math.floor(ATTACKS.kick.startup / TICK), (t) => [sweepAt0(t), {}]);
  Object.assign(m.state.fighters[1], { y: 0.3, vy: 0, grounded: false, action: 'jump' });
  const ev = hits(run(m, 6, (t) => [{ down: true }, {}]));
  assert.equal(ev.length, 1);
  assert.ok(!ev[0].sweep, 'airborne fighters are not swept');
  assert.equal(m.state.fighters[1].action, 'hit');
});

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

const [leftPlat, rightPlat, topPlat] = ARENA.platforms;

test('jumping up through a platform lands on top of it', () => {
  const m = fightAt(-8, rightPlat.x0 + 1);
  run(m, 60, (t) => [{}, t === 0 ? { jump: true } : {}]);
  const f = m.state.fighters[1];
  assert.equal(f.y, rightPlat.y);
  assert.ok(f.grounded);
});

test('down + jump drops through a platform to the floor', () => {
  const m = fightAt(-8, rightPlat.x0 + 1);
  run(m, 60, (t) => [{}, t === 0 ? { jump: true } : {}]);
  run(m, 60, (t) => [{}, { down: t < 2, jump: t === 1 }]);
  const f = m.state.fighters[1];
  assert.equal(f.y, ARENA.groundY);
  assert.ok(f.grounded);
});

test('walking off a platform edge falls to the floor', () => {
  const m = fightAt(-8, rightPlat.x0 + 0.3);
  run(m, 60, (t) => [{}, t === 0 ? { jump: true } : {}]);
  assert.equal(m.state.fighters[1].y, rightPlat.y);
  run(m, 60, () => [{}, { left: true }]);
  const f = m.state.fighters[1];
  assert.equal(f.y, ARENA.groundY);
  assert.ok(f.grounded);
});

test('the top platform is reachable from a side platform, not from the floor', () => {
  const fromFloor = fightAt(-8, 0);
  run(fromFloor, 60, (t) => [{}, t === 0 ? { jump: true } : {}]);
  assert.equal(fromFloor.state.fighters[1].y, ARENA.groundY);

  const m = fightAt(8, rightPlat.x0 + 0.1); // opponent on the right: fighter faces right
  run(m, 60, (t) => [{}, t === 0 ? { jump: true } : {}]);
  assert.equal(m.state.fighters[1].y, rightPlat.y);
  run(m, 60, (t) => [{}, t === 0 ? { jump: true, left: true } : {}]);
  const f = m.state.fighters[1];
  assert.equal(f.y, topPlat.y);
  assert.ok(f.x >= topPlat.x0 && f.x <= topPlat.x1);
});

test('a fighter cannot throw someone standing on a different level', () => {
  const m = fightAt(leftPlat.x1 - 0.2, leftPlat.x1 + 0.4);
  // Put fighter 1 on the floor next to fighter 0 standing on the platform.
  run(m, 60, (t) => [t === 0 ? { jump: true } : {}, {}]);
  assert.equal(m.state.fighters[0].y, leftPlat.y);
  const ev = hits(run(m, 40, (t) => [t === 0 ? { right: true, punch: true } : {}, {}]));
  assert.ok(!ev.some((e) => e.throw));
});

// ---------------------------------------------------------------------------
// Special cooldown
// ---------------------------------------------------------------------------

test('the special move recharges before it can be used again', () => {
  const m = fightAt(-8, 8);
  const ev = run(m, 120, (t) => [t % 10 === 0 ? { special: true } : {}, {}]);
  assert.equal(ev.filter((e) => e.type === 'fireball').length, 1, 'only one fireball within the cooldown');
  run(m, Math.ceil(ATTACKS.special.cooldown / TICK), () => [{}, {}]);
  const later = run(m, 30, (t) => [t === 0 ? { special: true } : {}, {}]);
  assert.equal(later.filter((e) => e.type === 'fireball').length, 1, 'ready again after the cooldown');
});

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

function trainingAt(x0, x1) {
  const m = createMatch(['A', 'B'], [1, 1], 0, { training: true });
  while (m.state.phase !== 'fight') m.step([EMPTY_INPUT, EMPTY_INPUT], TICK);
  m.drainEvents();
  m.state.fighters[0].x = x0;
  m.state.fighters[1].x = x1;
  return m;
}

test('training reports combo damage and refills health afterwards', () => {
  const m = trainingAt(0, 0.9);
  const ev = run(m, 60, (t) => [t % 4 === 0 && t < 40 ? { punch: true } : {}, {}]);
  const totals = ev.filter((e) => e.type === 'damage' && e.target === 1).map((e) => e.total);
  assert.ok(totals.length >= 2, `expected several damage reports, got ${totals}`);
  assert.ok(totals.every((v, i) => i === 0 || v > totals[i - 1]), 'running total grows');
  assert.ok(m.state.fighters[1].hp < MATCH.maxHp);
  run(m, Math.ceil(TRAINING.refillDelay / TICK) + 30);
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp);
});

test('training never ends: no timer, no K.O.', () => {
  const m = trainingAt(0, 0.9);
  m.state.fighters[1].hp = 1;
  run(m, 30, press('kick'));
  run(m, Math.ceil(MATCH.roundTime / TICK) + 60);
  assert.equal(m.state.phase, 'fight');
  assert.equal(m.state.timer, MATCH.roundTime);
  assert.ok(m.state.fighters[1].hp > 0);
  assert.notEqual(m.state.fighters[1].action, 'ko');
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

test('bot difficulty climbs per round within its range', () => {
  BOT_DIFFICULTIES.forEach((d, i) => {
    assert.equal(botLevel(i, 1), BOT_LEVELS[d.start]);
    assert.equal(botLevel(i, 99), BOT_LEVELS[d.cap], 'stays at the cap in long matches');
  });
  // Harder settings are never weaker than easier ones in the same round.
  for (let round = 1; round <= 3; round++) {
    const reactions = BOT_DIFFICULTIES.map((_, i) => botLevel(i, round).reaction);
    assert.deepEqual([...reactions].sort((x, y) => y - x), reactions);
  }
  assert.equal(botLevel(42, 1), botLevel(1, 1), 'unknown difficulty falls back to the default');
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
  assert.equal(decodeAuthority({ t: 's', k: 1, mi: 7, me: {}, s: { p: 'fight', f: [{}, {}] } }), null, 'out-of-range fighter index');
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

// ---------------------------------------------------------------------------
// 2v2 team fights
// ---------------------------------------------------------------------------

/** A 2v2 in the fight phase; `xs` are the four fighters' X (teams 0,0,1,1). */
function teamFightAt(xs) {
  const m = createMatch(['A', 'B', 'C', 'D'], [1, 1, 1, 1]);
  while (m.state.phase !== 'fight') m.step([EMPTY_INPUT, EMPTY_INPUT, EMPTY_INPUT, EMPTY_INPUT], TICK);
  m.drainEvents();
  xs.forEach((x, i) => { m.state.fighters[i].x = x; });
  return m;
}

const run4 = (m, ticks, inputs) => {
  const events = [];
  for (let t = 0; t < ticks; t++) {
    m.step(inputs(t).map((i) => ({ ...EMPTY_INPUT, ...i })), TICK);
    events.push(...m.drainEvents());
  }
  return events;
};

test('2v2: teams line up on opposite sides', () => {
  const m = createMatch(['A', 'B', 'C', 'D'], [0, 1, 2, 3]);
  assert.deepEqual(m.state.teams, [0, 0, 1, 1]);
  const xs = m.state.fighters.map((f) => f.x);
  assert.ok(xs[0] < 0 && xs[1] < 0 && xs[2] > 0 && xs[3] > 0);
});

test('2v2: teammates cannot hit each other', () => {
  // Fighter 0 punches toward its teammate (1); the enemies are far away.
  const m = teamFightAt([0, 0.9, 8, 8.5]);
  m.state.fighters[0].facing = 1;
  const ev = run4(m, 30, (t) => [t === 0 ? { punch: true } : {}, {}, {}, {}]);
  assert.equal(ev.filter((e) => e.type === 'hit').length, 0);
  assert.equal(m.state.fighters[1].hp, MATCH.maxHp);
});

test('2v2: fighters face the nearest enemy', () => {
  const m = teamFightAt([0, -3, 2, -6]);
  assert.equal(targetOf(m.state.fighters, m.state.teams, 0), 2);
  assert.equal(targetOf(m.state.fighters, m.state.teams, 1), 3);
});

test('2v2: a K.O.d fighter stays down and the round goes on until the team is out', () => {
  const m = teamFightAt([-1, -6, 0, 6]);
  m.state.fighters[0].hp = 1; // fighter 0 is next to fighter 2
  const ev = run4(m, 40, (t) => [{}, {}, t === 0 ? { punch: true } : {}, {}]);
  assert.equal(m.state.fighters[0].action, 'ko');
  assert.ok(ev.some((e) => e.type === 'ko' && e.target === 0));
  assert.equal(m.state.phase, 'fight', 'teammate still standing');

  m.state.fighters[1].hp = 0;
  run4(m, 2, () => [{}, {}, {}, {}]);
  assert.equal(m.state.phase, 'roundEnd');
  assert.equal(m.state.roundWinner, 1);
  assert.equal(m.state.wins[1], 1);
});

test('2v2: time-out goes to the team with more total health', () => {
  const m = teamFightAt([-8, -6, 6, 8]);
  m.state.fighters[2].hp = 40;
  m.state.timer = TICK / 2;
  run4(m, 2, () => [{}, {}, {}, {}]);
  assert.equal(m.state.roundWinner, 0);
});

test('2v2: four fighters and teams survive the network round trip', () => {
  const m = teamFightAt([-3, -1, 1, 3]);
  const packet = JSON.parse(JSON.stringify(encodeSnapshot(m.state, 5, [], 0, 3)));
  const auth = decodeAuthority(packet);
  assert.equal(auth.index, 3);
  assert.deepEqual(auth.teams, [0, 0, 1, 1]);
  assert.equal(auth.fighters.length, 4);
  assert.equal(auth.me.x, 3);
});
