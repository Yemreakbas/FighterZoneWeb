// DOM overlay helpers: screen switching, HUD updates, announcer.

const $ = (id) => document.getElementById(id);

const SCREENS = ['menu', 'lobby-host', 'lobby-join', 'result'];

/** Show one overlay screen, or `null` for the bare in-fight HUD. */
export function showScreen(name) {
  for (const id of SCREENS) $(id).classList.toggle('hidden', id !== name);
  // The result screen is drawn over the HUD so the final health stays visible.
  $('hud').classList.toggle('hidden', name !== null && name !== 'result');
}

export function showResult(title, detail, canRematch) {
  $('result-title').textContent = title;
  $('result-detail').textContent = detail;
  $('rematch-btn').classList.toggle('hidden', !canRematch);
  showScreen('result');
}

export function setWins(index, wins) {
  const pips = $(index === 0 ? 'p1-wins' : 'p2-wins').children;
  for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('on', i < wins);
}

export function setNetStatus(text, warn = false) {
  const el = $('net-status');
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

export function setMenuStatus(text) { $('menu-status').textContent = text; }
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
