import { createStage } from './scene.js';
import { MATCH, NET, TICK } from './config.js';
import { createMatch } from './game.js';
import { createFighter } from './fighter.js';
import { createBot } from './bot.js';
import { createKeyboard } from './input.js';
import { createFighterView } from './fighterView.js';
import { createEffects } from './effects.js';
import { hostRoom, isValidCode, joinRoom } from './network.js';
import { createInterpolator, encodeSnapshot } from './netsync.js';
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

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Runs the authoritative simulation locally at a fixed tick. Used for solo
 * play (and by the P2P host). Rendering interpolates between the last two
 * ticks so motion stays smooth on high refresh-rate displays.
 */
function createLocalSession(names, gatherInputs, onTick) {
  let match = createMatch(names);
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
      match = createMatch(names);
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

function startSolo() {
  const bot = createBot(1);
  session = createLocalSession(
    ['OYUNCU', 'BOT'],
    (state) => [keyboard.sample(), bot.think(state, TICK)],
  );
  enterFight();
}

// ---- P2P host: authoritative simulation + snapshot broadcast -------------

const HELD_KEYS = ['left', 'right', 'down', 'block'];
const PRESS_MAP = { JUMP: 'jump', PUNCH: 'punch', KICK: 'kick', SPECIAL: 'special' };

function startHost(link, room) {
  const remote = {
    held: { left: false, right: false, down: false, block: false },
    pressed: { jump: false, punch: false, kick: false, special: false },
  };
  const takeRemote = () => {
    const out = { ...remote.held, ...remote.pressed };
    for (const k in remote.pressed) remote.pressed[k] = false;
    return out;
  };

  // Tick counter survives rematches so client-side time stays monotonic.
  let tick = 0;
  let outbox = [];
  const local = createLocalSession(
    ['OYUNCU 1', 'OYUNCU 2'],
    () => [keyboard.sample(), takeRemote()],
    (state, events) => {
      tick++;
      outbox.push(...events);
      if (tick % NET.snapshotEvery === 0) {
        link.send(encodeSnapshot(state, tick, outbox));
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
    // The client is untrusted: only whitelisted input fields are accepted.
    onData(msg) {
      if (msg.t === 'held' && msg.keys && typeof msg.keys === 'object') {
        for (const k of HELD_KEYS) remote.held[k] = msg.keys[k] === true;
      } else if (typeof msg.input === 'string' && PRESS_MAP[msg.input]) {
        remote.pressed[PRESS_MAP[msg.input]] = true;
      }
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
  let lastHeld = '';

  session = {
    canRematch: false,
    update() {
      const input = keyboard.sample();
      const held = { left: input.left, right: input.right, down: input.down, block: input.block };
      const heldKey = HELD_KEYS.map((k) => (held[k] ? 1 : 0)).join('');
      if (heldKey !== lastHeld) {
        link.send({ t: 'held', keys: held });
        lastHeld = heldKey;
      }
      for (const [name, key] of Object.entries(PRESS_MAP)) {
        if (input[key]) link.send({ input: name });
      }

      const frameState = interp.sample();
      if (!frameState) {
        ui.setNetStatus('Host bekleniyor...', true);
        return { state: null };
      }
      ui.setNetStatus(
        frameState.stale ? 'Bağlantı yavaş...' : `Ping: ${Math.round(link.rtt)} ms`,
        frameState.stale,
      );
      return frameState;
    },
    onData(msg) {
      if (msg.t === 's') interp.push(msg);
    },
    dispose: () => room.cancel(),
  };
  enterFight();
}

// ---- Lobby ----------------------------------------------------------------

/** Pending hostRoom/joinRoom handle while in a lobby screen. */
let pendingRoom = null;

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
    onData: (msg) => session?.onData?.(msg),
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
        (link) => { pendingRoom = null; startHost(link, room); },
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
      (link) => { pendingRoom = null; startClient(link, room); },
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

function leaveToMenu(message = '') {
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
        const name = state.names[state.winner];
        const score = `${state.wins[0]} - ${state.wins[1]}`;
        const canRematch = !!session?.canRematch;
        ui.showResult(`${name} KAZANDI`, canRematch ? score : `${score} · Rövanşı host başlatabilir`, canRematch);
      } else {
        ui.showScreen(null);
      }
    });
  },
};

function handleEvents(events) {
  for (const e of events) {
    if (e.type === 'announce') {
      ui.announce(e.text, e.ms);
      if (e.text.startsWith('ROUND')) sound.play('round');
      else if (e.text === 'FIGHT!') sound.play('fight');
    } else if (e.type === 'hit') {
      sound.play(e.blocked ? 'block' : e.heavy ? 'heavy' : 'hit');
      effects.spark(e.x, e.y, e);
      if (!e.blocked) views[e.target].flash();
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
  solo: startSolo,
  host: openHostLobby,
  join: () => {
    ui.setJoinStatus('');
    ui.showScreen('lobby-join');
    document.getElementById('join-code').focus();
  },
  connect: connectToRoom,
  rematch: () => {
    if (!session?.rematch) return;
    session.rematch();
    hud.reset();
    ui.showScreen(null);
  },
  back: () => leaveToMenu(),
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && (session || pendingRoom)) leaveToMenu();
  if (e.code === 'KeyM' && !e.target.matches?.('input')) {
    const text = sound.toggleMute() ? 'SES KAPALI' : 'SES AÇIK';
    if (session) ui.announce(text, 800);
    else ui.setMenuStatus(text);
  }
});
// Audio may only start after a user gesture.
window.addEventListener('pointerdown', sound.unlock);
window.addEventListener('keydown', sound.unlock);
document.getElementById('join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectToRoom();
});

// ---------------------------------------------------------------------------
// Main loop: requestAnimationFrame with clamped delta time so a background
// tab returning to focus does not produce one giant simulation burst.
// ---------------------------------------------------------------------------
let last = performance.now();

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (session) {
    const { state, events, positions } = session.update(dt);
    if (state) {
      state.fighters.forEach((f, i) => views[i].update(f, dt, positions[i].x, positions[i].y));
      stage.updateCamera(dt, positions[0].x, positions[1].x);
      effects.syncProjectiles(state.projectiles || [], dt);
      hud.sync(state);
      handleEvents(events);
    }
  } else {
    effects.syncProjectiles([], dt);
    // Attract mode: idle fighters and a slow camera sway behind the menu.
    menuFighters.forEach((f, i) => views[i].update(f, dt, f.x, f.y));
    const sway = Math.sin(now / 1000 * 0.3) * 3;
    stage.updateCamera(dt, sway - 1.6, sway + 1.6);
  }

  effects.update(dt);
  stage.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
