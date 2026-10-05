/**
 * Shared types for the Kirby physics engine.
 *
 * The engine is deliberately free of Vue and canvas-drawing concerns: it works
 * on plain numbers and rectangles so it can be unit-tested and reasoned about
 * independently of the renderer.
 */

/** A single sprite frame, as stored in animations.json. */
export interface Frame {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An axis-aligned rectangle in canvas coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Tight bounds of a sprite's opaque pixels, in sprite-local coordinates.
 * `bx/by` is the first opaque pixel, `bw/bh` the extent.
 */
export interface TightBox {
  bx: number;
  by: number;
  bw: number;
  bh: number;
}

/** The character's collision box in canvas coordinates. */
export interface CharBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Distance from the frame's bottom edge down to the lowest opaque pixel. */
  feetInset: number;
}

/**
 * Everything the character's geometry depends on for one frame.
 *
 * Bundling it keeps the engine pure - it never reaches into component state.
 */
export interface CharContext {
  /** The frame being displayed this tick. */
  frame: Frame;
  /**
   * Final on-screen scale for the sprite, in canvas pixels per source pixel.
   * For Kirby (1x display): displayScale(1.0) * SPRITE_BASE_SCALE(2.0) = 2.0
   */
  scale: number;
  /** Canvas Y of the ground surface. */
  groundY: number;
  /** True when the sprite is mirrored, which for a left-facing default means facing right. */
  flip: boolean;
  canvasWidth: number;
  canvasHeight: number;
}

/** The inhale field: where it starts, how far it reaches, which way it points. */
export interface InhaleAnchor {
  x: number;
  y: number;
  bodyLen: number;
  range: number;
  /** +1 when facing right, -1 when facing left. */
  dir: 1 | -1;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Damage channels an attack can travel down.
 *
 * The original game describes an attacker's damage as a bit set and resolves
 * it against a per-enemy row of signed coefficients — six columns in the ROM
 * table, and seven bits in the code, which is exactly the kind of
 * one-more-than-the-table-holds that produced the original's out-of-bounds
 * reads for the placeholder enemy types. We keep the *mechanism* (a signed
 * coefficient per channel, clamped so damage never drops below 1) and use an
 * explicit enum instead of a bit set, so adding a channel is a type error
 * rather than an overflow.
 *
 * Only "contact" exists today; "burst" is the reserved slot for a ranged
 * attack, and it is deliberately kept in the enum now rather than added later
 * so the resistance table shape does not have to change when it arrives.
 */
export type DamageKind = "contact" | "burst";

/**
 * Per-enemy damage coefficients, indexed by {@link DamageKind}.
 *
 * Sign convention (this is the code fact, `object.c:538-552` of the original,
 * not an interpretation): `0` is normal damage, a **negative** value is
 * resistance and a **positive** value is a weakness. Damage resolves as
 * `max(1, amount + coefficient)`; when one hit qualifies for several channels
 * the largest resulting value wins rather than the sum, because the channels
 * are an either/or description of the attack, not a stack of modifiers.
 *
 * Values are ours. The original encodes 86 enemy types against its own level
 * balance and there is no correspondence between those and our three enemy
 * types, so nothing is copied across.
 */
export type ResistTable = Record<DamageKind, number>;

/** Outcome of one vertical physics step, so the caller can drive the state machine. */
export type VerticalStepResult =
  | { kind: "standing" }
  | { kind: "airborne" }
  | { kind: "landed"; surfaceY: number };
