import { TICK } from './config.js';
import { bufferPress, separate, stepFighter } from './fighter.js';

// Client-side prediction for the local fighter in online play.
//
// Without it, a client keypress only shows up after a round trip to the host
// plus the interpolation buffer. Instead, every client tick:
//   1. the input gets a sequence number, is sent to the host and stored;
//   2. the local fighter is stepped immediately with the shared stepFighter.
// Each snapshot carries the host's authoritative state of this fighter and
// the last input sequence it applied (`ack`). Reconciliation rebases the
// prediction on that state and replays every input the host has not seen
// yet. Hits, damage and the opponent stay fully host-authoritative: a
// mispredicted move is simply corrected by the next snapshot.
//
// Corrections are not applied as a visible snap: the jump is turned into a
// visual offset that decays over a few frames.

const MAX_PENDING = 180;     // ~3 s of unacknowledged input before dropping the oldest
const SNAP_DISTANCE = 1.5;   // corrections larger than this (round reset, etc.) snap
const SMOOTHING = 15;        // per-second decay rate of the visual offset

export function createPredictor() {
  let seq = 0;
  let pending = [];          // [{ seq, input }] sent but not yet applied by the host
  let me = null;             // predicted fighter; null while not predicting
  let opp = null;            // latest authoritative opponent
  let hitstop = 0;
  let live = false;          // host only applies inputs during the fight phase
  const offset = { x: 0, y: 0 };

  /** Mirror one host tick for our fighter (fighter index 1). */
  function advance(input) {
    if (!me || !live) return;
    if (hitstop > 0) {
      hitstop = Math.max(0, hitstop - TICK);
      bufferPress(me, input);
      return;
    }
    stepFighter(me, input, opp, TICK);
    // The host separates (fighter0, fighter1); use a throwaway opponent copy
    // so only our side of the push is applied.
    separate({ ...opp }, me);
  }

  return {
    /** Record and predict one local tick. Returns the sequence number to send. */
    input(input) {
      seq++;
      pending.push({ seq, input });
      if (pending.length > MAX_PENDING) pending.shift();
      advance(input);
      return seq;
    },

    /** Rebase on an authoritative snapshot (from decodeAuthority) and replay. */
    reconcile(auth) {
      pending = pending.filter((p) => p.seq > auth.ack);
      const before = me && live ? { x: me.x, y: me.y } : null;

      live = auth.phase === 'fight';
      opp = auth.opp;
      hitstop = auth.hitstop;
      me = { ...auth.me, buffer: auth.me.buffer && { ...auth.me.buffer } };
      for (const p of pending) advance(p.input);

      if (!live) {
        // Outside the fight the host ignores input: show its state as-is.
        me = null;
        offset.x = offset.y = 0;
      } else if (before) {
        offset.x += before.x - me.x;
        offset.y += before.y - me.y;
        if (Math.hypot(offset.x, offset.y) > SNAP_DISTANCE) offset.x = offset.y = 0;
      }
    },

    /** Predicted fighter and its smoothed render position, or null. */
    view(dt) {
      if (!me) return null;
      const k = Math.exp(-SMOOTHING * dt);
      offset.x *= k;
      offset.y *= k;
      return { fighter: me, x: me.x + offset.x, y: me.y + offset.y };
    },

    get pendingCount() { return pending.length; },
  };
}
