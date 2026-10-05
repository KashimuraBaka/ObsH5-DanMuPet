/**
 * Motion clips — table-driven movement scripts (archetype A8 in the reverse
 * engineering notes).
 *
 * The original game drives some enemies from a segment table: the enemy walks
 * for N frames at one speed, stands still, turns around, repeats. That is the
 * cheapest way to give a creature a recognisable "personality" without
 * writing a state machine per enemy, and it is what `PATROL_CLIPS` below
 * reproduces for our bots.
 *
 * Deliberate omissions compared with the original table:
 *
 *   - no `yspeed` / `ax` / `ay` fields. Those exist because the original
 *     script drives *flying* enemies (the Batty barrel roll). Our bots are
 *     grounded characters with gravity, and vertical motion belongs to the
 *     physics step, not to the behaviour script. Leaving the fields out makes
 *     it impossible to accidentally write `clip → vy`, which would break the
 *     one rule every script in this file obeys: a clip may only express
 *     horizontal intent.
 *
 * Durations are milliseconds. The interpreter advances at most one segment per
 * tick and never "catches up", so at very low frame rates a clip runs slightly
 * long — treat the numbers as approximate timings, not exact ones.
 */

import type { BotIntent } from "./AIBot.ts";

/** One segment of a motion script. */
export interface MotionSegment {
  /**
   * Horizontal speed multiplier applied to `config.speed`. Negative means
   * left, positive right. Zero means "stand still for this segment".
   */
  vx: number;
  /** How long this segment lasts, in ms. */
  ms: number;
  /** Presentation intent for this segment; omitted means "keep the previous". */
  intent?: BotIntent;
  /** Ask for a facing flip when this segment starts (the game's `flags ^= 1`). */
  turn?: boolean;
}

/** A whole scripted movement pattern. */
export interface MotionClip {
  name: string;
  /** Loop back to segment 0; otherwise hold the last segment. */
  loop: boolean;
  segs: MotionSegment[];
}

/**
 * Patrol scripts a bot can be given. Picked once per bot at construction with
 * a weighted draw (`pickWeighted`), exactly like the original binds a script
 * to the enemy template rather than rolling it every frame.
 *
 * `calm` is the common one, `fidget` is the nervous one, `scurry` is the
 * restless one — enough spread that a group of five bots does not look
 * synchronised.
 */
export const PATROL_CLIPS: readonly MotionClip[] = [
  {
    name: "calm",
    loop: true,
    segs: [
      { vx: 0.8, ms: 1400, intent: "walk" },
      { vx: 0.0, ms: 600, intent: "idle" },
      { vx: -0.8, ms: 1200, intent: "walk" },
      { vx: 0.0, ms: 400, intent: "idle", turn: true },
    ],
  },
  {
    name: "scurry",
    loop: true,
    segs: [
      { vx: 1.4, ms: 500, intent: "run" },
      { vx: 0.0, ms: 250, intent: "idle" },
      { vx: 0.6, ms: 700, intent: "walk" },
      { vx: -1.4, ms: 500, intent: "run", turn: true },
    ],
  },
  {
    name: "fidget",
    loop: true,
    segs: [
      { vx: 0.4, ms: 300, intent: "walk" },
      { vx: 0.0, ms: 1200, intent: "idle" },
    ],
  },
];

/**
 * Relative odds for `PATROL_CLIPS`. Kept ≤ 8 total so each clip is a whole
 * multiple of one eighth, matching the bucket discipline the original uses.
 */
export const PATROL_CLIP_WEIGHTS: readonly number[] = [3, 2, 1];