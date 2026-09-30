/**
 * Enemy entities with AI-driven patrol/chase/stun behaviour.
 *
 * Enemies use simple kinematic movement (no planck.js). They share the game
 * world with Kirby but don't need physics body interaction.
 */

import type { Rect } from "./types.ts";

// ---- types ----

export enum EnemyType {
  WALKER = "walker",
  FLYER = "flyer",
  JUMPER = "jumper",
}

export enum EnemyState {
  PATROL = "patrol",
  CHASE = "chase",
  STUNNED = "stunned",
}

export interface EnemyConfig {
  type: EnemyType;
  w: number;
  h: number;
  speed: number;
  health: number;
  patrolRange: number;
}

// ---- per-type defaults ----

const DEFAULTS: Record<EnemyType, Omit<EnemyConfig, "type">> = {
  [EnemyType.WALKER]: { w: 30, h: 28, speed: 1.2, health: 3, patrolRange: 120 },
  [EnemyType.FLYER]: { w: 28, h: 22, speed: 1.5, health: 2, patrolRange: 150 },
  [EnemyType.JUMPER]: { w: 26, h: 26, speed: 2.0, health: 2, patrolRange: 100 },
};

// ---- constants ----

const ENEMY_GRAVITY = 0.3;
const ENEMY_MAX_FALL = 12;
const JUMPER_BOUNCE_INTERVAL = 60;
const JUMPER_BOUNCE_VY = -4;
const STUN_DURATION_MS = 300;
const WRAP_MARGIN = 80;

// ---- unique id counter ----

let nextId = 1;

/**
 * A single enemy in the game world.
 */
export class Enemy {
  // position and size
  x = 0;
  y = 0;
  w = 30;
  h = 28;

  // identity
  type: EnemyType;
  readonly id: number;

  // health
  health: number;
  maxHealth: number;

  // movement
  speed: number;
  dir: 1 | -1 = 1;
  vx = 0;
  vy = 0;
  isOnGround = false;

  // AI
  state: EnemyState = EnemyState.PATROL;
  patrolCenterX: number;
  patrolRange: number;

  // stun
  isStunned = false;
  private stunTimer = 0;

  // lifecycle
  dead = false;

  // animation time (ms accumulated)
  animTime = 0;

  // jumper bounce
  private jumpFrames = 0;

  constructor(type: EnemyType, x: number, y: number) {
    this.type = type;
    this.id = nextId++;
    this.x = x;
    this.y = y;

    const d = DEFAULTS[type];
    this.w = d.w;
    this.h = d.h;
    this.speed = d.speed;
    this.health = d.health;
    this.maxHealth = d.health;
    this.patrolRange = d.patrolRange;
    this.patrolCenterX = x;
  }

  // ---- getters ----

  get centreX(): number {
    return this.x + this.w / 2;
  }

  get centreY(): number {
    return this.y + this.h / 2;
  }

  get top(): number {
    return this.y;
  }

  get bottom(): number {
    return this.y + this.h;
  }

  get left(): number {
    return this.x;
  }

  get right(): number {
    return this.x + this.w;
  }

  /** Whether this enemy is currently stunned. */
  get stunned(): boolean {
    return this.isStunned;
  }

  // ---- update ----

  /**
   * Advance the enemy by one frame.
   *
   * @param deltaTime  ms elapsed since last frame
   * @param groundY    canvas Y of the ground surface
   * @param blocks     solid blocks for collision
   * @param targetX    X position of the character the enemy should chase
   * @param targetY    Y position of the character
   * @param chaseRange px distance at which the enemy switches to chase
   */
  update(
    deltaTime: number,
    groundY: number,
    blocks: { x: number; y: number; w: number; h: number; dead: boolean }[],
    targetX: number,
    targetY: number,
    chaseRange = 200,
  ): void {
    if (this.dead) return;

    this.animTime += deltaTime;

    // ---- stun handling ----
    if (this.isStunned) {
      this.stunTimer -= deltaTime;
      if (this.stunTimer <= 0) {
        this.isStunned = false;
      } else {
        return; // frozen while stunned
      }
    }

    // ---- AI decision ----
    const distToTarget = Math.hypot(
      this.centreX - targetX,
      this.centreY - targetY,
    );
    if (distToTarget < chaseRange) {
      this.state = EnemyState.CHASE;
    } else {
      this.state = EnemyState.PATROL;
    }

    // ---- movement ----
    switch (this.state) {
      case EnemyState.PATROL:
        this.updatePatrol();
        break;
      case EnemyState.CHASE:
        this.updateChase(targetX);
        break;
    }

    // ---- type-specific movement ----
    this.updateTypeMovement();

    // ---- gravity (except flyer) ----
    if (this.type !== EnemyType.FLYER) {
      this.vy += ENEMY_GRAVITY;
      if (this.vy > ENEMY_MAX_FALL) this.vy = ENEMY_MAX_FALL;
    }

    // ---- apply velocity ----
    this.x += this.vx;
    this.y += this.vy;

    // ---- ground collision ----
    this.isOnGround = false;
    if (this.bottom >= groundY) {
      this.y = groundY - this.h;
      this.vy = 0;
      this.isOnGround = true;
    }

    // ---- block collision ----
    this.resolveBlockCollision(blocks);

    // ---- boundary wrap ----
    const wrapX = WRAP_MARGIN;
    if (this.right < -wrapX) {
      this.x = (this.x - this.right) + this.w + wrapX;
    }
    if (this.left > 9999 + wrapX) {
      // won't happen with current canvas sizes
    }
  }

  /** Patrol: walk toward patrolCenterX, flip when past range. */
  private updatePatrol(): void {
    const offset = this.centreX - this.patrolCenterX;
    if (offset > this.patrolRange) {
      this.dir = -1;
    } else if (offset < -this.patrolRange) {
      this.dir = 1;
    }
    this.vx = this.dir * this.speed;
  }

  /** Chase: move toward the target X. */
  private updateChase(targetX: number): void {
    const dx = targetX - this.centreX;
    this.dir = dx >= 0 ? 1 : -1;
    this.vx = this.dir * this.speed * 1.2; // slightly faster when chasing
  }

  /** Type-specific movement adjustments. */
  private updateTypeMovement(): void {
    switch (this.type) {
      case EnemyType.FLYER:
        // Sine wave floating, no gravity
        const wavePhase = (this.animTime / 500) * Math.PI * 2;
        this.vy = Math.sin(wavePhase) * 0.5;
        break;

      case EnemyType.JUMPER:
        // Bounce periodically
        this.jumpFrames++;
        if (this.isOnGround && this.jumpFrames >= JUMPER_BOUNCE_INTERVAL) {
          this.vy = JUMPER_BOUNCE_VY;
          this.jumpFrames = 0;
        }
        break;

      case EnemyType.WALKER:
        // No special movement
        break;
    }
  }

  /** Resolve AABB collision against blocks. */
  private resolveBlockCollision(
    blocks: { x: number; y: number; w: number; h: number; dead: boolean }[],
  ): void {
    for (const b of blocks) {
      if (b.dead) continue;

      const eLeft = this.x;
      const eRight = this.x + this.w;
      const eTop = this.y;
      const eBottom = this.y + this.h;

      const bLeft = b.x;
      const bRight = b.x + b.w;
      const bTop = b.y;
      const bBottom = b.y + b.h;

      if (eRight <= bLeft || eLeft >= bRight || eBottom <= bTop || eTop >= bBottom) {
        continue;
      }

      // Compute overlap
      const overlapLeft = eRight - bLeft;
      const overlapRight = bRight - eLeft;
      const overlapTop = eBottom - bTop;
      const overlapBottom = bBottom - eTop;

      const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

      if (minOverlap === overlapTop) {
        // Landing on top of block
        this.y = bTop - this.h;
        this.vy = 0;
        this.isOnGround = true;
      } else if (minOverlap === overlapBottom) {
        // Hit block from below
        this.y = bBottom;
        this.vy = 0;
      } else if (minOverlap === overlapLeft) {
        // Hit block from right
        this.x = bLeft - this.w;
        this.vx = 0;
        this.dir = -1;
      } else if (minOverlap === overlapRight) {
        // Hit block from left
        this.x = bRight;
        this.vx = 0;
        this.dir = 1;
      }
    }
  }

  // ---- combat ----

  /**
   * Apply damage to this enemy.
   *
   * @returns true if the enemy died from this damage
   */
  takeDamage(amount: number): boolean {
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      return true;
    }
    this.isStunned = true;
    this.stunTimer = STUN_DURATION_MS;
    return false;
  }

  /** Clear the stunned state (e.g. when inhaled). */
  resetStun(): void {
    this.isStunned = false;
    this.stunTimer = 0;
  }

  /** Return the enemy's collision hitbox. */
  getHitbox(): Rect {
    return { x: this.x, y: this.y, w: this.w, h: this.h };
  }
}

/**
 * Helper to manage enemy spawning and cleanup.
 */
export class EnemySpawner {
  private enemies: Enemy[] = [];
  private nextId = 1;

  /** Spawn an enemy of the given type at the specified position. */
  spawn(type: EnemyType, x: number, y: number): Enemy {
    const enemy = new Enemy(type, x, y);
    this.enemies.push(enemy);
    return enemy;
  }

  /** Spawn a random enemy type at the specified position. */
  spawnRandom(x: number, y: number): Enemy {
    const types = Object.values(EnemyType) as EnemyType[];
    const type = types[Math.floor(Math.random() * types.length)];
    return this.spawn(type, x, y);
  }

  /** Return all spawned enemies. */
  getAll(): Enemy[] {
    return this.enemies;
  }

  /** Remove all enemies. */
  clear(): void {
    this.enemies = [];
  }
}
