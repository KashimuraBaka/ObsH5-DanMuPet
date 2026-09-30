import { PhysicsWorld } from "./PhysicsWorld.ts";
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

/** Tolerance for considering the character at rest on the ground. */
const GROUND_VY_THRESHOLD = 0.5;

/** Tolerance for considering the character to have been falling (just landed). */
const LAND_FALL_THRESHOLD = 0.5;

/**
 * The character: a planck.js dynamic body whose position is the source of
 * truth for the collision geometry.
 *
 * `_px`/`_py` track the character's offset from the canvas centre / ground
 * in canvas coordinates. The PhysicsWorld handles the actual physics.
 */
export class Character {
  private spriteSheet: HTMLImageElement | null = null;
  private readonly tightCache = new Map<string, TightBox>();

  // Physics state (canvas coordinates)
  private _px = 0;
  private _py = 0;
  private _vx = 0;
  private _vy = 0;
  private _onGround = true;
  private _wasOnGround = true;
  private _justLanded = false;
  private _prevVy = 0;

  // Cached geometry for detecting shape changes
  private lastCtx: CharContext | null = null;
  private lastFrame: Frame | null = null;
  private lastTight: TightBox | null = null;
  private lastScale = 1;
  private lastFlip = false;

  // ---- computed state ----

  /** Horizontal offset from the canvas centre (pixels). */
  get x(): number {
    return this._px;
  }

  /** Vertical offset from the ground surface; 0 means standing on the ground. */
  get y(): number {
    return this._py;
  }

  get velocityY(): number {
    return this._vy;
  }

  get velocityX(): number {
    return this._vx;
  }

  get isOnGround(): boolean {
    return this._onGround;
  }

  get wasOnGround(): boolean {
    return this._wasOnGround;
  }

  get justLanded(): boolean {
    return this._justLanded;
  }

  // ---- sprite / tight-box ----

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
          let minX = frame.w,
            minY = frame.h,
            maxX = -1,
            maxY = -1;
          for (let py = 0; py < frame.h; py++) {
            for (let px = 0; px < frame.w; px++) {
              if (data[(py * frame.w + px) * 4 + 3] >= ALPHA_THRESHOLD) {
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;
              }
            }
          }
          if (maxX >= minX && maxY >= minY) {
            box = {
              bx: minX,
              by: minY,
              bw: maxX - minX + 1,
              bh: maxY - minY + 1,
            };
          }
        } catch (_e) {
          // Tainted canvas — fall back to the full frame.
        }
      }
    }

    this.tightCache.set(key, box);
    return box;
  }

  getBox(ctx: CharContext): CharBox | null {
    const tight = this.getTightBox(ctx.frame);
    const s = ctx.scale;
    const w = tight.bw * s;
    const h = tight.bh * s;

    // Compute the character's center in canvas coordinates
    const tightCenterX = ctx.flip
      ? ctx.frame.w - tight.bx - tight.bw / 2
      : tight.bx + tight.bw / 2;
    const offX = (-ctx.frame.w * s) / 2 + tightCenterX * s;
    const offY = -ctx.frame.h * s + (tight.by + tight.bh / 2) * s;

    const canvasX = ctx.canvasWidth / 2 + this._px + offX;
    const canvasY = ctx.groundY + this._py + offY;

    return {
      left: canvasX - w / 2,
      right: canvasX + w / 2,
      top: canvasY - h / 2,
      bottom: canvasY + h / 2,
      feetInset: 0,
    };
  }

  getInhaleAnchor(ctx: CharContext): InhaleAnchor | null {
    if (!this.lastCtx) return null;
    const s = ctx.scale;
    const tight = this.getTightBox(ctx.frame);

    // Compute the character's center in canvas coordinates
    const tightCenterX = ctx.flip
      ? ctx.frame.w - tight.bx - tight.bw / 2
      : tight.bx + tight.bw / 2;
    const offX = (-ctx.frame.w * s) / 2 + tightCenterX * s;
    const offY = -ctx.frame.h * s + (tight.by + tight.bh / 2) * s;

    const canvasX = ctx.canvasWidth / 2 + this._px + offX;
    const canvasY = ctx.groundY + this._py + offY;

    return {
      x: canvasX,
      y: canvasY,
      bodyLen: tight.bh * s,
      range: 0,
      dir: ctx.flip ? -1 : 1,
    };
  }

  getMouthPos(ctx: CharContext): Point {
    const s = ctx.scale;
    const tight = this.getTightBox(ctx.frame);

    // Compute the character's center in canvas coordinates
    const tightCenterX = ctx.flip
      ? ctx.frame.w - tight.bx - tight.bw / 2
      : tight.bx + tight.bw / 2;
    const offX = (-ctx.frame.w * s) / 2 + tightCenterX * s;
    const offY = -ctx.frame.h * s + (tight.by + tight.bh / 2) * s;

    const canvasX = ctx.canvasWidth / 2 + this._px + offX;
    const canvasY = ctx.groundY + this._py + offY;

    return {
      x: canvasX,
      y: canvasY - (tight.bh * s) * 0.35,
    };
  }

  // ---- input ----

  setVelocityX(vx: number): void {
    this._vx = vx;
  }

  jump(impulse: number): void {
    this._vy = impulse;
    this._onGround = false;
    this._wasOnGround = false;
  }

  /** Teleport horizontally, keeping the current height. */
  teleportX(x: number): void {
    if (!this.lastCtx) return;
    this._px = x;
  }

  /** Hard-snap to the ground surface. */
  snapToGround(groundY: number): void {
    if (!this.lastCtx) return;
    const ctx = this.lastCtx;
    const tight = this.getTightBox(ctx.frame);
    const s = ctx.scale;
    const tightCenterY = tight.by + tight.bh / 2;
    const offY = -ctx.frame.h * s + tightCenterY * s;
    // Place body so its bottom rests on groundY
    this._py = groundY - ctx.groundY - offY - (tight.bh * s) / 2;
    this._vy = 0;
    this._onGround = true;
    this._wasOnGround = true;
  }

  // ---- physics update ----

  /**
   * Called by the AnimatorController after the PhysicsWorld has stepped.
   * Reads the character's position and velocity from the physics world
   * and updates the state (onGround, justLanded, etc).
   */
  sync(
    ctx: CharContext,
    world: PhysicsWorld,
    charPx: number,
    charPy: number,
    charVx: number,
    charVy: number,
  ): void {
    this._px = charPx;
    this._py = charPy;
    this._vx = charVx;
    this._vy = charVy;
    this.lastCtx = ctx;

    const tight = this.getTightBox(ctx.frame);
    const s = ctx.scale;
    const tightCenterX = ctx.flip
      ? ctx.frame.w - tight.bx - tight.bw / 2
      : tight.bx + tight.bw / 2;
    const offX = (-ctx.frame.w * s) / 2 + tightCenterX * s;
    const offY = -ctx.frame.h * s + (tight.by + tight.bh / 2) * s;

    // Check if the character is on the ground or on any solid block
    const canvasY = ctx.groundY + this._py + offY;
    const bottom = canvasY + (tight.bh * s) / 2;
    const canvasX = ctx.canvasWidth / 2 + this._px + offX;
    const charLeft = canvasX - (tight.bw * s) / 2;
    const charRight = canvasX + (tight.bw * s) / 2;

    let isOnGround = bottom >= ctx.groundY - 0.5;

    if (!isOnGround) {
      for (const block of world.allSolids()) {
        if (block.dead) continue;
        const blockTop = block.top;
        const blockLeft = block.x;
        const blockRight = block.x + block.w;
        // Check vertical: bottom within 2px of block's top surface
        if (Math.abs(bottom - blockTop) < 2) {
          // Check horizontal overlap
          if (charLeft < blockRight && charRight > blockLeft) {
            isOnGround = true;
            break;
          }
        }
      }
    }

    this._justLanded =
      !this._wasOnGround && isOnGround && this._prevVy > LAND_FALL_THRESHOLD;
    this._wasOnGround = this._onGround;
    this._onGround = isOnGround;
    this._prevVy = charVy;
  }
}
