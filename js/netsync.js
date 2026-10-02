import { CHARACTERS, NET, TICK } from './config.js';

// State packets (host -> client) and client-side interpolation.
//
// Packet: { t: 's', k: hostTick, s: compactState, e: events[] }
// Field names are shortened and numbers rounded to keep packets small; at
// 30 Hz a packet is roughly 300 bytes.

const r3 = (v) => Math.round(v * 1000) / 1000;

export function encodeSnapshot(state, tick, events) {
  return {
    t: 's',
    k: tick,
    s: {
      n: state.names,
      ch: state.chars,
      r: state.round,
      tm: r3(state.timer),
      p: state.phase,
      w: state.wins,
      rw: state.roundWinner,
      wn: state.winner,
      f: state.fighters.map((f) => ({
        x: r3(f.x), y: r3(f.y), d: f.facing, hp: r3(f.hp),
        a: f.action, t: r3(f.t), c: f.crouch ? 1 : 0, g: f.grounded ? 1 : 0,
      })),
      pr: state.projectiles.map((p) => ({ o: p.owner, x: r3(p.x), y: r3(p.y), d: Math.sign(p.vx) })),
    },
    e: events.map((e) => (e.type === 'hit' ? { ...e, x: r3(e.x), y: r3(e.y) } : e)),
  };
}

const PHASES = new Set(['intro', 'fight', 'roundEnd', 'over']);
const ACTIONS = new Set(['idle', 'walk', 'crouch', 'jump', 'block', 'punch', 'kick', 'special', 'hit', 'ko', 'win']);
const validChar = (c) => (Number.isInteger(c) && c >= 0 && c < CHARACTERS.length ? c : 0);
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Rebuild a renderer-friendly state from a packet, rejecting garbage. */
function decodeState(s) {
  if (!s || !Array.isArray(s.f) || s.f.length !== 2 || !PHASES.has(s.p)) return null;
  return {
    names: Array.isArray(s.n) ? s.n.slice(0, 2).map((x) => String(x).slice(0, 16)) : ['P1', 'P2'],
    chars: Array.isArray(s.ch) ? [validChar(s.ch[0]), validChar(s.ch[1])] : [0, 1],
    round: num(s.r, 1),
    timer: num(s.tm),
    phase: s.p,
    wins: Array.isArray(s.w) ? [num(s.w[0]), num(s.w[1])] : [0, 0],
    roundWinner: num(s.rw, -1),
    winner: num(s.wn, -1),
    fighters: s.f.map((f) => ({
      x: num(f?.x), y: num(f?.y), facing: f?.d < 0 ? -1 : 1, hp: num(f?.hp),
      action: ACTIONS.has(f?.a) ? f.a : 'idle', t: num(f?.t),
      crouch: !!f?.c, grounded: !!f?.g,
    })),
    projectiles: (Array.isArray(s.pr) ? s.pr.slice(0, 4) : []).map((p) => ({
      owner: p?.o === 1 ? 1 : 0, x: num(p?.x), y: num(p?.y), vx: p?.d < 0 ? -1 : 1,
    })),
  };
}

/**
 * Snapshot interpolation.
 *
 * The client renders the world NET.interpDelayMs in the past, so there is
 * (almost) always a packet before and after the render time to blend
 * between. This hides network jitter at the cost of a small, constant delay.
 *
 * Host time is derived from the tick counter (tick * TICK). To map it onto
 * the local clock we track `offset = localReceiveTime - hostTime`. Its
 * minimum over time equals clock difference + the fastest observed latency;
 * packets delayed by jitter produce larger samples and are ignored. The
 * estimate relaxes slowly upward so a lasting latency increase is absorbed.
 */
export function createInterpolator() {
  const buffer = [];        // [{ time, state }] ordered by host time
  let pending = [];         // [{ time, event }] fired when render time passes
  let offset = null;
  let lastRecv = 0;

  function push(msg) {
    const state = decodeState(msg.s);
    const k = num(msg.k, -1);
    if (!state || k < 0) return;
    const hostTime = k * TICK * 1000;
    if (buffer.length && hostTime <= buffer[buffer.length - 1].time) return; // stale/duplicate

    const now = performance.now();
    const sample = now - hostTime;
    if (offset === null || sample < offset) offset = sample;
    else offset += (sample - offset) * 0.002;
    lastRecv = now;

    buffer.push({ time: hostTime, state });
    if (buffer.length > 40) buffer.shift();
    if (Array.isArray(msg.e)) {
      for (const event of msg.e.slice(0, 20)) {
        if (event && typeof event.type === 'string') pending.push({ time: hostTime, event });
      }
    }
  }

  function sample() {
    if (!buffer.length) return null;
    const now = performance.now();
    const renderTime = now - offset - NET.interpDelayMs;

    // Drop packets that are entirely in the past (keep one as the "from").
    while (buffer.length > 2 && buffer[1].time <= renderTime) buffer.shift();

    const from = buffer[0];
    const to = buffer.find((b) => b.time >= renderTime) || buffer[buffer.length - 1];
    const span = to.time - from.time;
    const alpha = span > 0 ? Math.max(0, Math.min(1, (renderTime - from.time) / span)) : 1;

    // Discrete values (hp, action, phase) come from the newer packet;
    // positions and animation time are blended. Copies keep the buffered
    // packets untouched for the next frame.
    const positions = [];
    const fighters = to.state.fighters.map((f, i) => {
      const a = from.state.fighters[i];
      positions.push({ x: a.x + (f.x - a.x) * alpha, y: a.y + (f.y - a.y) * alpha });
      const sameMove = a.action === f.action && a.t <= f.t;
      return { ...f, t: sameMove ? a.t + (f.t - a.t) * alpha : f.t };
    });
    // Projectiles are matched by owner (at most one each) and blended too.
    const projectiles = to.state.projectiles.map((p) => {
      const q = from.state.projectiles.find((o) => o.owner === p.owner);
      return q ? { ...p, x: q.x + (p.x - q.x) * alpha } : p;
    });
    const state = { ...to.state, fighters, projectiles };

    const events = [];
    pending = pending.filter((p) => {
      if (p.time > renderTime) return true;
      events.push(p.event);
      return false;
    });

    return { state, events, positions, stale: now - lastRecv > NET.staleMs };
  }

  return { push, sample };
}
