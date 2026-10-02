import { createStage } from './scene.js';
import { CHARACTERS, MATCH, NET, TICK } from './config.js';
import { createMatch } from './game.js';
import { EMPTY_INPUT, createFighter } from './fighter.js';
import { createBot } from './bot.js';
import { createKeyboard } from './input.js';
import { createFighterView } from './fighterView.js';
import { createEffects } from './effects.js';
import { hostRoom, isValidCode, joinRoom } from './network.js';
import { createInputQueue, createInterpolator, decodeAuthority, encodeInput, encodeSnapshot } from './netsync.js';
import { createPredictor } from './prediction.js';
import * as sound from './sound.js';
import * as ui from './ui.js';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const stage = createStage(document.getElementById('game-container'));
const views = [
  createFighterView(stage.scene, 0xc62828),
  createFighterView(stage.scene, 0x1e5bd6),
];
const effects = createEffects(stage.scene);
const keyboard = createKeyboard();

// Idle fighters posing behind the menu.
const menuFighters = [createFighter(-1.6, 1), createFighter(1.6, -1)];

/**
 * The active game session, or null while in menus. A session exposes
 * `update(dt)` returning `{ state, events, positions }` for rendering, plus
 * optional `rematch()` / `dispose()` and a `canRematch` flag.
 */
let session = null;

/**
 * Pause menu open. Only solo sessions (`pausable`) actually freeze; an
 * online match is host-authoritative and keeps running behind the menu.
 */
let paused = false;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Runs the authoritative simulation locally at a fixed tick. Used for solo
 * play (and by the P2P host). Rendering interpolates between the last two
 * ticks so motion stays smooth on high refresh-rate displays.
 */
function createLocalSession(chars, gatherInputs, onTick) {
  const names = chars.map((c) => CHARACTERS[c].name);
  let match = createMatch(names, chars);
  let acc = 0;
  let prev = snapshotPositions(match.state);
  let events = [];

  /** Run as many fixed ticks as `dt` covers. */
  function advance(dt) {
    acc += dt;
    while (acc >= TICK) {
      prev = snapshotPositions(match.state);
      match.step(gatherInputs(match.state), TICK);
      const tickEvents = match.drainEvents();
      events.push(...tickEvents);
      onTick?.(match.state, tickEvents);
      acc -= TICK;
    }
  }

  /** Render data: positions blended between the last two ticks. */
  function view() {
    const alpha = acc / TICK;
    const positions = match.state.fighters.map((f, i) => {
      const p = prev[i];
      // A new round replaces the fighter objects; never lerp across that.
      if (p.ref !== f) return { x: f.x, y: f.y };
      return { x: p.x + (f.x - p.x) * alpha, y: p.y + (f.y - p.y) * alpha };
    });
    const out = events;
    events = [];
    return { state: match.state, events: out, positions };
  }

  return {
    canRematch: true,
    advance,
    view,
    update(dt) {
      advance(dt);
      return view();
    },
    rematch() {
      match = createMatch(names, chars);
      acc = 0;
      prev = snapshotPositions(match.state);
    },
  };
}

function snapshotPositions(state) {
  return state.fighters.map((f) => ({ ref: f, x: f.x, y: f.y }));
}

/**
 * Calls `fn(dt)` every `ms` from a Web Worker timer. Browsers throttle
 * requestAnimationFrame (and main-thread timers) in background or unfocused
 * tabs, which would freeze the host's authoritative simulation for both
 * players; worker timers keep running. Falls back to setInterval.
 */
function createTicker(fn, ms) {
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    fn(Math.min((now - last) / 1000, 0.25));
    last = now;
  };
  try {
    const src = 'let id; onmessage = (e) => { clearInterval(id); if (e.data > 0) id = setInterval(() => postMessage(0), e.data); };';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = tick;
    worker.postMessage(ms);
    return { stop: () => worker.terminate() };
  } catch {
    const id = setInterval(tick, ms);
    return { stop: () => clearInterval(id) };
  }
}

// ---- Character select -----------------------------------------------------

/** Mode chosen in the menu, waiting for a character pick: 'solo' | 'host' | 'join'. */
let pendingMode = null;
let myChar = 0;

const validChar = (c) => (Number.isInteger(c) && c >= 0 && c < CHARACTERS.length ? c : 0);
const otherChar = (c) => (c + 1 + Math.floor(Math.random() * (CHARACTERS.length - 1))) % CHARACTERS.length;

function openSelect(mode) {
  pendingMode = mode;
  ui.setMenuStatus('');
  ui.showScreen('select');
  document.querySelector(`.char-card[data-char="${myChar}"]`)?.focus();
}

function pickCharacter(btn) {
  myChar = validChar(Number(btn?.dataset.char));
  const mode = pendingMode;
  pendingMode = null;
  if (mode === 'solo') startSolo();
  else if (mode === 'host') openHostLobby();
  else if (mode === 'join') openJoinLobby();
}

function startSolo() {
  const bot = createBot(1);
  session = createLocalSession(
    [myChar, otherChar(myChar)],
    (state) => [keyboard.sample(), bot.think(state, TICK)],
  );
  session.pausable = true;
  enterFight();
}

// ---- P2P host: authoritative simulation + snapshot broadcast -------------

function startHost(link, room, chars) {
  // Client inputs arrive numbered, one per client tick, and are applied one
  // per host tick; the last applied number is echoed back for prediction.
  const remote = createInputQueue();

  // Tick counter survives rematches so client-side time stays monotonic.
  let tick = 0;
  let outbox = [];
  const local = createLocalSession(
    chars,
    () => [playerInput(), remote.take()],
    (state, events) => {
      tick++;
      outbox.push(...events);
      if (tick % NET.snapshotEvery === 0) {
        link.send(encodeSnapshot(state, tick, outbox, remote.ack));
        outbox = [];
      }
    },
  );
  // Simulation is driven by the worker clock; rAF only renders (see createTicker).
  const ticker = createTicker(local.advance, 8);

  session = {
    canRematch: true,
    update() {
      ui.setNetStatus(`Ping: ${Math.round(link.rtt)} ms`);
      return local.view();
    },
    rematch: local.rematch,
    // The client is untrusted: the queue validates every packet.
    onData(msg) {
      if (msg.t === 'in') remote.push(msg);
    },
    dispose: () => {
      ticker.stop();
      room.cancel();
    },
  };
  enterFight();
}

// ---- P2P client: send inputs, render interpolated host state --------------

function startClient(link, room) {
  const interp = createInterpolator();
  const predictor = createPredictor();
  let acc = 0;

  session = {
    canRematch: false,
    update(dt) {
      // Fixed-tick input: each tick is numbered, sent, and predicted locally
      // so our own fighter reacts without waiting for the host.
      acc += dt;
      while (acc >= TICK) {
        const input = playerInput();
        const seq = predictor.input(input);
        link.send({ t: 'in', s: seq, k: encodeInput(input) });
        acc -= TICK;
      }

      const frameState = interp.sample();
      if (!frameState) {
        ui.setNetStatus('Host bekleniyor...', true);
        return { state: null };
      }
      ui.setNetStatus(
        frameState.stale ? 'Bağlantı yavaş...' : `Ping: ${Math.round(link.rtt)} ms · Tampon: ${Math.round(interp.delay)} ms`,
        frameState.stale,
      );

      // Our fighter (index 1) is drawn from the prediction, the opponent
      // from the interpolated host state.
      const predicted = predictor.view(dt);
      if (predicted) {
        frameState.state.fighters[1] = predicted.fighter;
        frameState.positions[1] = { x: predicted.x, y: predicted.y };
      }
      return frameState;
    },
    onData(msg) {
      if (msg.t !== 's') return;
      interp.push(msg);
      const auth = decodeAuthority(msg);
      if (auth) predictor.reconcile(auth);
    },
    dispose: () => room.cancel(),
  };
  enterFight();
}

// ---- Lobby ----------------------------------------------------------------

/** Pending hostRoom/joinRoom handle while in a lobby screen. */
let pendingRoom = null;
/** Host-side handler for the client's { t: 'hello', char } before the match starts. */
let awaitingHello = null;
const HELLO_TIMEOUT_MS = 3000;

const CLOSE_TEXT = {
  left: 'Rakip oyundan ayrıldı.',
  closed: 'Bağlantı koptu.',
  error: 'Bağlantı hatası.',
  timeout: 'Bağlantı zaman aşımı: rakip yanıt vermiyor.',
  full: 'Oda dolu.',
};

function netHandlers(onConnected, onError) {
  return {
    onConnected,
    onError,
    onData: (msg) => (session ? session.onData?.(msg) : awaitingHello?.(msg)),
    onClose: (reason) => {
      pendingRoom = null;
      leaveToMenu(CLOSE_TEXT[reason] || 'Bağlantı kapandı.');
    },
  };
}

function openHostLobby() {
  ui.setRoomCode('----');
  ui.setHostStatus('Oda kuruluyor...');
  ui.showScreen('lobby-host');
  try {
    const room = hostRoom({
      ...netHandlers(
        (link) => {
          // Wait for the client's character pick; fall back to a random one
          // if an older/misbehaving client never sends it.
          ui.setHostStatus('Rakip bağlandı...');
          // Compare against this connection's own waiter: after leaving and
          // re-hosting, a stale timer must not start a match on a dead link.
          const waiter = (msg) => { if (msg.t === 'hello') begin(validChar(msg.char)); };
          const begin = (char) => {
            if (awaitingHello !== waiter) return;
            awaitingHello = null;
            clearTimeout(timer);
            pendingRoom = null;
            startHost(link, room, [myChar, char]);
          };
          awaitingHello = waiter;
          const timer = setTimeout(() => begin(otherChar(myChar)), HELLO_TIMEOUT_MS);
        },
        (text) => { pendingRoom = null; ui.setHostStatus(text); },
      ),
      onCode: (code) => {
        ui.setRoomCode(code);
        ui.setHostStatus('Rakip bekleniyor... Kodu arkadaşına gönder.');
      },
    });
    pendingRoom = room;
  } catch (err) {
    ui.setHostStatus(err.message);
  }
}

function connectToRoom() {
  if (pendingRoom) return;
  const code = ui.getJoinCode();
  if (!isValidCode(code)) {
    ui.setJoinStatus('Geçerli bir oda kodu gir (4-6 rakam).');
    return;
  }
  ui.setJoinStatus('Bağlanıyor...');
  try {
    const room = joinRoom(code, netHandlers(
      (link) => {
        pendingRoom = null;
        link.send({ t: 'hello', char: myChar });
        startClient(link, room);
      },
      (text) => { pendingRoom = null; ui.setJoinStatus(text); },
    ));
    pendingRoom = room;
  } catch (err) {
    ui.setJoinStatus(err.message);
  }
}

function enterFight() {
  hud.reset();
  ui.setMenuStatus('');
  ui.setNetStatus('');
  ui.showScreen(null);
}

function openJoinLobby() {
  ui.setJoinStatus('');
  ui.showScreen('lobby-join');
  document.getElementById('join-code').focus();
}

/** Local player's input; neutral while the pause menu is open (online play keeps running). */
function playerInput() {
  const input = keyboard.sample();
  return paused ? { ...EMPTY_INPUT } : input;
}

function pause() {
  if (!session || paused || hud.last.phase === 'over') return;
  paused = true;
  ui.showPause(session.pausable ? '' : 'Online maç durdurulamaz, oyun arka planda sürüyor.');
}

function resume() {
  if (!paused) return;
  paused = false;
  keyboard.sample(); // drop presses made while the menu was open
  ui.showScreen(null);
}

function leaveToMenu(message = '') {
  paused = false;
  pendingMode = null;
  awaitingHello = null;
  pendingRoom?.cancel();
  pendingRoom = null;
  session?.dispose?.();
  session = null;
  ui.setNetStatus('');
  ui.announce('', 1);
  ui.setMenuStatus(message);
  ui.showScreen('menu');
}

// ---------------------------------------------------------------------------
// HUD sync (only touches the DOM when a value actually changes)
// ---------------------------------------------------------------------------
const hud = {
  last: {},
  reset() { this.last = {}; },
  set(key, value, apply) {
    if (this.last[key] === value) return;
    this.last[key] = value;
    apply(value);
  },
  sync(state) {
    const [a, b] = state.fighters;
    this.set('names', state.names.join('|'), () => ui.setNames(state.names[0], state.names[1]));
    this.set('hp0', a.hp, (v) => ui.setHealth(0, v, MATCH.maxHp));
    this.set('hp1', b.hp, (v) => ui.setHealth(1, v, MATCH.maxHp));
    this.set('round', state.round, ui.setRound);
    this.set('timer', Math.ceil(state.timer), ui.setTimer);
    this.set('wins0', state.wins[0], (v) => ui.setWins(0, v));
    this.set('wins1', state.wins[1], (v) => ui.setWins(1, v));
    this.set('phase', state.phase, (phase) => {
      if (phase === 'over') {
        paused = false;
        const name = state.names[state.winner];
        const score = `${state.wins[0]} - ${state.wins[1]}`;
        const canRematch = !!session?.canRematch;
        ui.showResult(`${name} KAZANDI`, canRematch ? score : `${score} · Rövanşı host başlatabilir`, canRematch);
      } else if (!paused) {
        ui.showScreen(null);
      }
    });
  },
};

/**
 * Turn simulation events into sound, effects and HUD feedback. On the client
 * these come from the network, so every field is treated as untrusted.
 */
function handleEvents(events) {
  const num = (v) => (Number.isFinite(v) ? v : 0);
  for (const e of events) {
    if (e.type === 'announce') {
      const text = String(e.text ?? '').slice(0, 32);
      ui.announce(text, Math.min(num(e.ms) || 1200, 5000));
      if (text.startsWith('ROUND')) sound.play('round');
      else if (text === 'FIGHT!') sound.play('fight');
    } else if (e.type === 'hit') {
      sound.play(e.blocked ? 'block' : e.heavy ? 'heavy' : 'hit');
      effects.spark(num(e.x), num(e.y), { blocked: !!e.blocked, heavy: !!e.heavy });
      if (!e.blocked) views[e.target]?.flash();
      stage.shake(e.blocked ? 0.06 : e.heavy ? 0.28 : 0.14);
    } else if (e.type === 'combo') {
      if (e.attacker === 0 || e.attacker === 1) ui.showCombo(e.attacker, Number(e.count) | 0);
    } else if (e.type === 'fireball') {
      sound.play('fireball');
    } else if (e.type === 'ko') {
      sound.play('ko');
      stage.shake(0.5);
    } else if (e.type === 'over') {
      sound.play('victory');
    }
  }
}

// ---------------------------------------------------------------------------
// Menu wiring
// ---------------------------------------------------------------------------
ui.bindActions({
  solo: () => openSelect('solo'),
  host: () => openSelect('host'),
  join: () => openSelect('join'),
  pick: pickCharacter,
  connect: connectToRoom,
  pause,
  resume,
  rematch: () => {
    if (!session?.rematch) return;
    paused = false;
    session.rematch();
    hud.reset();
    ui.showScreen(null);
  },
  back: () => leaveToMenu(),
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (session) (paused ? resume() : pause());
    else if (pendingRoom || pendingMode) leaveToMenu();
  }
  if (e.code === 'KeyM' && !e.target.matches?.('input')) {
    const text = sound.toggleMute() ? 'SES KAPALI' : 'SES AÇIK';
    if (session) ui.announce(text, 800);
    else ui.setMenuStatus(text);
  }
});
// Switching tabs mid-fight pauses solo play instead of letting the bot win.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && session?.pausable) pause();
});
// Audio may only start after a user gesture.
window.addEventListener('pointerdown', sound.unlock);
window.addEventListener('keydown', sound.unlock);
document.getElementById('join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectToRoom();
});

const darken = (hex, k) =>
  (Math.round(((hex >> 16) & 255) * k) << 16) | (Math.round(((hex >> 8) & 255) * k) << 8) | Math.round((hex & 255) * k);

let shownChars = '';
function applyCharacterColors(chars) {
  const key = chars.join(',');
  if (key === shownChars) return;
  shownChars = key;
  const mirror = chars[0] === chars[1];
  chars.forEach((c, i) => {
    let color = (CHARACTERS[c] || CHARACTERS[0]).color;
    // Mirror match: darken player 2 so the fighters stay distinguishable.
    if (mirror && i === 1) color = darken(color, 0.5);
    views[i].setColor(color);
    effects.setProjectileColor(i, color);
  });
}

ui.renderCharacters(CHARACTERS);

// ---------------------------------------------------------------------------
// Main loop: requestAnimationFrame with clamped delta time so a background
// tab returning to focus does not produce one giant simulation burst.
// ---------------------------------------------------------------------------
let last = performance.now();

function frame(now) {
  // Schedule first: an exception below must not kill the game loop.
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  // Gamepad is polled every frame, even while paused, so Start can resume.
  if (keyboard.poll() && session) (paused ? resume() : pause());

  if (session && !(paused && session.pausable)) {
    const { state, events, positions } = session.update(dt);
    if (state) {
      applyCharacterColors(state.chars || [0, 1]);
      state.fighters.forEach((f, i) => views[i].update(f, dt, positions[i].x, positions[i].y));
      stage.updateCamera(dt, positions[0].x, positions[1].x);
      effects.syncProjectiles(state.projectiles || [], dt);
      hud.sync(state);
      handleEvents(events);
    }
  } else if (!session) {
    applyCharacterColors([0, 1]);
    effects.syncProjectiles([], dt);
    // Attract mode: idle fighters and a slow camera sway behind the menu.
    menuFighters.forEach((f, i) => views[i].update(f, dt, f.x, f.y));
    const sway = Math.sin(now / 1000 * 0.3) * 3;
    stage.updateCamera(dt, sway - 1.6, sway + 1.6);
  }

  effects.update(dt);
  stage.render();
}
requestAnimationFrame(frame);
