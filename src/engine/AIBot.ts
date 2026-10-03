/**
 * AIBot — AI-controlled character that uses Kirby's animations.
 *
 * Standalone kinematic entity (no planck.js, no Character.ts, no PhysicsWorld.ts).
 * Uses simple AABB collision against ground and blocks.
 * Shares the game world with the main character (groundY, blocks, enemies).
 */

import animationDataRaw from "../assets/sprites/kirby.json";
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

// ---- Pathfinding constants ----
/** Grid cell size in pixels for BFS/A* pathfinding. */
const PATHFIND_CELL = 25;
/** Re-run pathfinding every N frames (performance limit). */
const PATHFIND_RECOMPUTE = 12;
/** Max cells up the bot can jump (based on jumpImpulse=-10.5, gravity=0.4,
 *  peak height = v²/2g ≈ 138px; 5 cells * 25px/cell = 125px, conservative). */
const PATHFIND_JUMP_H = 5;
/** Max horizontal cells the bot can travel during a jump.
 *  Jump time = 2*|v|/g = 2*10.5/0.4 = 52.5 frames; horizontal drift =
 *  52.5 * 3.75 ≈ 197px; 7 cells * 25px/cell = 175px (conservative). */
const PATHFIND_JUMP_W = 7;
/** Max cells the bot can fall in one step (gravity). */
const PATHFIND_FALL_H = 8;
/** Max A* nodes to expand before giving up (safety). */
const PATHFIND_MAX_STEPS = 5000;

// ---- Pathfinding types ----

interface PathGrid {
  cols: number;
  rows: number;
  blocked: Uint8Array;
}

interface PathNode {
  gx: number;
  gy: number;
  g: number;
  f: number;
}

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

  /** True if the bot was blocked horizontally by a block in the previous tick. */
  private blockedByBlock = false;

  /** True while the bot is in an AI-initiated jump arc (drifting over walls). */
  private jumpArc = false;

  // ---- Pathfinding state ----
  /** Current path waypoints in canvas coordinates. */
  private pathWaypoints: { x: number; y: number }[] | null = null;
  /** Index of the current waypoint being followed. */
  private pathIdx = 0;
  /** Frame counter for path recomputation. */
  private pathFrame = 0;
  /** Key of the last target the path was computed for. */
  private pathTargetKey = "";

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
    this.jumpArc = true;
    this.setAnimState("jump");
    this.dodgeJumpCooldown = 500;
    this.blockedTimer = 0;
  }

  constructor(config: Partial<AIBotConfig> = {}) {
    this.config = {
      name: "Bot",
      speed: 2.5,
      jumpImpulse: -10.5,
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
    this.runStateMachine(deltaTime, enemies, playerX, playerY, blocks, groundY);

    // Reset per-tick block flag (runStateMachine already read the previous tick's value)
    this.blockedByBlock = false;

    // Apply gravity
    this.vy += this.config.gravity;
    if (this.vy > 15) this.vy = 15;

    // ---- Horizontal movement + block collision ----
    this.x += this.vx;
    for (const block of blocks) {
      if (block.dead) continue;
      // Skip ground bricks — the ground collision check handles them.
      if (block.y >= groundY - 1) continue;
      // During an AI-initiated jump arc, skip horizontal block collision only
      // when the bot is above the block (bot.bottom < block.y) — i.e. the bot
      // is drifting over the wall.  If the bot is level with the block
      // (jump not high enough), horizontal collision still applies so the bot
      // cannot clip through the wall.  (When the bot is above, overlapsBlock
      // already returns false because its vertical check is strict, so this
      // skip is redundant but documents the intent.)
      if (this.jumpArc && this.bottom < block.y) continue;
      if (this.overlapsBlock(block)) {
        if (this.vx > 0) {
          this.x = block.x - this.w / 2;
        } else if (this.vx < 0) {
          this.x = block.x + block.w + this.w / 2;
        } else {
          // Bot is overlapping with vx = 0 (pushed in by a previous collision
          // or character shove). Push to the nearest horizontal edge, but only
          // when there is a clear winner — pushing when the two sides are equal
          // (bot exactly centred on the block) oscillates every tick.
          const pushLeft = this.right - block.x;
          const pushRight = block.x + block.w - this.left;
          if (pushLeft < pushRight) {
            this.x = block.x - this.w / 2;
          } else if (pushRight < pushLeft) {
            this.x = block.x + block.w + this.w / 2;
          }
        }
        if (!this.jumpArc) {
          this.vx = 0;
        }
        this.blockedByBlock = true;
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
      this.jumpArc = false;
    }

    // Block collision
    for (const block of blocks) {
      if (block.dead) continue;
      // Skip ground bricks — the ground collision check handles them.
      if (block.y >= groundY - 1) continue;
      // During a jump arc, skip only the head-bump case (vy < 0) so marginal
      // floating-point overlap does not trigger a head-bump that cancels the
      // jump.  Landing (vy > 0) is preserved so the bot can still land on top
      // of a block while drifting through a jump arc.
      if (this.jumpArc && this.vy < 0) continue;
      if (this.overlapsBlock(block)) {
        if (this.vy > 0) {
          // Landing on top
          this.y = block.y;
          this.vy = 0;
          this.onGround = true;
          this.jumpArc = false;
        } else if (this.vy < 0) {
          // Bumping head
          this.y = block.y + block.h + this.h;
          this.vy = 0;
        }
      }
    }

    // Clamp y after block collision — the block collision can push the bot
    // below the ground (e.g., ceiling collision on a ground brick), and the
    // ground collision above already ran. Re-check here.
    if (this.y >= groundY) {
      this.y = groundY;
      this.vy = 0;
      this.onGround = true;
      this.jumpArc = false;
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
    //
    // Three cases skip the sync — in each, the AI already set `dir` in
    // runStateMachine and `syncFacing` would override it based on movement
    // displacement, causing oscillation:
    //
    // 1. Clamped by a block: the clamp pushes `this.x` back past `tickStartX`,
    //    so `syncFacing` would flip `dir` every tick against the wall.
    //
    // 2. Jump arc: the bot drifts horizontally in a parabolic path; syncing
    //    against the jump displacement would flip `dir` every frame.
    //
    // 3. Following a path: the bot moves toward waypoints which may be slightly
    //    to the left or right of the bot's current position (especially when
    //    clamped against a block edge). The AI already faces the target enemy;
    //    syncing against waypoint movement would override it and cause
    //    left-right oscillation.
    const followingPath =
      this.pathWaypoints && this.pathIdx < this.pathWaypoints.length;
    if (!this.blockedByBlock && !this.jumpArc && !followingPath) {
      this.syncFacing(this.x - tickStartX);
    }
  }

  /**
   * Find the nearest non-dead enemy to the bot.
   * Returns null if no living enemies exist.
   */
  findNearestEnemy(enemies: EnemyRef[]): EnemyRef | null {
    let nearest: EnemyRef | null = null;
    let minDist = Infinity;
    let fallback: EnemyRef | null = null;
    let fallbackDist = Infinity;

    for (const e of enemies) {
      if (e.dead) continue;
      const dx = e.centreX - this.centreX;
      const dy = e.centreY - this.centreY;
      const dist = Math.hypot(dx, dy);

      // Track the nearest enemy regardless of lock (fallback)
      if (dist < fallbackDist) {
        fallbackDist = dist;
        fallback = e;
      }

      // Skip enemies locked by other bots
      if (e.lockedBy !== undefined && e.lockedBy !== this.id) continue;

      if (dist < minDist) {
        minDist = dist;
        nearest = e;
      }
    }

    // If no unlocked enemies are found, fall back to the nearest enemy
    // regardless of lock status.  Without this, a bot with no locked enemy
    // goes idle when all enemies are locked by other bots.
    return nearest ?? fallback;
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
    this.blockedByBlock = false;
    this.jumpArc = false;
    this.dodgeJumpCooldown = 0;
    this.pathWaypoints = null;
    this.pathIdx = 0;
    this.pathFrame = 0;
    this.pathTargetKey = "";
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

    // Re-derive facing from the net displacement. Two cases skip the sync:
    //
    // 1. When the bot was clamped by a block in update() the clamp already
    //    pushed it past its tick-start, so any additional shove would compound
    //    the false displacement and flip `dir` every tick.
    //
    // 2. When the shove pushes the bot opposite to its intended direction
    //    (e.g. chasing right while a character shoves it left). Without this
    //    guard syncFacing would flip `dir` to -1 every shove, and the AI would
    //    set it back to +1 next tick — oscillation. Keep the AI's target-facing
    //    direction; the bot should face where it's trying to go, not where it
    //   's being bumped.
    if (this.blockedByBlock) return;
    // Use `dir` (always set by the AI in runStateMachine) as the intended
    // direction — it's always 1 or -1, representing where the bot wants to face.
    if (
      Math.sign(shovedX) !== this.dir &&
      Math.abs(shovedX) > 0.5
    ) {
      return;
    }
    this.syncFacing(this.x - (this.tickStartX ?? entryX));
  }

  // ---- Private methods ----

  /** Check AABB overlap between the bot and a block. */
  private overlapsBlock(block: BlockRef): boolean {
    // Tiny horizontal epsilon to absorb sub-pixel floating-point drift at
    // block edges.  Without it, a bot resting exactly on a block surface
    // (right == block.x) can toggle overlapsBlock between true and false
    // every tick, which would flip `blockedByBlock` on and off and fight
    // the AI's target-facing direction.  Vertical checks stay tight so the
    // bot still lands cleanly on block tops and bumps its head on block
    // undersides.
    const hx = 0.01;
    return (
      this.left < block.x + block.w - hx &&
      this.right > block.x + hx &&
      this.top < block.y + block.h &&
      this.bottom > block.y
    );
  }

  /**
   * Face the direction the bot actually moved.
   *
   * The AI picks `dir` from where it *wants* to go in runStateMachine, but a
   * soft character collision can shove the bot the other way afterwards
   * (classically: the bot chases the player, the player steps into it, and the
   * bot ends the tick sliding away from it while still facing it — the
   * "walking backwards" bug). When that happens the sprite has to match the
   * net displacement, so `dir` is re-derived from its sign rather than from
   * the intended velocity.
   *
   * Callers skip this method when the bot was clamped by a block: the clamp
   * pushes `this.x` back past the tick start, which would flip `dir` every
   * tick and make the sprite oscillate left-right against the wall. The AI's
   * target-facing direction is kept instead.
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
    //
    // CHASE also commits to the AI's target-facing direction: runStateMachine
    // always sets `dir` to point at the target enemy, and syncing against
    // actual movement displacement would flip `dir` whenever the bot's real
    // displacement is opposite to the target — which happens when the bot is
    // following a waypoint on the opposite side of the target, is clamped
    // against a block edge, or is shoved by a character against the AI's
    // intent.  The AI's target-facing direction wins; the bot should face
    // where it's trying to go, not where it's being bumped.
    if (
      this.state === BotState.ATTACK ||
      this.state === BotState.SWALLOW ||
      this.state === BotState.CHASE
    ) {
      return;
    }

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
    blocks: BlockRef[],
    groundY: number,
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

        // Force path recomputation when the bot is blocked by a block — the
        // current path may lead into a wall, so re-plan immediately.
        if (this.blockedByBlock) {
          this.pathFrame = PATHFIND_RECOMPUTE;
        }

        // Recompute path every PATHFIND_RECOMPUTE frames or when target changes
        this.pathFrame++;
        const tk =
          `${Math.round(this.targetEnemy.centreX)}_${Math.round(this.targetEnemy.centreY)}`;
        if (this.pathFrame >= PATHFIND_RECOMPUTE || this.pathTargetKey !== tk) {
          this.computePath(
            blocks,
            groundY,
            this.targetEnemy.centreX,
            this.targetEnemy.centreY,
          );
          this.pathFrame = 0;
          this.pathTargetKey = tk;
        }

        // Follow path waypoints if available, else direct movement toward enemy
        let wp: { x: number; y: number } | null = null;
        if (
          this.pathWaypoints &&
          this.pathIdx < this.pathWaypoints.length
        ) {
          // Skip waypoints the bot has already passed.  Do NOT skip waypoints
          // that are above the bot — they are likely jump targets and skipping
          // them would cause the bot to miss the jump.
          while (this.pathIdx < this.pathWaypoints.length) {
            const w = this.pathWaypoints[this.pathIdx];
            const wdx = w.x - this.centreX;
            const wdy = w.y - this.centreY;
            // Skip waypoints the bot has already passed (more than 2 cells behind)
            if (wdx < -PATHFIND_CELL * 2) {
              this.pathIdx++;
              continue;
            }
            // Don't skip waypoints that are above the bot — they are jump targets
            if (wdy < -5) break;
            if (Math.hypot(w.x - this.centreX, w.y - this.centreY) > 10) break;
            this.pathIdx++;
          }
          wp =
            this.pathIdx < this.pathWaypoints.length
              ? this.pathWaypoints[this.pathIdx]
              : null;
        }

        if (wp) {
          const dx = wp.x - this.centreX;
          const dy = wp.y - this.centreY;
          // Face the target enemy, not the waypoint. The waypoint determines
          // movement direction, but facing should always be toward the target.
          // This prevents oscillation when waypoints near block edges have a
          // slightly different X than the bot's position, and also during a
          // jump arc — the bot keeps facing its target even while following a
          // parabolic path.
          if (this.targetEnemy) {
            this.dir = this.targetEnemy.centreX > this.x ? 1 : -1;
          }
          // If targetEnemy is null, keep current dir — don't flip based on
          // waypoint. This prevents oscillation during multi-bot target swaps
          // and when blocked by walls.

          // While airborne in a jump arc, keep the existing vx (set when the
          // jump was triggered) and do not recalculate from the waypoint —
          // recalculating vx every frame during a jump causes oscillation when
          // the bot overshoots the waypoint horizontally.
          if (this.jumpArc) {
            this.setAnimState("jump");
            return;
          }

          // Waypoint deadzone: when very close to a waypoint on the ground,
          // stop and advance to the next waypoint.  The bot's speed (3.75px/
          // frame) exceeds the old 10px skip threshold, so the bot overshoots
          // the waypoint and moveDir flips every tick (vx oscillation).  A 5px
          // deadzone lets the bot settle before advancing.
          if (
            this.onGround &&
            Math.abs(dx) < 5 &&
            Math.abs(dy) < 5
          ) {
            this.vx = 0;
            this.pathIdx++;
            this.setAnimState("run");
            return;
          }

          // Move towards the waypoint regardless of facing direction.
          // When dx is 0 the bot is aligned with the waypoint — do not flip
          // direction (the old ternary `dx > 0 ? 1 : -1` returned -1 for dx=0,
          // causing vx oscillation between +speed and -speed every frame).
          const moveDir = dx > 0 ? 1 : dx < 0 ? -1 : 0;
          this.vx = moveDir * this.config.speed * 1.5;

          this.setAnimState("run");

          // Jump when the next waypoint is above the bot.  Trigger the jump
          // as soon as the bot is on the ground and the waypoint is elevated,
          // or immediately when the bot is blocked by a block (stuck against
          // a wall that needs to be jumped over).
          if (this.onGround && this.jumpCooldown <= 0 && dy < -5) {
            // Jump if horizontally close to the waypoint OR if blocked by a block
            if (this.blockedByBlock || Math.abs(dx) < PATHFIND_CELL * 3) {
              // Ensure horizontal drift so the bot doesn't jump vertically in
              // place (block collision may have zeroed vx on the previous tick).
              this.vx = this.dir * this.config.speed * 1.5;
              this.vy = this.config.jumpImpulse;
              this.onGround = false;
              this.jumpArc = true;
              this.setAnimState("jump");
              this.jumpCooldown = 500;
            }
          }
          // If blocked by a block but the waypoint is NOT above, jump anyway as
          // a last-resort dodge — the bot is stuck and needs to break free.
          else if (this.onGround && this.jumpCooldown <= 0 && this.blockedByBlock) {
            this.vx = this.dir * this.config.speed * 1.5;
            this.vy = this.config.jumpImpulse;
            this.onGround = false;
            this.jumpArc = true;
            this.setAnimState("jump");
            this.jumpCooldown = 500;
          }
        } else {
          // No path — fallback to direct movement toward enemy. Only update
          // dir if we have a target; otherwise keep the current facing to
          // avoid flipping on a null target.
          if (nearest) {
            this.dir = nearest.centreX > this.x ? 1 : -1;
          }
          this.vx = this.dir * this.config.speed * 1.5;

          // While airborne in a jump arc, maintain drift
          if (this.jumpArc) {
            this.setAnimState("jump");
            return;
          }

          this.setAnimState("run");

          // Jump if the target is above the bot and the jump cooldown is ready.
          if (this.onGround && this.jumpCooldown <= 0) {
            const targetTop = this.targetEnemy.centreY - this.targetEnemy.h / 2;
            if (
              targetTop < this.top - 10 &&
              targetHDist < this.config.chaseRange * 0.6
            ) {
              this.vx = this.dir * this.config.speed * 1.5;
              this.vy = this.config.jumpImpulse;
              this.onGround = false;
              this.jumpArc = true;
              this.setAnimState("jump");
              this.jumpCooldown = 500;
            }
          }
          // Blocked by a block with no path — jump as a dodge
          else if (this.onGround && this.jumpCooldown <= 0 && this.blockedByBlock) {
            this.vx = this.dir * this.config.speed * 1.5;
            this.vy = this.config.jumpImpulse;
            this.onGround = false;
            this.jumpArc = true;
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

  // ---- Pathfinding ----

  /**
   * Build a path from the bot to a target using grid-based A*.
   * The grid is marked with blocks as obstacles. Jumping and falling
   * are modelled as multi-cell vertical moves.
   */
  private computePath(
    blocks: BlockRef[],
    groundY: number,
    tx: number,
    ty: number,
  ): void {
    const cols = Math.max(1, Math.ceil(this.canvasWidth / PATHFIND_CELL) + 1);
    const rows = Math.max(1, Math.ceil(Math.max(groundY, 1) / PATHFIND_CELL) + 1);
    const blocked = new Uint8Array(cols * rows);

    // Mark cells overlapped by blocks (skip ground bricks — they are handled
    // by the ground collision check and would block the entire ground row)
    for (const b of blocks) {
      if (b.dead) continue;
      if (b.y >= groundY - 1) continue;
      const bx1 = Math.max(0, Math.floor(b.x / PATHFIND_CELL));
      const bx2 = Math.min(cols - 1, Math.floor((b.x + b.w) / PATHFIND_CELL));
      const by1 = Math.max(0, Math.floor(b.y / PATHFIND_CELL));
      const by2 = Math.min(rows - 1, Math.floor((b.y + b.h) / PATHFIND_CELL));
      for (let cy = by1; cy <= by2; cy++) {
        for (let cx = bx1; cx <= bx2; cx++) {
          blocked[cy * cols + cx] = 1;
        }
      }
    }

    // Block cells whose centre lies at or below groundY — the bot cannot go
    // below the ground surface, and waypoints below ground are unreachable,
    // causing the bot to oscillate forever trying to approach them.
    for (let cy = 0; cy < rows; cy++) {
      if ((cy + 0.5) * PATHFIND_CELL >= groundY) {
        for (let cx = 0; cx < cols; cx++) {
          blocked[cy * cols + cx] = 1;
        }
      }
    }

    // Bot's cell (centre-based)
    let sgx = Math.max(
      0,
      Math.min(cols - 1, Math.floor(this.x / PATHFIND_CELL)),
    );
    let sgy = Math.max(
      0,
      Math.min(
        rows - 1,
        Math.floor((this.y - this.h * 0.5) / PATHFIND_CELL),
      ),
    );
    // Target's cell
    let egx = Math.max(0, Math.min(cols - 1, Math.floor(tx / PATHFIND_CELL)));
    let egy = Math.max(0, Math.min(rows - 1, Math.floor(ty / PATHFIND_CELL)));

    // If start is blocked, find nearest free cell
    if (blocked[sgy * cols + sgx]) {
      const n = this.findNearestFree(blocked, cols, rows, sgx, sgy);
      if (!n) {
        this.pathWaypoints = null;
        this.pathIdx = 0;
        return;
      }
      sgx = n[0];
      sgy = n[1];
    }
    // If end is blocked, find nearest free cell
    if (blocked[egy * cols + egx]) {
      const n = this.findNearestFree(blocked, cols, rows, egx, egy);
      if (!n) {
        this.pathWaypoints = null;
        this.pathIdx = 0;
        return;
      }
      egx = n[0];
      egy = n[1];
    }

    const grid: PathGrid = { cols, rows, blocked };
    const path = this.astar(grid, sgx, sgy, egx, egy);

    if (!path || path.length === 0) {
      this.pathWaypoints = null;
      this.pathIdx = 0;
      return;
    }

    // Convert grid cells to canvas waypoints (cell centres).
    // Skip the first cell (start cell) — the bot is already there.
    this.pathWaypoints = (path.length > 1 ? path.slice(1) : path).map((c) => ({
      x: c.gx * PATHFIND_CELL + PATHFIND_CELL * 0.5,
      y: c.gy * PATHFIND_CELL + PATHFIND_CELL * 0.5,
    }));
    this.pathIdx = 0;
  }

  /** A* search on the grid. Returns a list of grid cells from start to end. */
  private astar(
    grid: PathGrid,
    sgx: number,
    sgy: number,
    egx: number,
    egy: number,
  ): { gx: number; gy: number }[] | null {
    const { cols, rows, blocked } = grid;

    if (blocked[sgy * cols + sgx] || blocked[egy * cols + egx]) return null;

    const total = cols * rows;
    const gScore = new Float32Array(total);
    const cameFrom = new Int32Array(total);
    const closed = new Uint8Array(total);
    gScore.fill(Infinity);
    cameFrom.fill(-1);

    const startKey = sgy * cols + sgx;
    const endKey = egy * cols + egx;
    gScore[startKey] = 0;

    const hfn = (x: number, y: number) =>
      Math.abs(x - egx) + Math.abs(y - egy);

    const open: PathNode[] = [];
    open.push({ gx: sgx, gy: sgy, g: 0, f: hfn(sgx, sgy) });

    let steps = 0;
    while (open.length > 0 && steps < PATHFIND_MAX_STEPS) {
      // Find node with lowest f
      let mi = 0;
      for (let i = 1; i < open.length; i++) {
        if (open[i].f < open[mi].f) mi = i;
      }
      const cur = open[mi];
      open.splice(mi, 1);

      const curKey = cur.gy * cols + cur.gx;

      // Skip stale entries: g-score has been improved since this entry was added.
      // Use tolerance comparison because gScore is Float32Array and cur.g is Float64.
      if (Math.abs(cur.g - gScore[curKey]) > 0.001) continue;

      // Skip already-closed nodes (prevents redundant re-expansion)
      if (closed[curKey]) continue;

      steps++;
      if (curKey === endKey) {
        // Reconstruct path
        const path: { gx: number; gy: number }[] = [];
        let ck = curKey;
        while (ck !== -1) {
          path.unshift({ gx: ck % cols, gy: (ck / cols) | 0 });
          ck = cameFrom[ck];
        }
        return path;
      }

      closed[curKey] = 1;

      // Explore neighbours
      const neighbours = this.getNeighbors(grid, cur.gx, cur.gy);
      for (let ni = 0; ni < neighbours.length; ni++) {
        const [nx, ny, cost] = neighbours[ni];
        const nk = ny * cols + nx;
        if (closed[nk]) continue;
        const tg = cur.g + cost;
        if (tg < gScore[nk]) {
          gScore[nk] = tg;
          cameFrom[nk] = curKey;
          open.push({
            gx: nx,
            gy: ny,
            g: tg,
            f: tg + hfn(nx, ny),
          });
        }
      }
    }

    return null;
  }

  /** Generate valid neighbour cells from (x, y) with movement costs. */
  private getNeighbors(
    grid: PathGrid,
    x: number,
    y: number,
  ): Array<[number, number, number]> {
    const { cols, rows, blocked } = grid;
    const result: Array<[number, number, number]> = [];

    // Walk horizontally (left/right)
    for (const dx of [-1, 1] as const) {
      const nx = x + dx;
      if (nx >= 0 && nx < cols && !blocked[y * cols + nx]) {
        result.push([nx, y, 1]);
      }
    }

    // Fall downward (gravity — bot can drop onto any free cell below)
    for (let dy = 1; dy <= PATHFIND_FALL_H && y + dy < rows; dy++) {
      const ny = y + dy;
      if (blocked[ny * cols + x]) break; // can't fall through a block
      result.push([x, ny, 1]);
    }

    // Jump upward (up to PATHFIND_JUMP_H cells, with horizontal drift)
    for (let dy = 1; dy <= PATHFIND_JUMP_H; dy++) {
      const ny = y - dy;
      if (ny < 0) break;

      // Check that no block sits directly above the start cell (vertical clearance)
      let blockedPath = false;
      for (let cy = y - 1; cy >= ny; cy--) {
        if (blocked[cy * cols + x]) {
          blockedPath = true;
          break;
        }
      }
      if (blockedPath) break; // Can't jump through a block; higher jumps won't work either

      for (let dx = -PATHFIND_JUMP_W; dx <= PATHFIND_JUMP_W; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < cols && !blocked[ny * cols + nx]) {
          const cost = dy * 2 + Math.abs(dx);
          result.push([nx, ny, cost]);
        }
      }
    }

    return result;
  }

  /** Find the nearest non-blocked cell to (cx, cy) within a small radius. */
  private findNearestFree(
    blocked: Uint8Array,
    cols: number,
    rows: number,
    cx: number,
    cy: number,
  ): [number, number] | null {
    for (let r = 1; r < 13; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (
            nx >= 0 &&
            nx < cols &&
            ny >= 0 &&
            ny < rows &&
            !blocked[ny * cols + nx]
          ) {
            return [nx, ny];
          }
        }
      }
    }
    return null;
  }
}
