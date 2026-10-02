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
