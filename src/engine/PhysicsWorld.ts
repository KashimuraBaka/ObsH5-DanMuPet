import { GravityBlock } from './GravityBlock.ts'
import {
  BLOCK_CULL_MARGIN,
  CHAR_GRAVITY,
  GROUND_OVERHANG,
  MAX_FALL_SPEED,
  SOLID_EPS,
  SPAWN_CLEARANCE,
  SPAWN_HEIGHT_JITTER,
  WORLD_SCALE
} from './constants.ts'
import type { CharBox, Rect } from './types.ts'

/**
 * The physical world: the ground bricks plus every spawned block.
 *
 * Owns all block state and every query the character needs, so the Vue layer
 * only has to hand it a canvas size and a character box.
 */
export class PhysicsWorld {
  /** Solid ground bricks. */
  readonly ground: GravityBlock[] = []
  /** Dynamically spawned blocks that fall, stack and can be inhaled. */
  readonly blocks: GravityBlock[] = []

  private groundKey = ''

  /**
   * Rebuild the ground bricks.
   *
   * Called every frame from the draw loop, so it early-outs unless the geometry
   * actually changed.
   */
  rebuildGround(width: number, height: number, groundY: number, thickness: number): void {
    const key = `${width}x${height}`
    if (key === this.groundKey && this.ground.length) return
    this.groundKey = key

    const h = Math.max(6, thickness)
    const brickW = Math.max(20, Math.round(height * 0.06 * WORLD_SCALE))
    const start = -GROUND_OVERHANG
    const end = width + GROUND_OVERHANG

    this.ground.length = 0
    for (let x = start; x < end; x += brickW) {
      this.ground.push(new GravityBlock(x, groundY, Math.min(brickW, end - x), h, 'ground'))
    }
  }

  /**
   * Spawn a block above the view, away from the character so it never starts
   * intersecting him.
   */
  spawn(width: number, height: number, charX: number): GravityBlock {
    const size = 24 + Math.random() * 20
    let x = 0
    for (let tries = 0; tries < 12; tries++) {
      x = 70 + Math.random() * Math.max(1, width - 140 - size)
      if (Math.abs(x + size / 2 - charX) > SPAWN_CLEARANCE) break
    }
    const block = new GravityBlock(
      x,
      -size - Math.random() * SPAWN_HEIGHT_JITTER,
      size,
      size,
      'spawned'
    )
    this.blocks.push(block)
    return block
  }

  clear(): void {
    this.blocks.length = 0
  }

  /** Every solid rectangle, dead blocks excluded. */
  allSolids(): GravityBlock[] {
    return this.ground.concat(this.blocks.filter(b => !b.dead))
  }

  /**
   * True when the box intersects any solid.
   * Used to refuse a horizontal step that would push the character inside a block.
   */
  hitsSolid(box: CharBox | null): boolean {
    if (!box) return false
    const eps = SOLID_EPS
    for (const blk of this.allSolids()) {
      if (box.right <= blk.x + eps || box.left >= blk.x + blk.w - eps) continue
      if (box.bottom <= blk.y + eps || box.top >= blk.y + blk.h - eps) continue
      return true
    }
    return false
  }

  /**
   * Is there still a block whose top sits exactly at `surfaceY` under the
   * character? Used to notice that he walked off an edge, or that the block he
   * was standing on got inhaled.
   */
  surfaceStillThere(box: CharBox | null, surfaceY: number): boolean {
    if (!box) return false
    for (const b of this.allSolids()) {
      if (Math.abs(b.y - surfaceY) > 0.01) continue
      if (box.right <= b.x || box.left >= b.x + b.w) continue
      return true
    }
    return false
  }

  /**
   * Gravity and landing for the spawned blocks.
   *
   * The character's box counts as a solid, so a block can come to rest on
   * Kirby's head and fall away again when he walks off.
   */
  update(deltaTime: number, charBox: CharBox | null, viewHeight: number): void {
    const resting = this.blocks.filter(b => !b.dead && b.resting)
    // The solid list is the same for every block this tick, so build it once
    const solids: Rect[] = this.ground.concat(resting)
    if (charBox) {
      solids.push({
        x: charBox.left,
        y: charBox.top,
        w: charBox.right - charBox.left,
        h: charBox.bottom - charBox.top
      })
    }

    for (const b of this.blocks) {
      if (b.dead || b.inhale) continue
      if (b.resting) continue

      b.vy = Math.min(b.vy + CHAR_GRAVITY, MAX_FALL_SPEED)
      const prevBottom = b.bottom
      b.y += b.vy

      let landY: number | null = null
      for (const s of solids) {
        if (b.x + b.w <= s.x || b.x >= s.x + s.w) continue
        if (prevBottom <= s.y + SOLID_EPS && b.bottom >= s.y) {
          if (landY === null || s.y < landY) landY = s.y
        }
      }

      if (landY !== null) {
        b.y = landY - b.h
        b.vy = 0
        b.resting = true
      } else if (b.y > viewHeight + BLOCK_CULL_MARGIN) {
        b.dead = true
      }
    }

    for (let i = this.blocks.length - 1; i >= 0; i--) {
      if (this.blocks[i].dead) this.blocks.splice(i, 1)
    }
  }
}
