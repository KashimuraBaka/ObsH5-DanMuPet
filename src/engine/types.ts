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
  /** Final on-screen scale, i.e. props.scale * WORLD_SCALE. */
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

/** Outcome of one vertical physics step, so the caller can drive the state machine. */
export type VerticalStepResult =
  | { kind: "standing" }
  | { kind: "airborne" }
  | { kind: "landed"; surfaceY: number };
