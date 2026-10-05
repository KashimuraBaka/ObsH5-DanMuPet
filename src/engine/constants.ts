/**
 * Tuning constants for the Kirby physics engine.
 *
 * Kept in one place so the Vue layer and the engine can never disagree about
 * gravity, ranges or tolerances.
 */

/** The world is drawn at 1/5 scale - MapleStory "small hero, big world" ratio. */
export const WORLD_SCALE = 1 / 5;

/**
 * Default sprite scale at displayScale = 1.0.
 * Combined with WORLD_SCALE this gives the canonical "1x" sprite scale:
 *   final = displayScale * SPRITE_BASE_SCALE * characterScaleMultiplier
 * For Kirby: 1.0 * 2.0 * 1.0 = 2.0 (matches the historical default).
 */
export const SPRITE_BASE_SCALE = 10 * WORLD_SCALE;

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

/**
 * Horizontal slack around a bot's assigned follow slot that counts as "settled".
 * Must be wider than `BOT_COLLIDE_MAX_RESOLVE` (10) so incidental soft-pushes
 * from neighbouring bots don't drag a settled bot out of the band and back
 * into walking. 25 px is plenty for a one-frame nudge to absorb without the
 * bot ever registering motion on its own.
 */
export const FOLLOW_SLOT_SETTLE_PX = 25;

// ---- bot ledge sensing ----
// A patrolling bot has to know whether there is still floor under it before it
// commits to a step. This mirrors the original game's ground probe
// (`sub_0809D998`): a pure geometric query with no state, no allocation and no
// time component, so it cannot introduce frame-rate dependence.

/**
 * How far in front of the bot's feet the ledge probe reaches, in px. One bot
 * width (24 px) would react after the leading foot was already over the drop;
 * 16 px is far enough ahead to turn around while still standing on solid
 * floor, and close enough that a 30 px block still reads as ground.
 */
export const BOT_LEDGE_LOOKAHEAD_PX = 16;

/**
 * Half-width of the probe window, in px. Widens the sample so sub-pixel
 * wobble along a block edge cannot flip the answer between ticks — without
 * it a bot walking flush against a platform lip would turn around every
 * other frame.
 */
export const BOT_LEDGE_PROBE_HALF_PX = 2;

/**
 * Vertical tolerance for "the surface under my feet is at the right level",
 * in px. Absorbs the exact-equality case: the ground plane test is
 * `groundY - footY <= band`, so a bot resting exactly on `groundY` (which is
 * where the collision step puts it) is never mistaken for standing in the air.
 */
export const BOT_LEDGE_GROUND_BAND_PX = 2;

/**
 * How far *down* a surface may sit and still count as somewhere to step onto,
 * in px. Smaller than one block (30 px) on purpose: dropping off a 30 px ledge
 * is a fall the bot cannot walk back out of, so it must read as "no ground".
 */
export const BOT_LEDGE_STEP_DOWN_PX = 24;

// ---- bot roaming (patrol) ----
// Timers are milliseconds throughout: `deltaTime` comes from
// requestAnimationFrame, so a frame counter would drift whenever the tab is
// backgrounded. The game's original numbers are frame constants (GBA ≈ 59.73
// Hz), and the values below are the ms equivalents of the ones we borrowed —
// e.g. `counter > 0xC0` (192 frames ≈ 3.2 s) becomes BOT_ROAM_TURN_MS = 3200.

/**
 * How long a patrolling bot walks one way before turning, in ms.
 * 3200 ms ≈ 192 GBA frames, the slowest of the game's four patrol turn rates.
 * Long enough that the bot actually crosses some ground before reversing,
 * short enough that a bot left alone does not wander off screen.
 */
export const BOT_ROAM_TURN_MS = 3200;

/**
 * Default radius of a patrolling bot's activity around its home point, in px.
 * The game has no equivalent — it clamps enemies inside room walls — so this
 * is our substitute for a room boundary: it gives a loose, readable loop
 * instead of an endless march.
 */
export const BOT_ROAM_RANGE_PX = 240;

/**
 * Default seed for the per-bot random streams. Fixed rather than random so
 * that a scene replays identically between runs — a debugging aid, which is
 * why the panel shows the seed it used.
 */
export const BOT_WORLD_SEED = 1;

/**
 * Damage dealt by one successful inhale bite, in hp.
 *
 * MUST be ≥ 2: the resistance table is `max(1, amount + coef)` (the original's
 * formula, see Enemy.takeDamage), so with an amount of 1 the coefficients
 * −1…−4 all clamp to exactly the same result as 0 and the entire resistance
 * column is dead code. 2 is the smallest value that gives the table one
 * distinguishable step without turning "swallow an enemy" into a five-hit chore.
 */
export const BOT_INHALE_DAMAGE = 2;

/**
 * Minimum spacing between two damage ticks from the same bot, in ms.
 * The attack state re-tests the enemy every tick, so without a gap a 5 hp
 * enemy dies in three frames (48 ms) and the stun/hit feedback never shows.
 * 250 ms ≈ 15 GBA frames — long enough to read as separate bites, short
 * enough that an enemy still dies in well under two seconds.
 */
export const BOT_INHALE_REHIT_MS = 250;

/**
 * How long a bot keeps chasing a target it can no longer see, in ms.
 * The original has no "lost the target" fallback at all (each chaser is a
 * special case), so this is an addition rather than a port; it stops a bot
 * from snapping back to idle the instant a target crosses `chaseRange`, and
 * stops it from chasing across the map forever when the target is gone.
 */
export const BOT_LAST_SEEN_MS = 2500;

// ---- character physics safety ----

/**
 * Maximum character speed in planck units (m/s). Prevents the character from
 * tunneling through thin blocks at extreme velocities. Normal gameplay speeds
 * (walk 2.4, run 3.6, slide 4.8, fall up to 21.6 m/s) are well below this cap.
 */
export const MAX_CHAR_SPEED_MS = 30;
