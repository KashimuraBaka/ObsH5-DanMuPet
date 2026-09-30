/**
 * AIBot — AI-controlled character that uses Kirby's animations.
 *
 * Standalone kinematic entity (no planck.js, no Character.ts, no PhysicsWorld.ts).
 * Uses simple AABB collision against ground and blocks.
 * Shares the game world with the main character (groundY, blocks, enemies).
 */

import animationDataRaw from "../animations.json";
import {
  BOT_COLLIDE_MAX_RESOLVE,
  BOT_COLLIDE_SOFTNESS,
  BOT_COLLIDE_VERT_TOL,
  BOT_MIN_SPACING,
} from "./constants.ts";

// ---- Animation metadata helpers ----

const animData = animationDataRaw as {
  animations: Record<
    string,
    { frames: unknown[]; loop: boolean; frameDurationMs: number }
  >;
};

function getFrameCount(state: string): number {
  const a = animData.animations?.[state];
  return a ? a.frames.length : 1;
}

function getLooping(state: string): boolean {
  const a = animData.animations?.[state];
  return a ? a.loop : true;
}

const FRAME_DURATIONS: Record<string, number> = {
  idle: 500,
  crouch: 500,
  walk: 50,
  run: 50,
  jump: 30,
  attack: 40,
  swallow: 60,
};

// ---- Types ----

export enum BotState {
  IDLE = "idle",
  PATROL = "patrol",
  CHASE = "chase",
  ATTACK = "attack",
  SWALLOW = "swallow",
  RECOVER = "recover",
}

export type BotAction =
  | "jump"
  | "walkLeft"
  | "walkRight"
  | "attack"
  | "swallow"
  | "idle";

export interface AIBotConfig {
  name: string;
  speed: number;
  jumpImpulse: number;
  chaseRange: number;
  attackRange: number;
  gravity: number;
  playerFollowRange: number;
  playerStayRange: number;
}

export interface EnemyRef {
  x: number;
  y: number;
  w: number;
  h: number;
  dead: boolean;
  centreX: number;
  centreY: number;
  /** Bot id that has claimed this enemy; other bots skip it. */
  lockedBy?: number;
}

/**
 * A character the bot can collide with: the player, or another bot.
 *
 * `x`/`y` are the hitbox's origin (left/top in canvas coords) and
 * `centreX`/`centreY` its centre. Only `centreX`/`centreY`/`w`/`h` are read by
 * the collision code, so the `x`/`y` convention may differ between callers.
 */
export interface CharacterRef {
  x: number;
  y: number;
  w: number;
  h: number;
  centreX: number;
  centreY: number;
}

export interface BlockRef {
  x: number;
  y: number;
  w: number;
  h: number;
  dead: boolean;
}

// ---- ID counter ----

let nextBotId = 1;

// ---- Class ----

export class AIBot {
  // Position and velocity (canvas coordinates, centre-bottom of hitbox)
  x: number;
  y: number;
  vx: number;
  vy: number;

  // Hitbox dimensions
  w: number;
  h: number;

  // Facing direction
  dir: 1 | -1;

  // State machine
  state: BotState;

  // Animation state
  animState: string;
  animFrameIndex: number;
  animTime: number;
  frameDurationMs: number;

  // Physics
  onGround: boolean;

  // Configuration
  config: AIBotConfig;
  name: string;

  // Target tracking
  targetEnemy: EnemyRef | null;

  // Countdown timers (ms remaining)
  swallowTimer: number;
  recoverTimer: number;
  patrolDir: 1 | -1;
  patrolTimer: number;
  jumpCooldown: number;

  // Identity
  id: number;

  /** Canvas width for boundary wrapping. Set externally before/during update(). */
  canvasWidth: number = 800;

  /** Set to true to disable the bot. Checked at the start of update(). */
  dead: boolean = false;

  /**
   * Set by the host while the player is driving the character by hand. The bot
   * drops its own script and stands down: no chasing, no following, no
   * attacking. Only the AI script is suspended - gravity, boundary wrap and
   * the soft character collisions still apply, so a stand-down bot that gets
   * shoved still shuffles and faces the way it goes instead of sliding frozen.
   */
  aiSuspended: boolean = false;

  /**
   * Set by the host while the player is driving this particular bot by hand
   * (manual takeover). Takes precedence over aiSuspended: the bot's own script
   * is skipped and `manualDriveDir` moves it instead. Gravity, boundary wrap
   * and the soft character collisions all keep applying, so a driven bot that
   * gets shoved still faces the way it actually goes.
   */
  manualDriven: boolean = false;

  /** Direction the player is holding for this bot while `manualDriven`. */
  manualDriveDir: number = 0;

  // Private timers
  private idleTimer = 0;
  private attackTimer = 0;

  /**
   * X at the start of the current tick, so the bot can be faced along the
   * direction it *actually* moved rather than the direction its AI wanted to
   * move. Set by update(); still null when handleCharacterCollisions runs
   * without a preceding update() this tick.
   */
  private tickStartX: number | null = null;

  /** Returns the bot's X position at the start of the last tick. */
  get tickStart(): number {
    return this.tickStartX ?? this.x;
  }

  /**
   * When a bot is shoved while standing still (idle pose), the walk cycle is
   * latched for this many ms so it actually animates its shuffle instead of
   * being forced back to idle every tick by the AI reset.
   */
  private pushWalkTimer = 0;

  /** Cooldown timer (ms) for dodge jumps over blocking bots. */
  private dodgeJumpCooldown = 0;

  /** Timer (ms) tracking continuous blocked time before a dodge jump. */
  private blockedTimer = 0;

  /** Threshold (ms) for continuous blocking before a dodge jump triggers. */
  private static readonly BLOCKED_JUMP_THRESHOLD = 1500;

  /**
   * Trigger a dodge jump to bypass a blocking bot. Only jumps if the bot has
   * been continuously blocked for at least BLOCKED_JUMP_THRESHOLD ms. The
   * blockedTimer is accumulated in update() each tick the bot fails to move.
   */
  triggerDodgeJump(): void {
    if (!this.onGround || this.dodgeJumpCooldown > 0) return;
    if (this.blockedTimer < AIBot.BLOCKED_JUMP_THRESHOLD) return;

    this.vy = this.config.jumpImpulse * 1.5;
    this.onGround = false;
    this.setAnimState("jump");
    this.dodgeJumpCooldown = 500;
    this.blockedTimer = 0;
  }

  constructor(config: Partial<AIBotConfig> = {}) {
    this.config = {
      name: "Bot",
      speed: 2.5,
      jumpImpulse: -7,
      chaseRange: 9999,
      attackRange: 60,
      gravity: 0.4,
      playerFollowRange: 340,
      playerStayRange: 120,
      ...config,
    };
    this.name = this.config.name;
    this.id = nextBotId++;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.w = 24;
    this.h = 26;
    this.dir = 1;
    this.state = BotState.IDLE;
    this.animState = "idle";
    this.animFrameIndex = 0;
    this.animTime = 0;
    this.frameDurationMs = FRAME_DURATIONS.idle ?? 500;
    this.onGround = false;
    this.targetEnemy = null;
    this.swallowTimer = 0;
    this.recoverTimer = 0;
    this.patrolDir = 1;
    this.patrolTimer = 2000 + Math.random() * 1000;
    this.jumpCooldown = 0;
  }

  // ---- Getters ----

  get centreX(): number {
    return this.x;
  }

  get centreY(): number {
    return this.y - this.h / 2;
  }

  get top(): number {
    return this.y - this.h;
  }

  get bottom(): number {
    return this.y;
  }

  get left(): number {
    return this.x - this.w / 2;
  }

  get right(): number {
    return this.x + this.w / 2;
  }

  /** Current action derived from state and movement, for external logic. */
  get currentAction(): BotAction {
    switch (this.state) {
      case BotState.ATTACK:
        return "attack";
      case BotState.SWALLOW:
        return "swallow";
      case BotState.IDLE:
      case BotState.RECOVER:
        return "idle";
      case BotState.PATROL:
        return this.dir > 0 ? "walkRight" : "walkLeft";
      case BotState.CHASE:
        if (!this.onGround) return "jump";
        if (Math.abs(this.vx) > 0.1) {
          return this.vx > 0 ? "walkRight" : "walkLeft";
        }
        return "idle";
      default:
        return "idle";
    }
  }

  // ---- Public methods ----

  /**
   * Advance the bot by one tick.
   *
   * @param deltaTime  Time elapsed since last tick (ms)
   * @param groundY    Canvas Y of the ground surface
   * @param blocks     Solid blocks (ground bricks + spawned blocks)
   * @param enemies    Enemy entities in the world
   * @param playerX    X position of the player in canvas coords
   * @param playerY    Y position of the player in canvas coords
   */
  update(
    deltaTime: number,
    groundY: number,
    blocks: BlockRef[],
    enemies: EnemyRef[],
    playerX: number,
    playerY: number,
  ): void {
    if (this.dead) return;
    const tickStartX = this.x;
    this.tickStartX = tickStartX;

    // Decrement countdown timers
    if (this.swallowTimer > 0) this.swallowTimer -= deltaTime;
    if (this.recoverTimer > 0) this.recoverTimer -= deltaTime;
    if (this.jumpCooldown > 0) this.jumpCooldown -= deltaTime;
    if (this.patrolTimer > 0) this.patrolTimer -= deltaTime;
    if (this.dodgeJumpCooldown > 0) this.dodgeJumpCooldown -= deltaTime;

    // State machine: decide what to do and set animState / vx
    this.runStateMachine(deltaTime, enemies, playerX, playerY);

    // Apply gravity
    this.vy += this.config.gravity;
    if (this.vy > 15) this.vy = 15;

    // ---- Horizontal movement + block collision ----
    this.x += this.vx;
    for (const block of blocks) {
      if (block.dead) continue;
      if (this.overlapsBlock(block)) {
        if (this.vx > 0) {
          this.x = block.x - this.w / 2;
        } else if (this.vx < 0) {
          this.x = block.x + block.w + this.w / 2;
        }
        this.vx = 0;
      }
    }

    // ---- Vertical movement + block collision ----
    this.y += this.vy;
    this.onGround = false;

    // Ground collision (always check — covers gaps between blocks)
    if (this.y >= groundY) {
      this.y = groundY;
      this.vy = 0;
      this.onGround = true;
    }

    // Block collision
    for (const block of blocks) {
      if (block.dead) continue;
      if (this.overlapsBlock(block)) {
        if (this.vy > 0) {
          // Landing on top
          this.y = block.y;
          this.vy = 0;
          this.onGround = true;
        } else if (this.vy < 0) {
          // Bumping head
          this.y = block.y + block.h + this.h;
          this.vy = 0;
        }
      }
    }

    // ---- Blocked detection + dodge jump ----
    // If the bot wanted to move but its position didn't change (blocked by a
    // wall or solid block), accumulate blocked time. Once the threshold is
    // reached, triggerDodgeJump() performs the actual leap and resets timers.
    const tickDelta = this.x - tickStartX;
    const wantsToMove =
      this.state === BotState.CHASE ||
      this.state === BotState.PATROL ||
      (this.state === BotState.IDLE && this.animState !== "idle");

    if (Math.abs(tickDelta) < 0.5 && this.onGround && wantsToMove) {
      this.blockedTimer += deltaTime;
    } else {
      this.blockedTimer = 0;
    }

    this.triggerDodgeJump();

    // ---- Boundary wrap-around ----
    const margin = 40;
    if (this.x > this.canvasWidth + margin) {
      this.x = -margin;
    } else if (this.x < -margin) {
      this.x = this.canvasWidth + margin;
    }

    // ---- Advance animation frame ----
    this.updateAnimationFrame(deltaTime);

    // Face the way the bot really moved: AI intent + block stops. The soft
    // character collisions run after this and re-sync the same field.
    this.syncFacing(this.x - tickStartX);
  }

  /**
   * Find the nearest non-dead enemy to the bot.
   * Returns null if no living enemies exist.
   */
  findNearestEnemy(enemies: EnemyRef[]): EnemyRef | null {
    let nearest: EnemyRef | null = null;
    let minDist = Infinity;

    for (const e of enemies) {
      if (e.dead) continue;
      if (e.lockedBy !== undefined && e.lockedBy !== this.id) continue;
      const dx = e.centreX - this.centreX;
      const dy = e.centreY - this.centreY;
      const dist = Math.hypot(dx, dy);
      if (dist < minDist) {
        minDist = dist;
        nearest = e;
      }
    }

    return nearest;
  }

  /**
   * During ATTACK state, check if any enemy is within attackRange and in front
   * of the bot. If caught, marks the enemy as dead and returns it.
   * Returns null if no enemy was caught.
   */
  tryCatchEnemy(enemies: EnemyRef[]): EnemyRef | null {
    const range = this.config.attackRange;

    for (const e of enemies) {
      if (e.dead) continue;

      const dx = e.centreX - this.centreX;
      const inFront = dx * this.dir > 0;
      const dist = Math.abs(dx);
      const dy = Math.abs(e.centreY - this.centreY);

      // Within horizontal range, in front, and roughly at same height
      if (dist <= range && inFront && dy <= this.h * 2) {
        e.dead = true;
        return e;
      }
    }

    return null;
  }

  /** Reset the bot to IDLE state, clearing all timers and targets. */
  reset(): void {
    this.state = BotState.IDLE;
    this.setAnimState("idle");
    this.vx = 0;
    this.vy = 0;
    this.targetEnemy = null;
    this.swallowTimer = 0;
    this.recoverTimer = 0;
    this.idleTimer = 0;
    this.attackTimer = 0;
    this.blockedTimer = 0;
    this.dodgeJumpCooldown = 0;
  }

  /**
   * Returns render info for drawing the bot.
   * x and y are offsets from canvas centre and ground surface respectively,
   * matching SpriteRenderer's RenderState interface.
   */
  getRenderState(
    canvasWidth: number,
    _canvasHeight: number,
    groundY: number,
  ): {
    x: number;
    y: number;
    flip: boolean;
    animState: string;
    animFrameIndex: number;
  } {
    return {
      x: this.x - canvasWidth / 2,
      y: this.y - groundY,
      flip: this.dir === 1,
      animState: this.animState,
      animFrameIndex: this.animFrameIndex,
    };
  }

  /** Returns the current action for external logic (same as currentAction getter). */
  getAction(): BotAction {
    return this.currentAction;
  }

  /**
   * Soft character-to-character collision, run once per tick after this bot's
   * own update().
   *
   * Each other character the bot is near pushes the bot back along the
   * horizontal axis by a fraction (`BOT_COLLIDE_SOFTNESS`) of the shortfall
   * between their centres and the spacing they should be apart. The shortfall
   * shrinks as the bot moves, so this settles the two bodies at
   * `BOT_MIN_SPACING` apart instead of snapping them rigidly. A character
   * driving at `v` px/tick leaves a steady-state shortfall of about
   * `v * (1 - BOT_COLLIDE_SOFTNESS) / BOT_COLLIDE_SOFTNESS` beyond that
   * spacing, which turns into a real overlap past ~5 px/tick — the bot squashes
   * a little before it slides off, and a fast slide compresses it visibly
   * instead of stopping dead. `BOT_COLLIDE_MAX_RESOLVE` bounds how far a badly
   * overlapping start can displace it in a single tick.
   *
   * Only this bot is moved — the player (physically driven by planck.js) is
   * never displaced, and other bots push themselves in their own pass, so the
   * effect is symmetric without either side losing its own authority.
   */
  handleCharacterCollisions(others: CharacterRef[]): void {
    if (this.dead || others.length === 0) return;

    // Where the bot was before this pass. If update() ran this tick,
    // tickStartX is the real tick start and the bot's whole displacement is
    // used for facing; when this pass runs on its own, the shove alone is the
    // best displacement available.
    const entryX = this.x;

    const halfW = this.w * 0.5;
    const halfH = this.h * 0.5;
    let shovedX = 0;

    for (const other of others) {
      if (!other) continue;

      const dx = this.x - other.centreX;
      const dy = this.centreY - other.centreY;

      // Only resolve horizontally when the two bodies are at a comparable
      // height. A bot jumping over another is clearly above it and should not
      // be shoved sideways by a body it is passing over.
      if (Math.abs(dy) > halfH + other.h * 0.5 + BOT_COLLIDE_VERT_TOL) continue;

      // Desired centre-to-centre distance: touching, plus the personal-space
      // gap that stops a pack of bots piling onto one character.
      const desiredSeparation = halfW + other.w * 0.5 + BOT_MIN_SPACING;
      const shortfall = desiredSeparation - Math.abs(dx);
      if (shortfall <= 0) continue;

      const away = dx >= 0 ? 1 : -1;
      const push = Math.min(shortfall * BOT_COLLIDE_SOFTNESS, BOT_COLLIDE_MAX_RESOLVE);
      this.x += away * push;
      shovedX += away * push;
    }

    // A bot the AI left standing still still needs a walk cycle while it is
    // being shoved, otherwise it slides on the spot in an idle pose. The AI's
    // own walk/run choice is left alone — it already describes the motion.
    // Stationary actions (attack, swallow) never get turned around or animated
    // by a shove: they commit to a facing and hold the pose.
    if (
      Math.abs(shovedX) > 0.05 &&
      this.state !== BotState.ATTACK &&
      this.state !== BotState.SWALLOW &&
      this.onGround &&
      this.animState === "idle"
    ) {
      this.animState = "walk";
      this.animFrameIndex = 0;
      this.animTime = 0;
      this.frameDurationMs = FRAME_DURATIONS.walk ?? 50;
      this.pushWalkTimer = 250;
    }

    this.syncFacing(this.x - (this.tickStartX ?? entryX));
  }

  // ---- Private methods ----

  /** Check AABB overlap between the bot and a block. */
  private overlapsBlock(block: BlockRef): boolean {
    return (
      this.left < block.x + block.w &&
      this.right > block.x &&
      this.top < block.y + block.h &&
      this.bottom > block.y
    );
  }

  /**
   * Face the direction the bot actually moved.
   *
   * The AI picks `dir` from where it *wants* to go, but two things can move the
   * bot the other way afterwards: a soft character collision shoves it back
   * (classically: the bot chases the player, the player steps into it, and the
   * bot ends the tick sliding away from it while still facing it — the "walking
   * backwards" bug), and a block clamps it in place. Either way the sprite has
   * to match the net displacement, so `dir` is re-derived from its sign rather
   * than from the intended velocity.
   *
   * Pure in `delta`: update() passes the whole tick's displacement,
   * handleCharacterCollisions passes either the whole tick's (when update() ran
   * this tick) or just its own shove (when called on its own).
   *
   * @param delta Horizontal displacement to face along, in px (sign = direction).
   */
  private syncFacing(delta: number): void {
    // Stationary actions commit to a facing (they aim at their target) and are
    // never meant to walk, so a shove doesn't spin them around.
    if (this.state === BotState.ATTACK || this.state === BotState.SWALLOW) return;

    if (Math.abs(delta) < 0.05) return;

    this.dir = delta > 0 ? 1 : -1;
  }

  /** Change animation state, resetting frame index and time. */
  private setAnimState(newState: string): void {
    if (this.animState === newState) return;
    this.animState = newState;
    this.animFrameIndex = 0;
    this.animTime = 0;
    this.frameDurationMs = FRAME_DURATIONS[newState] ?? 100;
  }

  /** Advance the animation frame index based on elapsed time. */
  private updateAnimationFrame(deltaTime: number): void {
    this.animTime += deltaTime;

    const fc = getFrameCount(this.animState);
    const looping = getLooping(this.animState);

    while (this.animTime >= this.frameDurationMs) {
      this.animTime -= this.frameDurationMs;
      this.animFrameIndex++;

      if (this.animFrameIndex >= fc) {
        if (looping) {
          this.animFrameIndex = 0;
        } else {
          // Non-looping: stop at last frame
          this.animFrameIndex = fc - 1;
          this.animTime = 0;
          break;
        }
      }
    }
  }

  /** Run the bot's AI state machine for one tick. */
  private runStateMachine(
    deltaTime: number,
    enemies: EnemyRef[],
    playerX: number,
    playerY: number,
  ): void {
    // Manual takeover: the player drives this bot directly. Takes precedence
    // over aiSuspended (the host may have stood the whole floor down because a
    // direction key is held, but this bot is the one being driven). A held
    // direction walks it that way; no key leaves it standing down at idle.
    // Gravity, boundary wrap and the soft character collisions still run.
    if (this.manualDriven) {
      this.targetEnemy = null;
      if (this.manualDriveDir !== 0) {
        this.vx = this.manualDriveDir * this.config.speed;
        this.dir = this.manualDriveDir > 0 ? 1 : -1;
        this.setAnimState("walk");
      } else {
        this.vx = 0;
        this.setAnimState("idle");
      }
      return;
    }

    // A shoved bot latches a short walk cycle so it animates its shuffle
    // instead of being snapped back to idle every tick by the AI reset.
    if (this.pushWalkTimer > 0 && this.onGround && this.state !== BotState.ATTACK && this.state !== BotState.SWALLOW) {
      this.pushWalkTimer -= deltaTime;
      this.animState = "walk";
      this.vx = 0;
      return;
    }

    if (
      this.state === BotState.IDLE ||
      this.state === BotState.PATROL ||
      this.state === BotState.CHASE
    ) {
      // Enemies take priority.
      const nearest = this.findNearestEnemy(enemies);
      const enemyDist = nearest
        ? Math.hypot(nearest.centreX - this.centreX, nearest.centreY - this.centreY)
        : Infinity;

      if (nearest && enemyDist <= this.config.chaseRange) {
        this.targetEnemy = nearest;
        this.state = BotState.CHASE;
        this.dir = nearest.centreX > this.x ? 1 : -1;

        const targetHDist = Math.abs(this.targetEnemy.centreX - this.x);
        const targetVDist = Math.abs(this.targetEnemy.centreY - this.centreY);

        // Reached attack range → attack
        if (targetHDist <= this.config.attackRange && targetVDist <= this.h * 2) {
          this.vx = 0;
          this.attackTimer = 0;
          this.state = BotState.ATTACK;
          this.setAnimState("attack");
          return;
        }

        this.vx = this.dir * this.config.speed * 1.5;
        this.setAnimState("run");

        // Jump if the target is above the bot and the jump cooldown is ready.
        if (this.onGround && this.jumpCooldown <= 0) {
          const targetTop = this.targetEnemy.centreY - this.targetEnemy.h / 2;
          if (
            targetTop < this.top - 10 &&
            targetHDist < this.config.chaseRange * 0.6
          ) {
            this.vy = this.config.jumpImpulse;
            this.onGround = false;
            this.setAnimState("jump");
            this.jumpCooldown = 500;
          }
        }

        return;
      }

      // Otherwise follow the player.
      if (this.aiSuspended) {
        this.targetEnemy = null;
        this.state = BotState.IDLE;
        this.vx = 0;
        this.setAnimState("idle");
        return;
      }
      this.targetEnemy = null;
      this.state = BotState.IDLE;
      const dx = playerX - this.x;
      const dist = Math.hypot(dx, playerY - this.centreY);

      if (dist <= this.config.playerStayRange) {
        this.vx = 0;
        this.dir = dx >= 0 ? 1 : -1;
        this.setAnimState("idle");
        return;
      }

      this.dir = dx >= 0 ? 1 : -1;
      if (dist > this.config.playerFollowRange) {
        this.vx = this.dir * this.config.speed * 1.6;
        this.setAnimState("run");
      } else {
        this.vx = this.dir * this.config.speed;
        this.setAnimState("walk");
      }
      return;
    }

    switch (this.state) {
      // ---- ATTACK ----
      case BotState.ATTACK: {
        this.setAnimState("attack");
        this.vx = 0;
        this.attackTimer += deltaTime;

        // Always look for the nearest enemy and face it
        const nearest = this.findNearestEnemy(enemies);
        if (nearest) {
          this.targetEnemy = nearest;
          this.dir = nearest.centreX > this.x ? 1 : -1;
        }

        // Try to catch an enemy
        const caught = this.tryCatchEnemy(enemies);
        if (caught) {
          this.state = BotState.SWALLOW;
          this.setAnimState("swallow");
          this.targetEnemy = null;
          this.swallowTimer =
            getFrameCount("swallow") * (FRAME_DURATIONS.swallow ?? 60);
          return;
        }

        // Timeout after 1.5s without catching
        if (this.attackTimer >= 1500) {
          this.state = BotState.IDLE;
          this.idleTimer = 0;
          this.setAnimState("idle");
        }
        break;
      }

      // ---- SWALLOW ----
      case BotState.SWALLOW: {
        this.setAnimState("swallow");
        this.vx = 0;

        // When swallow animation finishes → RECOVER
        if (this.swallowTimer <= 0) {
          this.state = BotState.RECOVER;
          this.setAnimState("idle");
          this.recoverTimer = 500;
        }
        break;
      }

      // ---- RECOVER ----
      case BotState.RECOVER: {
        this.setAnimState("idle");
        this.vx = 0;

        // After recovery → IDLE
        if (this.recoverTimer <= 0) {
          this.state = BotState.IDLE;
          this.idleTimer = 0;
        }
        break;
      }
    }
  }
}
