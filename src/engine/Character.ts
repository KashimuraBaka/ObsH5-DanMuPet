import Matter from "matter-js";
import { INHALE_BODY_MULT } from "./constants.ts";
import type {
  CharBox,
  CharContext,
  Frame,
  InhaleAnchor,
  Point,
  TightBox,
} from "./types.ts";

/** Alpha above this counts as an opaque pixel when computing the tight box. */
const ALPHA_THRESHOLD = 16;

/** Tolerance for considering the body at rest on the ground. */
const GROUND_VY_THRESHOLD = 0.5;

/** Tolerance for considering the body to have been falling (just landed). */
const LAND_FALL_THRESHOLD = 0.5;

/**
 * The character: a Matter.js body whose position is the source of truth for
 * the collision geometry.
 *
 * `x`/`y` are computed from the body position using the current frame's tight
 * box, which is what the renderer already consumes. All physics (gravity,
 * landing, collision) is handled by the Matter.js solver — this class only
 * exposes the body state and sets velocities for input.
 */
export class Character {
  private spriteSheet: HTMLImageElement | null = null;
  private readonly tightCache = new Map<string, TightBox>();
  private body: Matter.Body | null = null;
  private lastCtx: CharContext | null = null;
  private _isOnGround = true;
  private _wasOnGround = true;
  private _justLanded = false;
  private _prevVelocityY = 0;

  // ---- computed state (from the body) ----

  /** Horizontal offset from the canvas centre. */
  get x(): number {
    if (!this.body || !this.lastCtx) return 0;
    const ctx = this.lastCtx;
    const tight = this.getTightBox(ctx.frame);
    const s = ctx.scale;
    const tightCenterX = ctx.flip
      ? ctx.frame.w - tight.bx - tight.bw / 2
      : tight.bx + tight.bw / 2;
    const offX = (-ctx.frame.w * s) / 2 + tightCenterX * s;
    return this.body.position.x - offX - ctx.canvasWidth / 2;
  }

  /** Vertical offset from the ground surface; 0 means standing on the ground. */
  get y(): number {
    if (!this.body || !this.lastCtx) return 0;
    const ctx = this.lastCtx;
    const tight = this.getTightBox(ctx.frame);
    const s = ctx.scale;
    const tightCenterY = tight.by + tight.bh / 2;
    const offY = -ctx.frame.h * s + tightCenterY * s;
    return this.body.position.y - offY - ctx.groundY;
  }

  get velocityY(): number {
    return this.body ? this.body.velocity.y : 0;
  }

  get velocityX(): number {
    return this.body ? this.body.velocity.x : 0;
  }

  get isOnGround(): boolean {
    return this._isOnGround;
  }

  get wasOnGround(): boolean {
    return this._wasOnGround;
  }

  get justLanded(): boolean {
    return this._justLanded;
  }

  // ---- sprite / tight-box (unchanged) ----

  setSpriteSheet(sheet: HTMLImageElement | null): void {
    if (this.spriteSheet === sheet) return;
    this.spriteSheet = sheet;
    this.tightCache.clear();
  }

  getTightBox(frame: Frame): TightBox {
    const key = `${frame.name}|${frame.x},${frame.y},${frame.w},${frame.h}`;
    const cached = this.tightCache.get(key);
    if (cached) return cached;

    let box: TightBox = { bx: 0, by: 0, bw: frame.w, bh: frame.h };

    if (this.spriteSheet) {
      const c = document.createElement("canvas");
      c.width = frame.w;
      c.height = frame.h;
      const g = c.getContext("2d");
      if (g) {
        g.drawImage(
          this.spriteSheet,
          frame.x,
          frame.y,
          frame.w,
          frame.h,
          0,
          0,
          frame.w,
          frame.h,
        );
        try {
          const data = g.getImageData(0, 0, frame.w, frame.h).data;
          let minX = frame.w;
          let minY = frame.h;
          let maxX = -1;
          let maxY = -1;
          for (let py = 0; py < frame.h; py++) {
            for (let px = 0; px < frame.w; px++) {
              if (data[(py * frame.w + px) * 4 + 3] > ALPHA_THRESHOLD) {
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;
              }
            }
          }
          if (maxX >= 0) {
            box = {
              bx: minX,
              by: minY,
              bw: maxX - minX + 1,
              bh: maxY - minY + 1,
            };
          }
        } catch {
          // getImageData can fail on a tainted canvas; keep the full frame
        }
      }
    }

    this.tightCache.set(key, box);
    return box;
  }

  // ---- collision geometry ----

  /**
   * The collision box in canvas coordinates, derived from the sprite's opaque
   * pixels rather than its (padded) frame rectangle.
   */
  getBox(ctx: CharContext): CharBox | null {
    const tight = this.getTightBox(ctx.frame);
    const s = ctx.scale;

    if (!this.body) {
      // Fallback: compute from default position (0, 0)
      const rectLeft = ctx.canvasWidth / 2 - (ctx.frame.w * s) / 2;
      const rectBottom = ctx.groundY;
      const left = ctx.flip
        ? rectLeft + (ctx.frame.w - tight.bx - tight.bw) * s
        : rectLeft + tight.bx * s;
      return {
        left,
        right: left + tight.bw * s,
        top: rectBottom - ctx.frame.h * s + tight.by * s,
        bottom: rectBottom - ctx.frame.h * s + (tight.by + tight.bh) * s,
        feetInset: (ctx.frame.h - tight.by - tight.bh) * s,
      };
    }

    // Body position IS the tight-box centre
    const bx = this.body.position.x;
    const by = this.body.position.y;
    const left = bx - (tight.bw * s) / 2;
    const top = by - (tight.bh * s) / 2;
    return {
      left,
      right: left + tight.bw * s,
      top,
      bottom: top + tight.bh * s,
      feetInset: (ctx.frame.h - tight.by - tight.bh) * s,
    };
  }

  // ---- inhale / mouth geometry (unchanged) ----

  getInhaleAnchor(ctx: CharContext): InhaleAnchor | null {
    const box = this.getBox(ctx);
    if (!box) return null;
    const dir: 1 | -1 = ctx.flip ? 1 : -1;
    const bodyLen = box.bottom - box.top;
    const range = bodyLen * INHALE_BODY_MULT;
    const mouthX = ctx.flip ? box.right : box.left;
    return {
      x: mouthX,
      y: box.top + bodyLen * 0.42,
      bodyLen,
      range,
      dir,
    };
  }

  getMouthPos(ctx: CharContext): Point {
    const box = this.getBox(ctx);
    if (!box) return { x: ctx.canvasWidth / 2, y: ctx.groundY };
    return {
      x: ctx.flip ? box.left : box.right,
      y: box.top + (box.bottom - box.top) * 0.42,
    };
  }

  // ---- input / state ----

  /** Set the desired horizontal velocity (called before the solver runs). */
  setVelocityX(vx: number): void {
    if (!this.body) return;
    Matter.Body.setVelocity(this.body, { x: vx, y: this.body.velocity.y });
  }

  /** Launch upward, e.g. on a jump key press. */
  jump(impulse: number): void {
    if (!this.body) return;
    Matter.Body.setVelocity(this.body, { x: this.body.velocity.x, y: impulse });
  }

  /**
   * Drop whatever surface was remembered and fall. The solver handles this
   * automatically (no ground below = fall), so this is a no-op kept for
   * backward compatibility.
   */
  detach(): void {
    // No-op: the solver handles landing and falling automatically.
  }

  /** Teleport horizontally for screen wrap-around. */
  teleportX(x: number): void {
    if (!this.body || !this.lastCtx) return;
    const ctx = this.lastCtx;
    const tight = this.getTightBox(ctx.frame);
    const s = ctx.scale;
    const tightCenterX = ctx.flip
      ? ctx.frame.w - tight.bx - tight.bw / 2
      : tight.bx + tight.bw / 2;
    const offX = (-ctx.frame.w * s) / 2 + tightCenterX * s;
    const bodyX = ctx.canvasWidth / 2 + x + offX;
    Matter.Body.setPosition(this.body, { x: bodyX, y: this.body.position.y });
    Matter.Body.setVelocity(this.body, { x: 0, y: this.body.velocity.y });
  }

  /** Snap the character to the ground surface, zeroing velocity. */
  snapToGround(groundY: number): void {
    if (!this.body || !this.lastCtx) return;
    const ctx = this.lastCtx;
    const tight = this.getTightBox(ctx.frame);
    const s = ctx.scale;
    const tightCenterY = tight.by + tight.bh / 2;
    const offY = -ctx.frame.h * s + tightCenterY * s;
    const bodyY = groundY + offY;
    Matter.Body.setPosition(this.body, { x: this.body.position.x, y: bodyY });
    Matter.Body.setVelocity(this.body, { x: 0, y: 0 });
  }

  /**
   * Read back the body state after the solver runs. Computes `isOnGround`,
   * `wasOnGround`, and `justLanded` for the animation state machine.
   */
  sync(ctx: CharContext, body: Matter.Body | null): void {
    this.body = body;
    this.lastCtx = ctx;
    if (!body) return;

    const vy = body.velocity.y;
    const prevVy = this._prevVelocityY;
    const isGrounded = Math.abs(vy) < GROUND_VY_THRESHOLD;

    this._justLanded =
      !this._wasOnGround && isGrounded && prevVy > LAND_FALL_THRESHOLD;
    this._wasOnGround = this._isOnGround;
    this._isOnGround = isGrounded;
    this._prevVelocityY = vy;
  }
}
