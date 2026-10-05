// Procedural sound effects with the Web Audio API: no audio files to host.
// Browsers only allow audio after a user gesture, so `unlock()` is called
// from the first click/keypress.

let ctx = null;
let master = null;
let musicBus = null;
let noiseBuffer = null;
let muted = false;
let musicOn = loadMusicPref();
const MUSIC_VOLUME = 0.32;
const MUSIC_KEY = 'fighterzone.music';

function loadMusicPref() {
  try { return localStorage.getItem('fighterzone.music') !== 'off'; } catch { return true; }
}

export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // no audio support: play() stays a no-op
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.45;
    master.connect(ctx.destination);
    musicBus = ctx.createGain();
    musicBus.connect(master);
    applyMusicVolume();

    // One second of white noise, reused by every percussive sound.
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  // Music asked for before the first gesture starts now.
  if (music.wanted && !music.timer) startScheduler();
}

export function toggleMute() {
  muted = !muted;
  applyMusicVolume();
  return muted;
}

/** Music on/off (remembered per browser). Returns the new state. */
export function toggleMusic() {
  musicOn = !musicOn;
  try { localStorage.setItem(MUSIC_KEY, musicOn ? 'on' : 'off'); } catch { /* not persisted */ }
  applyMusicVolume();
  return musicOn;
}

function applyMusicVolume() {
  if (!musicBus) return;
  const target = muted || !musicOn ? 0 : MUSIC_VOLUME;
  musicBus.gain.setTargetAtTime(target, ctx.currentTime, 0.05);
}

// ---------------------------------------------------------------------------
// Fight music: a small step sequencer. A timer schedules the next ~120 ms of
// 16th-note steps ahead on the audio clock, so timing stays tight even when
// the main thread is busy. 4-bar loop in A minor: Am - F - G - E.
// ---------------------------------------------------------------------------

const BPM = 132;
const STEP = 60 / BPM / 4;           // one 16th note in seconds
const LOOKAHEAD = 0.12;
const ROOTS = [55, 43.65, 49, 41.2]; // A1, F1, G1, E1 (one per bar)
// Chord tones (semitones over the root) for the arpeggio, per bar.
const CHORDS = [[12, 15, 19, 24], [12, 16, 19, 24], [12, 16, 19, 23], [12, 16, 19, 22]];
const BASS_STEPS = new Set([0, 3, 6, 8, 10, 11, 14]);
const BASS_OCTAVE = new Set([6, 14]);

const music = { wanted: false, timer: 0, step: 0, next: 0 };

const semis = (f, n) => f * 2 ** (n / 12);

function voice(type, freq, at, dur, peak, dest) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g).connect(dest);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

function hit(at, dur, freq, peak, type, dest) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(filter).connect(g).connect(dest);
  src.start(at, Math.random() * 0.5);
  src.stop(at + dur);
}

/** Schedule one 16th-note step of the loop at audio time `at`. */
function playStep(step, at) {
  const bar = Math.floor(step / 16) % 4;
  const s = step % 16;
  const root = ROOTS[bar];
  const bus = musicBus;
  // Drums: kick on the beat, snare on 2 and 4, hats on the off-beats.
  if (s % 4 === 0) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(140, at);
    osc.frequency.exponentialRampToValueAtTime(42, at + 0.12);
    g.gain.setValueAtTime(0.9, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    osc.connect(g).connect(bus);
    osc.start(at);
    osc.stop(at + 0.18);
  }
  if (s === 4 || s === 12) hit(at, 0.14, 1800, 0.45, 'bandpass', bus);
  if (s % 4 === 2) hit(at, 0.04, 7000, 0.18, 'highpass', bus);
  // Bass: driving root notes with octave jumps.
  if (BASS_STEPS.has(s)) voice('sawtooth', BASS_OCTAVE.has(s) ? root * 2 : root, at, STEP * 1.6, 0.32, bus);
  // Arpeggio on the second half of every other bar.
  if (bar % 2 === 1 && s >= 8 && s % 2 === 0) {
    const notes = CHORDS[bar];
    voice('square', semis(root * 4, notes[(s / 2) % notes.length]), at, STEP * 1.4, 0.06, bus);
  }
}

function startScheduler() {
  if (!ctx || music.timer) return;
  music.next = ctx.currentTime + 0.08;
  music.timer = setInterval(() => {
    while (music.next < ctx.currentTime + LOOKAHEAD) {
      playStep(music.step, music.next);
      music.step++;
      music.next += STEP;
    }
  }, 25);
}

/** Start the fight music from the top (no-op if already playing). */
export function startMusic() {
  if (music.wanted) return;
  music.wanted = true;
  music.step = 0;
  if (ctx && ctx.state === 'running') startScheduler();
}

export function stopMusic() {
  music.wanted = false;
  clearInterval(music.timer);
  music.timer = 0;
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
  grab() {
    // Cloth whoosh rising into the toss.
    noise(0.22, 1200, 0.45, 'bandpass');
    tone(140, 260, 0.18, 0.3, 'triangle');
  },
  slam() {
    // Body hitting the floor: low boom, a dull thud, then a short rattle.
    tone(90, 32, 0.45, 1);
    noise(0.18, 400, 0.9);
    noise(0.12, 2200, 0.2, 'highpass', 0.06);
  },
  pickup() {
    // Bright rising chime.
    [880, 1175, 1568].forEach((f, i) => tone(f, f, 0.12, 0.12, 'triangle', i * 0.06));
  },
  block() {
    noise(0.05, 3000, 0.25, 'highpass');
    tone(950, 700, 0.05, 0.12, 'square');
  },
  fireball() {
    noise(0.35, 900, 0.35, 'bandpass');
    tone(220, 520, 0.3, 0.18, 'sawtooth');
  },
  finish() {
    tone(110, 55, 1.2, 0.5, 'sawtooth');
    tone(82, 41, 1.4, 0.6);
  },
  fatality() {
    noise(0.9, 700, 1);
    tone(70, 20, 1.1, 1);
    tone(160, 40, 0.5, 0.5, 'square', 0.05);
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
