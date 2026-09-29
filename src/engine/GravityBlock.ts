import type { Rect } from './types.ts'

export type BlockKind = 'ground' | 'spawned'

let nextBlockId = 1

/**
 * A solid rectangle with gravity.
 *
 * Ground bricks and spawned enemy blocks are the same thing physically - only
 * `kind` and whether they move differ - so they share one class.
 */
export class GravityBlock implements Rect {
  x: number
  y: number
  w: number
  h: number
  readonly kind: BlockKind
  readonly id: number

  /** Vertical velocity, px per frame. */
  vy = 0
  /** True once the block has come to rest on something. */
  resting = false
  /** Set once the inhale field has caught this block. */
  inhale: { startDist: number } | null = null
  /** Marked for removal at the end of the tick. */
  dead = false

  constructor(
    x: number,
    y: number,
    w: number,
    h: number,
    kind: BlockKind = 'spawned',
    id = nextBlockId++
  ) {
    this.x = x
    this.y = y
    this.w = w
    this.h = h
    this.kind = kind
    this.id = id
  }

  get top(): number {
    return this.y
  }

  get bottom(): number {
    return this.y + this.h
  }

  get right(): number {
    return this.x + this.w
  }

  get centreX(): number {
    return this.x + this.w / 2
  }

  get centreY(): number {
    return this.y + this.h / 2
  }

  /** Release the block back into free fall (used when the inhale stops). */
  release(): void {
    this.inhale = null
  }
}
