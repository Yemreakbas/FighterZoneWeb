import { createStage } from './scene.js';
import { MATCH, TICK } from './config.js';
import { createMatch } from './game.js';
import { createFighter } from './fighter.js';
import { createBot } from './bot.js';
import { createKeyboard } from './input.js';
import { createFighterView } from './fighterView.js';
import { createEffects } from './effects.js';
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

  return {
    canRematch: true,
    update(dt) {
      acc += dt;
      const events = [];
      while (acc >= TICK) {
        prev = snapshotPositions(match.state);
        match.step(gatherInputs(match.state), TICK);
        const tickEvents = match.drainEvents();
        events.push(...tickEvents);
        onTick?.(match.state, tickEvents);
        acc -= TICK;
      }
      const alpha = acc / TICK;
      const positions = match.state.fighters.map((f, i) => {
        const p = prev[i];
        // A new round replaces the fighter objects; never lerp across that.
        if (p.ref !== f) return { x: f.x, y: f.y };
        return { x: p.x + (f.x - p.x) * alpha, y: p.y + (f.y - p.y) * alpha };
      });
      return { state: match.state, events, positions };
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

function startSolo() {
  const bot = createBot(1);
  session = createLocalSession(
    ['OYUNCU', 'BOT'],
    (state) => [keyboard.sample(), bot.think(state, TICK)],
  );
  enterFight();
}

function enterFight() {
  hud.reset();
  ui.setMenuStatus('');
  ui.setNetStatus('');
  ui.showScreen(null);
}

function leaveToMenu(message = '') {
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
        ui.showResult(`${name} KAZANDI`, `${state.wins[0]} - ${state.wins[1]}`, !!session?.canRematch);
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
    } else if (e.type === 'hit') {
      effects.spark(e.x, e.y, e);
      if (!e.blocked) views[e.target].flash();
      stage.shake(e.blocked ? 0.06 : e.heavy ? 0.28 : 0.14);
    } else if (e.type === 'ko') {
      stage.shake(0.5);
    }
  }
}

// ---------------------------------------------------------------------------
// Menu wiring
// ---------------------------------------------------------------------------
ui.bindActions({
  solo: startSolo,
  host: () => {
    ui.setRoomCode('----');
    ui.setHostStatus('Yakında: P2P bağlantısı');
    ui.showScreen('lobby-host');
  },
  join: () => {
    ui.setJoinStatus('');
    ui.showScreen('lobby-join');
  },
  connect: () => ui.setJoinStatus('Yakında: P2P bağlantısı'),
  rematch: () => {
    if (!session?.rematch) return;
    session.rematch();
    hud.reset();
    ui.showScreen(null);
  },
  back: () => leaveToMenu(),
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && session) leaveToMenu();
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
      hud.sync(state);
      handleEvents(events);
    }
  } else {
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
