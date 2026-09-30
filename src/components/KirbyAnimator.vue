<template>
  <!-- Fullscreen stage: the canvas IS the page. All debug UI lives in DebugPanels. -->
  <div class="animator-container">
    <!-- AI Controls -->
    <div class="ai-controls">
      <button @click="animator.spawnEnemy()" title="Spawn Enemy">👾</button>
      <button @click="animator.spawnEnemies(3)" title="Spawn 3">👾×3</button>
      <button @click="animator.spawnBot('Bot-A')" title="Spawn Bot" :class="{ active: animator.botEnabled }">🤖</button>
      <button @click="animator.toggleBot()" title="Toggle Bot" :class="{ active: animator.botEnabled }">⏯</button>
      <button @click="animator.clearEnemies()" title="Clear">🗑️</button>
      <span class="ai-count">{{ animator.enemies.length }} enemies</span>
    </div>
    <canvas
      ref="canvasRef"
      :width="animator.viewport.width"
      :height="animator.viewport.height"
      class="kirby-canvas"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { SpriteRenderer, WORLD_SCALE } from "../engine";
import type { AnimationConfig } from "../engine";
import animationDataRaw from "../animations.json";
import { useAnimatorStore, usePanelStore } from "../stores";

const animator = useAnimatorStore();
const panels = usePanelStore();

const canvasRef = ref<HTMLCanvasElement | null>(null);

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

  // Onion skin layering: previous = below, current = 0, next = above
  const onionOffsetPx = animator.onionOffset * animator.scale * WORLD_SCALE;
  const showPrev = animator.onionMode === "prev" || animator.onionMode === "both";
  const showNext = animator.onionMode === "next" || animator.onionMode === "both";

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

  // Draw enemies
  for (const enemy of animator.enemies) {
    if (enemy.dead) continue;
    renderer.drawEnemy(enemy);
  }

  // Draw bots
  const viewport = animator.viewport;
  const groundY = animator.groundY();
  const botRenderStates = animator.getBotRenderState();
  const anims = animationDataRaw.animations as Record<string, AnimationConfig>;
  for (const botRS of botRenderStates) {
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
    sheet.src = "/Kirby.png";
  });
}

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

.ai-controls {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 4px;
  z-index: 100;
  background: rgba(0,0,0,0.6);
  border-radius: 8px;
  padding: 4px 8px;
}
.ai-controls button {
  background: rgba(255,255,255,0.15);
  border: 1px solid rgba(255,255,255,0.3);
  color: white;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
}
.ai-controls button:hover {
  background: rgba(255,255,255,0.25);
}
.ai-controls button.active {
  background: rgba(100,200,100,0.4);
  border-color: rgba(100,200,100,0.7);
}
.ai-count {
  color: #aaa;
  font-size: 11px;
  align-self: center;
}
</style>
