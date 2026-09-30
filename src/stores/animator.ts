import { defineStore } from "pinia";
import { computed, markRaw, reactive, ref, watch } from "vue";
import animationDataRaw from "../animations.json";
import {
  AnimatorController,
  AIBot,
  BotState,
  Character,
  EnemySpawner,
  InhaleField,
  PhysicsWorld,
  computeLayout,
  INHALE_BODY_MULT,
  CHAR_JUMP_IMPULSE,
  MIN_RUN_DISTANCE,
  WORLD_SCALE,
  type AnimationConfig,
  type CharContext,
  type CharacterRef,
  type Frame,
  type RenderState,
  type SceneLayout,
} from "../engine";
import { usePanelStore } from "./panels";
import { useUiStore } from "./ui";

/** Every animation state Kirby can be in, in panel order. */
export const KIRBY_STATES = [
  "idle",
  "crouch",
  "walk",
  "run",
  "jump",
  "attack",
  "holdEnemy",
  "swallow",
  "walkWithEnemy",
  "phone",
  "slide",
  "brake",
  "coast",
  "jumpWithEnemy",
] as const;

export type KirbyState = (typeof KIRBY_STATES)[number];

/**
 * States offered as buttons in the animation panel. `coast` is left out: it is
 * an internal movement state that already plays the run animation, so a
 * separate button would only duplicate the run preview.
 */
export const PANEL_STATES: readonly KirbyState[] = KIRBY_STATES.filter(
  (s) => s !== "coast",
);

export const STATE_LABELS: Record<string, string> = {
  idle: "待机",
  crouch: "蹲下",
  walk: "行走",
  run: "奔跑",
  jump: "跳跃",
  attack: "攻击",
  holdEnemy: "含着",
  swallow: "吞下",
  walkWithEnemy: "吞敌行走",
  phone: "打电话",
  slide: "滑铲",
  brake: "刹车",
  coast: "原地小跑",
  jumpWithEnemy: "吞敌跳跃",
};

/** Keys the game consumes, so the browser never scrolls or opens quick-find. */
const GAME_KEYS = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  " ",
  "w",
  "W",
  "a",
  "A",
  "s",
  "S",
  "d",
  "D",
  "c",
  "C",
  "x",
  "X",
  "Shift",
];

const LEFT_KEYS = ["ArrowLeft", "a", "A"];
const RIGHT_KEYS = ["ArrowRight", "d", "D"];
const DOWN_KEYS = ["ArrowDown", "s", "S"];
const ATTACK_KEYS = ["x", "X"];

/** Double-tap window for switching from walk to run. */
const DOUBLE_TAP_MS = 200;

/**
 * Grace window after releasing a run: re-pressing a direction within this many
 * ms resumes the run, so a quick release+press never drops him into a walk
 * mid-stride.
 */
const RUN_RESUME_MS = 100;

/** How long the closed-eye blink frame stays visible. */
const BLINK_MS = 150;

/** What one simulation tick produced, so the renderer can draw the same frame. */
export interface StepResult {
  /** The frame that was on screen when the tick started. */
  frame: Frame | null;
  /** Geometry the engine used, for the physics debug overlay. */
  charCtx: CharContext | null;
}

/**
 * The animator: engine instances, playback state, input and the state machine.
 *
 * The Vue layer only owns the canvas, the requestAnimationFrame loop and the
 * sprite sheet - everything numerical lives here so the debug panels can read
 * and drive it without prop plumbing.
 */
export const useAnimatorStore = defineStore("animator", () => {
  const panelStore = usePanelStore();
  const uiStore = useUiStore();

  // Reactive so X/Y/W/H edits in the frame editor invalidate computed values
  const animationData = reactive(animationDataRaw);

  // ---- playback / view state ----
  const state = ref<KirbyState>("idle");
  const speed = ref<number>(animationDataRaw.globalSpeed || 1.0);
  // Sprite zoom. The world itself is drawn at 1/5 scale (WORLD_SCALE), so this
  // multiplies on top of that - 10 keeps Kirby at his original size relative to
  // the platform.
  const scale = ref(10);
  const frameIndex = ref(0);

  // Canvas fills the page; kept in sync with the viewport size
  const viewport = reactive({
    width: typeof window !== "undefined" ? window.innerWidth : 400,
    height: typeof window !== "undefined" ? window.innerHeight : 400,
  });

  // ---- onion skin (mode select is the on/off switch: 'none' means off) ----
  const onionMode = ref("none");
  const onionOpacity = ref(0.4);
  const onionOffset = ref(0);

  const showCopyFeedback = ref(false);
  let copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

  // How many gravity blocks one press of the panel's spawn button creates.
  const spawnCount = ref(5);

  // ---- engine instances (plain mutable objects, deliberately not reactive) ----
  const world = markRaw(new PhysicsWorld());
  const kirby = markRaw(new Character());
  const inhaleField = markRaw(new InhaleField());
  const spriteReady = ref(false);

  // ---- enemies and AI bots ----
  const enemies = ref<any[]>([]);
  const bots = ref<any[]>([]);
  const botEnabled = ref(false);
  const enemyCount = ref(0);
  const maxEnemies = 15;

  // Kirby is not auto-generated on init; call spawnKirby() to bring him in.
  // While false the canvas does not render him, bots / enemies target the
  // scene centre instead of his position, and his physics is skipped.
  const kirbyEnabled = ref(false);

  // True while a direction key is held: the player is driving the character by
  // hand, so the bots stand aside instead of acting out their own script.
  const manualControl = ref(false);

  // Click-to-select takeover: selection mode toggle and which entity is
  // currently controlled. 'kirby' means the player's own character, a number
  // means a bot id, null means nobody is being driven by hand.
  const takeoverMode = ref(false);
  const controlledEntity = ref<"kirby" | number | null>(null);

  // One-shot flag: on the first rendered frame, snap Kirby to the ground so
  // he does not start floating (snapToGround is not called by the state
  // watcher because the state never *changes* on init).
  let initialSnapDone = false;

  // ---- live readouts for the physics debug panel ----
  const stats = reactive({ blocks: 0, ground: 0, onGround: true });
  const charBoxLabel = ref("-");
  const inhaleRangeLabel = ref("-");

  // ---- derived ----
  const isJumping = computed(
    () => state.value === "jump" || state.value === "jumpWithEnemy",
  );

  // Editing mode is derived from the frame editor being open: opening it pauses
  // playback (frame advance + keyboard), closing it resumes automatically.
  const editingMode = computed(() => panelStore.panels.frameEditor.open);

  const stateLabel = computed(() => STATE_LABELS[state.value] || "待机");

  // Animation state display is based on the currently controlled entity:
  // - 'kirby' → Kirby's own state machine
  // - a bot id → that bot's animState
  // - null → no character is selected (shows as "未选中")
  const displayState = computed<string | null>(() => {
    if (controlledEntity.value === null) return null;
    if (controlledEntity.value === "kirby") return state.value;
    const bot = bots.value.find((b: any) => b.id === controlledEntity.value);
    return bot ? (bot.animState as string) : null;
  });

  const displayStateLabel = computed(() => {
    const s = displayState.value;
    if (s === null) return "未选中";
    return STATE_LABELS[s] || s;
  });

  const currentAnim = computed<AnimationConfig>(() => getCurrentAnimation());

  const currentFrameData = computed(
    () => getCurrentAnimation().frames[frameIndex.value],
  );

  const currentFrameInfo = computed(() => {
    const frame = currentFrameData.value;
    return frame ? `${frame.name} (${frame.w}x${frame.h})` : "";
  });

  const imageSize = computed(() => animationData.imageSize);
  const animationCount = computed(
    () => Object.keys(animationData.animations).length,
  );
  const globalSpeed = computed(() => animationData.globalSpeed);

  const sceneLayout = computed<SceneLayout>(() =>
    computeLayout(viewport.height),
  );

  // Generate JSON text for the current animation, formatted like animations.json
  const animationJson = computed(() => {
    const anim = currentAnim.value;
    const lines: string[] = [];
    lines.push(`    "${state.value}": {`);
    lines.push(`      "frames": [`);
    anim.frames.forEach((f: Frame, i: number) => {
      const comma = i < anim.frames.length - 1 ? "," : "";
      lines.push(
        `        { "name": "${f.name}", "x": ${f.x}, "y": ${f.y}, "w": ${f.w}, "h": ${f.h} }${comma}`,
      );
    });
    lines.push(`      ],`);
    lines.push(`      "frameDurationMs": ${anim.frameDurationMs},`);
    lines.push(`      "loop": ${anim.loop},`);
    lines.push(`      "defaultFacing": "${anim.defaultFacing}",`);
    lines.push(`      "description": "${anim.description || ""}"`);
    lines.push(`    }`);
    return lines.join("\n");
  });

  // ---- animation lookup ----
  function getCurrentAnimation(): AnimationConfig {
    const anims = animationData.animations as Record<string, AnimationConfig>;
    // The release-coast plays the run cycle as-is; only the ground speed
    // drops, so the legs keep running while he jogs to a stop.
    if (state.value === "coast") return anims.run;
    return anims[state.value] || anims.idle;
  }

  // ---- world geometry ----
  // Ground platform Y position - a thin strip in the lower part of the screen,
  // like MapleStory world proportions (platform stays small as the canvas grows)
  function groundY(): number {
    return viewport.height * 0.75;
  }

  // Platform thickness scales gently with the viewport but stays a thin strip.
  // The world itself is drawn at 1/5 scale (WORLD_SCALE), so the platform stays
  // a thin line even on a large canvas - the "small hero, big world" ratio.
  function platformThickness(): number {
    return Math.max(6, Math.round(viewport.height * 0.022 * WORLD_SCALE));
  }

  // Flip state, shared by rendering and collision so they never disagree.
  // All Kirby clips default to facing left, so a mirrored sprite faces right.
  function shouldFlipChar(anim?: AnimationConfig): boolean {
    const a = anim || getCurrentAnimation();
    return a.defaultFacing === "left"
      ? controller.isFacingRight
      : !controller.isFacingRight;
  }

  // Build the per-tick geometry context the engine works from
  function buildCharContext(
    anim: AnimationConfig,
    frameData: Frame | undefined,
  ): CharContext | null {
    if (!frameData) return null;
    return {
      frame: frameData,
      scale: scale.value * WORLD_SCALE,
      groundY: groundY(),
      flip: shouldFlipChar(anim),
      canvasWidth: viewport.width,
      canvasHeight: viewport.height,
    };
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
      canvasHeight: viewport.height,
    };
  }

  // ---- controller: per-tick timing, blink, physics, movement and inhale ----
  const controller = markRaw(
    new AnimatorController({
      getSpeed: () => speed.value,
      getState: () => state.value,
      onStateChange: (next: string) => {
        state.value = next as KirbyState;
      },
      getEditingMode: () => editingMode.value,
      isJumping: () => isJumping.value,
      getAnimation: () => getCurrentAnimation(),
    }),
  );

  // ---- world actions ----
  function rebuildGroundBlocks(): void {
    world.rebuildGround(
      viewport.width,
      viewport.height,
      groundY(),
      platformThickness(),
    );
  }

  function spawnGravityBlock(): void {
    const offsetX = kirbyEnabled.value ? kirby.x : 0;
    world.spawn(viewport.width, viewport.height, viewport.width / 2 + offsetX);
  }

  /** Spawn `count` blocks at once - the panel's quick-generation path. */
  function spawnGravityBlocks(count: number): void {
    const n = Math.min(200, Math.max(1, Math.floor(count) || 1));
    for (let i = 0; i < n; i++) spawnGravityBlock();
  }

  function clearBlocks(): void {
    world.clear();
  }

  // ---- enemy and bot management ----
  function spawnEnemy(): void {
    if (enemies.value.length >= maxEnemies) return;
    const enemy = new EnemySpawner().spawnRandom(
      Math.random() * viewport.width,
      groundY() - 50 - Math.random() * 100,
    );
    enemies.value.push(enemy);
    enemyCount.value = enemies.value.length;
  }

  function spawnEnemies(count: number): void {
    for (let i = 0; i < count; i++) spawnEnemy();
  }

  function spawnBot(name: string): void {
    const bot = new AIBot({ name });
    bot.x = viewport.width / 2 + (Math.random() - 0.5) * 200;
    bot.y = groundY();
    bots.value.push(bot);
    botEnabled.value = true;
  }

  /** Spawn N bots at once, each with a unique name. */
  function spawnBots(count: number): void {
    const n = Math.min(20, Math.max(1, Math.floor(count) || 1));
    for (let i = 0; i < n; i++) {
      spawnBot(`Bot-${bots.value.length + 1}`);
    }
  }

  /** Remove every bot and disable AI. */
  function clearBots(): void {
    bots.value = [];
    botEnabled.value = false;
    if (controlledEntity.value !== null && controlledEntity.value !== "kirby") {
      controlledEntity.value = null;
    }
  }

  /** Spawn a single enemy of a specific type at a random position. */
  function spawnEnemyOfType(type: "walker" | "flyer" | "jumper"): void {
    if (enemies.value.length >= maxEnemies) return;
    const enemy = new EnemySpawner().spawn(
      type as any,
      Math.random() * viewport.width,
      groundY() - 50 - Math.random() * 100,
    );
    enemies.value.push(enemy);
    enemyCount.value = enemies.value.length;
  }

  /** Spawn N enemies of the given type at once. */
  function spawnEnemiesOfType(count: number, type: "walker" | "flyer" | "jumper"): void {
    const n = Math.min(20, Math.max(1, Math.floor(count) || 1));
    for (let i = 0; i < n; i++) spawnEnemyOfType(type);
  }

  function toggleBot(): void {
    botEnabled.value = !botEnabled.value;
    if (!botEnabled.value) {
      bots.value = [];
      if (controlledEntity.value !== null && controlledEntity.value !== "kirby") {
        controlledEntity.value = null;
      }
    }
  }

  /** Manually spawn Kirby. Kirby is not auto-generated on init. */
  /** Spawn a character (AIBot). Can be controlled via takeover mode. */
  function spawnKirby(): void {
    const bot = new AIBot({ name: `Bot-${bots.value.length + 1}` });
    bot.x = viewport.width / 2 + (Math.random() - 0.5) * 200;
    bot.y = groundY();
    bots.value.push(bot);
    botEnabled.value = true;
  }

  /** Spawn N characters at once. */
  function spawnCharacters(count: number): void {
    const n = Math.min(20, Math.max(1, Math.floor(count) || 1));
    for (let i = 0; i < n; i++) {
      spawnKirby();
    }
  }

  /**
   * Toggle the click-to-select takeover mode. Three states:
   * - selection mode off, nothing controlled → enter selection mode
   * - selection mode on → cancel selection mode
   * - something controlled → cancel control (clear held keys, reset to idle)
   */
  function toggleTakeoverMode(): void {
    if (takeoverMode.value) {
      takeoverMode.value = false;
    } else if (controlledEntity.value !== null) {
      controlledEntity.value = null;
      if (
        state.value === "walk" ||
        state.value === "run" ||
        state.value === "coast"
      ) {
        state.value = "idle";
      }
      heldDirKeys.clear();
      manualControl.value = false;
    } else {
      takeoverMode.value = true;
    }
  }

  /**
   * Test a click position against Kirby and all bots. On hit, set the
   * controlled entity and exit selection mode. Kirby uses a 25px hit radius;
   * bots use their own half-extents plus 5px padding.
   */
  function selectCharacterAt(canvasX: number, canvasY: number): void {
    // Check Kirby first (priority when both overlap) — only when Kirby is enabled
    if (kirbyEnabled.value) {
      const rs = buildRenderState();
      const kirbyCanvasX = rs.canvasWidth / 2 + rs.charX;
      const kirbyCanvasY = rs.groundY + rs.charY;
      const kirbyDist = Math.hypot(kirbyCanvasX - canvasX, kirbyCanvasY - canvasY);
      if (kirbyDist <= 25) {
        controlledEntity.value = "kirby";
        takeoverMode.value = false;
        return;
      }
    }

    // Check bots — bot.x and bot.y are already in canvas coordinates
    const botList = bots.value as AIBot[];
    for (const bot of botList) {
      const hitW = bot.w / 2 + 5;
      const hitH = bot.h / 2 + 5;
      if (
        canvasX >= bot.x - hitW &&
        canvasX <= bot.x + hitW &&
        canvasY >= bot.y - hitH &&
        canvasY <= bot.y + hitH
      ) {
        controlledEntity.value = bot.id;
        takeoverMode.value = false;
        return;
      }
    }
  }

  function clearEnemies(): void {
    enemies.value = [];
    enemyCount.value = 0;
  }

  function getBotRenderState(): Array<{
    x: number;
    y: number;
    flip: boolean;
    animState: string;
    animFrameIndex: number;
    name: string;
  }> {
    return bots.value.map((bot: any) => ({
      x: bot.x,
      y: bot.y,
      flip: bot.dir === 1,
      animState: bot.animState,
      animFrameIndex: bot.animFrameIndex,
      name: bot.name,
    }));
  }

  function setSpriteSheet(sheet: HTMLImageElement | null): void {
    kirby.setSpriteSheet(sheet);
    spriteReady.value = !!sheet;
  }

  function setViewport(width: number, height: number): void {
    viewport.width = width;
    viewport.height = height;
    rebuildGroundBlocks();
  }

  // ---- frame editor ----
  function prevFrame(): void {
    if (frameIndex.value > 0) frameIndex.value--;
  }

  function nextFrame(): void {
    const anim = getCurrentAnimation();
    if (frameIndex.value < anim.frames.length - 1) frameIndex.value++;
  }

  async function copyAnimationJson(): Promise<void> {
    try {
      await navigator.clipboard.writeText(animationJson.value);
      showCopyFeedback.value = true;
      if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = setTimeout(() => {
        showCopyFeedback.value = false;
      }, 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }

  /**
   * The player's collision box in canvas coords, for the bots' soft collisions.
   * Matches AIBot's own convention: `x` is the centre, `y` the feet.
   */
  function buildPlayerCollisionRef(frameData: Frame | undefined): CharacterRef | null {
    if (!frameData || !spriteReady.value || !kirbyEnabled.value) return null;
    const s = scale.value * WORLD_SCALE;
    const tight = kirby.getTightBox(frameData);
    const x = kirby.x + viewport.width / 2;
    const feetY = groundY() + kirby.y;
    return {
      x,
      y: feetY,
      w: tight.bw * s,
      h: tight.bh * s,
      centreX: x,
      centreY: feetY - (tight.bh * s) / 2,
    };
  }

  /**
   * Push each bot away from the player and the other bots. Runs after all bots
   * have updated, so the AI's own movement and block collisions have already
   * happened for this tick and only the character-to-character overlap is left.
   */
  function separateBots(frameData: Frame | undefined): void {
    if (!botEnabled.value) return;
    const botList = bots.value as AIBot[];
    if (botList.length === 0) return;

    const playerRef = buildPlayerCollisionRef(frameData);
    for (const botA of botList) {
      const others: CharacterRef[] = [];
      if (playerRef) others.push(playerRef);
      for (const botB of botList) {
        if (botA === botB) continue;
        others.push({
          x: botB.x - botB.w / 2,
          y: botB.y - botB.h,
          w: botB.w,
          h: botB.h,
          centreX: botB.x,
          centreY: botB.y - botB.h / 2,
        });
      }
      botA.handleCharacterCollisions(others);
    }
  }

  function step(deltaTime: number): StepResult {
    const anim = getCurrentAnimation();
    let frameData = anim.frames[frameIndex.value];
    if (!frameData) {
      // The state changed but the reset watcher has not flushed yet (it can
      // happen inside a single frame, e.g. jump -> idle on landing). Fall back
      // to the first frame instead of drawing nothing.
      frameIndex.value = 0;
      frameData = anim.frames[0];
    }
    const charCtx = buildCharContext(anim, frameData);

    if (charCtx) {
      // Only run Kirby's physics / state machine when he is actually present.
      if (kirbyEnabled.value) {
        controller.tick(
          deltaTime,
          charCtx,
          world,
          inhaleField,
          kirby,
          viewport.width,
          viewport.height,
        );
        frameIndex.value = controller.frameIndex;
      } else {
        // Step the world physics without character updates (blocks still fall)
        world.stepOnly(deltaTime);
      }

      // First frame: snap to ground so Kirby does not start floating.
      // The state watcher only fires on state *changes*, so it never fires
      // for the initial "idle" state.
      if (!initialSnapDone) {
        initialSnapDone = true;
        if (!kirby.isOnGround) {
          kirby.snapToGround(groundY());
        }
      }
    }

    // Update enemies — target the player's position, or the scene centre
    // when Kirby is not present.
    const enemyList = enemies.value as any[];
    const groundYVal = groundY();
    const playerX = kirbyEnabled.value
      ? kirby.x + viewport.width / 2
      : viewport.width / 2;
    const playerY = kirbyEnabled.value
      ? groundYVal + kirby.y
      : groundYVal;
    for (const enemy of enemyList) {
      if (enemy.dead) continue;
      enemy.update(
        deltaTime,
        groundYVal,
        world.allSolids().filter((b: any) => !b.dead),
        playerX,
        playerY,
      );
    }
    // Remove dead enemies
    for (let i = enemyList.length - 1; i >= 0; i--) {
      if (enemyList[i].dead) enemyList.splice(i, 1);
    }
    enemyCount.value = enemyList.length;

    // Update bots
    if (botEnabled.value) {
      const botList = bots.value as AIBot[];
      // The player's held direction, or 0 if none or if both ways are held.
      let playerDir = 0;
      if (heldDirKeys.size > 0) {
        const leftHeld = [...heldDirKeys].some((k) => LEFT_KEYS.includes(k));
        const rightHeld = [...heldDirKeys].some((k) => RIGHT_KEYS.includes(k));
        if (leftHeld && !rightHeld) playerDir = -1;
        else if (rightHeld && !leftHeld) playerDir = 1;
      }
      const controlled = controlledEntity.value;
      const controlledBotId =
        controlled !== null && controlled !== "kirby" ? controlled : null;
      const standDown = playerDir !== 0;

      // Compute leader position: the controlled bot if one exists, Kirby if
      // enabled, otherwise null (no leader → bots stay idle).
      let leaderX: number | null = null;
      let leaderY: number | null = null;
      if (controlledBotId !== null) {
        const leaderBot = botList.find((b) => b.id === controlledBotId);
        if (leaderBot) {
          leaderX = leaderBot.x;
          leaderY = leaderBot.y;
        }
      } else if (kirbyEnabled.value) {
        leaderX = kirby.x + viewport.width / 2;
        leaderY = groundYVal + kirby.y;
      }

      for (const bot of botList) {
        bot.canvasWidth = viewport.width;
        const driven =
          controlledBotId !== null && bot.id === controlledBotId;
        bot.manualDriven = driven;
        bot.manualDriveDir = playerDir;
        bot.aiSuspended = standDown;
        // Clear stale locks from this bot before update
        for (const e of enemyList) {
          if (e.lockedBy === bot.id) e.lockedBy = undefined;
        }
        // If no leader, pass the bot's own position so it stays idle
        const targetX = leaderX !== null ? leaderX : bot.x;
        const targetY = leaderY !== null ? leaderY : bot.y;
        bot.update(
          deltaTime,
          groundYVal,
          world.allSolids().filter((b: any) => !b.dead),
          enemyList.filter((e: any) => !e.dead),
          targetX,
          targetY,
        );
        // Lock the bot's target so other bots skip it
        if (bot.targetEnemy) {
          bot.targetEnemy.lockedBy = bot.id;
        }
      }
      // Then resolve bot↔player and bot↔bot overlaps (soft push).
      separateBots(frameData);

      // Dodge jumps: if a bot is trying to move but hasn't moved (blocked by
      // another bot or the player), trigger a jump to bypass the obstacle.
      for (const bot of botList) {
        const moved = Math.abs(bot.x - bot.tickStart);
        const wantsToMove =
          bot.state === BotState.CHASE ||
          bot.state === BotState.PATROL ||
          (bot.state === BotState.IDLE && bot.animState !== "idle");
        if (moved < 0.5 && bot.onGround && wantsToMove) {
          bot.triggerDodgeJump();
        }
      }
    }

    uiStore.setSpriteName(frameData ? frameData.name : "");

    // Live readouts for the physics debug panel
    stats.blocks = world.blocks.length;
    stats.ground = world.ground.length;
    stats.onGround = kirby.isOnGround;

    charBoxLabel.value =
      frameData && spriteReady.value
        ? (() => {
            const t = kirby.getTightBox(frameData);
            const s = scale.value * WORLD_SCALE;
            return `${Math.round(t.bw * s)}×${Math.round(t.bh * s)}`;
          })()
        : "-";

    if (frameData && charCtx) {
      const anchor = kirby.getInhaleAnchor(charCtx);
      inhaleRangeLabel.value = anchor
        ? `${Math.round(anchor.range)}px (${INHALE_BODY_MULT}身位)`
        : "-";
    } else {
      inhaleRangeLabel.value = "-";
    }

    return { frame: frameData, charCtx };
  }

  // Direction keys currently held. Turning around mid-walk means pressing the
  // opposite key while the first is still down, so releasing that first key
  // has to hand the walk over to the key still held - not stop it.
  const heldDirKeys = new Set<string>();

  // When the run direction was last released; null when there is no run to
  // resume. Lets a quick release+press pick the run back up.
  let runReleasedAt: number | null = null;

  // ---- input ----
  function handleKeydown(e: KeyboardEvent): void {
    // Ignore key repeat events (auto-repeat when holding key)
    if (e.repeat) return;

    // Prevent default browser behavior for game control keys
    if (GAME_KEYS.includes(e.key)) e.preventDefault();

    // Disable keyboard controls when in editing mode
    if (editingMode.value) return;

    if (controlledEntity.value === null) return;
    if (controlledEntity.value !== "kirby") {
      // Bot control: only track direction keys, don't process Kirby state machine
      if (LEFT_KEYS.includes(e.key) || RIGHT_KEYS.includes(e.key)) {
        heldDirKeys.add(e.key);
        manualControl.value = heldDirKeys.size > 0;
      }
      return;
    }
    // controlledEntity === 'kirby': fall through to existing Kirby state machine code

    const currentTime = Date.now();
    let direction: number | null = null;

    if (LEFT_KEYS.includes(e.key)) direction = -1;
    else if (RIGHT_KEYS.includes(e.key)) direction = 1;

    if (direction !== null) {
      heldDirKeys.add(e.key);
      manualControl.value = heldDirKeys.size > 0;

      // Mid-skid: a direction press only re-aims where the skid ends up, it
      // must not disturb the skid itself.
      if (state.value === "brake") {
        controller.brakeTargetDir = direction;
        controller.heldDirection = direction;
        return;
      }

      // A re-press shortly after letting go of a run still counts as running,
      // so a quick release+press never drops him back into a walk.
      const runGrace =
        runReleasedAt !== null && currentTime - runReleasedAt <= RUN_RESUME_MS;
      if (runGrace) runReleasedAt = null;

      const running = state.value === "run" || runGrace;
      const turnFromRun =
        running && kirby.isOnGround && direction !== controller.walkDirection;
      if (turnFromRun && controller.runDistance >= MIN_RUN_DISTANCE) {
        // Momentum earned: skid to a stop first, then run the new way (the
        // classic Kirby turn brake).
        controller.startBrake(direction);
        controller.heldDirection = direction;
        state.value = "brake";
        return;
      }
      if (turnFromRun) {
        // The run never got going - a two-step run turns back into a walk
        // instead of skidding or doing a full-speed U-turn.
        state.value = "walk";
      }

      controller.walkDirection = direction;
      controller.heldDirection = direction;
      controller.isFacingRight = direction > 0;

      // While airborne keep the current animation; only update direction
      if (!isJumping.value) {
        if (
          controller.lastKeyDirection === direction &&
          currentTime - controller.lastKeyTime <= DOUBLE_TAP_MS
        ) {
          // Double-tap: only switch into run if not already running, so the
          // run clip is never restarted mid-stride
          if (state.value !== "run") state.value = "run";
          controller.lastKeyDirection = null;
        } else if (running && !turnFromRun) {
          // Keep running: the release+press was too quick to read as a walk.
          state.value = "run";
          controller.lastKeyDirection = null;
        } else {
          // Single tap: 'run' cannot reach here (the branch above owns it),
          // so this is a turn from idle or a non-moving state into a walk.
          if (state.value !== "walk") state.value = "walk";
          controller.lastKeyDirection = direction;
          controller.lastKeyTime = currentTime;
        }
      }
      return;
    }

    switch (e.key) {
      case "Shift":
        controller.shiftHeld = true;
        if (state.value === "walk") state.value = "run";
        break;
      case "c":
      case "C":
        // Jump - save previous state to return after landing.
        // Jumping while holding an enemy uses the same physics, just a different sprite set
        if (kirby.isOnGround && !isJumping.value) {
          controller.previousMoveState = state.value;
          state.value =
            state.value === "walkWithEnemy" ? "jumpWithEnemy" : "jump";
          kirby.jump(CHAR_JUMP_IMPULSE);
          world.jump(CHAR_JUMP_IMPULSE);
        }
        break;
      case "x":
      case "X":
        // Attack / Slide: down+attack triggers slide, attack alone triggers attack.
        // While holding an enemy in his mouth, X swallows it instead of inhaling.
        controller.attackKeyHeld = true;
        if (
          !isJumping.value &&
          state.value !== "slide" &&
          state.value !== "brake"
        ) {
          if (controller.downKeyHeld) {
            controller.previousSlideState = state.value;
            controller.slideDone = false;
            state.value = "slide";
          } else if (controller.isHolding) {
            // Swallow what is in his mouth
            controller.swallowDone = false;
            state.value = "swallow";
          } else {
            state.value = "attack";
          }
        }
        break;
      case "ArrowDown":
      case "s":
      case "S":
        // Crouch / Slide: attack+down triggers slide, down alone triggers crouch
        controller.downKeyHeld = true;
        if (
          !isJumping.value &&
          state.value !== "slide" &&
          state.value !== "brake"
        ) {
          if (controller.attackKeyHeld) {
            controller.previousSlideState = state.value;
            controller.slideDone = false;
            state.value = "slide";
          } else {
            state.value = "crouch";
          }
        }
        break;
    }
  }

  function handleKeyup(e: KeyboardEvent): void {
    if (editingMode.value) return;

    if (controlledEntity.value === null) return;
    if (controlledEntity.value !== "kirby") {
      if (LEFT_KEYS.includes(e.key) || RIGHT_KEYS.includes(e.key)) {
        heldDirKeys.delete(e.key);
        manualControl.value = heldDirKeys.size > 0;
      }
      return;
    }
    // controlledEntity === 'kirby': fall through to existing Kirby state machine code

    if (e.key === "Shift") {
      controller.shiftHeld = false;
      if (state.value === "run") state.value = "walk";
    }
    if (LEFT_KEYS.includes(e.key) || RIGHT_KEYS.includes(e.key)) {
      heldDirKeys.delete(e.key);
      manualControl.value = heldDirKeys.size > 0;
      // Another direction key may still be held (the usual way to turn
      // around): hand the walk over to the most recently pressed one that is
      // still down instead of stopping. Only a fully released direction stops
      // the character.
      const remaining = [...heldDirKeys].filter(
        (k) => LEFT_KEYS.includes(k) || RIGHT_KEYS.includes(k),
      );
      if (remaining.length) {
        const lastHeld = remaining[remaining.length - 1];
        const dir = LEFT_KEYS.includes(lastHeld) ? -1 : 1;
        controller.heldDirection = dir;
        if (state.value === "brake") {
          // Mid-skid: only re-aim where he ends up; the skid keeps sliding
          // the old way and slows down on its own.
          controller.brakeTargetDir = dir;
        } else {
          controller.walkDirection = dir;
          controller.isFacingRight = dir > 0;
        }
      } else {
        controller.heldDirection = 0;
        if (state.value === "walk" || state.value === "run") {
          if (state.value === "run") {
            // Let go of a run: remember it so a quick re-press resumes the
            // run, and jog on a short stretch before settling into idle.
            runReleasedAt = Date.now();
            controller.startCoast();
            state.value = "coast";
          } else {
            state.value = "idle";
          }
        }
      }
    }
    if (ATTACK_KEYS.includes(e.key)) {
      controller.attackKeyHeld = false;
      if (state.value === "attack") state.value = "idle";
      // If slide was triggered but still in slide state, let the animation
      // finish and auto-return (handled by the controller via slideDone)
    }
    if (DOWN_KEYS.includes(e.key)) {
      controller.downKeyHeld = false;
      if (state.value === "crouch") state.value = "idle";
    }
  }

  // ---- state transitions ----
  watch(state, (newState) => {
    frameIndex.value = 0;
    controller.resetForState(newState);

    if (newState === "idle" || newState === "crouch") {
      // Only fall back to the ground when Kirby is actually airborne.
      // Landing on a gravity block emits a state change, and resetting the
      // offset here unconditionally would yank him straight through the block
      // he just landed on, down to the ground.
      if (!kirby.isOnGround) {
        kirby.snapToGround(groundY());
      }
    }
    if (newState === "jump" || newState === "jumpWithEnemy") {
      kirby.jump(CHAR_JUMP_IMPULSE);
      world.jump(CHAR_JUMP_IMPULSE);
    }
    if (newState !== "slide") {
      // Left slide state: clear the auto-return guard
      controller.slideDone = false;
    }
    if (newState !== "swallow") {
      controller.swallowDone = false;
    }
    if (newState !== "holdEnemy") {
      // Left the holding state: arm the blink timer so the next entry blinks
      controller.nextBlinkTime = 2000 + Math.random() * 3000;
      controller.isBlinking = false;
    }
  });

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
    spawnCount,
    stats,
    charBoxLabel,
    inhaleRangeLabel,
    spriteReady,
    // enemies and bots
    enemies,
    bots,
    botEnabled,
    kirbyEnabled,
    manualControl,
    takeoverMode,
    controlledEntity,
    enemyCount,
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
    displayState,
    displayStateLabel,
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
    spawnGravityBlocks,
    clearBlocks,
    setSpriteSheet,
    // enemy and bot actions
    spawnEnemy,
    spawnEnemies,
    spawnEnemyOfType,
    spawnEnemiesOfType,
    spawnBot,
    spawnBots,
    spawnKirby,
    spawnCharacters,
    toggleBot,
    toggleTakeoverMode,
    selectCharacterAt,
    clearEnemies,
    clearBots,
    getBotRenderState,
    setViewport,
    prevFrame,
    nextFrame,
    copyAnimationJson,
    step,
    handleKeydown,
    handleKeyup,
  };
});
