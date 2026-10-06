import { createStage } from './scene.js';
import { ARENAS, ATTACKS, BOT_DIFFICULTIES, CHARACTERS, DEFAULT_DIFFICULTY, MATCH, NET, TICK } from './config.js';
import { TEAM_NAMES, createMatch, defaultTeams } from './game.js';
import { EMPTY_INPUT, createFighter } from './fighter.js';
import { createBot } from './bot.js';
import { createArcade } from './arcade.js';
import { createKeyboard } from './input.js';
import { createFighterView } from './fighterView.js';
import { createEffects } from './effects.js';
import { hostRoom, isValidCode, joinRoom } from './network.js';
import { createInputQueue, createInterpolator, decodeAuthority, encodeInput, encodeSnapshot } from './netsync.js';
import { createPredictor } from './prediction.js';
import * as sound from './sound.js';
import * as ui from './ui.js';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const MAX_FIGHTERS = 4;
const stage = createStage(document.getElementById('game-container'));
const views = Array.from({ length: MAX_FIGHTERS }, (_, i) => createFighterView(stage.scene, CHARACTERS[i % CHARACTERS.length].color));
const effects = createEffects(stage.scene);
const keyboard = createKeyboard();

// Idle fighters posing behind the menu.
const menuFighters = [createFighter(-1.6, 1), createFighter(1.6, -1)];

/**
 * The active game session, or null while in menus. A session exposes
 * `update(dt)` returning `{ state, events, positions }` for rendering (and
 * optionally blended `projectiles` and platform `clock`), plus
 * optional `rematch()` / `dispose()`, a `canRematch` flag and `localIndex`
 * (the fighter this player controls).
 */
let session = null;

/**
 * Pause menu open. Only solo sessions (`pausable`) actually freeze; an
 * online match is host-authoritative and keeps running behind the menu.
 */
let paused = false;
let helpReturn = 'menu';

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Runs the authoritative simulation locally at a fixed tick. Used for solo
 * play (and by the P2P host). Rendering interpolates between the last two
 * ticks so motion stays smooth on high refresh-rate displays.
 * `matchOptions` may carry `names`, `teams` and `training`.
 */
function createLocalSession(chars, gatherInputs, onTick, matchOptions = {}) {
  const names = matchOptions.names ?? chars.map((c) => CHARACTERS[c].name);
  // Every match (and rematch) is fought in a random arena.
  const randomArena = () => Math.floor(Math.random() * ARENAS.length);
  let match = createMatch(names, chars, randomArena(), matchOptions);
  let acc = 0;
  let prev = snapshotMotion(match.state);
  let events = [];

  /** Run as many fixed ticks as `dt` covers. */
  function advance(dt) {
    acc += dt;
    while (acc >= TICK) {
      prev = snapshotMotion(match.state);
      match.step(gatherInputs(match.state), TICK);
      const tickEvents = match.drainEvents();
      events.push(...tickEvents);
      onTick?.(match.state, tickEvents);
      acc -= TICK;
    }
  }

  /** Render data: positions, animation time and projectiles blended between the last two ticks. */
  function view() {
    const alpha = acc / TICK;
    const positions = match.state.fighters.map((f, i) => {
      const p = prev.fighters[i];
      // A new round replaces the fighter objects; never lerp across that.
      if (!p || p.ref !== f) return { x: f.x, y: f.y, t: f.t };
      // A move that started this tick shows from its first frame.
      const t = p.action === f.action && p.t <= f.t ? p.t + (f.t - p.t) * alpha : f.t;
      return { x: p.x + (f.x - p.x) * alpha, y: p.y + (f.y - p.y) * alpha, t };
    });
    const projectiles = match.state.projectiles.map((p) => {
      const q = prev.shots.find((s) => s.ref === p);
      return q ? { ...p, x: q.x + (p.x - q.x) * alpha } : p;
    });
    const out = events;
    events = [];
    // Platform clock blended like positions (it advances one TICK per step).
    const clock = Math.max(0, match.state.clock - (1 - alpha) * TICK);
    return { state: match.state, events: out, positions, projectiles, clock };
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
      match = createMatch(names, chars, randomArena(), matchOptions);
      acc = 0;
      prev = snapshotMotion(match.state);
    },
  };
}

/** What rendering blends between ticks: fighter positions and move time, projectile X. */
function snapshotMotion(state) {
  return {
    fighters: state.fighters.map((f) => ({ ref: f, x: f.x, y: f.y, action: f.action, t: f.t })),
    shots: state.projectiles.map((p) => ({ ref: p, x: p.x })),
  };
}

/**
 * Calls `fn(dt)` every `ms` from a Web Worker timer. Browsers throttle
 * requestAnimationFrame (and main-thread timers) in background or unfocused
 * tabs, which would freeze the host's authoritative simulation for every
 * player; worker timers keep running. Falls back to setInterval.
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

// ---- Character select -----------------------------------------------------

/** Mode chosen in the menu, waiting for a character pick: 'solo' | 'team' | 'training' | 'host' | 'join'. */
let pendingMode = null;
let myChar = 0;

// Bot difficulty is remembered per browser; storage may be unavailable.
const DIFFICULTY_KEY = 'fighterzone.difficulty';
let difficulty = loadDifficulty();

function loadDifficulty() {
  try {
    const d = Number(localStorage.getItem(DIFFICULTY_KEY) ?? NaN);
    if (Number.isInteger(d) && d >= 0 && d < BOT_DIFFICULTIES.length) return d;
  } catch { /* private mode / blocked storage */ }
  return DEFAULT_DIFFICULTY;
}

function setDifficulty(btn) {
  const d = Number(btn?.dataset.level);
  if (!Number.isInteger(d) || d < 0 || d >= BOT_DIFFICULTIES.length) return;
  difficulty = d;
  ui.setDifficulty(difficulty, true);
  try { localStorage.setItem(DIFFICULTY_KEY, String(d)); } catch { /* not persisted */ }
}

const validChar = (c) => (Number.isInteger(c) && c >= 0 && c < CHARACTERS.length ? c : 0);
const otherChar = (c) => (c + 1 + Math.floor(Math.random() * (CHARACTERS.length - 1))) % CHARACTERS.length;
const randomChar = () => Math.floor(Math.random() * CHARACTERS.length);

function openSelect(mode) {
  pendingMode = mode;
  ui.setMenuStatus('');
  // Modes with bots (solo, 2v2, a host's empty seats) pick their difficulty.
  ui.setDifficulty(difficulty, mode === 'solo' || mode === 'team' || mode === 'host');
  ui.setDummy(dummyMode, mode === 'training');
  ui.showScreen('select');
  document.querySelector(`.char-card[data-char="${myChar}"]`)?.focus();
}

function pickCharacter(btn) {
  myChar = validChar(Number(btn?.dataset.char));
  const mode = pendingMode;
  pendingMode = null;
  if (mode === 'solo') startSolo();
  else if (mode === 'team') startTeamSolo();
  else if (mode === 'arcade') startArcade();
  else if (mode === 'training') startTraining();
  else if (mode === 'host') openHostLobby();
  else if (mode === 'join') openJoinLobby();
}

function startSolo() {
  const bot = createBot(1, difficulty);
  session = createLocalSession(
    [myChar, otherChar(myChar)],
    (state) => [keyboard.sample(), bot.think(state, TICK)],
  );
  session.pausable = true;
  session.localIndex = 0;
  enterFight();
}

/** 2v2 against bots: you and a bot teammate against two bots. */
function startTeamSolo() {
  const chars = [myChar, randomChar(), randomChar(), randomChar()];
  const bots = chars.map((_, i) => (i === 0 ? null : createBot(i, difficulty)));
  session = createLocalSession(
    chars,
    (state) => state.fighters.map((_, i) => (i === 0 ? keyboard.sample() : bots[i].think(state, TICK))),
    undefined,
    { teams: defaultTeams(4), names: chars.map((c, i) => (i === 0 ? CHARACTERS[c].name : `BOT ${CHARACTERS[c].name}`)) },
  );
  session.pausable = true;
  session.localIndex = 0;
  enterFight();
}

// ---- Arcade: beat the other fighters in a row, each one harder -----------
//
// Stage n is fought at difficulty n (KOLAY, NORMAL, ZOR). A loss retries the
// same stage; clearing them all makes you champion. The best run is kept.

const ARCADE_BEST_KEY = 'fighterzone.arcadeBest';
/** The running arcade (see arcade.js), or null. */
let arcade = null;

const arcadeLength = () => CHARACTERS.length - 1;

function loadArcadeBest() {
  try { return Math.max(0, Number(localStorage.getItem(ARCADE_BEST_KEY)) | 0); } catch { return 0; }
}

function startArcade() {
  arcade = createArcade(myChar, CHARACTERS, BOT_DIFFICULTIES, shuffle);
  startArcadeStage();
}

function startArcadeStage() {
  const { opponent, level } = arcade.current();
  const bot = createBot(1, level);
  session = createLocalSession(
    [myChar, opponent],
    (state) => [keyboard.sample(), bot.think(state, TICK)],
  );
  session.pausable = true;
  session.localIndex = 0;
  session.rematch = arcadeContinue;
  session.result = arcadeResult;
  enterFight();
  ui.showHint(`Aşama ${arcade.stage + 1}/${arcade.ladder.length} · Rakip: ${CHARACTERS[opponent].name} · ${BOT_DIFFICULTIES[level].name}`, 3000);
}

function arcadeResult(state) {
  const r = arcade.finish(state.winner === 0);
  if (r.cleared > loadArcadeBest()) {
    try { localStorage.setItem(ARCADE_BEST_KEY, String(r.cleared)); } catch { /* not persisted */ }
    ui.setArcadeBest(r.cleared, arcadeLength());
  }
  return r;
}

/** The result screen's button: next stage, retry, or a fresh run after winning it all. */
function arcadeContinue() {
  if (arcade.done) return startArcade();
  arcade.advance();
  startArcadeStage();
}

// ---- Training: endless round against a scripted dummy ---------------------

/** Training dummy behaviour: 'stand' | 'block' | 'lowblock' | 'crouch' | 'jump'. */
let dummyMode = 'stand';

function setDummy(btn) {
  if (!['stand', 'block', 'lowblock', 'crouch', 'jump'].includes(btn?.dataset.mode)) return;
  dummyMode = btn.dataset.mode;
  ui.setDummy(dummyMode, true);
}

function dummyInput(me) {
  const input = { ...EMPTY_INPUT };
  if (dummyMode === 'block') input.block = true;
  else if (dummyMode === 'lowblock') { input.block = true; input.down = true; }
  else if (dummyMode === 'crouch') input.down = true;
  else if (dummyMode === 'jump') input.jump = me.grounded && me.action !== 'hit';
  return input;
}

function startTraining() {
  session = createLocalSession(
    [myChar, otherChar(myChar)],
    (state) => [keyboard.sample(), dummyInput(state.fighters[1])],
    undefined,
    { training: true },
  );
  session.pausable = true;
  session.localIndex = 0;
  session.canRematch = false;
  enterFight();
}

// ---- P2P host: authoritative simulation + snapshot broadcast -------------

/**
 * `setup` is { chars, teams, names, hostIndex, clients: [{ index, link }] }.
 * Fighters that are neither the host nor a client are played by bots, and
 * a client who leaves mid-match is replaced by one.
 */
function startHost(room, setup) {
  // Client inputs arrive numbered, one per client tick, and are applied one
  // per host tick; the last applied number is echoed back for prediction.
  const remotes = new Map(setup.clients.map(({ index, link }) => [index, { link, queue: createInputQueue() }]));
  const bots = new Map();
  setup.chars.forEach((_, i) => {
    if (i !== setup.hostIndex && !remotes.has(i)) bots.set(i, createBot(i, difficulty));
  });

  const inputFor = (state, i) => {
    if (i === setup.hostIndex) return playerInput();
    const remote = remotes.get(i);
    if (remote) return remote.queue.take();
    return bots.get(i)?.think(state, TICK) ?? { ...EMPTY_INPUT };
  };

  // Tick counter survives rematches so client-side time stays monotonic.
  let tick = 0;
  let outbox = [];
  const local = createLocalSession(
    setup.chars,
    (state) => state.fighters.map((_, i) => inputFor(state, i)),
    (state, events) => {
      tick++;
      outbox.push(...events);
      if (tick % NET.snapshotEvery === 0) {
        // Each client gets its own packet: its fighter's full state and ack.
        for (const [i, r] of remotes) r.link.send(encodeSnapshot(state, tick, outbox, r.queue.ack, i));
        outbox = [];
      }
    },
    { teams: setup.teams, names: setup.names },
  );
  // Simulation is driven by the worker clock; rAF only renders (see createTicker).
  const ticker = createTicker(local.advance, 8);

  session = {
    canRematch: true,
    localIndex: setup.hostIndex,
    update() {
      const pings = [...remotes.values()].map((r) => Math.round(r.link.rtt));
      ui.setNetStatus(pings.length ? `Ping: ${pings.join(' / ')} ms` : '');
      return local.view();
    },
    rematch: local.rematch,
    // Clients are untrusted: the queue validates every packet.
    onData(link, msg) {
      if (msg.t !== 'in') return;
      for (const r of remotes.values()) if (r.link === link) r.queue.push(msg);
    },
    onLeave(link) {
      for (const [i, r] of remotes) {
        if (r.link !== link) continue;
        remotes.delete(i);
        bots.set(i, createBot(i, difficulty));
        ui.showHint(`${setup.names[i]} ayrıldı, yerine bot geçti`, 3000);
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

function startClient(link, room, index) {
  const interp = createInterpolator();
  const predictor = createPredictor();
  let acc = 0;

  session = {
    canRematch: false,
    localIndex: index,
    update(dt) {
      // Fixed-tick input: each tick is numbered, sent, and predicted locally
      // so our own fighter reacts without waiting for the host.
      acc += dt;
      while (acc >= TICK) {
        const input = playerInput();
        const seq = predictor.input(input);
        link.send({ t: 'in', s: seq, k: encodeInput(input) });
        acc -= TICK;
      }

      const frameState = interp.sample();
      if (!frameState) {
        ui.setNetStatus('Host bekleniyor...', true);
        return { state: null };
      }
      ui.setNetStatus(
        frameState.stale ? 'Bağlantı yavaş...' : `Ping: ${Math.round(link.rtt)} ms · Tampon: ${Math.round(interp.delay)} ms`,
        frameState.stale,
      );

      // Our fighter is drawn from the prediction, everyone else from the
      // interpolated host state.
      const predicted = predictor.view(dt);
      if (predicted && frameState.state.fighters[index]) {
        frameState.state.fighters[index] = predicted.fighter;
        frameState.positions[index] = { x: predicted.x, y: predicted.y };
      }
      return frameState;
    },
    onData(msg) {
      if (msg.t !== 's') return;
      interp.push(msg);
      const auth = decodeAuthority(msg);
      if (auth) predictor.reconcile(auth);
    },
    dispose: () => room.cancel(),
  };
  enterFight();
}

// ---- Room lobby -----------------------------------------------------------
//
// The host keeps the lobby: { size: 2 | 4, players: [{ id, name, char, team, link }] }.
// Player 0 is the host; clients get the lowest free id. Everyone starts in
// the middle (team -1) and picks a side; whoever is still in the middle when
// the host starts is placed at random, and empty 2v2 seats get bots.
//
// Messages: client -> host { t: 'hello', char } and { t: 'team', team };
// host -> client { t: 'lobby', size, you, players } and { t: 'start', index }.

/** Pending hostRoom/joinRoom handle while in a lobby screen. */
let pendingRoom = null;
/** Host-side lobby, or null. */
let lobby = null;
/** Client-side: the link to the host while waiting in the lobby. */
let lobbyLink = null;

const MAX_CLIENTS = 3;

const CLOSE_TEXT = {
  left: 'Oyuncu oyundan ayrıldı.',
  closed: 'Bağlantı koptu.',
  error: 'Bağlantı hatası.',
  timeout: 'Bağlantı zaman aşımı: karşı taraf yanıt vermiyor.',
  full: 'Oda dolu ya da maç başlamış.',
};

const playerName = (id) => `P${id + 1}`;
const capacity = () => lobby.size / 2;
const teamCount = (team) => lobby.players.filter((p) => p.team === team).length;
const publicPlayers = () => lobby.players.map(({ id, name, char, team }) => ({ id, name, char, team }));

/** Show the current lobby on the host and send it to every client. */
function broadcastLobby() {
  if (!lobby) return;
  const players = publicPlayers();
  for (const p of lobby.players) p.link?.send({ t: 'lobby', size: lobby.size, you: p.id, players });
  ui.renderLobby({ size: lobby.size, players }, 0, true, CHARACTERS);
  const n = lobby.players.length;
  ui.setHostStatus(n === 1 ? 'Oyuncu bekleniyor... Kodu arkadaşlarına gönder.' : `${n} oyuncu odada. Takımını seç, hazır olunca BAŞLAT.`);
}

function setTeam(player, team) {
  if (team !== 0 && team !== 1) team = -1;
  if (team !== -1 && player.team !== team && teamCount(team) >= capacity()) return false;
  player.team = team;
  return true;
}

function openHostLobby() {
  lobby = { size: 4, players: [{ id: 0, name: playerName(0), char: myChar, team: -1, link: null }] };
  ui.setRoomCode('----');
  ui.showScreen('lobby');
  broadcastLobby();
  ui.setHostStatus('Oda kuruluyor...');
  try {
    pendingRoom = hostRoom({
      onCode: (code) => {
        ui.setRoomCode(code);
        broadcastLobby();
      },
      onConnected(link) {
        if (!lobby) return link.close();
        const used = new Set(lobby.players.map((p) => p.id));
        const id = [1, 2, 3].find((i) => !used.has(i));
        // Character is replaced by the client's own pick when its hello arrives.
        lobby.players.push({ id, name: playerName(id), char: randomChar(), team: -1, link });
        broadcastLobby();
      },
      onData(link, msg) {
        if (session) return session.onData?.(link, msg);
        const player = lobby?.players.find((p) => p.link === link);
        if (!player) return;
        if (msg.t === 'hello') player.char = validChar(msg.char);
        else if (msg.t === 'team') setTeam(player, msg.team);
        broadcastLobby();
      },
      onClose(link) {
        if (session) return session.onLeave?.(link);
        if (!lobby) return;
        lobby.players = lobby.players.filter((p) => p.link !== link);
        broadcastLobby();
      },
      onError: (text) => ui.setHostStatus(text),
    }, MAX_CLIENTS);
  } catch (err) {
    ui.setHostStatus(err.message);
  }
}

function lobbyTeam(btn) {
  const team = Number(btn?.dataset.team);
  if (lobbyLink) {
    lobbyLink.send({ t: 'team', team });
  } else if (lobby) {
    if (!setTeam(lobby.players[0], team)) ui.setHostStatus('O takım dolu.');
    else broadcastLobby();
  }
}

function lobbyMode(btn) {
  const size = Number(btn?.dataset.size);
  if (!lobby || (size !== 2 && size !== 4)) return;
  lobby.size = size;
  // Shrinking to 1v1: anyone beyond one per side goes back to the middle.
  for (const team of [0, 1]) {
    lobby.players.filter((p) => p.team === team).slice(capacity()).forEach((p) => { p.team = -1; });
  }
  broadcastLobby();
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** Put players still in the middle into random free seats (balanced first). */
function seatMiddle() {
  for (const p of shuffle(lobby.players.filter((q) => q.team === -1))) {
    const open = [0, 1].filter((t) => teamCount(t) < capacity());
    if (!open.length) break;
    const fewest = Math.min(...open.map(teamCount));
    const choices = open.filter((t) => teamCount(t) === fewest);
    p.team = choices[Math.floor(Math.random() * choices.length)];
  }
}

function lobbyRandom() {
  if (!lobby) return;
  lobby.players.forEach((p) => { p.team = -1; });
  seatMiddle();
  broadcastLobby();
}

function lobbyStart() {
  if (!lobby) return;
  if (lobby.size === 2 && lobby.players.length !== 2) {
    ui.setHostStatus('1v1 için odada tam 2 oyuncu olmalı.');
    return;
  }
  if (lobby.players.length > lobby.size) {
    ui.setHostStatus('Oyuncu sayısı bu mod için fazla, 2v2 seç.');
    return;
  }
  seatMiddle();

  // Fighter order: left team then right team; free 2v2 seats get bots.
  const chars = [];
  const teams = [];
  const names = [];
  const clients = [];
  let hostIndex = 0;
  for (const team of [0, 1]) {
    const members = lobby.players.filter((p) => p.team === team).sort((a, b) => a.id - b.id);
    for (let seat = 0; seat < capacity(); seat++) {
      const p = members[seat];
      const index = chars.length;
      const char = p ? p.char : randomChar();
      chars.push(char);
      teams.push(team);
      names.push(p ? `${p.name} ${CHARACTERS[char].name}` : `BOT ${CHARACTERS[char].name}`);
      if (p?.id === 0) hostIndex = index;
      else if (p) clients.push({ index, link: p.link });
    }
  }

  pendingRoom.locked = true;
  for (const { index, link } of clients) link.send({ t: 'start', index });
  const room = pendingRoom;
  pendingRoom = null;
  lobby = null;
  startHost(room, { chars, teams, names, hostIndex, clients });
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
    const room = joinRoom(code, {
      onConnected(link) {
        lobbyLink = link;
        link.send({ t: 'hello', char: myChar });
        // Clear any host controls left from hosting earlier until the lobby arrives.
        ui.renderLobby({ size: 4, players: [] }, -1, false, CHARACTERS);
        ui.setRoomCode(code);
        ui.setHostStatus('Bağlandı. Host\'un başlatması bekleniyor...');
        ui.showScreen('lobby');
      },
      onError: (text) => { pendingRoom = null; ui.setJoinStatus(text); },
      onData(msg) {
        if (session) return session.onData?.(msg);
        if (msg.t === 'lobby' && Array.isArray(msg.players)) {
          const players = msg.players.slice(0, MAX_CLIENTS + 1).map((p) => ({
            id: Number(p?.id) | 0, name: String(p?.name ?? '').slice(0, 8), char: validChar(p?.char),
            team: p?.team === 0 || p?.team === 1 ? p.team : -1,
          }));
          ui.renderLobby({ size: msg.size === 2 ? 2 : 4, players }, Number(msg.you) | 0, false, CHARACTERS);
          ui.setHostStatus(`${players.length} oyuncu odada. Host'un başlatması bekleniyor...`);
        } else if (msg.t === 'start' && Number.isInteger(msg.index) && msg.index >= 0 && msg.index < MAX_FIGHTERS) {
          pendingRoom = null;
          const link = lobbyLink;
          lobbyLink = null;
          startClient(link, room, msg.index);
        }
      },
      onClose: (reason) => leaveToMenu(CLOSE_TEXT[reason] || 'Bağlantı kapandı.'),
    });
    pendingRoom = room;
  } catch (err) {
    ui.setJoinStatus(err.message);
  }
}

function enterFight() {
  sound.startMusic();
  hud.reset();
  ui.setTrainingInfo(null);
  ui.setMenuStatus('');
  ui.setNetStatus('');
  ui.showScreen(null);
}

function openJoinLobby() {
  ui.setJoinStatus('');
  ui.showScreen('lobby-join');
  document.getElementById('join-code').focus();
}

/** Local player's input; neutral while the pause menu is open (online play keeps running). */
function playerInput() {
  const input = keyboard.sample();
  return paused ? { ...EMPTY_INPUT } : input;
}

function pause() {
  if (!session || paused || hud.last.phase === 'over') return;
  paused = true;
  const note = !session.pausable ? 'Online maç durdurulamaz, oyun arka planda sürüyor.'
    : portraitPhone.matches ? 'Devam etmek için telefonu yan çevir.' : '';
  ui.showPause(note);
}

function resume() {
  if (!paused) return;
  paused = false;
  keyboard.sample(); // drop presses made while the menu was open
  ui.showScreen(null);
}

function leaveToMenu(message = '') {
  sound.stopMusic();
  arcade = null;
  effects.clearPieces();
  paused = false;
  pendingMode = null;
  lobby = null;
  lobbyLink = null;
  pendingRoom?.cancel();
  pendingRoom = null;
  session?.dispose?.();
  session = null;
  ui.setNetStatus('');
  ui.setTrainingInfo(null);
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
    const n = state.fighters.length;
    const teams = state.teams || defaultTeams(n);
    const local = session?.localIndex ?? 0;
    // Rebuilding the rows invalidates every cached HUD value.
    const layout = `${state.names.join('|')}#${teams.join('')}#${local}`;
    if (this.last.layout !== layout) {
      this.last = { layout };
      ui.setupFighters(state.fighters.map((_, i) => ({ name: state.names[i], team: teams[i], local: i === local })));
    }
    state.fighters.forEach((f, i) => {
      this.set(`hp${i}`, f.hp, (v) => ui.setHealth(i, v, MATCH.maxHp));
      const charge = Math.round((1 - (f.cooldown || 0) / ATTACKS.special.cooldown) * 20) / 20;
      this.set(`sp${i}`, charge, (v) => {
        ui.setSpecial(i, v);
        if (i === local) ui.setTouchSpecial(v);
      });
    });
    this.set('round', state.training ? 0 : state.round, ui.setRound);
    this.set('timer', state.training ? null : Math.ceil(state.timer), ui.setTimer);
    this.set('wins0', state.wins[0], (v) => ui.setWins(0, v));
    this.set('wins1', state.wins[1], (v) => ui.setWins(1, v));
    this.set('phase', state.phase, (phase) => {
      if (phase === 'over' && session?.result) {
        paused = false;
        const r = session.result(state);
        ui.showResult(r.title, r.detail, true, r.button);
      } else if (phase === 'over') {
        paused = false;
        const name = n === 2 ? state.names[state.winner] : TEAM_NAMES[state.winner];
        const score = `${state.wins[0]} - ${state.wins[1]}`;
        const canRematch = !!session?.canRematch;
        ui.showResult(`${name} KAZANDI`, canRematch ? score : `${score} · Rövanşı host başlatabilir`, canRematch);
      } else if (!paused) {
        ui.showScreen(null);
      }
    });
  },
};

/**
 * Turn simulation events into sound, effects and HUD feedback. On the client
 * these come from the network, so every field is treated as untrusted.
 */
function handleEvents(events) {
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const fighterIndex = (v) => (Number.isInteger(v) && v >= 0 && v < MAX_FIGHTERS ? v : -1);
  for (const e of events) {
    if (e.type === 'announce') {
      const text = String(e.text ?? '').slice(0, 32);
      ui.announce(text, Math.min(num(e.ms) || 1200, 5000), e.style === 'blood' ? 'blood' : '');
      if (text.startsWith('ROUND') || text === 'ANTRENMAN') {
        sound.play('round');
        sound.startMusic(); // also restarts it for an online client after a rematch
        effects.clearPieces();
      }
      else if (text === 'FIGHT!') sound.play('fight');
    } else if (e.type === 'hit') {
      sound.play(e.throw ? 'grab' : e.blocked ? 'block' : e.heavy ? 'heavy' : 'hit');
      effects.spark(num(e.x), num(e.y), { blocked: !!e.blocked, heavy: !!e.heavy });
      const struck = views[fighterIndex(e.target)];
      struck?.impact(!!e.heavy, !!e.blocked);
      if (!e.blocked) struck?.flash();
      stage.shake(e.blocked ? 0.06 : e.heavy ? 0.28 : 0.14);
      if (e.throw) stage.punchZoom(0.6);
    } else if (e.type === 'slam') {
      sound.play('slam');
      effects.spark(num(e.x), 0.15, { heavy: true });
      effects.dust(num(e.x), 1.2);
      stage.shake(0.45);
      stage.punchZoom(0.9);
    } else if (e.type === 'damage') {
      if (e.target === 1) ui.setTrainingInfo(`HASAR ${Number(e.total) | 0}`);
    } else if (e.type === 'combo') {
      // Shown on the attacker's team side.
      const side = e.team ?? e.attacker;
      if (side === 0 || side === 1) ui.showCombo(side, Number(e.count) | 0);
    } else if (e.type === 'fireball') {
      sound.play('fireball');
    } else if (e.type === 'pickup') {
      sound.play('pickup');
      effects.spark(num(e.x), num(e.y), { blocked: e.kind === 'charge' });
      if (e.target === session?.localIndex) ui.showHint(e.kind === 'health' ? '+25 CAN' : 'ÖZEL HAZIR!', 1200);
    } else if (e.type === 'ko') {
      sound.play('ko');
      // A fighter dropping in 2v2 (has a target) is a smaller moment than a round K.O.
      stage.shake(e.target === undefined ? 0.5 : 0.3);
      if (e.target === undefined) stage.punchZoom(1.2);
    } else if (e.type === 'over') {
      sound.stopMusic();
      sound.play('victory');
    } else if (e.type === 'finish') {
      sound.play('finish');
      if (e.winner === session?.localIndex) ui.showHint('ÖZEL HAREKETLE BİTİR!  (U / ○ / ÖZEL)', 3500);
    } else if (e.type === 'fatality') {
      sound.play('fatality');
      stage.shake(0.8);
      const target = Math.max(0, fighterIndex(e.target));
      effects.explode(num(e.x), num(e.y), shownColors[target]);
      effects.dust(num(e.x), 1.6);
      stage.punchZoom(1.5);
    }
  }
}

// ---------------------------------------------------------------------------
// Menu wiring
// ---------------------------------------------------------------------------
ui.bindActions({
  solo: () => openSelect('solo'),
  arcade: () => openSelect('arcade'),
  team: () => openSelect('team'),
  host: () => openSelect('host'),
  join: () => openSelect('join'),
  pick: pickCharacter,
  difficulty: setDifficulty,
  dummy: setDummy,
  training: () => openSelect('training'),
  connect: connectToRoom,
  'lobby-team': lobbyTeam,
  'lobby-mode': lobbyMode,
  'lobby-random': lobbyRandom,
  'lobby-start': lobbyStart,
  pause,
  resume,
  // Help opens from the menu or the pause screen and returns to it.
  help: () => {
    helpReturn = paused ? 'pause' : 'menu';
    ui.setHelpOverFight(paused);
    ui.showScreen('help');
  },
  'help-back': () => ui.showScreen(helpReturn),
  rematch: () => {
    if (!session?.rematch) return;
    paused = false;
    effects.clearPieces();
    session.rematch();
    sound.startMusic();
    hud.reset();
    ui.showScreen(null);
  },
  back: () => leaveToMenu(),
  fullscreen: toggleFullscreen,
  music: toggleMusic,
  graphics: cycleGraphics,
});

function toggleMusic() {
  const text = sound.toggleMusic() ? 'MUZIK ACIK' : 'MUZIK KAPALI';
  if (session) ui.announce(text, 800);
  else ui.setMenuStatus(text);
}

/**
 * Phones: fullscreen hides the browser bars, and landscape is locked where
 * the browser allows it (Android Chrome; iOS Safari ignores both quietly).
 */
async function toggleFullscreen() {
  const doc = document;
  try {
    if (doc.fullscreenElement) {
      await doc.exitFullscreen();
      return;
    }
    await doc.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    await screen.orientation?.lock?.('landscape');
  } catch { /* not supported or refused: keep playing in the page */ }
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (session) (paused ? resume() : pause());
    else if (pendingRoom || pendingMode) leaveToMenu();
  }
  if (e.code === 'KeyM' && !e.target.matches?.('input')) {
    const text = sound.toggleMute() ? 'SES KAPALI' : 'SES AÇIK';
    if (session) ui.announce(text, 800);
    else ui.setMenuStatus(text);
  }
  if (e.code === 'KeyN' && !e.target.matches?.('input')) toggleMusic();
});
// Switching tabs mid-fight pauses solo play instead of letting the bot win.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && session?.pausable) pause();
});
// So does turning a phone upright (the "rotate" overlay covers the fight).
const portraitPhone = window.matchMedia('(pointer: coarse) and (orientation: portrait) and (max-width: 600px)');
portraitPhone.addEventListener?.('change', (e) => {
  if (e.matches && session?.pausable) pause();
});
// Audio may only start after a user gesture.
window.addEventListener('pointerdown', sound.unlock);
window.addEventListener('keydown', sound.unlock);
document.getElementById('join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectToRoom();
});

const scale = (hex, k) =>
  (Math.round(((hex >> 16) & 255) * k) << 16) | (Math.round(((hex >> 8) & 255) * k) << 8) | Math.round((hex & 255) * k);
const lighten = (hex, k) => {
  const ch = (shift) => { const c = (hex >> shift) & 255; return Math.round(c + (255 - c) * k); };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};
const TEAM_COLORS = [0xff3b3b, 0x3a8bff];

let shownKey = '';
const shownColors = views.map((_, i) => CHARACTERS[i % CHARACTERS.length].color);
/**
 * Colour the fighters by character. Repeated characters get darker/lighter
 * variants so they stay distinguishable; team fights add team rings and an
 * arrow over the local player.
 */
function applyCharacterColors(chars, teams, local) {
  const key = `${chars.join(',')}|${teams.join('')}|${local}`;
  if (key === shownKey) return;
  shownKey = key;
  const teamFight = chars.length > 2;
  const seen = {};
  views.forEach((v, i) => v.setEnabled(i < chars.length));
  chars.forEach((c, i) => {
    let color = (CHARACTERS[c] || CHARACTERS[0]).color;
    const copy = (seen[c] = (seen[c] || 0) + 1);
    if (copy === 2) color = scale(color, 0.5);
    else if (copy === 3) color = lighten(color, 0.45);
    else if (copy === 4) color = scale(color, 0.28);
    views[i].setColor(color);
    views[i].setCharacter((CHARACTERS[c] || CHARACTERS[0]).id);
    views[i].setMarker(teamFight ? TEAM_COLORS[teams[i]] : null, teamFight && i === local);
    shownColors[i] = color;
    effects.setProjectileColor(i, color);
  });
}

ui.renderCharacters(CHARACTERS);
ui.setArcadeBest(loadArcadeBest(), arcadeLength());

// ---- Graphics quality (OTO / DÜŞÜK / ORTA / YÜKSEK), remembered per browser ----
const GRAPHICS_KEY = 'fighterzone.graphics';
const GRAPHICS = ['auto', 0, 1, 2];
let graphics = (() => {
  try {
    const v = localStorage.getItem(GRAPHICS_KEY);
    return v === null || v === 'auto' ? 'auto' : GRAPHICS.includes(Number(v)) ? Number(v) : 'auto';
  } catch { return 'auto'; }
})();
stage.setQualityMode(graphics);
ui.setGraphicsLabel(graphics);

function cycleGraphics() {
  graphics = GRAPHICS[(GRAPHICS.indexOf(graphics) + 1) % GRAPHICS.length];
  stage.setQualityMode(graphics);
  ui.setGraphicsLabel(graphics);
  try { localStorage.setItem(GRAPHICS_KEY, String(graphics)); } catch { /* not persisted */ }
}

/**
 * Compile every material up front: effects (projectiles, sparks, crystal,
 * fatality pieces, team markers) start hidden, and the first time one showed
 * up mid-fight its shader compile caused a visible hitch.
 */
function prewarmShaders() {
  const hidden = [];
  stage.scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });
  try { stage.renderer.compile(stage.scene, stage.camera); } catch { /* compile is only an optimisation */ }
  for (const o of hidden) o.visible = false;
}
prewarmShaders();

// ---------------------------------------------------------------------------
// Main loop: requestAnimationFrame with clamped delta time so a background
// tab returning to focus does not produce one giant simulation burst.
// ---------------------------------------------------------------------------
let last = performance.now();
const wasAirborne = views.map(() => false);

function frame(now) {
  // Schedule first: an exception below must not kill the game loop.
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  // Gamepad is polled every frame, even while paused, so Start can resume.
  if (keyboard.poll() && session) (paused ? resume() : pause());

  // Solo play never runs upright on a phone (the rotate prompt covers it).
  if (session?.pausable && !paused && portraitPhone.matches) pause();

  if (session && !(paused && session.pausable)) {
    const { state, events, positions, projectiles, clock } = session.update(dt);
    if (state) {
      stage.updatePlatforms(clock ?? state.clock ?? 0);
      const chars = state.chars || [0, 1];
      applyCharacterColors(chars, state.teams || defaultTeams(chars.length), session.localIndex ?? 0);
      stage.setArena(state.arena ?? 0);
      state.fighters.forEach((f, i) => {
        views[i]?.update(f, dt, positions[i].x, positions[i].y, positions[i].t);
        // A puff of dust when landing from a jump (knockdowns have their own slam).
        if (f.grounded && wasAirborne[i] && f.action !== 'hit') effects.dust(positions[i].x, 0.45, positions[i].y);
        wasAirborne[i] = !f.grounded;
      });
      stage.updateCamera(dt, positions);
      effects.syncProjectiles(projectiles ?? state.projectiles ?? [], dt);
      effects.syncPickup(state.pickup ?? null, dt);
      hud.sync(state);
      handleEvents(events);
    }
  } else if (!session) {
    applyCharacterColors([0, 1], [0, 1], -1);
    stage.setArena(0);
    effects.syncProjectiles([], dt);
    effects.syncPickup(null, dt);
    // Attract mode: idle fighters and a slow camera sway behind the menu.
    menuFighters.forEach((f, i) => views[i].update(f, dt, f.x, f.y));
    stage.updatePlatforms(now / 1000);
    const sway = Math.sin(now / 1000 * 0.3) * 3;
    stage.updateCamera(dt, [{ x: sway - 1.6, y: 0 }, { x: sway + 1.6, y: 0 }]);
  }

  effects.update(dt);
  stage.animate(now / 1000);
  stage.reportFrame(dt);
  stage.render();
}
requestAnimationFrame(frame);
