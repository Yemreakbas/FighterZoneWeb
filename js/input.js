// Keyboard, touch buttons and gamepad -> abstract fighter input.
// Held keys (movement, crouch, block) are level-triggered; jump/punch/kick are
// edge-triggered and latched until the next `sample()` so a quick tap between
// two simulation ticks is never lost.

const HELD = {
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  KeyS: 'down', ArrowDown: 'down',
  KeyL: 'block',
};
const PRESS = {
  KeyW: 'jump', ArrowUp: 'jump', Space: 'jump',
  KeyJ: 'punch',
  KeyK: 'kick',
  KeyU: 'special',
};

export function createKeyboard() {
  const held = { left: false, right: false, down: false, block: false };
  // `drop` is a touch-only shortcut for down + jump (double-tap ▼).
  const pressed = { jump: false, punch: false, kick: false, special: false, drop: false };

  const isTyping = (e) => e.target instanceof HTMLElement && e.target.matches('input, textarea');

  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    if (HELD[e.code]) held[HELD[e.code]] = true;
    if (PRESS[e.code] && !e.repeat) pressed[PRESS[e.code]] = true;
    if (HELD[e.code] || PRESS[e.code]) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (HELD[e.code]) held[HELD[e.code]] = false;
  });
  // Alt-tabbing away while holding a key never fires keyup.
  window.addEventListener('blur', () => {
    for (const k in held) held[k] = false;
  });

  const touchHeld = bindTouch(pressed);
  const pad = createGamepadReader(pressed);

  return {
    /**
     * Read the gamepad. Called every animation frame (also while paused, so
     * Start can resume). Returns true when Start was just pressed.
     */
    poll: () => pad.poll(),
    /** Snapshot of the current input; clears the edge-triggered presses. */
    sample() {
      const { drop, ...out } = pressed;
      for (const k in held) out[k] = held[k] || touchHeld[k] > 0 || pad.held[k];
      // One thumb can't hold ▼ and tap ▲, so a double-tap on ▼ drops
      // through a platform (down + jump).
      if (drop) out.down = out.jump = true;
      pressed.jump = pressed.punch = pressed.kick = pressed.special = pressed.drop = false;
      return out;
    },
  };
}

// Standard Gamepad mapping (Xbox layout names; PlayStation in brackets).
const PAD_PRESS = { 2: 'punch', 0: 'kick', 1: 'special' }; // X [□], A [✕], B [○]
const PAD_BLOCK = [4, 5, 7];                                // LB, RB, RT
const PAD = { up: 12, down: 13, left: 14, right: 15, start: 9 };
const STICK_DEADZONE = 0.5;

/**
 * Polls the first connected gamepad. Buttons are turned into the same
 * held/pressed signals as the keyboard; presses are edge-detected against
 * the previous poll so holding a button attacks only once.
 */
function createGamepadReader(pressed) {
  const held = { left: false, right: false, down: false, block: false };
  let prev = {};

  function poll() {
    const gp = navigator.getGamepads?.().find((g) => g && g.connected);
    if (!gp) {
      for (const k in held) held[k] = false;
      prev = {};
      return false;
    }
    const btn = (i) => !!gp.buttons[i]?.pressed;
    const [ax = 0, ay = 0] = gp.axes;
    const now = {
      up: btn(PAD.up) || ay < -STICK_DEADZONE,
      start: btn(PAD.start),
    };
    for (const i in PAD_PRESS) now[`b${i}`] = btn(i);
    const edge = (key) => now[key] && !prev[key];

    held.left = btn(PAD.left) || ax < -STICK_DEADZONE;
    held.right = btn(PAD.right) || ax > STICK_DEADZONE;
    held.down = btn(PAD.down) || ay > STICK_DEADZONE;
    held.block = PAD_BLOCK.some(btn);

    if (edge('up')) pressed.jump = true;
    for (const [i, action] of Object.entries(PAD_PRESS)) if (edge(`b${i}`)) pressed[action] = true;

    const startPressed = edge('start');
    prev = now;
    return startPressed;
  }

  return { held, poll };
}

/**
 * On-screen buttons: `data-hold` buttons act like held keys, `data-press`
 * buttons like a key tap. Each pointer remembers which button it holds so
 * multi-touch (walk + block, etc.) works and a lifted finger always
 * releases exactly what it pressed. Returns per-key hold counts.
 */
function bindTouch(pressed) {
  const counts = { left: 0, right: 0, down: 0, block: 0 };
  const byPointer = new Map(); // pointerId -> button element
  const DOUBLE_TAP_MS = 300;
  let lastDownTap = -Infinity;

  const release = (e) => {
    const btn = byPointer.get(e.pointerId);
    if (!btn) return;
    byPointer.delete(e.pointerId);
    if (btn.dataset.hold) counts[btn.dataset.hold] = Math.max(0, counts[btn.dataset.hold] - 1);
    if (![...byPointer.values()].includes(btn)) btn.classList.remove('on');
  };

  for (const btn of document.querySelectorAll('[data-hold], [data-press]')) {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (byPointer.has(e.pointerId)) return; // duplicate down for the same finger
      byPointer.set(e.pointerId, btn);
      btn.classList.add('on');
      if (btn.dataset.hold) counts[btn.dataset.hold]++;
      if (btn.dataset.press) pressed[btn.dataset.press] = true;
      if (btn.dataset.hold === 'down') {
        if (e.timeStamp - lastDownTap < DOUBLE_TAP_MS) pressed.drop = true;
        lastDownTap = e.timeStamp;
      }
      // Capture keeps the release on this button even if the finger slides
      // off. It throws for unknown/inactive pointers, which must not undo
      // the press above.
      try { btn.setPointerCapture(e.pointerId); } catch { /* release still arrives via pointerup */ }
    });
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  // Backstop: a finger lifted anywhere releases whatever it was holding.
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  return counts;
}
