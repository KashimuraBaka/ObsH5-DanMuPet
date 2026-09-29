import { PhysicsWorld } from './PhysicsWorld.ts'
import { CHAR_GRAVITY, INHALE_BODY_MULT, LAND_NEAR_TOP, MAX_FALL_SPEED } from './constants.ts'
import type { CharBox, CharContext, Frame, InhaleAnchor, Point, TightBox, VerticalStepResult } from './types.ts'

/** Alpha above this counts as an opaque pixel when computing the tight box. */
const ALPHA_THRESHOLD = 16

/**
 * The character: position, velocity, and the pixel-tight collision geometry.
 *
 * `x`/`y` are offsets from the render origin (canvas centre / ground surface),
 * which is what the renderer already consumes, so no conversion is needed on
 * the way out.
 */
export class Character {
  /** Horizontal offset from the canvas centre. */
  x = 0
  /** Vertical offset from the ground surface; 0 means standing on the ground. */
  y = 0
  velocityY = 0
  /** Canvas Y of the surface being stood on, or null while airborne. */
  supportSurfaceY: number | null = null
  isOnGround = true

  private spriteSheet: HTMLImageElement | null = null
  private readonly tightCache = new Map<string, TightBox>()

  /**
   * Point the character at a sprite sheet. Changing the sheet invalidates the
   * tight-box cache, since every cached value was derived from the old pixels.
   */
  setSpriteSheet(sheet: HTMLImageElement | null): void {
    if (this.spriteSheet === sheet) return
    this.spriteSheet = sheet
    this.tightCache.clear()
  }

  /**
   * Pixel-tight bounding box of a sprite frame: the smallest rectangle that
   * contains every non-transparent pixel.
   *
   * Cached per sprite because scanning is O(w*h) and the sheet never changes.
   * Falls back to the full frame if the canvas is tainted or the sheet is not
   * loaded yet.
   */
  getTightBox(frame: Frame): TightBox {
    const key = `${frame.name}|${frame.x},${frame.y},${frame.w},${frame.h}`
    const cached = this.tightCache.get(key)
    if (cached) return cached

    let box: TightBox = { bx: 0, by: 0, bw: frame.w, bh: frame.h }

    if (this.spriteSheet) {
      const c = document.createElement('canvas')
      c.width = frame.w
      c.height = frame.h
      const g = c.getContext('2d')
      if (g) {
        g.drawImage(this.spriteSheet, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h)
        try {
          const data = g.getImageData(0, 0, frame.w, frame.h).data
          let minX = frame.w
          let minY = frame.h
          let maxX = -1
          let maxY = -1
          for (let py = 0; py < frame.h; py++) {
            for (let px = 0; px < frame.w; px++) {
              if (data[(py * frame.w + px) * 4 + 3] > ALPHA_THRESHOLD) {
                if (px < minX) minX = px
                if (px > maxX) maxX = px
                if (py < minY) minY = py
                if (py > maxY) maxY = py
              }
            }
          }
          if (maxX >= 0) {
            box = { bx: minX, by: minY, bw: maxX - minX + 1, bh: maxY - minY + 1 }
          }
        } catch {
          // getImageData can fail on a tainted canvas; keep the full frame
        }
      }
    }

    this.tightCache.set(key, box)
    return box
  }

  /**
   * The collision box in canvas coordinates, derived from the sprite's opaque
   * pixels rather than its (padded) frame rectangle.
   */
  getBox(ctx: CharContext): CharBox | null {
    const { frame } = ctx
    const tight = this.getTightBox(frame)
    const s = ctx.scale
    const rectLeft = ctx.canvasWidth / 2 + this.x - frame.w * s / 2
    const rectBottom = ctx.groundY + this.y

    // A mirrored sprite maps local x to (frame.w - x), so the tight box has to
    // be folded back the other way.
    const left = ctx.flip
      ? rectLeft + (frame.w - tight.bx - tight.bw) * s
      : rectLeft + tight.bx * s

    return {
      left,
      right: left + tight.bw * s,
      top: rectBottom - frame.h * s + tight.by * s,
      bottom: rectBottom - frame.h * s + (tight.by + tight.bh) * s,
      // distance from the frame's bottom edge down to the lowest opaque pixel
      feetInset: (frame.h - tight.by - tight.bh) * s
    }
  }

  /**
   * The inhale anchor: the character's centre, the reach, and the facing
   * direction. The effective field is a half-disc of 3-4 body lengths opening
   * the way he looks, so things behind him are never pulled in.
   */
  getInhaleAnchor(ctx: CharContext): InhaleAnchor | null {
    const box = this.getBox(ctx)
    if (!box) return null
    const bodyLen = box.bottom - box.top
    return {
      x: (box.left + box.right) / 2,
      y: (box.top + box.bottom) / 2,
      bodyLen,
      range: bodyLen * INHALE_BODY_MULT,
      // The sprite's default facing is left, so a flipped sprite faces RIGHT.
      dir: ctx.flip ? 1 : -1
    }
  }

  /** Where the mouth is, in canvas coordinates - the inhale target. */
  getMouthPos(ctx: CharContext): Point {
    const box = this.getBox(ctx)
    if (!box) return { x: ctx.canvasWidth / 2, y: ctx.groundY - 20 }
    const h = box.bottom - box.top
    return {
      x: ctx.flip ? box.left - 6 : box.right + 6,
      y: box.top + h * 0.38
    }
  }

  /**
   * Move horizontally, refusing the step if it would push the character inside
   * a block.
   */
  tryMoveX(world: PhysicsWorld, delta: number, ctx: CharContext): boolean {
    const before = this.x
    this.x += delta
    if (world.hitsSolid(this.getBox(ctx))) {
      this.x = before
      return false
    }
    return true
  }

  /**
   * One tick of vertical physics: gravity plus collision against the world's
   * blocks, using the pixel-tight box so the character lands exactly where his
   * visible feet touch a surface.
   *
   * Returns what happened so the caller can drive the animation state machine
   * without the engine knowing about it.
   */
  stepVertical(world: PhysicsWorld, ctx: CharContext): VerticalStepResult {
    const box = this.getBox(ctx)

    if (this.supportSurfaceY !== null && this.velocityY <= 0) {
      // Standing: re-glue using THIS frame's tight box. This is what makes the
      // contact frame-independent - no tolerance juggling, no sinking.
      this.y = this.supportSurfaceY - ctx.groundY + (box ? box.feetInset : 0)
      this.velocityY = 0
      this.isOnGround = true

      // Still on a surface? He may have walked off an edge, or the block he was
      // standing on may have been inhaled.
      if (!world.surfaceStillThere(box, this.supportSurfaceY)) {
        this.supportSurfaceY = null
        this.isOnGround = false
        return { kind: 'airborne' }
      }
      return { kind: 'standing' }
    }

    // Airborne
    const prevBox = box
    this.velocityY = Math.min(this.velocityY + CHAR_GRAVITY, MAX_FALL_SPEED)
    this.y += this.velocityY

    const moved = this.getBox(ctx)
    let supportY: number | null = null
    if (prevBox && moved) {
      for (const b of world.allSolids()) {
        if (moved.right <= b.x || moved.left >= b.x + b.w) continue
        // Either the feet crossed the top surface this tick (fast falls), or
        // they are already resting within a few px of it (standing / the tight
        // box changed between frames).
        const crossed = prevBox.bottom <= b.y && moved.bottom >= b.y
        const nearTop = Math.abs(moved.bottom - b.y) <= LAND_NEAR_TOP
        if (crossed || nearTop) {
          if (supportY === null || b.y < supportY) supportY = b.y
        }
      }
    }

    if (this.velocityY >= 0 && supportY !== null && moved) {
      this.supportSurfaceY = supportY
      // Snap so the lowest opaque pixel rests exactly on the surface
      this.y = supportY - ctx.groundY + moved.feetInset
      this.velocityY = 0
      if (!this.isOnGround) {
        this.isOnGround = true
        return { kind: 'landed', surfaceY: supportY }
      }
      return { kind: 'standing' }
    }

    this.isOnGround = false
    return { kind: 'airborne' }
  }

  /** Launch upward, e.g. on a jump key press. */
  jump(impulse: number): void {
    this.velocityY = impulse
    this.supportSurfaceY = null
    this.isOnGround = false
  }

  /** Drop whatever surface was remembered and fall. */
  detach(): void {
    this.supportSurfaceY = null
    this.isOnGround = false
  }
}
