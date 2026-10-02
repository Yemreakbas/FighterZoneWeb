// DOM overlay helpers: screen switching, HUD updates, announcer.

const $ = (id) => document.getElementById(id);

const SCREENS = ['menu', 'lobby-host', 'lobby-join'];

export function showScreen(name) {
  for (const id of SCREENS) $(id).classList.toggle('hidden', id !== name);
  $('hud').classList.toggle('hidden', name !== null);
}

export function setRoomCode(code) { $('room-code').textContent = code; }
export function setHostStatus(text) { $('host-status').textContent = text; }
export function setJoinStatus(text) { $('join-status').textContent = text; }
export function getJoinCode() { return $('join-code').value.trim(); }

export function setNames(p1, p2) {
  $('p1-name').textContent = p1;
  $('p2-name').textContent = p2;
}

export function setHealth(index, hp, maxHp) {
  const el = $(index === 0 ? 'p1-health' : 'p2-health');
  const pct = Math.max(0, Math.min(1, hp / maxHp)) * 100;
  el.style.width = `${pct}%`;
  el.classList.toggle('low', pct <= 25);
}

export function setRound(n) { $('round-label').textContent = `ROUND ${n}`; }
export function setTimer(seconds) { $('timer').textContent = String(Math.ceil(seconds)); }

let announceTimeout = 0;
export function announce(text, ms = 1200) {
  const el = $('announcer');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(announceTimeout);
  if (ms > 0) announceTimeout = setTimeout(() => el.classList.remove('show'), ms);
}

/** Routes `data-action` button clicks to a handler map. */
export function bindActions(handlers) {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    handlers[btn.dataset.action]?.();
  });
}
