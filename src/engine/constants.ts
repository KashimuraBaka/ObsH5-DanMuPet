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
/** Jump impulse, in px per frame (negative = up). */
export const CHAR_JUMP_IMPULSE = -6;
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

// ---- bot soft collisions ----
// Bots are kinematic and only ever push *themselves*, so the player's
// physics-driven body stays authoritative. The player is never displaced.

/**
 * Fraction of the shortfall between two characters' centres and their target
 * spacing that is resolved each tick (0 = completely free, 1 = rigid).
 *
 * Because the shortfall shrinks as the bot moves, this settles the two bodies
 * at `BOT_MIN_SPACING` apart instead of snapping them rigidly. A character
 * pushing at `v` px/tick leaves a steady-state shortfall of about
 * `v * (1 - BOT_COLLIDE_SOFTNESS) / BOT_COLLIDE_SOFTNESS` beyond that spacing,
 * which becomes a real overlap once `v` passes ~5 px/tick — so a shove squashes
 * the bot a little before it slides off, and a fast slide visibly compresses
 * it instead of stopping dead.
 */
export const BOT_COLLIDE_SOFTNESS = 0.4;

/**
 * Hard cap on how far a single neighbour may displace the bot in one tick.
 * Only reachable from a badly overlapping start, where it prevents a huge
 * one-frame displacement — and the jitter that would follow — instead of
 * teleporting the bot clear of the pack.
 */
export const BOT_COLLIDE_MAX_RESOLVE = 10;

/**
 * Target empty gap between two bodies, in px. Bots hold this much personal
 * space from each other and from the player, which is what stops a group of
 * bots from piling onto one character.
 */
export const BOT_MIN_SPACING = 8;

/**
 * Vertical tolerance on the collision test. Bodies whose centres are farther
 * apart than this (plus their combined half-heights) are not considered to be
 * at the same height, so a jumping bot is never shoved sideways by a body it
 * is clearly above or below.
 */
export const BOT_COLLIDE_VERT_TOL = 4;

// ---- character physics safety ----

/**
 * Maximum character speed in planck units (m/s). Prevents the character from
 * tunneling through thin blocks at extreme velocities. Normal gameplay speeds
 * (walk 2.4, run 3.6, slide 4.8, fall up to 21.6 m/s) are well below this cap.
 */
export const MAX_CHAR_SPEED_MS = 30;
