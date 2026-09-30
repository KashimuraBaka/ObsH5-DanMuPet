import * as planck from "planck";
import { GravityBlock } from "./GravityBlock.ts";
import {
  BLOCK_CULL_MARGIN,
  GROUND_OVERHANG,
  SPAWN_CLEARANCE,
  SPAWN_HEIGHT_JITTER,
  WORLD_SCALE,
} from "./constants.ts";
import type { CharBox, TightBox } from "./types.ts";

// ---- coordinate conversion ----
// Canvas: (x, y) where y increases downward
// Planck: (x, y) where y increases upward
const PX_TO_M = 0.02; // 50px = 1m
const PX_TO_M_INV = 1 / PX_TO_M;

function toPlankX(x: number): number {
  return x * PX_TO_M;
}

function toPlankY(y: number): number {
  return -y * PX_TO_M;
}

function toPlank(x: number, y: number): planck.Vec2 {
  return new planck.Vec2(x * PX_TO_M, -y * PX_TO_M);
}

function toCanvasX(plankX: number): number {
  return plankX * PX_TO_M_INV;
}

function toCanvasY(plankY: number): number {
  return -plankY * PX_TO_M_INV;
}

// ---- physics constants ----
const TIME_STEP = 1 / 60;
const GRAVITY_Y = -10; // downward in planck (Y-up) = downward in canvas (Y-down)
const VEL_ITER = 8;
const POS_ITER = 3;

// ---- collision filtering ----
// Character collides with ground and blocks.
// Blocks are static bodies, so the character cannot push them.
// During inhale, blocks switch to kinematic (driven by InhaleField).
const CAT_CHARACTER = 0x0001; // bit 0
const CAT_BLOCK = 0x0002; // bit 1
const CAT_GROUND = 0x0004; // bit 2
const MASK_ALL = CAT_CHARACTER | CAT_BLOCK | CAT_GROUND; // 0x0007
const MASK_GROUND = CAT_GROUND; // 0x0004
const MASK_BLOCK = CAT_BLOCK | CAT_GROUND; // 0x0006 — character collides with blocks + ground

/**
 * The physical world: a planck.World with ground bricks, spawned blocks,
 * and the character body.
 *
 * All bodies live in the planck world (meters, Y-up). The game layer uses
 * canvas coordinates (pixels, Y-down). The conversion helpers handle the
 * translation in both directions.
 */
export class PhysicsWorld {
  /** Solid ground bricks. */
  readonly ground: GravityBlock[] = [];
  /** Dynamically spawned blocks that fall, stack and can be inhaled. */
  readonly blocks: GravityBlock[] = [];

  /** The underlying planck physics world. */
  readonly world: planck.World;

  /** Static ground bodies. */
  private groundBodies: planck.Body[] = [];
  /** Dynamic block bodies, keyed by GravityBlock. */
  private bodies = new Map<GravityBlock, planck.Body>();
  /** The character body. */
  private charBody: planck.Body | null = null;

  private groundKey = "";
  private _groundY = 0;

  get groundY(): number {
    return this._groundY;
  }

  constructor() {
    this.world = new planck.World(new planck.Vec2(0, GRAVITY_Y));
    this.world.setAllowSleeping(true);
  }

  /** Rebuild the ground bricks. Called every frame; early-outs if unchanged. */
  rebuildGround(
    width: number,
    height: number,
    groundY: number,
    thickness: number,
  ): void {
    const key = `${width}x${height}`;
    if (key === this.groundKey && this.ground.length) return;
    this.groundKey = key;
    this._groundY = groundY;

    // Destroy old ground bodies
    for (const b of this.groundBodies) {
      this.world.destroyBody(b);
    }
    this.groundBodies.length = 0;
    this.ground.length = 0;

    // Create new ground bricks
    const h = Math.max(6, thickness);
    const brickW = Math.max(20, Math.round(height * 0.06 * WORLD_SCALE));
    const start = -GROUND_OVERHANG;
    const end = width + GROUND_OVERHANG;

    for (let x = start; x < end; x += brickW) {
      const w = Math.min(brickW, end - x);

      // Create planck body at canvas center of the brick
      const cx = x + w / 2;
      const cy = groundY + h / 2;
      const body = this.world.createBody({
        type: "static",
        position: toPlank(cx, cy),
      });
      body.createFixture(
        new planck.BoxShape(w * PX_TO_M / 2, h * PX_TO_M / 2),
        {
          friction: 0.8,
          restitution: 0,
          filterCategoryBits: CAT_GROUND,
          filterMaskBits: MASK_ALL,
        },
      );
      this.groundBodies.push(body);

      // Create GravityBlock for rendering
      this.ground.push(new GravityBlock(x, groundY, w, h, "ground"));
    }
  }

  /** Spawn a single square block above the view. */
  spawn(width: number, height: number, charX: number): GravityBlock {
    const size = 24 + Math.random() * 40;
    const w = size;
    const h = size;

    let cx: number;
    if (Math.random() < 0.5) {
      cx = width * 0.15 + Math.random() * width * 0.7;
    } else {
      const sign = Math.random() < 0.5 ? -1 : 1;
      cx = charX + sign * (SPAWN_CLEARANCE + Math.random() * width * 0.4);
    }
    cx = Math.max(width * 0.05, Math.min(width * 0.95, cx));

    const cy = -h / 2 - Math.random() * SPAWN_HEIGHT_JITTER;
    const block = new GravityBlock(cx - w / 2, cy - h / 2, w, h);

    // Create planck body (dynamic + high density so blocks fall & collide
    // with each other, but the character can't meaningfully push them)
    const body = this.world.createDynamicBody(toPlank(cx, cy));
    body.setFixedRotation(true);
    body.createFixture(
      new planck.BoxShape(w * PX_TO_M / 2, h * PX_TO_M / 2),
      {
        density: 1000, // 1000× heavier than character (density 1.6)
        friction: 0.3,
        restitution: 0,
        filterCategoryBits: CAT_BLOCK,
        filterMaskBits: MASK_ALL,
      },
    );
    this.bodies.set(block, body);

    this.blocks.push(block);
    return block;
  }

  /** Clear all spawned blocks. */
  clear(): void {
    for (const [, body] of this.bodies) {
      this.world.destroyBody(body);
    }
    this.bodies.clear();
    this.blocks.length = 0;
  }

  /** All solid blocks (ground + spawned). */
  allSolids(): GravityBlock[] {
    return [...this.ground, ...this.blocks];
  }

  /**
   * Create or update the character body. Called every frame.
   * The character is a dynamic body with fixed rotation.
   */
  setCharacterBody(
    ctx: { canvasWidth: number; groundY: number; flip: boolean; frame: { w: number; h: number }; scale: number },
    tightBox: TightBox,
    px: number,
    py: number,
  ): planck.Body {
    const s = ctx.scale;
    const w = tightBox.bw * s;
    const h = tightBox.bh * s;

    // Compute the character's center in canvas coordinates
    const tightCenterX = ctx.flip
      ? ctx.frame.w - tightBox.bx - tightBox.bw / 2
      : tightBox.bx + tightBox.bw / 2;
    const offX = (-ctx.frame.w * s) / 2 + tightCenterX * s;
    const offY = -ctx.frame.h * s + (tightBox.by + tightBox.bh / 2) * s;

    const canvasX = ctx.canvasWidth / 2 + px + offX;
    const canvasY = ctx.groundY + py + offY;

    if (!this.charBody) {
      this.charBody = this.world.createDynamicBody(
        toPlank(canvasX, canvasY),
      );
      this.charBody.setFixedRotation(true);
      this.charBody.setLinearDamping(0);
      this.charBody.createFixture(
        new planck.BoxShape(w * PX_TO_M / 2, h * PX_TO_M / 2),
        {
          density: 1.6,
          friction: 0,
          restitution: 0,
          filterCategoryBits: CAT_CHARACTER,
          filterMaskBits: MASK_ALL,
        },
      );
    } else {
      // Update the body shape if the tight box changed
      const pos = this.charBody.getPosition();
      const canvasPos = { x: toCanvasX(pos.x), y: toCanvasY(pos.y) };
      const dx = canvasX - canvasPos.x;
      const dy = canvasY - canvasPos.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        this.charBody.setPosition(
          toPlank(canvasX, canvasY),
        );
      }
    }

    return this.charBody;
  }

  /** Get the character body. */
  getCharacterBody(): planck.Body | null {
    return this.charBody;
  }

  /**
   * Apply a vertical jump impulse to the character body.
   * @param impulsePxPerTick vertical impulse in canvas pixels per tick (negative = upward).
   */
  jump(impulsePxPerTick: number): void {
    if (!this.charBody) return;
    const vel = this.charBody.getLinearVelocity();
    // Convert pixels/tick → pixels/second → meters/second
    const vyPerSec = impulsePxPerTick * 60;
    this.charBody.setLinearVelocity(
      new planck.Vec2(vel.x, -toPlankX(vyPerSec)),
    );
  }

  /**
   * Update the world: sync block positions, step the physics, sync back.
   *
   * This is called once per frame from the AnimatorController.
   *
   * @param charVx desired horizontal velocity in pixels/tick (from player input).
   * @param charVy desired vertical velocity in pixels/tick (0 except during jump).
   */
  update(
    deltaTime: number,
    ctx: { canvasWidth: number; canvasHeight: number; groundY: number; flip: boolean; frame: { w: number; h: number }; scale: number },
    tightBox: TightBox,
    charPx: number,
    charPy: number,
    charVx: number,
    charVy: number,
  ): void {
    // 1. Create/update character body
    this.setCharacterBody(ctx, tightBox, charPx, charPy);

    // 2. Sync character horizontal velocity to body.
    // Only set X velocity — preserve Y velocity so planck's gravity works.
    // Convert pixels/tick → pixels/second → meters/second.
    if (this.charBody) {
      const vel = this.charBody.getLinearVelocity();
      const vxPerSec = charVx * 60;
      this.charBody.setLinearVelocity(
        new planck.Vec2(toPlankX(vxPerSec), vel.y),
      );
    }

    // 3. Sync block body types.
    // Inhaled blocks → kinematic (moved by InhaleField).
    // Non-inhaled blocks → dynamic (fall via gravity, collide with each other).
    for (const block of this.blocks) {
      if (block.dead) continue;
      const body = this.bodies.get(block);
      if (!body) continue;

      if (block.inhale) {
        body.setKinematic();
        body.setLinearVelocity(new planck.Vec2(0, 0));
        body.setPosition(
          toPlank(block.x + block.w / 2, block.y + block.h / 2),
        );
      } else {
        body.setDynamic();
      }
    }

    // 4. Step the world
    this.world.step(TIME_STEP, VEL_ITER, POS_ITER);

    // 5. Sync body positions back to blocks (dynamic blocks only).
    // Inhaled blocks are managed by InhaleField — skip them.
    for (const [block, body] of this.bodies) {
      if (block.dead) continue;
      if (block.inhale) continue;

      const pos = body.getPosition();
      const vy = body.getLinearVelocity().y;

      block.x = toCanvasX(pos.x) - block.w / 2;
      block.y = toCanvasY(pos.y) - block.h / 2;
      block.vy = -toCanvasY(vy); // Convert plank Y to canvas Y-down
      block.resting = Math.abs(vy) < 0.01;
    }

    // 6. Sync character position back
    if (this.charBody) {
      const pos = this.charBody.getPosition();
      const vel = this.charBody.getLinearVelocity();

      // Convert to canvas coordinates
      const canvasX = toCanvasX(pos.x);
      const canvasY = toCanvasY(pos.y);

      // Convert to character-local coordinates
      const s = ctx.scale;
      const tightCenterX = ctx.flip
        ? ctx.frame.w - tightBox.bx - tightBox.bw / 2
        : tightBox.bx + tightBox.bw / 2;
      const offX = (-ctx.frame.w * s) / 2 + tightCenterX * s;
      const offY = -ctx.frame.h * s + (tightBox.by + tightBox.bh / 2) * s;

      // px is the character's horizontal offset from center
      // py is the character's vertical offset from ground
      this.charPx = canvasX - offX - ctx.canvasWidth / 2;
      this.charPy = canvasY - offY - ctx.groundY;
      // Convert meters/second → pixels/second → pixels/tick
      this.charVx = toCanvasX(vel.x) / 60;
      this.charVy = toCanvasY(vel.y) / 60;
    }

    // 7. Cull dead and off-screen blocks
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i];
      const gone =
        block.dead ||
        block.y > ctx.canvasHeight + BLOCK_CULL_MARGIN ||
        block.x + block.w < -BLOCK_CULL_MARGIN ||
        block.x > ctx.canvasWidth + BLOCK_CULL_MARGIN;
      if (gone) {
        const body = this.bodies.get(block);
        if (body) {
          this.world.destroyBody(body);
          this.bodies.delete(block);
        }
        this.blocks.splice(i, 1);
      }
    }
  }

  // Internal state for character position sync
  private charPx = 0;
  private charPy = 0;
  private charVx = 0;
  private charVy = 0;

  get charPxValue(): number {
    return this.charPx;
  }

  get charPyValue(): number {
    return this.charPy;
  }

  get charVxValue(): number {
    return this.charVx;
  }

  get charVyValue(): number {
    return this.charVy;
  }
}
