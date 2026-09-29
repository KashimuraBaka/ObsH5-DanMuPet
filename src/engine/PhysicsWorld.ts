import Matter from "matter-js";
import { GravityBlock } from "./GravityBlock.ts";
import {
  BLOCK_CULL_MARGIN,
  GROUND_OVERHANG,
  MAX_FALL_SPEED,
  SPAWN_CLEARANCE,
  SPAWN_HEIGHT_JITTER,
  WORLD_SCALE,
} from "./constants.ts";
import type { CharContext, Frame, TightBox } from "./types.ts";

/**
 * The physical world: the ground bricks, every spawned block, and the
 * character — all simulated by Matter.js.
 *
 * Block dynamics (gravity, stacking, resting on the character) and character
 * dynamics (gravity, landing, collision with blocks) are all handled by the
 * same solver, so there is a single source of truth for every body.
 *
 * Bodies are rectangles in pixel units, stepped at a fixed 16.667ms.
 */

/** Fixed step, matching the game's per-tick timing assumptions. */
const STEP_MS = 1000 / 60;

/** Gravity that yields ~0.5 px/tick^2, matching CHAR_GRAVITY at 60Hz. */
const GRAVITY_Y = 1.8;

/** Collision categories so inhaling blocks can pass through the character. */
const CAT_BLOCK = 0x0001;
const CAT_CHAR = 0x0004;

/** Exact AABB of a body from its vertices (body.bounds carries velocity padding). */
function bodyAABB(body: Matter.Body): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of body.vertices) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export class PhysicsWorld {
  /** Solid ground bricks. */
  readonly ground: GravityBlock[] = [];
  /** Dynamically spawned blocks that fall, stack and can be inhaled. */
  readonly blocks: GravityBlock[] = [];

  private groundKey = "";
  private readonly engine: Matter.Engine;
  private readonly groundBodies: Matter.Body[] = [];
  private readonly bodies = new Map<GravityBlock, Matter.Body>();
  /** Dynamic body for the character, created on the first setCharacterBox() call. */
  private charBody: Matter.Body | null = null;
  /** Cached frame/tight/scale/flip for detecting shape changes. */
  private lastFrame: Frame | null = null;
  private lastTight: TightBox | null = null;
  private lastScale = 1;
  private lastFlip = false;

  constructor() {
    this.engine = Matter.Engine.create({
      gravity: { x: 0, y: GRAVITY_Y, scale: 0.001 },
      enableSleeping: false,
    });
    this.engine.positionIterations = 16;
    this.engine.velocityIterations = 10;
  }

  /**
   * Rebuild the ground bricks.
   *
   * Called every frame from the draw loop, so it early-outs unless the geometry
   * actually changed.
   */
  rebuildGround(
    width: number,
    height: number,
    groundY: number,
    thickness: number,
  ): void {
    const key = `${width}x${height}`;
    if (key === this.groundKey && this.ground.length) return;
    this.groundKey = key;

    for (const body of this.groundBodies) {
      Matter.Composite.remove(this.engine.world, body);
    }
    this.groundBodies.length = 0;
    this.ground.length = 0;

    const h = Math.max(6, thickness);
    const brickW = Math.max(20, Math.round(height * 0.06 * WORLD_SCALE));
    const start = -GROUND_OVERHANG;
    const end = width + GROUND_OVERHANG;

    for (let x = start; x < end; x += brickW) {
      const w = Math.min(brickW, end - x);
      this.ground.push(new GravityBlock(x, groundY, w, h, "ground"));
      const body = Matter.Bodies.rectangle(x + w / 2, groundY + h / 2, w, h, {
        isStatic: true,
        friction: 1,
        frictionStatic: 1,
        restitution: 0,
        slop: 0.02,
      });
      this.groundBodies.push(body);
      Matter.Composite.add(this.engine.world, body);
    }
  }

  /**
   * Drop a fresh block somewhere above the view. It falls into the world under
   * the same Matter.js gravity as everything else.
   */
  spawn(width: number, height: number, charX: number): GravityBlock {
    const w = 24 + Math.random() * 40;
    const h = 24 + Math.random() * 40;
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
    const body = Matter.Bodies.rectangle(cx, cy, w, h, {
      friction: 0.3,
      frictionStatic: 0.5,
      restitution: 0,
      slop: 0.02,
      density: 0.001,
      inertia: 0,
      collisionFilter: { category: CAT_BLOCK, mask: 0xffff },
    });
    this.blocks.push(block);
    this.bodies.set(block, body);
    Matter.Composite.add(this.engine.world, body);
    return block;
  }

  clear(): void {
    for (const b of this.blocks) {
      const body = this.bodies.get(b);
      if (body) Matter.Composite.remove(this.engine.world, body);
    }
    this.blocks.length = 0;
    this.bodies.clear();
  }

  /** Every solid rectangle the character can stand on. */
  allSolids(): GravityBlock[] {
    return [...this.ground, ...this.blocks];
  }

  /** The character's physics body, or null before the first setCharacterBox(). */
  get characterBody(): Matter.Body | null {
    return this.charBody;
  }

  /**
   * Create or update the character's physics body to match the current frame's
   * tight box. When the frame (or flip) changes, the body position is adjusted
   * so the visual anchor stays stable across animation frames.
   */
  setCharacterBox(ctx: CharContext, tight: TightBox): void {
    const s = ctx.scale;
    const w = Math.max(1, tight.bw * s);
    const h = Math.max(1, tight.bh * s);

    // Tight-box centre offset within the frame (from frame bottom-centre)
    const tightCenterX = ctx.flip
      ? ctx.frame.w - tight.bx - tight.bw / 2
      : tight.bx + tight.bw / 2;
    const offX = (-ctx.frame.w * s) / 2 + tightCenterX * s;
    const offY = -ctx.frame.h * s + (tight.by + tight.bh / 2) * s;

    if (!this.charBody) {
      // First time: create the body at the character's initial position
      const cx = ctx.canvasWidth / 2 + offX;
      const cy = ctx.groundY + offY;
      this.charBody = Matter.Bodies.rectangle(cx, cy, w, h, {
        friction: 0,
        frictionStatic: 0,
        restitution: 0,
        slop: 0.02,
        inertia: 0,
        density: 0.01,
        collisionFilter: { category: CAT_CHAR, mask: 0xffff },
      });
      Matter.Composite.add(this.engine.world, this.charBody);
    } else if (
      this.lastFrame &&
      (this.lastFrame !== ctx.frame ||
        this.lastTight !== tight ||
        this.lastScale !== s ||
        this.lastFlip !== ctx.flip)
    ) {
      // Frame / tight box / scale / flip changed: adjust the body position so
      // the visual anchor stays the same. The tight-box centre moves within
      // the frame, so compensating keeps the sprite from shifting.
      const oldFrame = this.lastFrame;
      const oldTight = this.lastTight!;
      const oldS = this.lastScale;
      const oldFlip = this.lastFlip;

      const oldTightCenterX = oldFlip
        ? oldFrame.w - oldTight.bx - oldTight.bw / 2
        : oldTight.bx + oldTight.bw / 2;
      const oldOffX = (-oldFrame.w * oldS) / 2 + oldTightCenterX * oldS;
      const oldOffY =
        -oldFrame.h * oldS + (oldTight.by + oldTight.bh / 2) * oldS;

      const dx = offX - oldOffX;
      const dy = offY - oldOffY;
      Matter.Body.setPosition(this.charBody, {
        x: this.charBody.position.x + dx,
        y: this.charBody.position.y + dy,
      });
    }

    this.lastFrame = ctx.frame;
    this.lastTight = tight;
    this.lastScale = s;
    this.lastFlip = ctx.flip;

    // Update the collision vertices at the current position.
    const pos = this.charBody.position;
    Matter.Body.setVertices(this.charBody, [
      { x: pos.x - w / 2, y: pos.y - h / 2 },
      { x: pos.x + w / 2, y: pos.y - h / 2 },
      { x: pos.x + w / 2, y: pos.y + h / 2 },
      { x: pos.x - w / 2, y: pos.y + h / 2 },
    ]);
  }

  /**
   * One physics step for the world: update the character body shape, push
   * externally modified block wrappers back to their bodies, clamp velocities,
   * run the solver, and sync every wrapper.
   */
  update(
    deltaTime: number,
    charCtx: CharContext,
    tight: TightBox,
    viewWidth: number,
    viewHeight: number,
  ): void {
    // 1. Update the character body shape for the current frame.
    this.setCharacterBox(charCtx, tight);

    // 2. Push externally modified block wrappers back to their bodies
    //    (the inhale field repositions blocks directly).
    this.applyOverrides();

    // 3. Clamp velocities before the solver runs.
    this.clampVelocities();

    // 4. Run the solver.
    Matter.Engine.update(this.engine, deltaTime);

    // 5. Sync every block wrapper from its body.
    this.syncFromBodies();

    // 6. Cull dead and fallen-past-the-view blocks.
    this.cullBlocks(viewWidth, viewHeight);
  }

  /**
   * Push externally moved wrappers back to their bodies. The inhale field
   * repositions blocks directly; this keeps the bodies in sync so the solver
   * starts from the correct state.
   */
  private applyOverrides(): void {
    for (const b of this.blocks) {
      const body = this.bodies.get(b);
      if (!body) continue;
      const aabb = bodyAABB(body);
      if (
        Math.abs(aabb.x - b.x) > 0.5 ||
        Math.abs(aabb.y - b.y) > 0.5 ||
        body.angle !== 0
      ) {
        Matter.Body.setAngle(body, 0);
        Matter.Body.setPosition(body, {
          x: b.x + b.w / 2,
          y: b.y + b.h / 2,
        });
        // A teleported body must not drag its old velocity into the solver.
        Matter.Body.setVelocity(body, { x: 0, y: 0 });
      }
    }
  }

  /** Clamp every body's vertical and horizontal speed before the solver runs. */
  private clampVelocities(): void {
    const MAX_H_SPEED = 10;
    for (const b of this.blocks) {
      const body = this.bodies.get(b);
      if (!body) continue;
      if (body.velocity.y > MAX_FALL_SPEED) {
        Matter.Body.setVelocity(body, {
          x: body.velocity.x,
          y: MAX_FALL_SPEED,
        });
      }
      if (Math.abs(body.velocity.x) > MAX_H_SPEED) {
        Matter.Body.setVelocity(body, {
          x: body.velocity.x > 0 ? MAX_H_SPEED : -MAX_H_SPEED,
          y: body.velocity.y,
        });
      }
    }
    if (this.charBody) {
      if (this.charBody.velocity.y > MAX_FALL_SPEED) {
        Matter.Body.setVelocity(this.charBody, {
          x: this.charBody.velocity.x,
          y: MAX_FALL_SPEED,
        });
      }
      if (Math.abs(this.charBody.velocity.x) > MAX_H_SPEED) {
        Matter.Body.setVelocity(this.charBody, {
          x: this.charBody.velocity.x > 0 ? MAX_H_SPEED : -MAX_H_SPEED,
          y: this.charBody.velocity.y,
        });
      }
    }
  }

  /** Sync block wrappers from their bodies. The character is synced separately. */
  private syncFromBodies(): void {
    for (const b of this.blocks) {
      const body = this.bodies.get(b);
      if (!body) continue;
      const aabb = bodyAABB(body);
      b.x = aabb.x;
      b.y = aabb.y;
      b.w = aabb.w;
      b.h = aabb.h;
    }
  }

  /** Drop eaten and fallen-past-the-view blocks. */
  private cullBlocks(viewWidth: number, viewHeight: number): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i];
      const body = this.bodies.get(block);
      const gone =
        !body ||
        block.dead ||
        block.y > viewHeight + BLOCK_CULL_MARGIN ||
        block.x + block.w < -BLOCK_CULL_MARGIN ||
        block.x > viewWidth + BLOCK_CULL_MARGIN;
      if (!gone) continue;
      if (body) Matter.Composite.remove(this.engine.world, body);
      this.bodies.delete(block);
      this.blocks.splice(i, 1);
    }
  }
}
