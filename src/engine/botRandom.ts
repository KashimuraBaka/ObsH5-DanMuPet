/**
 * Per-agent random source for the AI bots.
 *
 * The original game keeps exactly one random word (`gRngVal`, IWRAM
 * 0x030068D8) that every enemy in the room draws from. That works for the
 * game because "which enemy am I" is not a debugging question the player
 * asks — but it does not survive a scene with twenty independent bots:
 *
 *   - adding or removing one bot shifts every other bot's random stream,
 *     so a behaviour can never be reproduced from its own inputs alone;
 *   - two bots that happen to be at the same index are perfectly correlated
 *     after a respawn.
 *
 * So the *structure* is copied (a linear congruential generator with the same
 * constants the game uses) but the *stream sharing* is deliberately not: each
 * bot gets its own generator derived from `(worldSeed, botId)`. With a fixed
 * `worldSeed` the whole scene replays identically, which is what a debug tool
 * wants; change the seed and the whole cast re-rolls its personalities at
 * once.
 */

/**
 * 32-bit mixing hash that turns `(worldSeed, agentId)` into a seed unrelated
 * to either input. Cheap avalanche (xorshift-multiply-xorshift) so that
 * neighbouring agent ids land in unrelated regions of the stream.
 */
export function hashSeed(worldSeed: number, agentId: number): number {
  let h = (worldSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ agentId, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * One agent's LCG. Same multiplier/increment family as the game's `gRngVal`
 * (1664525 / 1013904223) so the *distribution* is familiar, but the state is
 * private to the closure instead of global.
 *
 * Returns a float in [0, 1) built from the high 24 bits, matching the way
 * `Rand16()` is consumed in the original (`Rand16() & 0xF` style masks).
 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) / 0x1000000;
  };
}

/**
 * Weighted picker over a small bucket table, using the subtractive-threshold
 * method the game's boss brains use (`dark_meta_knight.c`: walk the buckets in
 * order, subtract each weight, pick the first one that goes negative).
 *
 * Bucket counts are meant to stay ≤ 8 so every weight is a whole multiple of
 * one eighth — the original relies on that to keep its branches cheap.
 * Negative weights are treated as zero. Returns -1 when every weight is zero
 * (or the list is empty); callers must handle that.
 */
export function pickWeighted(rng: () => number, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += Math.max(0, w | 0);
  if (total <= 0) return -1;
  let r = Math.floor(rng() * total);
  for (let i = 0; i < weights.length; i++) {
    r -= Math.max(0, weights[i] | 0);
    if (r < 0) return i;
  }
  return weights.length - 1; // float-rounding fallback
}