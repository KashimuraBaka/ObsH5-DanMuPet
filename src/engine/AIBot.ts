/**
 * AIBot — AI-controlled character that uses Kirby's animations.
 *
 * Standalone kinematic entity (no planck.js, no Character.ts, no PhysicsWorld.ts).
 * Uses simple AABB collision against ground and blocks.
 * Shares the game world with the main character (groundY, blocks, enemies).
 *
 * The behaviour model follows the original game's shape: one per-frame
 * pipeline that (1) asks a decision function what to do, (2) integrates the
 * resulting *intent*, (3) resolves collisions, and (4) advances the sprite.
 * The AI never writes x/y/vy directly outside of jump initiation — see
 * `runStateMachine` and `runPatrol` for the rules that keep it that way.
 */

import defaultAnimDataRaw from "../assets/sprites/kirby.json";
import {
  BOT_COLLIDE_MAX_RESOLVE,
  BOT_COLLIDE_SOFTNESS,
  BOT_COLLIDE_VERT_TOL,
  BOT_INHALE_DAMAGE,
  BOT_INHALE_REHIT_MS,
  BOT_LAST_SEEN_MS,
  BOT_LEDGE_GROUND_BAND_PX,
  BOT_LEDGE_LOOKAHEAD_PX,
  BOT_LEDGE_PROBE_HALF_PX,
  BOT_LEDGE_STEP_DOWN_PX,
  BOT_MIN_SPACING,
  BOT_ROAM_RANGE_PX,
  BOT_ROAM_TURN_MS,
  BOT_WORLD_SEED,
  FOLLOW_SLOT_SETTLE_PX,
} from "./constants.ts";
import { hashSeed, makeRng, pickWeighted } from "./botRandom.ts";
import {
  PATROL_CLIPS,
  PATROL_CLIP_WEIGHTS,
  type MotionClip,
} from "./motionClips.ts";
import type { DamageKind } from "./types.ts";

// ---- Animation metadata helpers ----

/**
 * Shape a bot needs from an animation dataset: just enough to know how many
 * frames a clip has and whether it loops.
 */
export interface BotAnimData {
  animations: Record<
    string,
    { frames: unknown[]; loop: boolean; frameDurationMs: number }
  >;
}

const defaultAnimData = defaultAnimDataRaw as unknown as BotAnimData;

/** Whether a clip loops in the given dataset; unknown states default to true. */
function getLooping(data: BotAnimData, state: string): boolean {
  const a = data.animations?.[state];
  return a ? a.loop : true;
}

/** Frame count for a clip in the given dataset; unknown states draw one frame. */
function getFrameCount(data: BotAnimData, state: string): number {
  const a = data.animations?.[state];
  return a ? a.frames.length : 1;
}

const FRAME_DURATIONS: Record<string, number> = {
  idle: 500,
  crouch: 500,
  walk: 50,
  run: 50,
  jump: 30,
  attack: 40,
  swallow: 60,
  // Two clips the intent resolver can land on for a mage character, which is
  // the whole point of CLIP_FALLBACK: an intent is a *request*, and the dataset
  // decides what actually plays. They need frame durations too, otherwise they
  // silently fall back to the 100 ms catch-all in setAnimState().
  dance: 40,
  lie: 60,
};

// ---- Presentation intents ----

/**
 * What the AI wants the character to *look* like, independent of what the
 * dataset can actually draw.
 *
 * Before this existed the code wrote clip names as string literals at 28 call
 * sites, so a character type that does not ship a clip silently fell back to
 * idle at the renderer. Every mage skin is in that position: no run, no jump,
 * no attack, no swallow. The result was a mage bot that chased an enemy while
 * visibly standing still. Naming the intent and resolving it against the
 * dataset once, at the point of use, makes that fallback explicit and testable.
 */
export type BotIntent =
  | "idle"
  | "walk"
  | "run"
  | "jump"
  | "attack"
  | "swallow"
  | "stun"
  | "celebrate";

/**
 * Intent → ordered candidate clips; the first one that exists in the current
 * dataset wins. "idle" is the terminal fallback because every dataset has it.
 *
 * For a Kirby bot this is the identity map, so existing behaviour is unchanged.
 * For a mage bot it degrades: run→walk, jump→walk, attack→dance, stun→lie. The
 * ordering is our own design decision, not a port — the original collapses
 * hundreds of enemy types into a handful of outcome buckets so a new type
 * inherits a death animation for free, and this is the same shape applied to
 * clips.
 */
const CLIP_FALLBACK: Record<BotIntent, readonly string[]> = {
  idle: ["idle"],
  walk: ["walk"],
  run: ["run", "walk"],
  jump: ["jump", "walk"],
  attack: ["attack", "dance", "walk"],
  swallow: ["swallow", "walk", "idle"],
  stun: ["lie", "crouch", "idle"],
  celebrate: ["dance", "idle"],
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

  /**
   * Roaming / patrol behaviour. Off by default: with no leader a bot must
   * still stand perfectly still, because that is the guarantee the host and
   * the existing tests rely on ("nobody to follow ⇒ nobody moves").
   */
  roam: boolean;

  /**
   * Activity radius around the bot's home point, in px. Outside it the patrol
   * script is vetoed and the bot walks itself back — see `runPatrol` (2).
   */
  roamRange: number;

  /** How long a patrolling bot walks one way before turning, in ms. */
  roamTurnMs: number;

  /** What to do on finding no floor ahead: walk back, or stop at the lip. */
  ledgePolicy: "turn" | "brake";

  /** Seed for this bot's private random stream. Same seed ⇒ same behaviour. */
  worldSeed: number;

  /**
   * Scripted patrol.
   *
   * - omitted / `undefined` → one is drawn from `PATROL_CLIPS` at construction
   * - `null`              → no script; run the plain walk / pause / turn loop
   * - a `MotionClip`      → use exactly this one
   */
  patrolClip?: MotionClip | null;
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
  /**
   * Optional damage sink. Real `Enemy` instances have it; duck-typed literals
   * (test fixtures, host stubs) do not, which is why the bot keeps a fallback
   * path instead of assuming the method exists.
   */
  takeDamage?(amount: number, kind?: DamageKind): boolean;
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
  patrolTimer: number;
  jumpCooldown: number;

  // Identity
  id: number;

  /** Canvas width for boundary wrapping. Set externally before/during update(). */
  canvasWidth: number = 800;

  /** Set to true to disable the bot. Checked at the start of update(). */
  dead: boolean = false;

  /**
   * Set by the host while the player is driving this particular bot by hand
   * (manual takeover). Takes precedence over `aiStopped`: the bot's own script
   * is skipped and `manualDriveDir` moves it instead. Gravity, boundary wrap
   * and the soft character collisions all keep applying, so a driven bot that
   * gets shoved still faces the way it actually goes.
   */
  manualDriven: boolean = false;

  /**
   * Set by the host when the player pauses AI from the 角色生成 panel. The bot
   * keeps existing and keeps simulating — gravity, boundary wrap and the soft
   * collisions all still run — but acts out no script at all: it stands at idle
   * instead of chasing, following or attacking.
   */
  aiStopped: boolean = false;

  /** Direction the player is holding for this bot while `manualDriven`. */
  manualDriveDir: number = 0;

  /**
   * One-shot jump request from the keyboard, set by the store when the player
   * presses the jump key while this bot is being driven. Consumed (and reset)
   * in the next on-ground tick of the `manualDriven` branch.
   */
  manualJump: boolean = false;

  /**
   * Stable horizontal offset (in canvas px) assigned at construction time. The
   * follow-player branch targets `leader.x + slotOffset` for this bot, so each
   * bot has its own "should-be position" relative to the leader instead of all
   * bots piling onto the player's exact x. Assigned once at spawn — a bot keeps
   * its slot even if other bots are added or removed afterwards.
   */
  slotOffset: number = 0;

  /**
   * Which character this bot was generated as. Decides its animation dataset,
   * its sprite sheet and the states it can actually play — a mage bot is drawn
   * from a mage sheet and only the five states those sheets ship.
   */
  characterType: string = "kirby";

  /** Mage skin variant, only meaningful when `characterType === "mage"`. */
  mageSkin: string = "mage";

  /**
   * Animation dataset for this bot's character type, injected at construction
   * so AIBot does not need to import every character's JSON itself.
   */
  animData: BotAnimData = defaultAnimData;

  // Private timers
  private idleTimer = 0;
  private attackTimer = 0;

  /**
   * Damage of a single successful bite. Static because it is a property of the
   * bot's attack rather than of an instance — and because it has to stay
   * coupled to the clamp inside `Enemy.takeDamage`: at 1, the resistance
   * column would be arithmetically dead (see BOT_INHALE_DAMAGE).
   */
  private static readonly INHALE_DAMAGE = BOT_INHALE_DAMAGE;

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

  // ---- Roaming / patrol state ----

  /**
   * X this bot treats as "home", anchored on its position the first time it
   * ticks. Deliberately not captured in the constructor: the host (and the
   * tests) place the bot *after* construction, so a value taken there would be
   * 0 and the bot would immediately read as out of range.
   */
  private homeX: number | null = null;

  /**
   * Cursor into the active patrol script: which segment, and how many ms of it
   * are left. Both are cleared together by `turnAround()` so a forced turn
   * cannot resume a segment that is already half over.
   */
  private clipIdx = 0;
  private clipLeft = 0;

  /**
   * Name of the patrol script this bot last ran. Its weight is zeroed the next
   * time a script is drawn, so a revived bot does not replay the identical
   * routine (the original's boss brains zero the previous action's weight and
   * let the rest renormalise).
   */
  private lastAction: string | null = null;

  /**
   * Remaining ms of target memory. Decremented exactly once per tick, in
   * update(); the chase decision only ever reads it.
   */
  private lastSeenTimer = 0;

  /** Remaining ms before this bot may land another damaging bite. */
  private hitCooldown = 0;

  /**
   * Private random stream for this bot only. Deriving one per agent from
   * `(worldSeed, id)` instead of sharing a single global word is a deliberate
   * departure from the original, where one `gRngVal` word feeds every enemy in
   * the room: sharing it makes one bot's behaviour depend on how many other
   * bots exist, and makes a single bot impossible to reproduce in isolation.
   */
  private rng: () => number;

  /**
   * Behaviour override, in the spirit of the original's `unk78` override: a
   * reaction replaces the current decision rather than being pushed on a stack,
   * and expiry drops straight back into normal thinking. Nothing in the project
   * can damage a bot yet, so `requestOverride()` has no internal caller — the
   * hook exists so a damage source does not have to redesign the state machine
   * when it arrives.
   */
  private override: { until: number; intent: BotIntent } | null = null;

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
    this.setIntent("jump");
    this.dodgeJumpCooldown = 500;
    this.blockedTimer = 0;
  }

  constructor(
    config: Partial<AIBotConfig> = {},
    appearance?: {
      characterType?: string;
      mageSkin?: string;
      animData?: BotAnimData;
      slotOffset?: number;
    },
  ) {
    this.characterType = appearance?.characterType ?? "kirby";
    this.mageSkin = appearance?.mageSkin ?? "mage";
    this.animData = appearance?.animData ?? defaultAnimData;
    this.slotOffset = appearance?.slotOffset ?? 0;
    this.config = {
      name: "Bot",
      speed: 2.5,
      jumpImpulse: -10.5,
      chaseRange: 9999,
      attackRange: 60,
      gravity: 0.4,
      playerFollowRange: 340,
      playerStayRange: 120,
      roam: false,
      roamRange: BOT_ROAM_RANGE_PX,
      roamTurnMs: BOT_ROAM_TURN_MS,
      ledgePolicy: "turn",
      worldSeed: BOT_WORLD_SEED,
      // No default on purpose: leaving `patrolClip` absent is what asks the
      // constructor to draw one, which in turn needs `id` to have been assigned.
      ...config,
    };
    this.name = this.config.name;
    this.id = nextBotId++;
    this.rng = makeRng(hashSeed(this.config.worldSeed, this.id));
    // The patrol script is drawn once, here, and then fixed for the bot's
    // lifetime. The original binds a movement script to the enemy template
    // rather than re-rolling it per frame; re-rolling would also make the same
    // seed play back differently on every visit to the state.
    if (this.config.patrolClip === undefined) {
      this.config.patrolClip = this.drawPatrolClip();
    }
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.w = 24;
    this.h = 26;
    this.dir = 1;
    this.state = BotState.IDLE;
    // Field initialisation, not a clip switch. `setIntent` early-outs when the
    // resolved clip is unchanged, so routing the constructor through it would
    // silently skip the frame-duration lookup below.
    this.animState = "idle";
    this.animFrameIndex = 0;
    this.animTime = 0;
    this.frameDurationMs = FRAME_DURATIONS.idle ?? 500;
    this.onGround = false;
    this.targetEnemy = null;
    this.swallowTimer = 0;
    this.recoverTimer = 0;
    // Staggered first leg: 5/8 to 15/16 of a full turn, so a group spawned in
    // one frame does not reverse in lockstep. Derived from the *configured*
    // turn time, so changing `roamTurnMs` actually changes the cadence.
    this.patrolTimer = Math.round(
      this.config.roamTurnMs * (0.625 + 0.3125 * this.rng()),
    );
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
   * @param playerX    X position of the player in canvas coords (null = none)
   * @param playerY    Y position of the player in canvas coords (null = none)
   */
  update(
    deltaTime: number,
    groundY: number,
    blocks: BlockRef[],
    enemies: EnemyRef[],
    playerX: number | null,
    playerY: number | null,
  ): void {
    if (this.dead) return;
    const tickStartX = this.x;
    this.tickStartX = tickStartX;

    // Anchor "home" on the first tick rather than in the constructor: the host
    // (and the tests) place the bot after construction, so the spawn point is
    // only known here. Until it is set, roaming is inert.
    if (this.homeX === null) this.homeX = this.x;

    // Decrement countdown timers
    if (this.swallowTimer > 0) this.swallowTimer -= deltaTime;
    if (this.recoverTimer > 0) this.recoverTimer -= deltaTime;
    if (this.jumpCooldown > 0) this.jumpCooldown -= deltaTime;
    if (this.patrolTimer > 0) this.patrolTimer -= deltaTime;
    if (this.dodgeJumpCooldown > 0) this.dodgeJumpCooldown -= deltaTime;
    if (this.hitCooldown > 0) this.hitCooldown -= deltaTime;
    // Target memory. Decremented here and nowhere else — the chase decision
    // reads it without writing it, so the window lasts exactly lastSeenMs
    // instead of half of that.
    if (this.lastSeenTimer > 0) this.lastSeenTimer -= deltaTime;

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
    // A patroller standing still on purpose (a zero-velocity clip segment) is
    // not "blocked": without this it would quietly accumulate blockedTimer and
    // eventually be told to hop over an obstacle that was never there.
    const intendsMotion = this.state !== BotState.PATROL || this.vx !== 0;

    if (
      Math.abs(tickDelta) < 0.5 &&
      this.onGround &&
      wantsToMove &&
      intendsMotion
    ) {
      this.blockedTimer += deltaTime;
    } else {
      this.blockedTimer = 0;
    }

    this.triggerDodgeJump();

    // ---- Boundary wrap-around ----
    const margin = 40;
    if (this.x > this.canvasWidth + margin) {
      this.x = -margin;
      // A wrap is a teleport, so "home" has to travel with it. Otherwise a
      // patrolling bot lands on the far edge, reads as instantly out of range,
      // and trudges all the way back across the canvas.
      this.homeX = this.x;
    } else if (this.x < -margin) {
      this.x = this.canvasWidth + margin;
      this.homeX = this.x;
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
   * Land one contact hit on an enemy and report whether that finished it.
   *
   * `takeDamage` is optional on purpose: the test fixtures are duck-typed
   * object literals with no damage method at all. Falling back to the old
   * "mark it dead outright" keeps those working, instead of turning a missing
   * method into a silently swallowed hit.
   */
  private applyHit(e: EnemyRef, dmg: number): boolean {
    if (typeof e.takeDamage === "function") return e.takeDamage(dmg);
    e.dead = true;
    return true;
  }

  /**
   * During ATTACK state, check if any enemy is within attackRange and in front
   * of the bot. If caught, resolve one damage tick against it and return it
   * **only if that tick killed it**. An enemy that survives keeps the attack
   * state alive (stunned, health bar ticking down) and is hit again once the
   * re-hit gap has passed.
   *
   * The gap matters: the attack state re-tests every tick, so without it a
   * 5 hp enemy would lose all five points in three frames (48 ms) and the
   * entire point of the damage model — a visible hit reaction — would never
   * appear.
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
        if (this.hitCooldown > 0) return null;
        this.hitCooldown = BOT_INHALE_REHIT_MS;
        if (this.applyHit(e, AIBot.INHALE_DAMAGE)) return e;
        return null;
      }
    }

    return null;
  }

  /**
   * Ask for an external behaviour override — the slot a hit reaction would
   * occupy. The original game overrides the behaviour callback outright on a
   * hit (no save/restore stack: the enemy just re-enters its normal decision
   * point when the reaction ends); this is the same rule at a single level.
   * There is no caller yet because nothing in the project can damage a bot,
   * which is why it is a public hook rather than an internal branch.
   */
  requestOverride(intent: BotIntent, ms: number): void {
    this.override = { until: ms, intent };
  }

  /** Reset the bot to IDLE state, clearing all timers and targets. */
  reset(): void {
    this.state = BotState.IDLE;
    this.setIntent("idle");
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
    this.lastSeenTimer = 0;
    this.hitCooldown = 0;
    this.override = null;
    this.clipIdx = 0;
    this.clipLeft = 0;
    // A reset is a fresh start, so the patrol script is drawn again — with the
    // previous script's weight zeroed, which is what stops a revived bot from
    // replaying the identical routine. A bot that opted out of scripts (an
    // explicit `null`) stays that way.
    if (this.config.patrolClip !== null) {
      this.lastAction = null;
      this.config.patrolClip = this.drawPatrolClip();
    }
    this.homeX = this.x;
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
      const push = Math.min(
        shortfall * BOT_COLLIDE_SOFTNESS,
        BOT_COLLIDE_MAX_RESOLVE,
      );
      // When this bot is mid-walk toward a slot (vx was set by runStateMachine
      // this tick in the follow branch) the soft-push fights the walk when
      // the bot is crossing past another bot whose slot is on the opposite
      // side of the leader. The natural shove direction is away from `other`,
      // but `away` here can point opposite to where this bot actually wants
      // to go — and pushing it that way traps the whole cluster around the
      // leader, because every tick the walk step (2.5 px) is dwarfed by the
      // push step (up to 10 px) in the wrong direction. Skip the push when
      // it would move against the bot's current walk intent; the two bots
      // cross paths and the walk continues. vx=0 bots (idle) skip the check
      // so the soft-push still nudges them when settled bots get shoved by
      // a third body.
      if (this.vx !== 0 && away !== Math.sign(this.vx)) continue;
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
      this.setIntent("walk");
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
    // `dir` is the AI's intended facing. It is always 1 or -1; it is *not*
    // necessarily reassigned every tick — the follow branch deliberately keeps
    // the current facing when the bot has settled into its slot.
    if (Math.sign(shovedX) !== this.dir && Math.abs(shovedX) > 0.5) {
      return;
    }
    this.syncFacing(this.x - (this.tickStartX ?? entryX));
  }

  // ---- Private methods ----

  /**
   * Map a presentation intent onto a clip that actually exists in this bot's
   * dataset. This is the single place where "what the AI wants" meets "what
   * the art has".
   */
  private resolveClip(intent: BotIntent): string {
    const candidates = CLIP_FALLBACK[intent];
    for (let i = 0; i < candidates.length; i++) {
      if (this.animData.animations?.[candidates[i]]) return candidates[i];
    }
    return "idle";
  }

  /**
   * Request a presentation and let the dataset pick the concrete clip.
   *
   * The ordering inside `setAnimState` matters: the intent is resolved *first*
   * and the resulting clip is what gets compared for the "already there" early
   * out. Comparing intents instead would never early-out (two different
   * intents can resolve to one clip) and would restart the animation every
   * tick of a state that had not actually changed.
   */
  private setIntent(intent: BotIntent): void {
    this.setAnimState(this.resolveClip(intent));
  }

  /**
   * Draw this bot's patrol script from `PATROL_CLIPS`, with the script it ran
   * last time excluded (the anti-repetition rule: zero the previous bucket,
   * let the rest renormalise, which the subtractive picker gives for free).
   */
  private drawPatrolClip(): MotionClip | null {
    const weights = PATROL_CLIP_WEIGHTS.map((w, i) =>
      PATROL_CLIPS[i] && PATROL_CLIPS[i].name === this.lastAction ? 0 : w,
    );
    const pick = pickWeighted(this.rng, weights);
    // -1 means every weight was zero (a one-entry table that just got
    // suppressed). Keeping the current script is the safe reading of "no
    // alternative"; re-rolling forever would be a livelock.
    if (pick < 0 || !PATROL_CLIPS[pick]) return this.config.patrolClip ?? null;
    this.lastAction = PATROL_CLIPS[pick].name;
    return PATROL_CLIPS[pick];
  }

  /**
   * Is there still floor under the bot one short step ahead?
   *
   * Pure geometry — no state, no allocation, no time term — so it cannot
   * introduce frame-rate dependence. Two rules, in this order:
   *
   * 1. The ground plane is infinite in x, so a bot standing on it always has
   *    ground ahead. This must be checked first, for two reasons: the world
   *    wraps at the canvas edges (a wrap teleports the bot across, and a
   *    blocks-only test would read that as a cliff), and the normal scene runs
   *    the follow branch with no blocks in range at all.
   * 2. Otherwise look for a live block whose *top* is within stepping range:
   *    not more than a hair above the feet (that is a wall to jump, not a
   *    step) and not more than one step down (that is a fall, not a walk).
   */
  private isGroundAhead(
    blocks: BlockRef[],
    groundY: number,
    dir: 1 | -1,
  ): boolean {
    const probeX = this.x + dir * BOT_LEDGE_LOOKAHEAD_PX;
    const footY = this.y; // AIBot's y is its foot line

    // Rule 1 — ground plane.
    if (groundY - footY <= BOT_LEDGE_GROUND_BAND_PX) return true;

    // Rule 2 — a block top within stepping range under the probe window.
    for (const b of blocks) {
      if (b.dead) continue;
      if (b.y >= groundY - 1) continue; // ground bricks are covered by rule 1
      if (probeX + BOT_LEDGE_PROBE_HALF_PX < b.x) continue;
      if (probeX - BOT_LEDGE_PROBE_HALF_PX > b.x + b.w) continue;
      if (b.y < footY - BOT_LEDGE_GROUND_BAND_PX) continue; // too high to step onto
      if (b.y > footY + BOT_LEDGE_STEP_DOWN_PX) continue; // too far down to climb back
      return true;
    }
    return false;
  }

  /**
   * Flip the patrol direction and re-arm the turn timer.
   *
   * The three writes happen together on purpose — the original does the same
   * (`flags ^= 1; xspeed = -xspeed; counter = 0;`). The script is restarted
   * for the same reason: resuming a segment halfway through after a forced
   * turn reads as the bot stuttering.
   */
  private turnAround(): void {
    this.dir = -this.dir as 1 | -1;
    this.patrolTimer = this.config.roamTurnMs;
    this.clipIdx = 0;
    this.clipLeft = 0;
  }

  /**
   * Advance the scripted patrol by one tick.
   *
   * Writes horizontal intent and presentation only — never x, y or vy. Vertical
   * motion belongs to the physics step, which is exactly why the original's
   * script fields for y-speed and per-axis acceleration were dropped instead of
   * ported.
   *
   * Durations are approximate: at most one segment boundary is crossed per
   * tick, so at low frame rates a clip runs slightly long rather than
   * catching up in a burst.
   */
  private motionStep(clip: MotionClip, deltaTime: number): void {
    if (clip.segs.length === 0) return;
    const seg = clip.segs[this.clipIdx];
    if (!seg) return;

    if (this.clipLeft <= 0) {
      // Entering a segment: honour its turn request, latch its duration and
      // publish its presentation (an intent-less segment keeps the previous).
      if (this.clipIdx > 0 && seg.turn) this.dir = -this.dir as 1 | -1;
      this.clipLeft = seg.ms;
      if (seg.intent) this.setIntent(seg.intent);
      this.vx = seg.vx * this.config.speed;
      if (this.clipLeft <= 0) {
        // Zero-length segment: step over it rather than spin on it forever.
        this.advanceClip(clip);
        return;
      }
    }

    // A non-zero segment velocity always re-derives the facing. A sprite
    // walking backwards is a much louder bug than a redundant `turn` flag.
    if (seg.vx !== 0) this.dir = seg.vx > 0 ? 1 : -1;

    this.clipLeft -= deltaTime;
    if (this.clipLeft <= 0) this.advanceClip(clip);
  }

  private advanceClip(clip: MotionClip): void {
    this.clipIdx =
      this.clipIdx + 1 < clip.segs.length
        ? this.clipIdx + 1
        : clip.loop
          ? 0
          : clip.segs.length - 1;
    this.clipLeft = 0;
  }

  /**
   * Patrol for one tick.
   *
   * The priority chain below is the whole design and must not be reshuffled:
   *
   *     wall / ledge veto  >  home radius veto  >  script velocity
   *                       >  timed turn  >  script `turn`
   *
   * The vetoes come first because they are the only rules that can be *wrong*:
   * a scripted segment that walks a bot off a platform, or across the whole
   * canvas, is unrecoverable, while an extra turn is only a differently-shaped
   * loop.
   */
  private runPatrol(
    blocks: BlockRef[],
    groundY: number,
    deltaTime: number,
  ): void {
    this.state = BotState.PATROL;

    // ---- (1) veto layer: wall or ledge ----
    if (
      this.blockedByBlock ||
      (this.onGround && !this.isGroundAhead(blocks, groundY, this.dir))
    ) {
      // A wall is always turned away from. A ledge depends on policy: "brake"
      // stops dead on the lip for this tick, "turn" walks back the way it came.
      if (this.config.ledgePolicy === "brake" && !this.blockedByBlock) {
        this.vx = 0;
        this.dir = -this.dir as 1 | -1;
        this.patrolTimer = this.config.roamTurnMs;
        this.clipIdx = 0;
        this.clipLeft = 0;
      } else {
        this.turnAround();
      }
      // The veto also invalidates the running segment — the script was about to
      // keep walking, which is exactly what must stop happening.
      this.setIntent(this.onGround ? "walk" : "jump");
      this.vx = this.onGround ? this.dir * this.config.speed : 0;
      return;
    }

    // ---- (2) home range: a veto, for the same reason the wall/ledge one is ----
    //
    // The original bounds an enemy's wander with room walls. We have no rooms,
    // so a radius around the spawn point is the equivalent — and it has to have
    // veto power, not merely set a facing.
    //
    // `motionStep` re-derives BOTH `dir` and `vx` from the segment's signed
    // velocity on every tick it runs (:1215 / :1225). A rule that only sets
    // `dir` beforehand is therefore overwritten on every non-zero-velocity
    // frame, and since all three PATROL_CLIPS have a positive net displacement
    // per cycle, a facing hint can never win — the bot walks away for good.
    // Measured before this fix (roamRange 240, dt 16 ms): `fidget` drifted
    // 608 px and never came back, `scurry` 2112 px.
    //
    // So while the bot is outside the radius the script does not drive the legs
    // at all — the same one-tick-early-return shape the wall/ledge veto uses.
    const homeX = this.homeX ?? this.x;
    if (this.onGround && Math.abs(homeX - this.x) > this.config.roamRange) {
      // Turn only when the bot is facing away from home. Flipping an
      // already-correct facing would send it outward, and flipping every tick
      // would make it turn on the spot instead of walking back.
      const headingHome = Math.sign(this.dir) === Math.sign(homeX - this.x);
      if (!headingHome) this.turnAround();
      this.vx = this.dir * this.config.speed;
      this.setIntent(this.onGround ? "walk" : "jump");
      return;
    }
    // In range (or airborne, where the physics step owns vx anyway): hand the
    // legs back to the script below.

    // ---- (3) who drives the legs ----
    if (this.config.patrolClip) {
      this.motionStep(this.config.patrolClip, deltaTime);
    } else {
      if (this.patrolTimer <= 0) this.turnAround();
      this.vx = this.dir * this.config.speed;
      // Patrol is a stroll, not a sprint: `run` stays reserved for chasing.
      this.setIntent("walk");
    }

    // Airborne patrol has no horizontal authority — the physics step owns it.
    if (!this.onGround) {
      this.vx = 0;
      this.setIntent("jump");
    }
  }

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
    //
    // PATROL joins the list for the same reason: the patrol rules own `dir` for
    // a whole tick (wall, ledge, home range, timed turn, script segment), and
    // syncing against displacement would flip it every frame against whatever
    // it is walking into.
    if (
      this.state === BotState.ATTACK ||
      this.state === BotState.SWALLOW ||
      this.state === BotState.CHASE ||
      this.state === BotState.PATROL
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

    const fc = getFrameCount(this.animData, this.animState);
    const looping = getLooping(this.animData, this.animState);

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
    playerX: number | null,
    playerY: number | null,
    blocks: BlockRef[],
    groundY: number,
  ): void {
    // Manual takeover: the player drives this bot directly. Takes precedence
    // over any other AI state. A held direction walks it that way; no key
    // leaves it standing down at idle. Gravity, boundary wrap and the soft
    // character collisions still run.
    if (this.manualDriven) {
      this.targetEnemy = null;
      // Jump request from the keyboard: take off when grounded. Consumed
      // here so a press becomes exactly one jump; re-pressing after landing
      // has to re-arm the flag. jumpCooldown guards against repeated
      // triggers from a held key.
      if (this.manualJump && this.onGround && this.jumpCooldown <= 0) {
        this.vy = this.config.jumpImpulse;
        this.onGround = false;
        this.jumpArc = true;
        this.jumpCooldown = 500;
        this.manualJump = false;
        this.setIntent("jump");
        return;
      }
      // A held direction walks it; no key leaves it standing down at idle.
      if (this.manualDriveDir !== 0) {
        this.vx = this.manualDriveDir * this.config.speed;
        this.dir = this.manualDriveDir > 0 ? 1 : -1;
        this.setIntent("walk");
      } else {
        this.vx = 0;
        this.setIntent("idle");
      }
      return;
    }

    // AI paused from the panel: the character stays on the field but acts out
    // no script. Checked after manualDriven so a hand-driven bot keeps moving.
    if (this.aiStopped) {
      this.targetEnemy = null;
      this.state = BotState.IDLE;
      this.vx = 0;
      this.setIntent("idle");
      return;
    }

    // External behaviour override (hit reaction, and anything else that must
    // take the body over for a while). Placed *before* the no-leader gate so an
    // overridden bot plays its reaction even when there is nobody to follow —
    // otherwise the most dramatic moment would be skipped exactly when there is
    // no crowd watching.
    //
    // Precondition: something has to call `requestOverride()`. Nothing inside
    // the engine does yet (no source of damage exists), which is why this is a
    // public hook rather than an internal branch — see the method's own note.
    if (this.override) {
      this.override.until -= deltaTime;
      this.targetEnemy = null;
      this.vx = 0;
      this.setIntent(this.override.intent);
      if (this.override.until <= 0) this.override = null;
      return;
    }

    // No leader: nobody to follow, nothing to chase towards. Stand completely
    // still — including the push-shuffle animation below — so a cluster of bots
    // at idle looks like a cluster of bots at idle instead of a heap of
    // walking-in-place animations. Checked before pushWalkTimer so a soft push
    // never paints a walk cycle on top of "no target".
    //
    // `roam` is the single exception: a bot explicitly told to patrol is
    // *supposed* to go somewhere when there is nobody to follow. The flag
    // defaults to false, so every bot that has not opted in still stops dead
    // here — which is what the "no leader ⇒ no movement" guarantee rests on.
    if (playerX === null && playerY === null && !this.config.roam) {
      this.targetEnemy = null;
      this.state = BotState.IDLE;
      this.vx = 0;
      this.setIntent("idle");
      return;
    }

    // A shoved bot latches a short walk cycle so it animates its shuffle
    // instead of being snapped back to idle every tick by the AI reset.
    if (
      this.pushWalkTimer > 0 &&
      this.onGround &&
      this.state !== BotState.ATTACK &&
      this.state !== BotState.SWALLOW
    ) {
      this.pushWalkTimer -= deltaTime;
      this.setIntent("walk");
      this.vx = 0;
      return;
    }

    if (
      this.state === BotState.IDLE ||
      this.state === BotState.PATROL ||
      this.state === BotState.CHASE
    ) {
      // ---- target acquisition, then target *memory* ----
      //
      // Two separate decisions on purpose. Re-scanning every tick and dropping
      // the target the instant it crossed chaseRange made bots twitch at the
      // boundary and forget a target that had only briefly stepped out of
      // view. So "what can I see now" (acquisition) is split from "how long do
      // I keep chasing what I last saw" (retention, `lastSeenTimer`).
      //
      // The original game has no such fallback — every chaser special-cases
      // "lost the target" — so this is an addition rather than a port.
      const nearest = this.findNearestEnemy(enemies);
      const enemyDist = nearest
        ? Math.hypot(
            nearest.centreX - this.centreX,
            nearest.centreY - this.centreY,
          )
        : Infinity;
      const acquired = nearest !== null && enemyDist <= this.config.chaseRange;

      // Drop a cached target that has since died *before* deciding, not after:
      // the host splices dead enemies out only after update() returns and then
      // writes `lockedBy` on whatever target this bot reports, so holding a
      // corpse would pin a lock on an object about to disappear.
      if (this.targetEnemy !== null && this.targetEnemy.dead) {
        this.targetEnemy = null;
        this.lastSeenTimer = 0;
      }

      // Retention is read-only here — update() already decremented it this
      // tick, so writing again would halve the window every frame.
      const chasing =
        acquired || (this.lastSeenTimer > 0 && this.targetEnemy !== null);
      // `chasing` gates the target, it does not merely describe it: without the
      // ternary below, a stale `targetEnemy` would keep feeding the CHASE
      // branch after the memory window closed, and the bot would walk to the
      // other side of the map chasing something it had already forgotten.
      const chaseTarget = chasing
        ? acquired
          ? nearest
          : this.targetEnemy
        : null;

      if (chaseTarget) {
        if (acquired) this.lastSeenTimer = BOT_LAST_SEEN_MS;
        this.targetEnemy = chaseTarget;
        this.state = BotState.CHASE;

        const targetHDist = Math.abs(this.targetEnemy.centreX - this.x);
        const targetVDist = Math.abs(this.targetEnemy.centreY - this.centreY);

        // Reached attack range → attack
        if (targetHDist <= this.config.attackRange && targetVDist <= this.h * 2) {
          this.vx = 0;
          this.attackTimer = 0;
          this.state = BotState.ATTACK;
          this.setIntent("attack");
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
        if (
          this.pathFrame >= PATHFIND_RECOMPUTE ||
          this.pathTargetKey !== tk
        ) {
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
          // jump arc — the bot keeps facing its target even while following
          // a parabolic path.
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
            this.setIntent("jump");
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
            this.setIntent("run");
            return;
          }

          // Move towards the waypoint regardless of facing direction.
          // When dx is 0 the bot is aligned with the waypoint — do not flip
          // direction (the old ternary `dx > 0 ? 1 : -1` returned -1 for dx=0,
          // causing vx oscillation between +speed and -speed every frame).
          const moveDir = dx > 0 ? 1 : dx < 0 ? -1 : 0;
          this.vx = moveDir * this.config.speed * 1.5;

          this.setIntent("run");

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
              this.setIntent("jump");
              this.jumpCooldown = 500;
            }
          }
          // If blocked by a block but the waypoint is NOT above, jump anyway as
          // a last-resort dodge — the bot is stuck and needs to break free.
          else if (
            this.onGround &&
            this.jumpCooldown <= 0 &&
            this.blockedByBlock
          ) {
            this.vx = this.dir * this.config.speed * 1.5;
            this.vy = this.config.jumpImpulse;
            this.onGround = false;
            this.jumpArc = true;
            this.setIntent("jump");
            this.jumpCooldown = 500;
          }
        } else {
          // No path — fallback to direct movement toward enemy. Only update
          // dir if we have a target; otherwise keep the current facing to
          // avoid flipping on a null target.
          //
          // `chaseTarget`, not `nearest`: while the bot is running on target
          // memory there may be nothing in range this tick, and the facing has
          // to stay pointed at the remembered target rather than at nothing.
          if (chaseTarget) {
            this.dir = chaseTarget.centreX > this.x ? 1 : -1;
          }
          this.vx = this.dir * this.config.speed * 1.5;

          // While airborne in a jump arc, maintain drift
          if (this.jumpArc) {
            this.setIntent("jump");
            return;
          }

          this.setIntent("run");

          // Jump if the target is above the bot and the jump cooldown is ready.
          if (this.onGround && this.jumpCooldown <= 0) {
            const targetTop =
              this.targetEnemy.centreY - this.targetEnemy.h / 2;
            if (
              targetTop < this.top - 10 &&
              targetHDist < this.config.chaseRange * 0.6
            ) {
              this.vx = this.dir * this.config.speed * 1.5;
              this.vy = this.config.jumpImpulse;
              this.onGround = false;
              this.jumpArc = true;
              this.setIntent("jump");
              this.jumpCooldown = 500;
            }
          }
          // Blocked by a block with no path — jump as a dodge
          else if (
            this.onGround &&
            this.jumpCooldown <= 0 &&
            this.blockedByBlock
          ) {
            this.vx = this.dir * this.config.speed * 1.5;
            this.vy = this.config.jumpImpulse;
            this.onGround = false;
            this.jumpArc = true;
            this.setIntent("jump");
            this.jumpCooldown = 500;
          }
        }

        return;
      }

      // ---- no enemy: follow the leader, else patrol, else stand still ----
      //
      // Follow comes first, always. The project's normal scene always has a
      // leader (Kirby, or a taken-over bot); if patrol outranked it, every bot
      // would abandon its formation the moment it stopped chasing, which would
      // tear the follower tail apart.
      if (playerX !== null && playerY !== null) {
        this.targetEnemy = null;
        this.state = BotState.IDLE;

        // Each bot has a stable horizontal slot relative to the leader, so it
        // targets `leader.x + slotOffset` instead of the player's exact x. This
        // stops the cluster of identical targets that causes bots to keep
        // turning left-right into each other near a stationary player. The
        // settle threshold is small (vs the soft-push step) so once the bot
        // arrives at its slot it stays idle and does not get dragged back into
        // walking by incidental shoves.
        const targetX = playerX + this.slotOffset;
        const dx = targetX - this.x;
        const distToSlot = Math.abs(dx);

        if (distToSlot <= FOLLOW_SLOT_SETTLE_PX) {
          this.vx = 0;
          // Keep the current facing — don't flip on tiny dx wobble, that's the
          // "kept turning left-right" symptom.
          this.setIntent("idle");
          return;
        }

        this.dir = dx > 0 ? 1 : dx < 0 ? -1 : this.dir;
        // Vertical distance still contributes to the run/walk decision: a bot
        // far above or below its slot (mid-jump or falling) should not slow
        // down.
        const dist = Math.hypot(dx, playerY - this.centreY);
        if (dist > this.config.playerFollowRange) {
          this.vx = this.dir * this.config.speed * 1.6;
          this.setIntent("run");
        } else {
          this.vx = this.dir * this.config.speed;
          this.setIntent("walk");
        }
        return;
      }

      if (this.config.roam) {
        this.targetEnemy = null;
        this.runPatrol(blocks, groundY, deltaTime);
        return;
      }

      // Defence in depth: the no-leader gate above already returned for every
      // bot that has not opted into roaming, so this is unreachable today. It
      // stays so that reordering the gates above can never silently turn
      // "nobody to follow" into "the bot wanders off on its own".
      this.targetEnemy = null;
      this.state = BotState.IDLE;
      this.vx = 0;
      this.setIntent("idle");
      return;
    }

    switch (this.state) {
      // ---- ATTACK ----
      case BotState.ATTACK: {
        this.setIntent("attack");
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
          this.setIntent("swallow");
          this.targetEnemy = null;
          // Time the swallow by the clip that will actually play. Using the
          // literal "swallow" here returned a frame count of 1 for a mage
          // (which has no such clip), so the whole swallow phase flashed past
          // in a single frame.
          const clip = this.resolveClip("swallow");
          this.swallowTimer =
            getFrameCount(this.animData, clip) *
            (FRAME_DURATIONS[clip] ?? 60);
          return;
        }

        // Timeout after 1.5s without catching
        if (this.attackTimer >= 1500) {
          this.state = BotState.IDLE;
          this.idleTimer = 0;
          this.setIntent("idle");
        }
        break;
      }

      // ---- SWALLOW ----
      case BotState.SWALLOW: {
        this.setIntent("swallow");
        this.vx = 0;

        // When swallow animation finishes → RECOVER
        if (this.swallowTimer <= 0) {
          this.state = BotState.RECOVER;
          this.setIntent("idle");
          this.recoverTimer = 500;
        }
        break;
      }

      // ---- RECOVER ----
      case BotState.RECOVER: {
        this.setIntent("idle");
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
    const cols = Math.max(
      1,
      Math.ceil(this.canvasWidth / PATHFIND_CELL) + 1,
    );
    const rows = Math.max(
      1,
      Math.ceil(Math.max(groundY, 1) / PATHFIND_CELL) + 1,
    );
    const blocked = new Uint8Array(cols * rows);

    // Mark cells overlapped by blocks (skip ground bricks — they are handled
    // by the ground collision check and would block the entire ground row)
    for (const b of blocks) {
      if (b.dead) continue;
      if (b.y >= groundY - 1) continue;
      const bx1 = Math.max(0, Math.floor(b.x / PATHFIND_CELL));
      const bx2 = Math.min(
        cols - 1,
        Math.floor((b.x + b.w) / PATHFIND_CELL),
      );
      const by1 = Math.max(0, Math.floor(b.y / PATHFIND_CELL));
      const by2 = Math.min(
        rows - 1,
        Math.floor((b.y + b.h) / PATHFIND_CELL),
      );
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
    let egx = Math.max(
      0,
      Math.min(cols - 1, Math.floor(tx / PATHFIND_CELL)),
    );
    let egy = Math.max(
      0,
      Math.min(rows - 1, Math.floor(ty / PATHFIND_CELL)),
    );

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

      // Skip stale entries: g-score has been improved since this entry was
      // added. Use a tolerance comparison because gScore is Float32Array while
      // cur.g is Float64.
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