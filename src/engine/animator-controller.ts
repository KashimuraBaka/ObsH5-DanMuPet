/**
 * Per-tick animation and game-logic controller for KirbyAnimator.
 *
 * The Vue component owns rendering and input events; this class owns the
 * numerical simulation (frame timing, blink, movement, physics step, inhale).
 * Keeping it free of canvas/Vue concerns makes it unit-testable.
 */

import { BRAKE_TICKS, RUN_COAST_TICKS, WORLD_SCALE } from "./constants.ts";
import type { CharContext, Frame } from "./types.ts";
import type { AnimationConfig } from "./SpriteRenderer.ts";
import { PhysicsWorld } from "./PhysicsWorld.ts";
import { InhaleField } from "./InhaleField.ts";
import { Character } from "./Character.ts";

export interface AnimatorControllerOptions {
  /** Global playback speed multiplier, read live so slider edits apply instantly. */
  getSpeed: () => number;
  /** Current animation state string, e.g. 'walk' or 'jump'. */
  getState: () => string;
  /** Callback when the controller wants to change state. */
  onStateChange: (state: string) => void;
  /** Whether the component is in frame-editing mode (pauses playback). */
  getEditingMode: () => boolean;
  /** True when the current state is jump or jumpWithEnemy. */
  isJumping: () => boolean;
  /** Current animation config. */
  getAnimation: () => AnimationConfig;
}

/** States that keep the character moving horizontally, so landing can resume one. */
const MOVE_STATES = ["walk", "run", "walkWithEnemy"];

export class AnimatorController {
  // ---- playback state ----
  frameIndex = 0;
  frameTime = 0;
  isBlinking = false;
  blinkStartTime = 0;
  nextBlinkTime = 0;

  // ---- character state ----
  isHolding = false;
  /** The move state to return to when he next lands, after a jump or a fall. */
  previousMoveState = "idle";
  previousSlideState = "idle";
  walkDirection = 1;
  heldDirection = 0;
  isFacingRight = true;
  downKeyHeld = false;
  attackKeyHeld = false;
  lastKeyTime = 0;
  lastKeyDirection: number | null = null;
  shiftHeld = false;

  // ---- rendering state (mirrored in Vue for template bindings where needed) ----
  get flip(): boolean {
    // All Kirby clips default to facing left, so flipped = facing right
    return this.isFacingRight;
  }

  // ---- one-shot guards ----
  slideDone = false;
  swallowDone = false;

  // ---- turn-skid (brake) state ----
  /** Frames left in the current skid; 0 means not braking. */
  brakeTicksLeft = 0;
  /** Direction to run once the skid is over. */
  brakeTargetDir = 1;

  // ---- run momentum ----
  /** Distance covered in the current run stint; gates the turn skid. */
  runDistance = 0;
  /** Frames left in the release-coast; 0 means not coasting. */
  coastTicksLeft = 0;

  constructor(private readonly opts: AnimatorControllerOptions) {
    this.nextBlinkTime = 2000 + Math.random() * 3000;
  }

  /** Reset everything that depends on the current state string. */
  resetForState(state: string): void {
    this.frameIndex = 0;
    this.frameTime = 0;
    this.isBlinking = false;

    if (state === "idle" || state === "crouch") {
      this.nextBlinkTime = 2000 + Math.random() * 3000;
    }
    if (state === "slide") {
      this.slideDone = false;
    }
    if (state === "brake") {
      this.brakeTicksLeft = BRAKE_TICKS;
    }
    if (state === "coast") {
      this.coastTicksLeft = RUN_COAST_TICKS;
    }
    if (state === "run") {
      // A fresh run stint: it starts with no momentum.
      this.runDistance = 0;
    }
    if (state !== "slide") {
      this.slideDone = false;
    }
    if (state !== "swallow") {
      this.swallowDone = false;
    }
    if (state !== "holdEnemy") {
      this.nextBlinkTime = 2000 + Math.random() * 3000;
      this.isBlinking = false;
    }
  }

  isJumping(): boolean {
    return this.opts.isJumping();
  }

  /** One game tick. Returns the current frame (for rendering). */
  tick(
    deltaTime: number,
    ctx: CharContext,
    world: PhysicsWorld,
    inhaleField: InhaleField,
    kirby: Character,
    canvasWidth: number,
    canvasHeight: number,
  ): Frame | null {
    const anim = this.opts.getAnimation();
    const state = this.opts.getState();
    const isJumping = this.opts.isJumping();
    const editingMode = this.opts.getEditingMode();

    if (editingMode) return anim.frames[this.frameIndex] ?? null;

    // ---- frame timing ----
    if (state === "idle" || state === "crouch" || state === "holdEnemy") {
      this.frameTime += deltaTime;
      if (!this.isBlinking && this.frameTime >= this.nextBlinkTime) {
        this.isBlinking = true;
        this.blinkStartTime = this.frameTime;
        this.frameIndex = 1;
      }
      if (this.isBlinking && this.frameTime - this.blinkStartTime >= 150) {
        this.isBlinking = false;
        this.frameIndex = 0;
        this.frameTime = 0;
        this.nextBlinkTime = 2000 + Math.random() * 3000;
      }
    } else {
      this.frameTime += deltaTime;
      const frameInterval = anim.frameDurationMs / this.opts.getSpeed();
      if (this.frameTime >= frameInterval) {
        this.frameTime = 0;
        this.frameIndex++;
        if (this.frameIndex >= anim.frames.length) {
          if (anim.loop) {
            this.frameIndex = 0;
          } else {
            this.frameIndex = anim.frames.length - 1;
          }
        }
      }
    }

    // ---- compute desired horizontal velocity from state ----
    let desiredVX = 0;
    if (state === "walk" || state === "walkWithEnemy") {
      desiredVX = this.walkDirection * 2 * this.opts.getSpeed();
    } else if (state === "run") {
      desiredVX = this.walkDirection * 3 * this.opts.getSpeed();
    } else if (state === "slide") {
      desiredVX = this.walkDirection * 4 * this.opts.getSpeed();
    } else if (state === "brake") {
      const decay = Math.max(0, this.brakeTicksLeft) / BRAKE_TICKS;
      desiredVX = this.walkDirection * 3 * decay * this.opts.getSpeed();
    } else if (state === "coast") {
      const decay = Math.max(0, this.coastTicksLeft) / RUN_COAST_TICKS;
      desiredVX = this.walkDirection * 1.6 * decay * this.opts.getSpeed();
    } else if (isJumping) {
      if (this.heldDirection !== 0) {
        desiredVX = this.heldDirection * 2 * this.opts.getSpeed();
        this.walkDirection = this.heldDirection;
        this.isFacingRight = this.heldDirection > 0;
      }
    }

    // ---- set velocity and run physics (planck.js) ----
    kirby.setVelocityX(desiredVX);
    world.update(
      deltaTime,
      ctx,
      kirby.getTightBox(ctx.frame),
      kirby.x,
      kirby.y,
      kirby.velocityX,
      kirby.velocityY,
    );
    kirby.sync(
      ctx,
      world,
      world.charPxValue,
      world.charPyValue,
      world.charVxValue,
      world.charVyValue,
    );

    // ---- post-solver state updates ----
    if (state === "run" && desiredVX !== 0) {
      this.runDistance += Math.abs(desiredVX);
    }

    // Losing the surface under him (walked off a block edge, or the block was
    // inhaled) does not release the move: remember which move state he was in
    // so landing — however far below — resumes exactly that one, run included.
    if (kirby.wasOnGround && !kirby.isOnGround && MOVE_STATES.includes(state)) {
      this.previousMoveState = state;
    }

    // Landing after a jump — or after falling off a physics block — must not
    // stop a move the player never released. Resume the remembered move
    // state; when there is none worth resuming (he jumped while standing
    // still and only then pressed a direction) start a fresh walk/run.
    if (kirby.justLanded) {
      if (this.heldDirection !== 0 || this.shiftHeld) {
        this.opts.onStateChange(
          MOVE_STATES.includes(this.previousMoveState)
            ? this.previousMoveState
            : this.shiftHeld
              ? "run"
              : "walk",
        );
      } else {
        this.opts.onStateChange("idle");
      }
    }

    // ---- slide end ----
    if (
      state === "slide" &&
      this.frameIndex === anim.frames.length - 1 &&
      !anim.loop
    ) {
      this.slideDone = true;
      this.opts.onStateChange(this.previousSlideState);
    }

    // ---- brake end ----
    if (state === "brake") {
      this.brakeTicksLeft--;
      if (this.brakeTicksLeft <= 0) {
        this.walkDirection =
          this.heldDirection !== 0 ? this.heldDirection : this.brakeTargetDir;
        this.isFacingRight = this.walkDirection > 0;
        this.opts.onStateChange(this.heldDirection !== 0 ? "run" : "idle");
      }
    }

    // ---- coast end ----
    if (state === "coast") {
      this.coastTicksLeft--;
      if (this.coastTicksLeft <= 0) {
        this.opts.onStateChange("idle");
      }
    }

    // ---- wrap-around ----
    const halfWidth = canvasWidth / 2;
    const margin = 20;
    if (kirby.x > halfWidth + margin) {
      kirby.teleportX(-halfWidth - margin);
    } else if (kirby.x < -halfWidth - margin) {
      kirby.teleportX(halfWidth + margin);
    }

    // ---- blocks + inhale ----
    const eaten = inhaleField.update(
      world.blocks,
      kirby.getInhaleAnchor(ctx),
      kirby.getMouthPos(ctx),
      state === "attack",
    );
    if (eaten.length) this.onBlockSwallowed();

    // ---- swallow one-shot ----
    if (
      state === "swallow" &&
      !anim.loop &&
      this.frameIndex === anim.frames.length - 1 &&
      !this.swallowDone
    ) {
      this.swallowDone = true;
      this.isHolding = false;
      this.opts.onStateChange("idle");
    }
    if (state !== "swallow") this.swallowDone = false;

    return anim.frames[this.frameIndex] ?? null;
  }

  onBlockSwallowed(): void {
    if (this.isHolding) return;
    this.isHolding = true;
    this.opts.onStateChange("holdEnemy");
  }

  jump(): void {
    this.isHolding = false;
  }

  /**
   * Begin a turn-skid: keep sliding the old way for BRAKE_TICKS frames at a
   * decaying speed, then run `targetDir`.
   */
  startBrake(targetDir: number): void {
    this.brakeTargetDir = targetDir;
    this.brakeTicksLeft = BRAKE_TICKS;
  }

  /**
   * Begin the release-coast: jog on at half speed for RUN_COAST_TICKS frames,
   * then settle into idle.
   */
  startCoast(): void {
    this.coastTicksLeft = RUN_COAST_TICKS;
  }
}
