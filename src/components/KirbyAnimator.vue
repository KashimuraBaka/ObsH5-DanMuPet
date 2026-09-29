<template>
  <!-- Fullscreen stage: the canvas IS the page. All debug UI lives in DebugPanels. -->
  <div class="animator-container">
    <canvas
      ref="canvasRef"
      :width="animator.viewport.width"
      :height="animator.viewport.height"
      class="kirby-canvas"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { SpriteRenderer, WORLD_SCALE } from '../engine'
import { useAnimatorStore, usePanelStore } from '../stores'

const animator = useAnimatorStore()
const panels = usePanelStore()

const canvasRef = ref<HTMLCanvasElement | null>(null)

let ctx: CanvasRenderingContext2D | null = null
let renderer: SpriteRenderer | null = null
let animationId: number | null = null
let lastTime = 0

// Animation loop - rendering only; the animator store owns all simulation
function animate(timestamp: number) {
  if (!ctx || !renderer) return

  const deltaTime = timestamp - lastTime
  lastTime = timestamp

  // Static scenery (sky, sub-ground, ground bricks) then the spawned blocks
  animator.rebuildGroundBlocks()
  const renderState = animator.buildRenderState()
  renderer.drawScene(animator.sceneLayout, animator.world.ground, renderState)

  for (const b of animator.world.blocks) {
    if (b.dead) continue
    renderer.drawGravityBlock(b)
  }

  const anim = animator.currentAnim

  // Per-tick simulation (frame timing, physics, movement, inhale)
  const { frame, charCtx } = animator.step(deltaTime)

  // Onion skin layering: previous = below, current = 0, next = above
  const onionOffsetPx = animator.onionOffset * animator.scale * WORLD_SCALE
  const showPrev = animator.onionMode === 'prev' || animator.onionMode === 'both'
  const showNext = animator.onionMode === 'next' || animator.onionMode === 'both'

  if (showPrev) {
    const prev = anim.frames[animator.frameIndex - 1]
    if (prev) {
      renderer.drawCharacter(prev, anim, renderState, -onionOffsetPx, 0,
        animator.onionOpacity, '#00ff00')
    }
  }

  renderer.drawCharacter(frame, anim, renderState)

  if (showNext) {
    const next = anim.frames[animator.frameIndex + 1]
    if (next) {
      renderer.drawCharacter(next, anim, renderState, onionOffsetPx, 0,
        animator.onionOpacity, '#ff0000')
    }
  }

  // Physics debug overlay on the very top so it is never hidden by sprites
  if (panels.panels.physics.open) {
    const box = charCtx ? animator.kirby.getBox(charCtx) : null
    const anchor = charCtx ? animator.kirby.getInhaleAnchor(charCtx) : null
    const mouth = charCtx ? animator.kirby.getMouthPos(charCtx) : null
    renderer.drawPhysicsDebug(
      box,
      animator.state === 'attack' && anchor && mouth
        ? {
            x: anchor.x, y: anchor.y, range: anchor.range, dir: anchor.dir,
            mouthX: mouth.x, mouthY: mouth.y
          }
        : null
    )
  }

  animationId = requestAnimationFrame(animate)
}

function loadSpriteSheet(): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const sheet = new Image()
    sheet.onload = () => resolve(sheet)
    sheet.onerror = reject
    sheet.src = '/Kirby.png'
  })
}

// Initialize canvas
async function init() {
  const canvas = canvasRef.value
  if (!canvas) return

  const context = canvas.getContext('2d')
  if (!context) return
  ctx = context
  ctx.imageSmoothingEnabled = false

  animator.setViewport(window.innerWidth, window.innerHeight)

  const sheet = await loadSpriteSheet()
  // Hand the sheet to the engine so it can compute pixel-tight collision boxes
  animator.setSpriteSheet(sheet)
  renderer = new SpriteRenderer(ctx, sheet)

  lastTime = performance.now()
  animationId = requestAnimationFrame(animate)
}

// Keep the canvas matched to the viewport so it always fills the page
function handleResize() {
  animator.setViewport(window.innerWidth, window.innerHeight)
}

onMounted(async () => {
  await init()
  window.addEventListener('keydown', animator.handleKeydown)
  window.addEventListener('keyup', animator.handleKeyup)
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  if (animationId) cancelAnimationFrame(animationId)
  window.removeEventListener('keydown', animator.handleKeydown)
  window.removeEventListener('keyup', animator.handleKeyup)
  window.removeEventListener('resize', handleResize)
})
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
