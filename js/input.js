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

  const touchHeld = bindTouch(pressed);

  return {
    /** Snapshot of the current input; clears the edge-triggered presses. */
    sample() {
      const out = { ...pressed };
      for (const k in held) out[k] = held[k] || touchHeld[k] > 0;
      pressed.jump = pressed.punch = pressed.kick = false;
      return out;
    },
  };
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
