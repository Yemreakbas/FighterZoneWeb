import { createStage } from './scene.js';
import { MATCH } from './config.js';
import * as ui from './ui.js';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const stage = createStage(document.getElementById('game-container'));

const app = {
  mode: 'menu', // 'menu' | 'solo' | 'host' | 'client'
};

// ---------------------------------------------------------------------------
// Menu wiring (game modes are implemented in upcoming modules)
// ---------------------------------------------------------------------------
ui.bindActions({
  solo: () => {
    app.mode = 'solo';
    ui.setNames('OYUNCU', 'BOT');
    ui.setHealth(0, MATCH.maxHp, MATCH.maxHp);
    ui.setHealth(1, MATCH.maxHp, MATCH.maxHp);
    ui.setRound(1);
    ui.setTimer(MATCH.roundTime);
    ui.showScreen(null);
    ui.announce('FIGHT!');
  },
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
  back: () => {
    app.mode = 'menu';
    ui.showScreen('menu');
  },
});

// ---------------------------------------------------------------------------
// Main loop: requestAnimationFrame with clamped delta time so a background
// tab returning to focus does not produce one giant simulation step.
// ---------------------------------------------------------------------------
let last = performance.now();
let idleT = 0;

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (app.mode === 'menu') {
    // Slow attract-mode camera sway behind the menu.
    idleT += dt;
    const sway = Math.sin(idleT * 0.3) * 3;
    stage.updateCamera(dt, sway, sway);
  } else {
    stage.updateCamera(dt, -2.5, 2.5);
  }

  stage.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
