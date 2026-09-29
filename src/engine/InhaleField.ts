import type { GravityBlock } from './GravityBlock.ts'
import {
  INHALE_APPROACH_SPEED,
  INHALE_BODY_MULT,
  INHALE_EAT_DIST,
  INHALE_SUCK_DIST,
  INHALE_SUCK_SPEED
} from './constants.ts'
import type { InhaleAnchor, Point } from './types.ts'

/**
 * The inhale field.
 *
 * A caught block is NOT swallowed immediately: it drifts toward the mouth at a
 * constant speed and is then yanked the last stretch. Because the drift speed
 * is constant, the total travel time is proportional to the distance the block
 * started at - the farther away it is caught, the longer it takes to arrive.
 */
export class InhaleField {
  /**
   * Catch and pull blocks toward the mouth.
   *
   * @returns the blocks that reached the mouth this tick (already marked dead)
   */
  update(
    blocks: readonly GravityBlock[],
    anchor: InhaleAnchor | null,
    mouth: Point,
    inhaling: boolean
  ): GravityBlock[] {
    const swallowed: GravityBlock[] = []

    for (const b of blocks) {
      if (b.dead) continue

      if (!inhaling || !anchor) {
        b.release()
        continue
      }

      const cx = b.centreX
      const cy = b.centreY
      const dx = mouth.x - cx
      const dy = mouth.y - cy
      const dist = Math.hypot(dx, dy) || 1

      // Catch test: within 3-4 body lengths of the centre, and in front of him.
      // The half-block of slack stops a block he is standing on from being
      // counted as "behind".
      if (!b.inhale) {
        const toCentre = Math.hypot(cx - anchor.x, cy - anchor.y)
        const inFront = (cx - anchor.x) * anchor.dir > -b.w * 0.5
        if (toCentre <= anchor.range && inFront) {
          // remember how far it had to travel, for debug readouts
          b.inhale = { startDist: dist }
        } else {
          continue
        }
      }

      b.resting = false

      const speed = dist <= INHALE_SUCK_DIST ? INHALE_SUCK_SPEED : INHALE_APPROACH_SPEED
      b.x += (dx / dist) * speed
      b.y += (dy / dist) * speed

      if (dist < INHALE_EAT_DIST) {
        b.dead = true
        swallowed.push(b)
      }
    }

    return swallowed
  }

  /** Reach in px for a character of the given body height. */
  rangeFor(bodyLen: number): number {
    return bodyLen * INHALE_BODY_MULT
  }
}
