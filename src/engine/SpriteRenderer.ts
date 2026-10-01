import { WORLD_SCALE } from "./constants.ts";
import type { CharBox, Frame } from "./types.ts";
import type { GravityBlock } from "./GravityBlock.ts";

/** One animation clip, as stored in animations.json. */
export interface AnimationConfig {
  frames: Frame[];
  frameDurationMs: number;
  loop: boolean;
  defaultFacing: string;
  description?: string;
}

/** Everything the renderer needs for one frame that it cannot derive itself. */
export interface RenderState {
  /** Horizontal offset from the canvas centre. */
  charX: number;
  /** Vertical offset from the ground surface. */
  charY: number;
  /** Extra vertical bob applied on top of charY. */
  bobOffset: number;
  /** True when the sprite is mirrored, which for a left-facing default means facing right. */
  flip: boolean;
  /** Final on-screen scale, i.e. props.scale * WORLD_SCALE. */
  scale: number;
  groundY: number;
  canvasWidth: number;
  canvasHeight: number;
}

/** Layout of the scene, recomputed only when the canvas resizes. */
export interface SceneLayout {
  /** Thickness of the ground strip. */
  platformH: number;
  /** Width of a single ground brick. */
  brickW: number;
}

/**
 * All canvas drawing for the animator.
 *
 * The Vue component keeps animation playback, input and the state machine; this
 * class owns nothing but pixels, so it can be reasoned about (and later
 * screenshot-tested) without a component instance.
 */
export class SpriteRenderer {
  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private sheet: HTMLImageElement | null,
  ) {}

  /** Swap in a newly loaded sprite sheet. */
  setSpriteSheet(sheet: HTMLImageElement | null): void {
    this.sheet = sheet;
  }

  /** Static scenery: sky gradient, sub-ground fill and the ground bricks. */
  drawScene(
    layout: SceneLayout,
    ground: readonly GravityBlock[],
    st: RenderState,
  ): void {
    const { ctx } = this;
    const { groundY, canvasWidth, canvasHeight } = st;

    // Sky-to-dirt gradient background
    const grad = ctx.createLinearGradient(0, 0, 0, groundY);
    grad.addColorStop(0, "#87CEEB");
    grad.addColorStop(0.65, "#B0E0E6");
    grad.addColorStop(1, "#E0F6B8");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvasWidth, groundY);

    // Deep background below the platform
    const belowGrad = ctx.createLinearGradient(0, groundY, 0, canvasHeight);
    belowGrad.addColorStop(0, "#6B4423");
    belowGrad.addColorStop(1, "#3E2A14");
    ctx.fillStyle = belowGrad;
    ctx.fillRect(0, groundY, canvasWidth, canvasHeight - groundY);

    // The ground itself: a row of solid gravity bricks. Each brick is an
    // independent collision block, not a decorative strip.
    for (const b of ground) {
      // body
      ctx.fillStyle = "#A0662C";
      ctx.fillRect(b.x, b.y, b.w, b.h);
      // lit grass cap
      ctx.fillStyle = "#7CC242";
      ctx.fillRect(b.x, b.y, b.w, Math.max(2, Math.round(b.h * 0.3)));
      // seam between bricks
      ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
      ctx.fillRect(b.x, b.y + b.h * 0.4, 1, b.h * 0.6);
    }

    // Shadow line under the ground
    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    ctx.fillRect(
      0,
      groundY + layout.platformH,
      canvasWidth,
      Math.max(2, Math.round(layout.platformH * 0.25)),
    );
  }

  /** A spawned gravity block: a rounded enemy-ish cube with eyes. */
  drawGravityBlock(b: GravityBlock): void {
    const { ctx } = this;
    const r = Math.min(6, b.w * 0.2);

    ctx.save();

    // body
    ctx.fillStyle = b.inhale ? "#FFD27F" : "#F0A030";
    roundRect(ctx, b.x, b.y, b.w, b.h, r);
    ctx.fill();

    // border
    ctx.strokeStyle = "rgba(90, 45, 0, 0.85)";
    ctx.lineWidth = 2;
    roundRect(ctx, b.x + 1, b.y + 1, b.w - 2, b.h - 2, r);
    ctx.stroke();

    // top highlight
    ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
    roundRect(ctx, b.x + 3, b.y + 3, b.w - 6, Math.max(3, b.h * 0.22), r * 0.6);
    ctx.fill();

    // eyes
    const eyeR = Math.max(1.5, b.w * 0.09);
    const eyeY = b.y + b.h * 0.44;
    const eyeDx = b.w * 0.2;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(b.x + b.w / 2 - eyeDx, eyeY, eyeR, 0, Math.PI * 2);
    ctx.arc(b.x + b.w / 2 + eyeDx, eyeY, eyeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#222";
    ctx.beginPath();
    ctx.arc(b.x + b.w / 2 - eyeDx, eyeY, eyeR * 0.5, 0, Math.PI * 2);
    ctx.arc(b.x + b.w / 2 + eyeDx, eyeY, eyeR * 0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * The character, bottom-aligned on the ground surface.
   * @param offsetX extra horizontal offset on top of st.charX
   * @param offsetY extra vertical offset on top of st.charY
   * @param opacity 1 for the main sprite, lower for onion skin
   * @param tint when set, the sprite is recoloured (onion skin)
   */
  drawCharacter(
    frame: Frame | null | undefined,
    anim: AnimationConfig,
    st: RenderState,
    offsetX = 0,
    offsetY = 0,
    opacity = 1.0,
    tint?: string,
  ): void {
    const { ctx } = this;
    if (!frame || !this.sheet) return;

    const { x, y, w, h } = frame;

    ctx.save();

    if (opacity < 1.0) {
      ctx.globalAlpha = opacity;
    }

    const finalScale = st.scale;
    // The clip's own default facing decides what "not flipped" means
    const shouldFlip = anim.defaultFacing === "left" ? st.flip : !st.flip;

    ctx.translate(
      st.canvasWidth / 2 + st.charX + offsetX,
      st.groundY + st.charY + offsetY,
    );
    ctx.scale(shouldFlip ? -finalScale : finalScale, finalScale);

    ctx.drawImage(this.sheet, x, y, w, h, -w / 2, -h, w, h);

    // Tint overlay for onion skin
    if (tint) {
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = tint;
      ctx.fillRect(-w / 2, -h, w, h);
    }

    ctx.restore();
  }

  /**
   * Draw a health bar above an enemy when health < maxHealth.
   */
  private drawHealthBar(
    cx: number,
    topY: number,
    w: number,
    health: number,
    maxHealth: number,
  ): void {
    const barW = Math.max(w, 20);
    const barH = 4;
    const x = cx - barW / 2;
    const y = topY - 10;

    // Background
    this.ctx.fillStyle = "rgba(0,0,0,0.5)";
    this.ctx.fillRect(x - 1, y - 1, barW + 2, barH + 2);

    // Health fill (green→yellow→red)
    const pct = health / maxHealth;
    const r = pct < 0.3 ? 255 : pct < 0.6 ? 255 : 0;
    const g = pct < 0.3 ? 100 : pct < 0.6 ? 200 : 255;
    const b = 0;
    this.ctx.fillStyle = `rgb(${r},${g},${b})`;
    this.ctx.fillRect(x, y, barW * pct, barH);
  }

  /**
   * Draw a small yellow star for stun indicators.
   */
  private drawStar(cx: number, cy: number, r: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = "#FFD700";
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      const px = cx + Math.cos(angle) * r;
      const py = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * Draw a small red exclamation mark for chase indicators.
   */
  private drawExclamation(cx: number, topY: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = "#FF4444";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("!", cx, topY - 2);
    ctx.restore();
  }

  /**
   * Draw an enemy using canvas primitives.
   *
   * WALKER: red round body with walking legs, eyes, and health bar.
   * FLYER: blue oval body with flapping wings, eyes, hover bob.
   * JUMPER: green round body with squash/stretch, eyes, feet.
   */
  drawEnemy(enemy: {
    x: number;
    y: number;
    w: number;
    h: number;
    type: string;
    centreX: number;
    centreY: number;
    dir: number;
    animTime: number;
    state: string;
    health: number;
    maxHealth: number;
    vy?: number;
  }): void {
    const { ctx } = this;
    const cx = enemy.x + enemy.w / 2;
    const topY = enemy.y;
    const r = enemy.w / 2;

    ctx.save();

    if (enemy.type === "walker") {
      // ---- WALKER: red round body ----
      // Shadow
      ctx.fillStyle = "rgba(0,0,0,0.2)";
      ctx.beginPath();
      ctx.ellipse(cx, topY + enemy.h + 2, r * 0.8, 4, 0, 0, Math.PI * 2);
      ctx.fill();

      // Legs (animated walking)
      const legPhase = (enemy.animTime / 200) % (Math.PI * 2);
      const legLen = Math.max(6, enemy.h * 0.3);
      const legDx = r * 0.4;
      ctx.strokeStyle = "#8B0000";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      const leg1EndY = topY + enemy.h + Math.sin(legPhase) * 3;
      const leg2EndY = topY + enemy.h + Math.sin(legPhase + Math.PI) * 3;
      ctx.moveTo(cx - legDx, topY + enemy.h - 2);
      ctx.lineTo(cx - legDx, leg1EndY);
      ctx.moveTo(cx + legDx, topY + enemy.h - 2);
      ctx.lineTo(cx + legDx, leg2EndY);
      ctx.stroke();

      // Body
      ctx.fillStyle = "#E53935";
      ctx.beginPath();
      ctx.arc(cx, topY + r, r, 0, Math.PI * 2);
      ctx.fill();
      // Outline
      ctx.strokeStyle = "#8B0000";
      ctx.lineWidth = 2;
      ctx.stroke();
      // Highlight
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.beginPath();
      ctx.arc(cx - r * 0.3, topY + r * 0.6, r * 0.3, 0, Math.PI * 2);
      ctx.fill();

      // Eyes
      const eyeR = Math.max(2, r * 0.2);
      const eyeY = topY + r * 0.8;
      const eyeDx = r * 0.25;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(cx - eyeDx, eyeY, eyeR, 0, Math.PI * 2);
      ctx.arc(cx + eyeDx, eyeY, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#111";
      ctx.beginPath();
      ctx.arc(
        cx - eyeDx + enemy.dir * eyeR * 0.3,
        eyeY,
        eyeR * 0.5,
        0,
        Math.PI * 2,
      );
      ctx.arc(
        cx + eyeDx + enemy.dir * eyeR * 0.3,
        eyeY,
        eyeR * 0.5,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    } else if (enemy.type === "flyer") {
      // ---- FLYER: blue winged creature ----
      // Hover bob
      const bob = Math.sin(enemy.animTime / 300) * 3;
      const bodyY = topY + r + bob;

      // Wings (flapping with sin wave)
      const wingFlap = Math.sin(enemy.animTime / 150) * 0.4;
      ctx.fillStyle = "rgba(100,180,255,0.7)";
      ctx.beginPath();
      ctx.ellipse(
        cx - r * 0.8,
        bodyY - r * 0.3,
        r * 0.7,
        r * 0.4,
        -0.3 + wingFlap,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(
        cx + r * 0.8,
        bodyY - r * 0.3,
        r * 0.7,
        r * 0.4,
        0.3 - wingFlap,
        0,
        Math.PI * 2,
      );
      ctx.fill();

      // Body (oval)
      ctx.fillStyle = "#42A5F5";
      ctx.beginPath();
      ctx.ellipse(cx, bodyY, r * 0.8, r, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#1565C0";
      ctx.lineWidth = 2;
      ctx.stroke();
      // Highlight
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.beginPath();
      ctx.ellipse(
        cx - r * 0.2,
        bodyY - r * 0.3,
        r * 0.25,
        r * 0.3,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();

      // Eyes
      const eyeR = Math.max(2, r * 0.2);
      const eyeY = bodyY - r * 0.1;
      const eyeDx = r * 0.25;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(cx - eyeDx, eyeY, eyeR, 0, Math.PI * 2);
      ctx.arc(cx + eyeDx, eyeY, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#111";
      ctx.beginPath();
      ctx.arc(
        cx - eyeDx + enemy.dir * eyeR * 0.3,
        eyeY,
        eyeR * 0.5,
        0,
        Math.PI * 2,
      );
      ctx.arc(
        cx + eyeDx + enemy.dir * eyeR * 0.3,
        eyeY,
        eyeR * 0.5,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    } else if (enemy.type === "jumper") {
      // ---- JUMPER: green bouncing creature ----
      // Squash/stretch based on velocity
      const stretch = Math.max(0.7, Math.min(1.3, 1 + Math.abs(enemy.vy ?? 0) * 0.05));
      const bodyR = r * (2 - stretch) * 0.5 + r * 0.5;

      // Shadow
      ctx.fillStyle = "rgba(0,0,0,0.2)";
      ctx.beginPath();
      ctx.ellipse(cx, topY + enemy.h + 2, r * 0.7, 3, 0, 0, Math.PI * 2);
      ctx.fill();

      // Feet
      ctx.fillStyle = "#2E7D32";
      ctx.beginPath();
      ctx.ellipse(cx - r * 0.3, topY + enemy.h, r * 0.2, 3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx + r * 0.3, topY + enemy.h, r * 0.2, 3, 0, 0, Math.PI * 2);
      ctx.fill();

      // Body
      ctx.fillStyle = "#66BB6A";
      ctx.beginPath();
      ctx.ellipse(
        cx,
        topY + r * (2 - stretch) * 0.5 + r * 0.5,
        r * stretch,
        r * (2 - stretch) * 0.5 + r * 0.5,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.strokeStyle = "#1B5E20";
      ctx.lineWidth = 2;
      ctx.stroke();
      // Highlight
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.beginPath();
      ctx.ellipse(
        cx - r * 0.2,
        topY + r * (2 - stretch) * 0.5 + r * 0.3,
        r * 0.2,
        r * 0.3,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();

      // Big eyes
      const eyeR = Math.max(3, r * 0.25);
      const eyeY = topY + r * (2 - stretch) * 0.5 + r * 0.7;
      const eyeDx = r * 0.3;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(cx - eyeDx, eyeY, eyeR, 0, Math.PI * 2);
      ctx.arc(cx + eyeDx, eyeY, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#111";
      ctx.beginPath();
      ctx.arc(
        cx - eyeDx + enemy.dir * eyeR * 0.3,
        eyeY,
        eyeR * 0.55,
        0,
        Math.PI * 2,
      );
      ctx.arc(
        cx + eyeDx + enemy.dir * eyeR * 0.3,
        eyeY,
        eyeR * 0.55,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }

    // ---- Common overlays ----

    // Health bar if damaged
    if (enemy.health < enemy.maxHealth) {
      this.drawHealthBar(cx, topY, enemy.w, enemy.health, enemy.maxHealth);
    }

    // Stun effect: yellow stars
    if (enemy.state === "stunned") {
      const starPhase = enemy.animTime / 200;
      for (let i = 0; i < 3; i++) {
        const angle = starPhase + (i * Math.PI * 2) / 3;
        const sx = cx + Math.cos(angle) * (r + 6);
        const sy = topY - 12 + Math.sin(angle) * 4;
        this.drawStar(sx, sy, 4);
      }
    }

    // Chase indicator: red exclamation mark
    if (enemy.state === "chase") {
      this.drawExclamation(cx, topY);
    }

    ctx.restore();
  }

  /**
   * Draw an AI bot character using the sprite sheet animation, with a name label
   * and state indicator dot.
   */
  drawBot(
    bot: {
      x: number;
      y: number;
      w: number;
      h: number;
      dir: number;
      name: string;
      state: string;
      animState: string;
    },
    frame: Frame | null | undefined,
    anim: AnimationConfig,
    st: RenderState,
  ): void {
    if (!frame || !this.sheet) return;
    const { ctx } = this;

    // Draw the character sprite at the bot's position
    // Bot's x/y are absolute canvas coords, convert to the render state's relative coords
    const botRenderState: RenderState = {
      ...st,
      charX: bot.x - st.canvasWidth / 2,
      charY: bot.y - st.groundY,
      flip: bot.dir === 1,
    };
    this.drawCharacter(frame, anim, botRenderState);

    // Name label above the bot
    const cx = bot.x;
    const topY = bot.y - bot.h;
    ctx.save();
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    // Background for readability
    const labelWidth = ctx.measureText(bot.name).width + 8;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(cx - labelWidth / 2, topY - 18, labelWidth, 14);
    // Text
    ctx.fillStyle = "#fff";
    ctx.fillText(bot.name, cx, topY - 7);
    ctx.restore();

    // Bot state indicator (small colored dot)
    const stateColors: Record<string, string> = {
      idle: "#888",
      patrol: "#4CAF50",
      chase: "#F44336",
      attack: "#FF9800",
      flee: "#2196F3",
      inhale: "#E91E63",
      slide: "#9C27B0",
      jump: "#00BCD4",
    };
    const dotColor = stateColors[bot.state] ?? "#888";
    ctx.save();
    ctx.fillStyle = dotColor;
    ctx.beginPath();
    ctx.arc(cx, topY - 22, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Debug overlay: the pixel-tight collision box plus the directional inhale
   * field. Drawn last so sprites never hide it.
   */
  drawPhysicsDebug(box: CharBox | null, inhale: InhaleDebug | null): void {
    const { ctx } = this;

    if (box) {
      ctx.save();
      ctx.strokeStyle = "#00ff88";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        box.left,
        box.top,
        box.right - box.left,
        box.bottom - box.top,
      );
      ctx.restore();
    }

    if (inhale) {
      ctx.save();
      ctx.strokeStyle = "rgba(255, 105, 180, 0.55)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      // half-disc opening in the facing direction
      const start = inhale.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      ctx.beginPath();
      ctx.arc(inhale.x, inhale.y, inhale.range, start, start + Math.PI);
      ctx.stroke();
      // diameter, so the field reads as a half-disc rather than an arc
      ctx.beginPath();
      ctx.moveTo(inhale.x, inhale.y - inhale.range);
      ctx.lineTo(inhale.x, inhale.y + inhale.range);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // mouth anchor
      ctx.save();
      ctx.fillStyle = "#ff69b4";
      ctx.beginPath();
      ctx.arc(inhale.mouthX, inhale.mouthY, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

/** Inhale field geometry, flattened for drawing. */
export interface InhaleDebug {
  x: number;
  y: number;
  range: number;
  dir: 1 | -1;
  mouthX: number;
  mouthY: number;
}

/** Scene layout derived from the canvas height. */
export function computeLayout(canvasHeight: number): SceneLayout {
  return {
    platformH: Math.max(6, Math.round(canvasHeight * 0.022 * WORLD_SCALE)),
    brickW: Math.max(20, Math.round(canvasHeight * 0.06 * WORLD_SCALE)),
  };
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}
