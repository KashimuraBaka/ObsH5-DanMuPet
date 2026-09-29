/**
 * Per-tick animation and game-logic controller for KirbyAnimator.
 *
 * The Vue component owns rendering and input events; this class owns the
 * numerical simulation (frame timing, blink, movement, physics step, inhale).
 * Keeping it free of canvas/Vue concerns makes it unit-testable.
 */

import { WORLD_SCALE } from './constants.ts'
import type { CharContext, Frame, VerticalStepResult } from './types.ts'
import type { AnimationConfig } from './SpriteRenderer.ts'
import { PhysicsWorld } from './PhysicsWorld.ts'
import { InhaleField } from './InhaleField.ts'
import { Character } from './Character.ts'

export interface AnimatorControllerOptions {
  /** Global playback speed multiplier, read live so slider edits apply instantly. */
  getSpeed: () => number
  /** Current animation state string, e.g. 'walk' or 'jump'. */
  getState: () => string
  /** Callback when the controller wants to change state. */
  onStateChange: (state: string) => void
  /** Whether the component is in frame-editing mode (pauses playback). */
  getEditingMode: () => boolean
  /** True when the current state is jump or jumpWithEnemy. */
  isJumping: () => boolean
  /** Current animation config. */
  getAnimation: () => AnimationConfig
}

/** States that keep the character moving horizontally, so landing can resume one. */
const MOVE_STATES = ['walk', 'run', 'walkWithEnemy']

export class AnimatorController {
  // ---- playback state ----
  frameIndex = 0
  frameTime = 0
  isBlinking = false
  blinkStartTime = 0
  nextBlinkTime = 0

  // ---- character state ----
  isHolding = false
  /** The move state to return to when he next lands, after a jump or a fall. */
  previousMoveState = 'idle'
  previousSlideState = 'idle'
  walkDirection = 1
  heldDirection = 0
  isFacingRight = true
  downKeyHeld = false
  attackKeyHeld = false
  lastKeyTime = 0
  lastKeyDirection: number | null = null
  shiftHeld = false

  // ---- rendering state (mirrored in Vue for template bindings where needed) ----
  get flip(): boolean {
    // All Kirby clips default to facing left, so flipped = facing right
    return this.isFacingRight
  }

  // ---- one-shot guards ----
  slideDone = false
  swallowDone = false

  constructor(private readonly opts: AnimatorControllerOptions) {
    this.nextBlinkTime = 2000 + Math.random() * 3000
  }

  /** Reset everything that depends on the current state string. */
  resetForState(state: string): void {
    this.frameIndex = 0
    this.frameTime = 0
    this.isBlinking = false

    if (state === 'idle' || state === 'crouch') {
      this.nextBlinkTime = 2000 + Math.random() * 3000
    }
    if (state === 'slide') {
      this.slideDone = false
    }
    if (state !== 'slide') {
      this.slideDone = false
    }
    if (state !== 'swallow') {
      this.swallowDone = false
    }
    if (state !== 'holdEnemy') {
      this.nextBlinkTime = 2000 + Math.random() * 3000
      this.isBlinking = false
    }
  }

  isJumping(): boolean {
    return this.opts.isJumping()
  }

  /** One game tick. Returns the current frame (for rendering). */
  tick(
    deltaTime: number,
    ctx: CharContext,
    world: PhysicsWorld,
    inhaleField: InhaleField,
    kirby: Character,
    canvasWidth: number,
    canvasHeight: number
  ): Frame | null {
    const anim = this.opts.getAnimation()
    const state = this.opts.getState()
    const isJumping = this.opts.isJumping()
    const editingMode = this.opts.getEditingMode()

    if (editingMode) return anim.frames[this.frameIndex] ?? null

    // ---- frame timing ----
    if (state === 'idle' || state === 'crouch' || state === 'holdEnemy') {
      this.frameTime += deltaTime
      if (!this.isBlinking && this.frameTime >= this.nextBlinkTime) {
        this.isBlinking = true
        this.blinkStartTime = this.frameTime
        this.frameIndex = 1
      }
      if (this.isBlinking && (this.frameTime - this.blinkStartTime) >= 150) {
        this.isBlinking = false
        this.frameIndex = 0
        this.frameTime = 0
        this.nextBlinkTime = 2000 + Math.random() * 3000
      }
    } else {
      this.frameTime += deltaTime
      const frameInterval = anim.frameDurationMs / this.opts.getSpeed()
      if (this.frameTime >= frameInterval) {
        this.frameTime = 0
        this.frameIndex++
        if (this.frameIndex >= anim.frames.length) {
          if (anim.loop) {
            this.frameIndex = 0
          } else {
            this.frameIndex = anim.frames.length - 1
          }
        }
      }
    }

    // ---- vertical physics ----
    const wasGrounded = kirby.isOnGround
    const step = kirby.stepVertical(world, ctx)

    // Losing the surface under him (walked off a block edge, or the block was
    // inhaled) does not release the move: remember which move state he was in
    // so landing - however far below - resumes exactly that one, run included.
    if (wasGrounded && step.kind === 'airborne' && MOVE_STATES.includes(state)) {
      this.previousMoveState = state
    }

    if (step.kind === 'landed') {
      // Landing after a jump - or after falling off a physics block - must not
      // stop a move the player never released. Resume the remembered move
      // state; when there is none worth resuming (he jumped while standing
      // still and only then pressed a direction) start a fresh walk/run.
      if (this.heldDirection !== 0 || this.shiftHeld) {
        this.opts.onStateChange(
          MOVE_STATES.includes(this.previousMoveState)
            ? this.previousMoveState
            : this.shiftHeld ? 'run' : 'walk'
        )
      } else {
        this.opts.onStateChange('idle')
      }
    }

    // ---- horizontal movement ----
    const halfWidth = canvasWidth / 2
    const margin = 20

    if (state === 'walk' || state === 'run') {
      const moveSpeed = state === 'run' ? 3 : 2
      kirby.tryMoveX(world, this.walkDirection * moveSpeed * this.opts.getSpeed(), ctx)
      if (kirby.x > halfWidth + margin) {
        kirby.x = -halfWidth - margin
      } else if (kirby.x < -halfWidth - margin) {
        kirby.x = halfWidth + margin
      }
      this.isFacingRight = this.walkDirection > 0
    }

    if (state === 'slide') {
      const slideSpeed = 4 * this.opts.getSpeed()
      kirby.tryMoveX(world, this.walkDirection * slideSpeed, ctx)
      if (kirby.x > halfWidth + margin) {
        kirby.x = -halfWidth - margin
      } else if (kirby.x < -halfWidth - margin) {
        kirby.x = halfWidth + margin
      }
      this.isFacingRight = this.walkDirection > 0
      if (this.frameIndex === anim.frames.length - 1 && !anim.loop) {
        this.slideDone = true
        this.opts.onStateChange(this.previousSlideState)
      }
    }

    if (isJumping) {
      if (this.heldDirection !== 0) {
        const jumpMoveSpeed = 2
        kirby.tryMoveX(world, this.heldDirection * jumpMoveSpeed * this.opts.getSpeed(), ctx)
        this.walkDirection = this.heldDirection
        this.isFacingRight = this.heldDirection > 0
      }
      if (kirby.x > halfWidth + margin) {
        kirby.x = -halfWidth - margin
      } else if (kirby.x < -halfWidth - margin) {
        kirby.x = halfWidth + margin
      }
    }

    // ---- blocks + inhale ----
    world.update(deltaTime, kirby.getBox(ctx), canvasHeight)
    const eaten = inhaleField.update(
      world.blocks,
      kirby.getInhaleAnchor(ctx),
      kirby.getMouthPos(ctx),
      state === 'attack'
    )
    if (eaten.length) this.onBlockSwallowed()

    // ---- swallow one-shot ----
    if (state === 'swallow' && !anim.loop && this.frameIndex === anim.frames.length - 1 && !this.swallowDone) {
      this.swallowDone = true
      this.isHolding = false
      this.opts.onStateChange('idle')
    }
    if (state !== 'swallow') this.swallowDone = false

    return anim.frames[this.frameIndex] ?? null
  }

  onBlockSwallowed(): void {
    if (this.isHolding) return
    this.isHolding = true
    this.opts.onStateChange('holdEnemy')
  }

  jump(): void {
    this.isHolding = false
  }
}
