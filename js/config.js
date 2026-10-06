// Central tuning values. Gameplay modules read from here so balancing
// never requires digging through logic code.

export const ARENA = {
  halfWidth: 9,       // fighters are clamped to [-halfWidth, halfWidth] on X
  groundY: 0,
  /**
   * Solid platforms { x0, x1, y, move? }: slabs `slab` thick whose top is at
   * `y`. Fighters land on top, bump their head on the underside and are
   * stopped by the edges, so they climb on from the side: jump toward a
   * platform from next to it and the jump carries them over the edge once
   * their feet clear the top. Walk off an edge to get down.
   * Side platforms sit high enough that the underside clears the drawn
   * fighter's head (BODY.drawnHeight), so fighters walk under them, and the
   * top platform clears the head of someone standing on a side platform.
   * A jump peaks at jumpVelocity^2 / (2 * |gravity|) = 3.08, so the side
   * platforms are reachable from the floor and the top one only from a side
   * platform. Heights are chosen so a jump from the floor (head at
   * 3.08 + drawnHeight = 5.26) never reaches the top slab's underside (5.47):
   * the mover can swing anywhere without capping a climb onto a side platform. `move` slides a platform along X:
   * offset = amp * sin(2 * PI * clock / period); riders are carried along.
   */
  platforms: [
    { x0: -6.6, x1: -3.2, y: 2.9 },
    { x0: 3.2, x1: 6.6, y: 2.9 },
    { x0: -1.8, x1: 1.8, y: 5.75, move: { amp: 3.4, period: 9 } },
  ],
  slab: 0.28,
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
  jumpVelocity: 13.6,
  jumpForwardSpeed: 4,
  knockbackDecay: 8,    // per-second exponential decay of knockback velocity
  minSeparation: 0.8,   // fighters cannot overlap closer than this on X
};

// Body proportions used for hurtboxes (world units, feet at y = 0).
export const BODY = {
  width: 0.7,
  height: 1.9,
  crouchHeight: 1.15,
  // Top of the drawn model (fighterView proportions incl. bob, KOR's larger
  // build and helmet, YILDIRIM's hair); used for platform collisions so
  // nothing visibly sticks into a slab.
  drawnHeight: 2.32,
};

/**
 * Frame data in seconds. An attack runs startup -> active -> recovery and
 * can only hit during the active window. `hitY` is the vertical span of
 * the hitbox relative to the attacker's feet; `reach` is how far in front
 * of the attacker the hitbox extends.
 *
 * `cancel`: once a grounded attack has connected (hit or blocked), a move
 * from this list pressed meanwhile cuts the rest of it short, so strings
 * flow punch -> kick -> special. Only stronger moves, never a whiff, and a
 * sweep keeps its full recovery (a blocked sweep stays punishable).
 */
export const ATTACKS = {
  punch: {
    startup: 0.07, active: 0.08, recovery: 0.16,
    damage: 6, chip: 0.6, reach: 1.2, hitY: [1.3, 1.65],
    knockback: 2.5, hitstun: 0.4, blockstun: 0.14, // long enough to chain into punch or kick
    cancel: ['kick', 'special'],
  },
  kick: {
    startup: 0.14, active: 0.1, recovery: 0.3,
    damage: 11, chip: 1.2, reach: 1.55, hitY: [0.55, 1.1],
    knockback: 5.5, hitstun: 0.42, blockstun: 0.2,
    cancel: ['special'],
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
 * Names avoid Turkish-only letters: the pixel font has no glyphs for them
 * (`special.name` is shown in the body font and may use them).
 *
 * Each fighter's special is its own projectile: `height` of its centre
 * above the caster's feet, `radius` and a `damage` multiplier. A crouching
 * hurtbox is BODY.crouchHeight (1.15) tall, so a projectile whose bottom
 * (height - radius) is above that can be ducked; anything lower must be
 * jumped or blocked.
 */
export const CHARACTERS = [
  { id: 'kor',    name: 'KOR',    color: 0xc62828, desc: 'Güçlü ama yavaş',     speed: 0.9,  power: 1.15, projectileSpeed: 7,
    special: { name: 'Yer Dalgası: eğilerek kaçılmaz, üstünden zıpla', height: 0.3, radius: 0.3, damage: 1.2 } },
  { id: 'ayaz',   name: 'AYAZ',   color: 0x1e5bd6, desc: 'Dengeli, hızlı top',   speed: 1.0,  power: 1.0,  projectileSpeed: 11.5,
    special: { name: 'Buz Topu: dengeli enerji topu', height: 1.4, radius: 0.22, damage: 1 } },
  { id: 'kuzgun', name: 'KUZGUN', color: 0x7b2fbf, desc: 'Çevik ama kırılgan',   speed: 1.2,  power: 0.85, projectileSpeed: 13,
    special: { name: 'Gölge Oku: çok hızlı, kafa hizasında', height: 1.6, radius: 0.15, damage: 0.95 } },
  { id: 'yildirim', name: 'YILDIRIM', color: 0xd4a017, desc: 'En hızlı, ağır top',  speed: 1.25, power: 0.95, projectileSpeed: 6.5,
    special: { name: 'Yıldırım Küresi: iri, eğilmek yetmez', height: 1.2, radius: 0.36, damage: 1.1 } },
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
    // Kept darker and less saturated than the fighters so they stand out.
    name: 'TAPINAK',
    sky: 0x2a1424, hemiSky: 0xffc8a0, hemiGround: 0x2e1a0c, hemi: 0.9,
    key: 0xffd2a0, keyIntensity: 2.3, rims: [0xff6a2a, 0xffb347], torch: 0xffc061,
    floor: { base: '#4a3b2b', speck: [88, 72, 52], grout: '#241a10' },
    wall: { base: '#1a120d', brick: [60, 45, 34] },
    pillar: 0x5e4c3a, banners: [0x8a1c1c, 0xd4a017],
  },
];

/**
 * Power-up crystals that appear on a random platform during a fight (not in
 * training): 'health' heals, 'charge' refills the special move. One at a
 * time; it hovers `hover` above the platform (riding a moving one) and
 * vanishes after `life` seconds if nobody touches it.
 */
export const PICKUPS = {
  kinds: ['health', 'charge'],
  firstDelay: 12, interval: 18, life: 10,
  heal: 25, hover: 0.7, radius: 0.35,
};

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
