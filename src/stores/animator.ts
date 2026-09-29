import { defineStore } from 'pinia'
import { computed, markRaw, reactive, ref, watch } from 'vue'
import animationDataRaw from '../animations.json'
import {
  AnimatorController,
  Character,
  InhaleField,
  PhysicsWorld,
  computeLayout,
  INHALE_BODY_MULT,
  MIN_RUN_DISTANCE,
  WORLD_SCALE,
  type AnimationConfig,
  type CharContext,
  type Frame,
  type RenderState,
  type SceneLayout
} from '../engine'
import { usePanelStore } from './panels'
import { useUiStore } from './ui'

/** Every animation state Kirby can be in, in panel order. */
export const KIRBY_STATES = [
  'idle',
  'crouch',
  'walk',
  'run',
  'jump',
  'attack',
  'holdEnemy',
  'swallow',
  'walkWithEnemy',
  'phone',
  'slide',
  'brake',
  'coast',
  'jumpWithEnemy'
] as const

export type KirbyState = (typeof KIRBY_STATES)[number]

/**
 * States offered as buttons in the animation panel. `coast` is left out: it is
 * an internal movement state that already plays the run animation, so a
 * separate button would only duplicate the run preview.
 */
export const PANEL_STATES: readonly KirbyState[] = KIRBY_STATES.filter(s => s !== 'coast')

export const STATE_LABELS: Record<string, string> = {
  idle: '待机',
  crouch: '蹲下',
  walk: '行走',
  run: '奔跑',
  jump: '跳跃',
  attack: '攻击',
  holdEnemy: '含着',
  swallow: '吞下',
  walkWithEnemy: '吞敌行走',
  phone: '打电话',
  slide: '滑铲',
  brake: '刹车',
  coast: '原地小跑',
  jumpWithEnemy: '吞敌跳跃'
}

/** Keys the game consumes, so the browser never scrolls or opens quick-find. */
const GAME_KEYS = [
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ',
  'w', 'W', 'a', 'A', 's', 'S', 'd', 'D', 'c', 'C', 'x', 'X', 'Shift'
]

const LEFT_KEYS = ['ArrowLeft', 'a', 'A']
const RIGHT_KEYS = ['ArrowRight', 'd', 'D']
const DOWN_KEYS = ['ArrowDown', 's', 'S']
const ATTACK_KEYS = ['x', 'X']

/** Double-tap window for switching from walk to run. */
const DOUBLE_TAP_MS = 200

/**
 * Grace window after releasing a run: re-pressing a direction within this many
 * ms resumes the run, so a quick release+press never drops him into a walk
 * mid-stride.
 */
const RUN_RESUME_MS = 100

/** How long the closed-eye blink frame stays visible. */
const BLINK_MS = 150

/** What one simulation tick produced, so the renderer can draw the same frame. */
export interface StepResult {
  /** The frame that was on screen when the tick started. */
  frame: Frame | null
  /** Geometry the engine used, for the physics debug overlay. */
  charCtx: CharContext | null
}

/**
 * The animator: engine instances, playback state, input and the state machine.
 *
 * The Vue layer only owns the canvas, the requestAnimationFrame loop and the
 * sprite sheet - everything numerical lives here so the debug panels can read
 * and drive it without prop plumbing.
 */
export const useAnimatorStore = defineStore('animator', () => {
  const panelStore = usePanelStore()
  const uiStore = useUiStore()

  // Reactive so X/Y/W/H edits in the frame editor invalidate computed values
  const animationData = reactive(animationDataRaw)

  // ---- playback / view state ----
  const state = ref<KirbyState>('idle')
  const speed = ref<number>(animationDataRaw.globalSpeed || 1.0)
  // Sprite zoom. The world itself is drawn at 1/5 scale (WORLD_SCALE), so this
  // multiplies on top of that - 10 keeps Kirby at his original size relative to
  // the platform.
  const scale = ref(10)
  const frameIndex = ref(0)

  // Canvas fills the page; kept in sync with the viewport size
  const viewport = reactive({
    width: typeof window !== 'undefined' ? window.innerWidth : 400,
    height: typeof window !== 'undefined' ? window.innerHeight : 400
  })

  // ---- onion skin (mode select is the on/off switch: 'none' means off) ----
  const onionMode = ref('none')
  const onionOpacity = ref(0.4)
  const onionOffset = ref(0)

  const showCopyFeedback = ref(false)
  let copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null

  // ---- engine instances (plain mutable objects, deliberately not reactive) ----
  const world = markRaw(new PhysicsWorld())
  const kirby = markRaw(new Character())
  const inhaleField = markRaw(new InhaleField())
  const spriteReady = ref(false)

  // ---- live readouts for the physics debug panel ----
  const stats = reactive({ blocks: 0, ground: 0, onGround: true })
  const charBoxLabel = ref('-')
  const inhaleRangeLabel = ref('-')

  // ---- derived ----
  const isJumping = computed(() => state.value === 'jump' || state.value === 'jumpWithEnemy')

  // Editing mode is derived from the frame editor being open: opening it pauses
  // playback (frame advance + keyboard), closing it resumes automatically.
  const editingMode = computed(() => panelStore.panels.frameEditor.open)

  const stateLabel = computed(() => STATE_LABELS[state.value] || '待机')

  const currentAnim = computed<AnimationConfig>(() => getCurrentAnimation())

  const currentFrameData = computed(() => getCurrentAnimation().frames[frameIndex.value])

  const currentFrameInfo = computed(() => {
    const frame = currentFrameData.value
    return frame ? `${frame.name} (${frame.w}x${frame.h})` : ''
  })

  const imageSize = computed(() => animationData.imageSize)
  const animationCount = computed(() => Object.keys(animationData.animations).length)
  const globalSpeed = computed(() => animationData.globalSpeed)

  const sceneLayout = computed<SceneLayout>(() => computeLayout(viewport.height))

  // Generate JSON text for the current animation, formatted like animations.json
  const animationJson = computed(() => {
    const anim = currentAnim.value
    const lines: string[] = []
    lines.push(`    "${state.value}": {`)
    lines.push(`      "frames": [`)
    anim.frames.forEach((f: Frame, i: number) => {
      const comma = i < anim.frames.length - 1 ? ',' : ''
      lines.push(`        { "name": "${f.name}", "x": ${f.x}, "y": ${f.y}, "w": ${f.w}, "h": ${f.h} }${comma}`)
    })
    lines.push(`      ],`)
    lines.push(`      "frameDurationMs": ${anim.frameDurationMs},`)
    lines.push(`      "loop": ${anim.loop},`)
    lines.push(`      "defaultFacing": "${anim.defaultFacing}",`)
    lines.push(`      "description": "${anim.description || ''}"`)
    lines.push(`    }`)
    return lines.join('\n')
  })

  // ---- animation lookup ----
  function getCurrentAnimation(): AnimationConfig {
    const anims = animationData.animations as Record<string, AnimationConfig>
    // The release-coast plays the run cycle as-is; only the ground speed
    // drops, so the legs keep running while he jogs to a stop.
    if (state.value === 'coast') return anims.run
    return anims[state.value] || anims.idle
  }

  // ---- world geometry ----
  // Ground platform Y position - a thin strip in the lower part of the screen,
  // like MapleStory world proportions (platform stays small as the canvas grows)
  function groundY(): number {
    return viewport.height * 0.75
  }

  // Platform thickness scales gently with the viewport but stays a thin strip.
  // The world itself is drawn at 1/5 scale (WORLD_SCALE), so the platform stays
  // a thin line even on a large canvas - the "small hero, big world" ratio.
  function platformThickness(): number {
    return Math.max(6, Math.round(viewport.height * 0.022 * WORLD_SCALE))
  }

  // Flip state, shared by rendering and collision so they never disagree.
  // All Kirby clips default to facing left, so a mirrored sprite faces right.
  function shouldFlipChar(anim?: AnimationConfig): boolean {
    const a = anim || getCurrentAnimation()
    return a.defaultFacing === 'left' ? controller.isFacingRight : !controller.isFacingRight
  }

  // Build the per-tick geometry context the engine works from
  function buildCharContext(anim: AnimationConfig, frameData: Frame | undefined): CharContext | null {
    if (!frameData) return null
    return {
      frame: frameData,
      scale: scale.value * WORLD_SCALE,
      groundY: groundY(),
      flip: shouldFlipChar(anim),
      canvasWidth: viewport.width
    }
  }

  /** Everything the renderer needs for one frame that it cannot derive itself. */
  function buildRenderState(): RenderState {
    return {
      charX: kirby.x,
      charY: kirby.y,
      bobOffset: 0,
      flip: shouldFlipChar(),
      scale: scale.value * WORLD_SCALE,
      groundY: groundY(),
      canvasWidth: viewport.width,
      canvasHeight: viewport.height
    }
  }

  // ---- controller: per-tick timing, blink, physics, movement and inhale ----
  const controller = markRaw(new AnimatorController({
    getSpeed: () => speed.value,
    getState: () => state.value,
    onStateChange: (next: string) => {
      state.value = next as KirbyState
    },
    getEditingMode: () => editingMode.value,
    isJumping: () => isJumping.value,
    getAnimation: () => getCurrentAnimation()
  }))

  // ---- world actions ----
  function rebuildGroundBlocks(): void {
    world.rebuildGround(viewport.width, viewport.height, groundY(), platformThickness())
  }

  function spawnGravityBlock(): void {
    world.spawn(viewport.width, viewport.height, viewport.width / 2 + kirby.x)
  }

  function clearBlocks(): void {
    world.clear()
  }

  function setSpriteSheet(sheet: HTMLImageElement | null): void {
    kirby.setSpriteSheet(sheet)
    spriteReady.value = !!sheet
  }

  function setViewport(width: number, height: number): void {
    viewport.width = width
    viewport.height = height
    rebuildGroundBlocks()
  }

  // ---- frame editor ----
  function prevFrame(): void {
    if (frameIndex.value > 0) frameIndex.value--
  }

  function nextFrame(): void {
    const anim = getCurrentAnimation()
    if (frameIndex.value < anim.frames.length - 1) frameIndex.value++
  }

  async function copyAnimationJson(): Promise<void> {
    try {
      await navigator.clipboard.writeText(animationJson.value)
      showCopyFeedback.value = true
      if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
      copyFeedbackTimer = setTimeout(() => {
        showCopyFeedback.value = false
      }, 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  // ---- one simulation tick ----
  function step(deltaTime: number): StepResult {
    const anim = getCurrentAnimation()
    let frameData = anim.frames[frameIndex.value]
    if (!frameData) {
      // The state changed but the reset watcher has not flushed yet (it can
      // happen inside a single frame, e.g. jump -> idle on landing). Fall back
      // to the first frame instead of drawing nothing.
      frameIndex.value = 0
      frameData = anim.frames[0]
    }
    const charCtx = buildCharContext(anim, frameData)

    if (charCtx) {
      controller.tick(deltaTime, charCtx, world, inhaleField, kirby, viewport.width, viewport.height)
      frameIndex.value = controller.frameIndex
    }

    uiStore.setSpriteName(frameData ? frameData.name : '')

    // Live readouts for the physics debug panel
    stats.blocks = world.blocks.length
    stats.ground = world.ground.length
    stats.onGround = kirby.isOnGround

    charBoxLabel.value = frameData && spriteReady.value
      ? (() => {
          const t = kirby.getTightBox(frameData)
          const s = scale.value * WORLD_SCALE
          return `${Math.round(t.bw * s)}×${Math.round(t.bh * s)}`
        })()
      : '-'

    if (frameData && charCtx) {
      const anchor = kirby.getInhaleAnchor(charCtx)
      inhaleRangeLabel.value = anchor ? `${Math.round(anchor.range)}px (${INHALE_BODY_MULT}身位)` : '-'
    } else {
      inhaleRangeLabel.value = '-'
    }

    return { frame: frameData, charCtx }
  }

  // Direction keys currently held. Turning around mid-walk means pressing the
  // opposite key while the first is still down, so releasing that first key
  // has to hand the walk over to the key still held - not stop it.
  const heldDirKeys = new Set<string>()

  // When the run direction was last released; null when there is no run to
  // resume. Lets a quick release+press pick the run back up.
  let runReleasedAt: number | null = null

  // ---- input ----
  function handleKeydown(e: KeyboardEvent): void {
    // Ignore key repeat events (auto-repeat when holding key)
    if (e.repeat) return

    // Prevent default browser behavior for game control keys
    if (GAME_KEYS.includes(e.key)) e.preventDefault()

    // Disable keyboard controls when in editing mode
    if (editingMode.value) return

    const currentTime = Date.now()
    let direction: number | null = null

    if (LEFT_KEYS.includes(e.key)) direction = -1
    else if (RIGHT_KEYS.includes(e.key)) direction = 1

    if (direction !== null) {
      heldDirKeys.add(e.key)

      // Mid-skid: a direction press only re-aims where the skid ends up, it
      // must not disturb the skid itself.
      if (state.value === 'brake') {
        controller.brakeTargetDir = direction
        controller.heldDirection = direction
        return
      }

      // A re-press shortly after letting go of a run still counts as running,
      // so a quick release+press never drops him back into a walk.
      const runGrace = runReleasedAt !== null && (currentTime - runReleasedAt) <= RUN_RESUME_MS
      if (runGrace) runReleasedAt = null

      const running = state.value === 'run' || runGrace
      const turnFromRun = running && kirby.isOnGround && direction !== controller.walkDirection
      if (turnFromRun && controller.runDistance >= MIN_RUN_DISTANCE) {
        // Momentum earned: skid to a stop first, then run the new way (the
        // classic Kirby turn brake).
        controller.startBrake(direction)
        controller.heldDirection = direction
        state.value = 'brake'
        return
      }
      if (turnFromRun) {
        // The run never got going - a two-step run turns back into a walk
        // instead of skidding or doing a full-speed U-turn.
        state.value = 'walk'
      }

      controller.walkDirection = direction
      controller.heldDirection = direction
      controller.isFacingRight = direction > 0

      // While airborne keep the current animation; only update direction
      if (!isJumping.value) {
        if (controller.lastKeyDirection === direction && (currentTime - controller.lastKeyTime) <= DOUBLE_TAP_MS) {
          // Double-tap: only switch into run if not already running, so the
          // run clip is never restarted mid-stride
          if (state.value !== 'run') state.value = 'run'
          controller.lastKeyDirection = null
        } else if (running && !turnFromRun) {
          // Keep running: the release+press was too quick to read as a walk.
          state.value = 'run'
          controller.lastKeyDirection = null
        } else {
          // Single tap: 'run' cannot reach here (the branch above owns it),
          // so this is a turn from idle or a non-moving state into a walk.
          if (state.value !== 'walk') state.value = 'walk'
          controller.lastKeyDirection = direction
          controller.lastKeyTime = currentTime
        }
      }
      return
    }

    switch (e.key) {
      case 'Shift':
        controller.shiftHeld = true
        if (state.value === 'walk') state.value = 'run'
        break
      case 'c':
      case 'C':
        // Jump - save previous state to return after landing.
        // Jumping while holding an enemy uses the same physics, just a different sprite set
        if (kirby.isOnGround && !isJumping.value) {
          controller.previousMoveState = state.value
          state.value = state.value === 'walkWithEnemy' ? 'jumpWithEnemy' : 'jump'
          kirby.jump(-10)
        }
        break
      case 'x':
      case 'X':
        // Attack / Slide: down+attack triggers slide, attack alone triggers attack.
        // While holding an enemy in his mouth, X swallows it instead of inhaling.
        controller.attackKeyHeld = true
        if (!isJumping.value && state.value !== 'slide' && state.value !== 'brake') {
          if (controller.downKeyHeld) {
            controller.previousSlideState = state.value
            controller.slideDone = false
            state.value = 'slide'
          } else if (controller.isHolding) {
            // Swallow what is in his mouth
            controller.swallowDone = false
            state.value = 'swallow'
          } else {
            state.value = 'attack'
          }
        }
        break
      case 'ArrowDown':
      case 's':
      case 'S':
        // Crouch / Slide: attack+down triggers slide, down alone triggers crouch
        controller.downKeyHeld = true
        if (!isJumping.value && state.value !== 'slide' && state.value !== 'brake') {
          if (controller.attackKeyHeld) {
            controller.previousSlideState = state.value
            controller.slideDone = false
            state.value = 'slide'
          } else {
            state.value = 'crouch'
          }
        }
        break
    }
  }

  function handleKeyup(e: KeyboardEvent): void {
    if (editingMode.value) return

    if (e.key === 'Shift') {
      controller.shiftHeld = false
      if (state.value === 'run') state.value = 'walk'
    }
    if (LEFT_KEYS.includes(e.key) || RIGHT_KEYS.includes(e.key)) {
      heldDirKeys.delete(e.key)
      // Another direction key may still be held (the usual way to turn
      // around): hand the walk over to the most recently pressed one that is
      // still down instead of stopping. Only a fully released direction stops
      // the character.
      const remaining = [...heldDirKeys].filter(k => LEFT_KEYS.includes(k) || RIGHT_KEYS.includes(k))
      if (remaining.length) {
        const lastHeld = remaining[remaining.length - 1]
        const dir = LEFT_KEYS.includes(lastHeld) ? -1 : 1
        controller.heldDirection = dir
        if (state.value === 'brake') {
          // Mid-skid: only re-aim where he ends up; the skid keeps sliding
          // the old way and slows down on its own.
          controller.brakeTargetDir = dir
        } else {
          controller.walkDirection = dir
          controller.isFacingRight = dir > 0
        }
      } else {
        controller.heldDirection = 0
        if (state.value === 'walk' || state.value === 'run') {
          if (state.value === 'run') {
            // Let go of a run: remember it so a quick re-press resumes the
            // run, and jog on a short stretch before settling into idle.
            runReleasedAt = Date.now()
            controller.startCoast()
            state.value = 'coast'
          } else {
            state.value = 'idle'
          }
        }
      }
    }
    if (ATTACK_KEYS.includes(e.key)) {
      controller.attackKeyHeld = false
      if (state.value === 'attack') state.value = 'idle'
      // If slide was triggered but still in slide state, let the animation
      // finish and auto-return (handled by the controller via slideDone)
    }
    if (DOWN_KEYS.includes(e.key)) {
      controller.downKeyHeld = false
      if (state.value === 'crouch') state.value = 'idle'
    }
  }

  // ---- state transitions ----
  watch(state, (newState) => {
    frameIndex.value = 0
    controller.resetForState(newState)

    if (newState === 'idle' || newState === 'crouch') {
      // Keep kirby.x - don't auto-reset to center.
      //
      // Only fall back to the ground when Kirby is actually airborne. Landing on
      // a gravity block emits a state change, and resetting the offset here
      // unconditionally would yank him straight through the block he just landed
      // on, down to the ground. When he is already standing on something, the
      // engine re-glues him to that surface every frame, so there is nothing to reset.
      if (kirby.supportSurfaceY === null) {
        kirby.velocityY = 0
        kirby.supportSurfaceY = groundY()
      }
      kirby.isOnGround = true
    }
    if (newState === 'jump' || newState === 'jumpWithEnemy') {
      kirby.jump(-10)
    }
    if (newState !== 'slide') {
      // Left slide state: clear the auto-return guard
      controller.slideDone = false
    }
    if (newState !== 'swallow') {
      controller.swallowDone = false
    }
    if (newState !== 'holdEnemy') {
      // Left the holding state: arm the blink timer so the next entry blinks
      controller.nextBlinkTime = 2000 + Math.random() * 3000
      controller.isBlinking = false
    }
  })

  // Exposed for the panels / renderer
  return {
    // state
    state,
    speed,
    scale,
    frameIndex,
    viewport,
    onionMode,
    onionOpacity,
    onionOffset,
    showCopyFeedback,
    stats,
    charBoxLabel,
    inhaleRangeLabel,
    spriteReady,
    // engine
    world,
    kirby,
    inhaleField,
    controller,
    // derived
    animationData,
    isJumping,
    editingMode,
    stateLabel,
    currentAnim,
    currentFrameData,
    currentFrameInfo,
    imageSize,
    animationCount,
    globalSpeed,
    sceneLayout,
    animationJson,
    // actions
    getCurrentAnimation,
    groundY,
    platformThickness,
    shouldFlipChar,
    buildCharContext,
    buildRenderState,
    rebuildGroundBlocks,
    spawnGravityBlock,
    clearBlocks,
    setSpriteSheet,
    setViewport,
    prevFrame,
    nextFrame,
    copyAnimationJson,
    step,
    handleKeydown,
    handleKeyup
  }
})
