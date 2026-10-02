// Keyboard -> abstract fighter input.
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
};

export function createKeyboard() {
  const held = { left: false, right: false, down: false, block: false };
  const pressed = { jump: false, punch: false, kick: false };

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

  return {
    /** Snapshot of the current input; clears the edge-triggered presses. */
    sample() {
      const out = { ...held, ...pressed };
      pressed.jump = pressed.punch = pressed.kick = false;
      return out;
    },
  };
}
