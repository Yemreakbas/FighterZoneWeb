// Central tuning values. Gameplay modules read from here so balancing
// never requires digging through logic code.

export const ARENA = {
  halfWidth: 9,       // fighters are clamped to [-halfWidth, halfWidth] on X
  groundY: 0,
  /**
   * One-way platforms { x0, x1, y }: jump up through them from below, land on
   * them from above, drop through with down + jump. A jump peaks at about
   * jumpVelocity^2 / (2 * |gravity|) = 1.84, so the side platforms are
   * reachable from the floor and the top one from a side platform.
   */
  platforms: [
    { x0: -6.4, x1: -3.0, y: 1.5 },
    { x0: 3.0, x1: 6.4, y: 1.5 },
    { x0: -2.2, x1: 2.2, y: 3.0 },
  ],
  dropThrough: 0.25,  // seconds a dropping fighter ignores platforms
};

export const CAMERA = {
  fov: 45,
  height: 2.6,
  distance: 11,       // base Z distance from the fighting plane
  minDistance: 9,
  maxDistance: 16,
  followLerp: 4,      // higher = snappier tracking
};

export const MATCH = {
  maxHp: 100,
  roundTime: 99,      // seconds
  roundsToWin: 2,
};

// Fixed simulation step (seconds). The host runs physics at this rate
// regardless of display refresh rate, which keeps combat deterministic.
export const TICK = 1 / 60;

export const PHYSICS = {
  gravity: -30,
  walkSpeed: 4.2,
  backWalkFactor: 0.75, // walking away from the opponent is slower
  jumpVelocity: 10.5,
  jumpForwardSpeed: 4,
  knockbackDecay: 8,    // per-second exponential decay of knockback velocity
  minSeparation: 0.8,   // fighters cannot overlap closer than this on X
};

// Body proportions used for hurtboxes (world units, feet at y = 0).
export const BODY = {
  width: 0.7,
  height: 1.9,
  crouchHeight: 1.15,
};

/**
 * Frame data in seconds. An attack runs startup -> active -> recovery and
 * can only hit during the active window. `hitY` is the vertical span of
 * the hitbox relative to the attacker's feet; `reach` is how far in front
 * of the attacker the hitbox extends.
 */
export const ATTACKS = {
  punch: {
    startup: 0.07, active: 0.08, recovery: 0.16,
    damage: 6, chip: 0.6, reach: 1.2, hitY: [1.3, 1.65],
    knockback: 2.5, hitstun: 0.4, blockstun: 0.14, // long enough to chain into punch or kick
  },
  kick: {
    startup: 0.14, active: 0.1, recovery: 0.3,
    damage: 11, chip: 1.2, reach: 1.55, hitY: [0.55, 1.1],
    knockback: 5.5, hitstun: 0.42, blockstun: 0.2,
  },
};
// Special move: launches a projectile when startup ends. It has no melee
// hitbox; damage values apply to the projectile instead.
ATTACKS.special = {
  startup: 0.3, active: 0.05, recovery: 0.4,
  damage: 9, chip: 1.5,
  knockback: 3.5, hitstun: 0.35, blockstun: 0.2,
  cooldown: 3, // seconds after starting a special before the next one
};

/**
 * Throw: forward + punch up close. It ignores block, so it is the answer to
 * a turtling opponent; strikes beat it (a fighter in hitstun can't be
 * grabbed) and a whiffed throw has a long, punishable recovery. The victim
 * is tossed over the thrower's shoulder and lands behind them.
 */
ATTACKS.throw = {
  startup: 0.1, active: 0.04, recovery: 0.5,
  damage: 13, reach: 1.15,
  tossVx: 5, tossVy: 8, landStun: 0.4,
};

/**
 * Sweep: a kick started from a crouch. It hits low, so only a crouching
 * block stops it; a clean sweep knocks the victim off their feet. It reuses
 * the kick's frame data but recovers more slowly, so a blocked or whiffed
 * sweep can be punished.
 */
export const SWEEP = {
  damage: 9, extraRecovery: 0.18,
  popVy: 4.5, slideVx: 2.5, landStun: 0.5,
};

/**
 * Projectile travels at chest height: crouching (hurtbox top 1.15) ducks
 * under it and jumping clears it. One projectile per fighter at a time.
 */
export const PROJECTILE = {
  speed: 9,
  height: 1.4,    // centre height above the caster's feet
  radius: 0.22,
  spawnOffset: 0.6,
  lifetime: 2.2,
};

/**
 * Selectable fighters. Stats are multipliers on the shared base values so
 * every move keeps the same frame data and only the feel changes.
 * Names avoid Turkish-only letters: the pixel font has no glyphs for them.
 */
export const CHARACTERS = [
  { id: 'kor',    name: 'KOR',    color: 0xc62828, desc: 'Güçlü ama yavaş',     speed: 0.9,  power: 1.15, projectileSpeed: 8 },
  { id: 'ayaz',   name: 'AYAZ',   color: 0x1e5bd6, desc: 'Dengeli, hızlı top',   speed: 1.0,  power: 1.0,  projectileSpeed: 11.5 },
  { id: 'kuzgun', name: 'KUZGUN', color: 0x7b2fbf, desc: 'Çevik ama kırılgan',   speed: 1.2,  power: 0.85, projectileSpeed: 9 },
  { id: 'yildirim', name: 'YILDIRIM', color: 0xd4a017, desc: 'En hızlı, ağır top',  speed: 1.25, power: 0.95, projectileSpeed: 6.5 },
];

/**
 * Arenas share the same geometry; only colours, textures and lighting
 * change, so switching never adds or removes lights (no shader recompiles).
 * Texture palettes: floor { base, speck: [r, g, b], grout }, wall { base, brick: [r, g, b] }.
 */
export const ARENAS = [
  {
    name: 'ZINDAN',
    sky: 0x0b0b16, hemiSky: 0x9aa8ff, hemiGround: 0x2a1010, hemi: 1.1,
    key: 0xffffff, keyIntensity: 2.2, rims: [0xff2a2a, 0x2a6bff], torch: 0xff8a2a,
    floor: { base: '#2a2730', speck: [40, 35, 45], grout: '#141218' },
    wall: { base: '#100e16', brick: [32, 26, 36] },
    pillar: 0x3a3440, banners: [0xc62828, 0x1e5bd6],
  },
  {
    name: 'TAPINAK',
    sky: 0x2a1424, hemiSky: 0xffb27a, hemiGround: 0x3a1e0c, hemi: 1.0,
    key: 0xffc890, keyIntensity: 2.6, rims: [0xff6a2a, 0xffb347], torch: 0xffc061,
    floor: { base: '#5e4a30', speck: [110, 88, 58], grout: '#2e2214' },
    wall: { base: '#24160e', brick: [88, 64, 42] },
    pillar: 0x8a6a45, banners: [0x8a1c1c, 0xd4a017],
  },
];

// Training mode: a fighter's health refills once it has taken no damage
// for this long (and instantly if it would be knocked out).
export const TRAINING = { refillDelay: 1.2 };

/**
 * Combo breaker: no infinite pressure (punch spam in a corner). A fighter
 * hit again while still stunned has taken `maxChain` hits in a row; that hit
 * knocks them clear (`push`, the attacker is shoved back by `attackerPush`),
 * shortens the stun to `stun` and makes them untouchable for `guard`
 * seconds so they can move or counter.
 */
export const COMBO_BREAK = { maxChain: 2, stun: 0.2, guard: 0.6, push: 6, attackerPush: 3 };

// Impact freeze on clean hits (seconds). Blocked hits don't freeze.
export const HITSTOP = { light: 0.05, heavy: 0.09 };

// Crouching attacks hit this much lower.
export const CROUCH_ATTACK_DROP = 0.5;
// A button pressed while busy is remembered this long (input buffer).
export const INPUT_BUFFER = 0.15;

export const ROUND_FLOW = {
  introAnnounce: 1.1, // "ROUND n" is shown, then "FIGHT!"
  introTotal: 1.7,
  koToWinPose: 1.0,
  finishTime: 4.0,    // FINISH HIM window before the loser collapses on their own
  fatalityHold: 1.5,  // extra time on the round-end screen after a fatality
  roundEndTotal: 3.0,
};

/**
 * Bot skill levels, from weakest to strongest.
 * reaction:   seconds between decisions
 * block:      probability of blocking an incoming attack
 * aggression: probability of attacking when in range on a decision
 * combo:      probability of chaining a follow-up attack
 * speed:      fraction of walk input the bot actually uses
 */
export const BOT_LEVELS = [
  { reaction: 0.5,  block: 0.08, aggression: 0.35, combo: 0.0, speed: 0.6 },
  { reaction: 0.28, block: 0.4,  aggression: 0.6,  combo: 0.45, speed: 0.9 },
  { reaction: 0.16, block: 0.6,  aggression: 0.8,  combo: 0.7, speed: 1.0 },
  { reaction: 0.11, block: 0.75, aggression: 0.85, combo: 0.85, speed: 1.0 },
];

/**
 * Difficulty chosen before a solo match. The bot starts at level `start` in
 * round 1 and climbs one level per round, up to `cap` (BOT_LEVELS indices).
 */
export const BOT_DIFFICULTIES = [
  { name: 'KOLAY',  start: 0, cap: 1 },
  { name: 'NORMAL', start: 0, cap: 2 },
  { name: 'ZOR',    start: 2, cap: 3 },
];
export const DEFAULT_DIFFICULTY = 1;

export const NET = {
  idPrefix: 'fighterzone-v1-', // namespaces short room codes on the public PeerJS broker
  codeLength: 4,
  snapshotEvery: 2,     // host sends a state packet every N ticks (30 Hz)
  // The client renders the world slightly in the past to smooth jitter. The
  // delay adapts to measured jitter within these bounds.
  interpMinMs: 50,
  interpMaxMs: 150,
  pingMs: 1000,
  timeoutMs: 6000,
  connectTimeoutMs: 10000,
  staleMs: 800,         // client shows a warning if no state arrives for this long
};
