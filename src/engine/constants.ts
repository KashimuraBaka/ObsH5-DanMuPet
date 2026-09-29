/**
 * Tuning constants for the Kirby physics engine.
 *
 * Kept in one place so the Vue layer and the engine can never disagree about
 * gravity, ranges or tolerances.
 */

/** The world is drawn at 1/5 scale - MapleStory "small hero, big world" ratio. */
export const WORLD_SCALE = 1 / 5;

/** Character gravity, in px per frame. */
export const CHAR_GRAVITY = 0.5;
/** Terminal velocity, in px per frame. */
export const MAX_FALL_SPEED = 18;

/**
 * Frames the run-turn skid lasts. He keeps sliding the old way at a linearly
 * decaying speed over this many frames, then runs the new direction.
 */
export const BRAKE_TICKS = 24;

/**
 * Momentum a run must build before a turn is allowed to skid. A run shorter
 * than this never really got going, so turning just drops back into a walk.
 */
export const MIN_RUN_DISTANCE = 24;

/**
 * Frames the release-coast lasts: after letting go of a run he jogs on for a
 * moment at a decaying speed before settling into idle. Any input interrupts it.
 */
export const RUN_COAST_TICKS = 30;

/**
 * The ground bricks extend past both viewport edges. Screen wrap-around parks
 * the character just outside the canvas, so without this overhang there would
 * be no block under his feet on the wrap frame and he would fall forever.
 */
export const GROUND_OVERHANG = 160;

// ---- inhale ----
// The inhale acts from the character's centre outward in the direction he
// faces, over 3-4 body lengths. A caught block drifts in at a constant speed
// and is then yanked the last stretch, so the total travel time is
// proportional to the distance it started at - farther blocks take longer.

/** Effective range, in body lengths (3~4). */
export const INHALE_BODY_MULT = 3.5;
/** px/frame while drifting in. */
export const INHALE_APPROACH_SPEED = 1.5;
/** px/frame for the final yank. */
export const INHALE_SUCK_SPEED = 10;
/** Switch to the fast phase this close to the mouth. */
export const INHALE_SUCK_DIST = 60;
/** Swallowed at this distance. */
export const INHALE_EAT_DIST = 12;

/**
 * Landing tolerance: feet already this close to a surface count as supported.
 * Needed because the tight box changes between animation frames, which would
 * otherwise make the crossing test miss and drop the character through a block.
 */
export const LAND_NEAR_TOP = 4;

/** Epsilon so standing exactly on a surface never counts as intersecting it. */
export const SOLID_EPS = 0.5;

/** Blocks further below the view than this are culled. */
export const BLOCK_CULL_MARGIN = 300;

/** How far a freshly spawned block may fall above the view before entering. */
export const SPAWN_HEIGHT_JITTER = 120;

/** Minimum distance from the character a new block tries to spawn at. */
export const SPAWN_CLEARANCE = 150;
