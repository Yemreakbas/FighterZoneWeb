// Procedural sound effects with the Web Audio API: no audio files to host.
// Browsers only allow audio after a user gesture, so `unlock()` is called
// from the first click/keypress.

let ctx = null;
let master = null;
let noiseBuffer = null;
let muted = false;

export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // no audio support: play() stays a no-op
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.45;
    master.connect(ctx.destination);

    // One second of white noise, reused by every percussive sound.
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export function toggleMute() {
  muted = !muted;
  return muted;
}

/** Gain node with a fast attack and exponential decay to silence. */
function envelope(peak, dur, at) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  g.connect(master);
  return g;
}

function noise(dur, freq, peak, type = 'lowpass', delay = 0) {
  const at = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  src.connect(filter).connect(envelope(peak, dur, at));
  src.start(at, Math.random() * 0.5);
  src.stop(at + dur);
}

function tone(from, to, dur, peak, type = 'sine', delay = 0) {
  const at = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + dur);
  osc.connect(envelope(peak, dur, at));
  osc.start(at);
  osc.stop(at + dur);
}

const SOUNDS = {
  hit() {
    noise(0.08, 2500, 0.5);
    tone(170, 60, 0.1, 0.7);
  },
  heavy() {
    noise(0.14, 1600, 0.7);
    tone(130, 40, 0.2, 0.9);
  },
  block() {
    noise(0.05, 3000, 0.25, 'highpass');
    tone(950, 700, 0.05, 0.12, 'square');
  },
  fireball() {
    noise(0.35, 900, 0.35, 'bandpass');
    tone(220, 520, 0.3, 0.18, 'sawtooth');
  },
  ko() {
    tone(95, 28, 0.7, 1);
    noise(0.45, 500, 0.6);
  },
  round() {
    tone(440, 440, 0.12, 0.12, 'square');
  },
  fight() {
    tone(523, 523, 0.09, 0.12, 'square');
    tone(784, 784, 0.18, 0.14, 'square', 0.1);
  },
  victory() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.16, 0.1, 'square', i * 0.12));
  },
};

export function play(name) {
  if (!ctx || muted || ctx.state !== 'running') return;
  SOUNDS[name]?.();
}
