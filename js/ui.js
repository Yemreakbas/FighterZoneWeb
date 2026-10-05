// DOM overlay helpers: screen switching, HUD updates, announcer.

const $ = (id) => document.getElementById(id);

const SCREENS = ['menu', 'select', 'lobby-host', 'lobby-join', 'result', 'pause', 'help'];

// Help opened from the pause menu keeps the HUD visible underneath.
let helpOverFight = false;
export function setHelpOverFight(v) { helpOverFight = v; }

/** Show one overlay screen, or `null` for the bare in-fight HUD. */
export function showScreen(name) {
  for (const id of SCREENS) $(id).classList.toggle('hidden', id !== name);
  // Result, pause and help are drawn over the HUD so the fight stays visible.
  const overFight = name === null || name === 'result' || name === 'pause' || (name === 'help' && helpOverFight);
  $('hud').classList.toggle('hidden', !overFight);
}

export function showResult(title, detail, canRematch) {
  $('result-title').textContent = title;
  $('result-detail').textContent = detail;
  $('rematch-btn').classList.toggle('hidden', !canRematch);
  showScreen('result');
}

export function showPause(note) {
  $('pause-note').textContent = note;
  showScreen('pause');
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

export function setRound(n) { $('round-label').textContent = n === 0 ? 'ANTRENMAN' : `ROUND ${n}`; }
export function setTimer(seconds) { $('timer').textContent = seconds === null ? '--' : String(Math.ceil(seconds)); }

let announceTimeout = 0;
/** `style` 'blood' renders the MK-style red variant (FINISH HIM, FATALITY). */
export function announce(text, ms = 1200, style = '') {
  const el = $('announcer');
  el.textContent = text;
  el.classList.toggle('blood', style === 'blood');
  el.classList.add('show');
  clearTimeout(announceTimeout);
  if (ms > 0) announceTimeout = setTimeout(() => el.classList.remove('show'), ms);
}

let hintTimeout = 0;
export function showHint(text, ms) {
  const el = $('hint');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(hintTimeout);
  hintTimeout = setTimeout(() => el.classList.remove('show'), ms);
}

const comboTimeouts = [0, 0];
export function showCombo(side, count) {
  const el = $(`combo-${side}`);
  el.innerHTML = `<b>${count}</b> HIT<br>COMBO`;
  el.classList.remove('show');
  void el.offsetWidth; // restart the pop-in transition
  el.classList.add('show');
  clearTimeout(comboTimeouts[side]);
  comboTimeouts[side] = setTimeout(() => el.classList.remove('show'), 1100);
}

/**
 * Build the character cards. Stats are shown relative to the strongest
 * value of each stat across the roster.
 */
export function renderCharacters(characters) {
  const max = (key) => Math.max(...characters.map((c) => c[key]));
  const stat = (label, value, top) =>
    `<div class="stat"><span>${label}</span><div class="bar"><i style="width:${Math.round((value / top) * 100)}%"></i></div></div>`;
  $('char-grid').innerHTML = characters.map((c, i) => `
    <button class="char-card" data-action="pick" data-char="${i}" style="--char-color:#${c.color.toString(16).padStart(6, '0')}">
      <span class="name">${c.name}</span>
      <span class="desc">${c.desc}</span>
      ${stat('HIZ', c.speed, max('speed'))}
      ${stat('GÜÇ', c.power, max('power'))}
      ${stat('TOP', c.projectileSpeed, max('projectileSpeed'))}
    </button>`).join('');
}

/** Show the difficulty picker (solo only) and highlight the chosen level. */
export function setDifficulty(level, visible) {
  $('difficulty').classList.toggle('hidden', !visible);
  for (const btn of $('difficulty').querySelectorAll('.seg')) {
    const on = Number(btn.dataset.level) === level;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

/** Show the training dummy picker and highlight the chosen behaviour. */
export function setDummy(mode, visible) {
  $('dummy').classList.toggle('hidden', !visible);
  for (const btn of $('dummy').querySelectorAll('.seg')) {
    const on = btn.dataset.mode === mode;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

/** Training HUD line under the dummy's health bar; `null` hides it. */
export function setTrainingInfo(text) {
  $('train-info').classList.toggle('hidden', text === null);
  $('train-info').textContent = text ?? '';
}

/** Routes `data-action` button clicks to a handler map (handler gets the button). */
export function bindActions(handlers) {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    handlers[btn.dataset.action]?.(btn);
  });
}
