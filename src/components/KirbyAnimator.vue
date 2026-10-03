<template>
  <!-- Fullscreen stage: the canvas IS the page. All debug UI lives in DebugPanels. -->
  <div class="animator-container">
    <canvas
      ref="canvasRef"
      :width="animator.viewport.width"
      :height="animator.viewport.height"
      class="kirby-canvas"
      @click="handleCanvasClick"
      @mousemove="handleCanvasMove"
      @mouseleave="handleCanvasLeave"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { SpriteRenderer, WORLD_SCALE } from "../engine";
import type { AnimationConfig } from "../engine";
import { useAnimatorStore, usePanelStore } from "../stores";

const animator = useAnimatorStore();
const panels = usePanelStore();

const canvasRef = ref<HTMLCanvasElement | null>(null);

function handleCanvasClick(e: MouseEvent): void {
  if (!animator.takeoverMode || !canvasRef.value) return;
  if (animator.editingMode) return;
  const rect = canvasRef.value.getBoundingClientRect();
  // Scale click coordinates to canvas internal resolution
  const scaleX = canvasRef.value.width / rect.width;
  const scaleY = canvasRef.value.height / rect.height;
  const clickX = (e.clientX - rect.left) * scaleX;
  const clickY = (e.clientY - rect.top) * scaleY;
  animator.selectCharacterAt(clickX, clickY);
}

// ---- hover detection (mousemove tracks mouse position; the render loop
//      checks it every frame and draws a glow behind the hovered character) ----
let mouseX = -9999;
let mouseY = -9999;

function handleCanvasMove(e: MouseEvent): void {
  if (!canvasRef.value) return;
  const rect = canvasRef.value.getBoundingClientRect();
  const scaleX = canvasRef.value.width / rect.width;
  const scaleY = canvasRef.value.height / rect.height;
  mouseX = (e.clientX - rect.left) * scaleX;
  mouseY = (e.clientY - rect.top) * scaleY;
}

function handleCanvasLeave(): void {
  mouseX = -9999;
  mouseY = -9999;
}

/** Hit-test the current mouse position against Kirby and all bots. */
function computeHover(): { type: "kirby" } | { type: "bot"; id: number } | null {
  if (mouseX < 0) return null;

  const rs = animator.buildRenderState();
  // Kirby's canvas-space centre — only when Kirby is present
  if (animator.kirbyEnabled) {
    const kirbyCX = rs.canvasWidth / 2 + rs.charX;
    const kirbyCY = rs.groundY + rs.charY;
    const kirbyHitR = 25;
    if (Math.hypot(kirbyCX - mouseX, kirbyCY - mouseY) <= kirbyHitR) {
      return { type: "kirby" };
    }
  }

  // Bots — bot.x is centre X, bot.y is feet Y
  const bots = animator.bots as any[];
  for (const bot of bots) {
    const hitW = bot.w / 2 + 5;
    const hitH = bot.h / 2 + 5;
    const centreY = bot.y - bot.h / 2;
    if (
      mouseX >= bot.x - hitW &&
      mouseX <= bot.x + hitW &&
      mouseY >= centreY - hitH &&
      mouseY <= centreY + hitH
    ) {
      return { type: "bot", id: bot.id };
    }
  }
  return null;
}

/** Draw a soft pink glow ring behind a character to signal hover. */
function drawHoverGlow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
): void {
  ctx.save();
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  grad.addColorStop(0, "rgba(255, 105, 180, 0.0)");
  grad.addColorStop(0.5, "rgba(255, 105, 180, 0.12)");
  grad.addColorStop(0.8, "rgba(255, 105, 180, 0.35)");
  grad.addColorStop(1, "rgba(255, 105, 180, 0.0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  // inner ring for a brighter core
  ctx.strokeStyle = "rgba(255, 105, 180, 0.5)";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

let ctx: CanvasRenderingContext2D | null = null;
let renderer: SpriteRenderer | null = null;
let animationId: number | null = null;
let lastTime = 0;

// Animation loop - rendering only; the animator store owns all simulation
function animate(timestamp: number) {
  if (!ctx || !renderer) return;

  const deltaTime = timestamp - lastTime;
  lastTime = timestamp;

  // Static scenery (sky, sub-ground, ground bricks) then the spawned blocks
  animator.rebuildGroundBlocks();
  const renderState = animator.buildRenderState();
  renderer.drawScene(animator.sceneLayout, animator.world.ground, renderState);

  for (const b of animator.world.blocks) {
    if (b.dead) continue;
    renderer.drawGravityBlock(b);
  }

  const anim = animator.currentAnim;

  // Per-tick simulation (frame timing, physics, movement, inhale)
  const { frame, charCtx } = animator.step(deltaTime);

  // Compute hover target before drawing characters
  const hover = computeHover();

  // Onion skin layering: previous = below, current = 0, next = above
  const onionOffsetPx = animator.onionOffset * animator.scale * WORLD_SCALE;
  const showPrev = animator.onionMode === "prev" || animator.onionMode === "both";
  const showNext = animator.onionMode === "next" || animator.onionMode === "both";

  // Draw hover glow behind Kirby if hovered (only when Kirby is present)
  if (animator.kirbyEnabled && hover?.type === "kirby") {
    const rs = animator.buildRenderState();
    const kirbyCX = rs.canvasWidth / 2 + rs.charX;
    const kirbyCY = rs.groundY + rs.charY;
    drawHoverGlow(ctx, kirbyCX, kirbyCY - 15, 35);
  }

  // Kirby is not drawn when kirbyEnabled is false
  if (animator.kirbyEnabled) {
    if (showPrev) {
      const prev = anim.frames[animator.frameIndex - 1];
      if (prev) {
        renderer.drawCharacter(prev, anim, renderState, -onionOffsetPx, 0,
          animator.onionOpacity, "#00ff00");
      }
    }

    renderer.drawCharacter(frame, anim, renderState);

    if (showNext) {
      const next = anim.frames[animator.frameIndex + 1];
      if (next) {
        renderer.drawCharacter(next, anim, renderState, onionOffsetPx, 0,
          animator.onionOpacity, "#ff0000");
      }
    }
  }

  // Draw enemies
  for (const enemy of animator.enemies) {
    if (enemy.dead) continue;
    renderer.drawEnemy(enemy);
  }

  // Draw bots
  const viewport = animator.viewport;
  const groundY = animator.groundY();
  const botRenderStates = animator.getBotRenderState();
  const botsList = animator.bots as any[];
  const anims = animator.activeAnimationData.animations as Record<string, AnimationConfig>;
  for (let i = 0; i < botRenderStates.length; i++) {
    const botRS = botRenderStates[i];
    const botObj = botsList[i];
    // Draw hover glow behind this bot if it is hovered
    if (hover?.type === "bot" && botObj && botObj.id === hover.id) {
      const botHalfH = (botObj.h || 40) / 2;
      drawHoverGlow(ctx, botRS.x, botRS.y - botHalfH, 35);
    }
    const botAnim = anims[botRS.animState] ?? anims["idle"];
    if (botAnim) {
      const botFrame = botAnim.frames[botRS.animFrameIndex % botAnim.frames.length];
      if (botFrame) {
        const botRenderState = {
          ...renderState,
          charX: botRS.x - viewport.width / 2,
          charY: botRS.y - groundY,
          flip: botRS.flip,
        };
        renderer.drawCharacter(botFrame, botAnim, botRenderState);
      }
    }
  }

  // Physics debug overlay on the very top so it is never hidden by sprites
  if (panels.panels.physics.open) {
    const box = charCtx ? animator.kirby.getBox(charCtx) : null;
    const anchor = charCtx ? animator.kirby.getInhaleAnchor(charCtx) : null;
    const mouth = charCtx ? animator.kirby.getMouthPos(charCtx) : null;
    renderer.drawPhysicsDebug(
      box,
      animator.state === "attack" && anchor && mouth
        ? {
            x: anchor.x, y: anchor.y, range: anchor.range, dir: anchor.dir,
            mouthX: mouth.x, mouthY: mouth.y,
          }
        : null,
    );
  }

  animationId = requestAnimationFrame(animate);
}

function loadSpriteSheet(): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const sheet = new Image();
    sheet.onload = () => resolve(sheet);
    sheet.onerror = reject;
    sheet.src = animator.getSpriteSheetUrl();
  });
}

// Reload sprite sheet when character type changes
watch(
  () => animator.characterType,
  async () => {
    if (!ctx) return;
    const sheet = await loadSpriteSheet();
    animator.setSpriteSheet(sheet);
    renderer?.setSpriteSheet(sheet);
  },
);

// Reload sprite sheet when mage skin changes
watch(
  () => animator.mageSkin,
  async () => {
    if (!ctx || animator.characterType !== "mage") return;
    const sheet = await loadSpriteSheet();
    animator.setSpriteSheet(sheet);
    renderer?.setSpriteSheet(sheet);
  },
);

// Initialize canvas
async function init() {
  const canvas = canvasRef.value;
  if (!canvas) return;

  const context = canvas.getContext("2d");
  if (!context) return;
  ctx = context;
  ctx.imageSmoothingEnabled = false;

  animator.setViewport(window.innerWidth, window.innerHeight);

  const sheet = await loadSpriteSheet();
  // Hand the sheet to the engine so it can compute pixel-tight collision boxes
  animator.setSpriteSheet(sheet);
  renderer = new SpriteRenderer(ctx, sheet);

  lastTime = performance.now();
  animationId = requestAnimationFrame(animate);
}

// Keep the canvas matched to the viewport so it always fills the page
function handleResize() {
  animator.setViewport(window.innerWidth, window.innerHeight);
}

onMounted(async () => {
  await init();
  window.addEventListener("keydown", animator.handleKeydown);
  window.addEventListener("keyup", animator.handleKeyup);
  window.addEventListener("resize", handleResize);
});

onUnmounted(() => {
  if (animationId) cancelAnimationFrame(animationId);
  window.removeEventListener("keydown", animator.handleKeydown);
  window.removeEventListener("keyup", animator.handleKeyup);
  window.removeEventListener("resize", handleResize);
});
</script>

<style scoped>
/* Fullscreen stage - the canvas IS the page */
.animator-container {
  position: fixed;
  inset: 0;
  overflow: hidden;
}

.kirby-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  background: #87CEEB;
}
</style>
