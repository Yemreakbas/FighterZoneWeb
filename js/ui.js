// DOM overlay helpers: screen switching, HUD updates, announcer.

const $ = (id) => document.getElementById(id);

const SCREENS = ['menu', 'select', 'lobby', 'lobby-join', 'result', 'pause', 'help'];

// Help opened from the pause menu keeps the HUD visible underneath.
let helpOverFight = false;
export function setHelpOverFight(v) { helpOverFight = v; }

/** Show one overlay screen, or `null` for the bare in-fight HUD. */
export function showScreen(name) {
  for (const id of SCREENS) $(id).classList.toggle('hidden', id !== name);
  // Result, pause and help are drawn over the HUD so the fight stays visible.
  const overFight = name === null || name === 'result' || name === 'pause' || (name === 'help' && helpOverFight);
  $('hud').classList.toggle('hidden', !overFight);
  // The bare fight (no menu on top) is the only landscape-only screen.
  document.body.classList.toggle('in-fight', name === null);
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

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Build the HUD rows: `fighters` is [{ name, team, local }] in fighter order.
 * Each team's column lists its members; team fights use compact rows.
 */
export function setupFighters(fighters) {
  const compact = fighters.length > 2;
  for (const team of [0, 1]) {
    $(`team-${team}`).innerHTML = fighters
      .map((f, i) => ({ ...f, i }))
      .filter((f) => f.team === team)
      .map((f) => `
        <div class="frow${compact ? ' compact' : ''}${f.local && compact ? ' me' : ''}" id="row-${f.i}">
          <span class="fighter-name">${escapeHtml(f.name)}${f.local && compact ? ' (SEN)' : ''}</span>
          <div class="health"><div class="health-fill" id="hp-${f.i}"></div></div>
          <div class="special" title="Özel hareket"><div class="special-fill" id="sp-${f.i}"></div></div>
        </div>`).join('');
  }
}

export function setHealth(index, hp, maxHp) {
  const el = $(`hp-${index}`);
  if (!el) return;
  const pct = Math.max(0, Math.min(1, hp / maxHp)) * 100;
  el.style.width = `${pct}%`;
  el.classList.toggle('low', pct <= 25);
  $(`row-${index}`)?.classList.toggle('down', hp <= 0);
}

/** The local player's charge also dims the on-screen ÖZEL button until ready. */
export function setTouchSpecial(charge) {
  const btn = document.querySelector('.tbtn.special');
  if (!btn) return;
  btn.style.setProperty('--charge', String(charge));
  btn.classList.toggle('charging', charge < 1);
}

/** Special-move charge, 0 (just used) to 1 (ready). */
export function setSpecial(index, charge) {
  const el = $(`sp-${index}`);
  if (!el) return;
  el.style.width = `${Math.round(charge * 100)}%`;
  el.classList.toggle('ready', charge >= 1);
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
      ${c.special ? `<span class="special-name">${escapeHtml(c.special.name)}</span>` : ''}
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

/**
 * Draw the room lobby. `lobby` is { size, players: [{ id, name, char, team }] },
 * `you` our player id, `isHost` shows the host controls. Team columns show
 * free slots; in 2v2 those are filled by bots when the match starts.
 */
export function renderLobby(lobby, you, isHost, characters) {
  const cap = lobby.size / 2;
  const chip = (p) => {
    const c = characters[p.char] || characters[0];
    const tags = [p.id === 0 ? 'HOST' : '', p.id === you ? 'SEN' : ''].filter(Boolean).join(' · ');
    return `<div class="chip${p.id === you ? ' me' : ''}" style="--char-color:#${c.color.toString(16).padStart(6, '0')}">
      <b>${escapeHtml(p.name)}</b><span>${escapeHtml(c.name)}${tags ? ` · ${tags}` : ''}</span></div>`;
  };
  const free = (n) => Array.from({ length: n }, () =>
    `<div class="chip empty">${lobby.size === 4 ? 'BOŞ · BOT GELİR' : 'BOŞ'}</div>`).join('');
  for (const team of [0, 1]) {
    const members = lobby.players.filter((p) => p.team === team);
    $(`slots-${team}`).innerHTML = members.map(chip).join('') + free(Math.max(0, cap - members.length));
  }
  $('slots-mid').innerHTML = lobby.players.filter((p) => p.team !== 0 && p.team !== 1).map(chip).join('')
    || '<div class="chip empty">—</div>';
  $('lobby').classList.toggle('is-host', isHost);
  for (const btn of $('lobby-mode').querySelectorAll('.seg')) {
    const on = Number(btn.dataset.size) === lobby.size;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.disabled = !isHost;
  }
}

/** Routes `data-action` button clicks to a handler map (handler gets the button). */
export function bindActions(handlers) {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    handlers[btn.dataset.action]?.(btn);
  });
}
