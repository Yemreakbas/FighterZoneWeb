// Regression tests for the pure simulation modules (no browser, no npm).
// Run from the project root:  node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ARENA, ATTACKS, MATCH, PHYSICS, TICK } from '../js/config.js';
import { EMPTY_INPUT } from '../js/fighter.js';
import { createMatch } from '../js/game.js';
import { createBot } from '../js/bot.js';
import { createInterpolator, encodeSnapshot } from '../js/netsync.js';

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
