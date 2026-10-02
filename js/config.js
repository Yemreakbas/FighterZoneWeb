// Central tuning values. Gameplay modules read from here so balancing
// never requires digging through logic code.

export const ARENA = {
  halfWidth: 9,       // fighters are clamped to [-halfWidth, halfWidth] on X
  groundY: 0,
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

// Crouching attacks hit this much lower.
export const CROUCH_ATTACK_DROP = 0.5;
// A button pressed while busy is remembered this long (input buffer).
export const INPUT_BUFFER = 0.15;

export const ROUND_FLOW = {
  introAnnounce: 1.1, // "ROUND n" is shown, then "FIGHT!"
  introTotal: 1.7,
  koToWinPose: 1.0,
  roundEndTotal: 3.0,
};

/**
 * Bot difficulty per round (index 0 = round 1; the last entry is reused).
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
];

export const NET = {
  idPrefix: 'fighterzone-v1-', // namespaces short room codes on the public PeerJS broker
  codeLength: 4,
  snapshotEvery: 2,     // host sends a state packet every N ticks (30 Hz)
  interpDelayMs: 100,   // client renders this far in the past to smooth jitter
  pingMs: 1000,
  timeoutMs: 6000,
  connectTimeoutMs: 10000,
  staleMs: 800,         // client shows a warning if no state arrives for this long
};
