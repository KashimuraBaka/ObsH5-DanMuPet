# Kirby Animation 项目文档

## 项目概述

基于 Vue 3 + Vite + Pinia 的 Kirby 动画预览与交互工具，支持角色动画播放、精灵图编辑、AI Bot 模拟等功能。

## 目录结构

```
kirby-animation/
├── src/                          # 源代码
│   ├── assets/
│   │   └── sprites/              # 精灵图资源
│   │       ├── Kirby.png         # Kirby 精灵图
│   │       ├── kirby.json        # Kirby 动画数据
│   │       └── mage/             # 魔界人资源
│   │           ├── Angry.png + angry.json
│   │           ├── Basic.png + basic.json
│   │           ├── ... (共 14 个皮肤)
│   │           └── Twinkle.png + twinkle.json
│   ├── components/               # Vue 组件
│   │   ├── KirbyAnimator.vue     # 主动画画布
│   │   ├── SpriteExtractor.vue   # 精灵坐标提取器
│   │   └── DebugPanels.vue       # 调试面板
│   ├── engine/                   # 游戏引擎核心
│   │   ├── AIBot.ts              # AI Bot 实体
│   │   ├── Character.ts          # 角色类
│   │   ├── SpriteRenderer.ts     # 精灵渲染器
│   │   ├── PhysicsWorld.ts       # 物理世界
│   │   ├── constants.ts          # 常量定义
│   │   ├── types.ts              # 类型定义
│   │   └── ...
│   ├── extractor/                # 精灵提取逻辑
│   ├── stores/                   # Pinia 状态管理
│   │   ├── animator.ts           # 动画状态（核心）
│   │   ├── panels.ts             # 面板状态
│   │   ├── ui.ts                 # UI 状态
│   │   └── index.ts              # 导出入口
│   ├── App.vue
│   └── main.ts
├── scripts/                      # 项目工具脚本
│   └── convert-mage-sprites.mjs  # GIF → 精灵图转换
├── tests/                        # 测试脚本与数据（不提交 git）
│   ├── check-browser.mjs         # 浏览器集成测试
│   ├── test-ai-bot.mjs           # AI Bot 单元测试
│   └── mage-characters.json      # 皮肤清单
├── docs/                         # 项目文档
├── public/                       # 静态资源（已清空）
├── dist/                         # 构建输出
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## 角色系统

### 角色类型（CharType）

```typescript
type CharType = "kirby" | "mage";
```

- `kirby`：经典 Kirby，使用 `Kirby.png` + `kirby.json`
- `mage`：魔界人，使用 `mage/<Skin>.png` + `mage/<skin>.json`

### 魔界人皮肤（MageSkin）

14 个皮肤变体，共享同一个 `Character` 类，仅精灵图和动画数据不同：

```typescript
type MageSkin =
  | "angry" | "basic" | "blanket" | "dizzy" | "drowsy" | "egg"
  | "glummy" | "happy" | "mage" | "sad" | "scooter" | "shy" | "sunglass" | "twinkle";
```

### 动画状态（KirbyState）

Kirby 支持 18 个状态，魔界人支持 5 个：

| 状态 | Kirby | 魔界人 |
|------|-------|--------|
| idle | ✅ | ✅ |
| walk | ✅ | ✅ |
| crouch | ✅ | ✅ |
| dance | ✅ | ✅ |
| lie | ✅ | ✅ |
| run | ✅ | ❌ |
| jump | ✅ | ❌ |
| attack | ✅ | ❌ |
| 其他 | ✅ | ❌ |

## 精灵图规范

### 精灵图布局

- 统一 20 列布局
- 帧间距（GAP）：2px
- 每帧左上角对齐单元格，无额外偏移

### JSON 格式

```json
{
  "imageSize": { "width": 1000, "height": 500 },
  "globalSpeed": 1.0,
  "animations": {
    "idle": {
      "frames": [
        { "name": "Kirby_0", "x": 2, "y": 2, "w": 64, "h": 64 }
      ],
      "frameDurationMs": 500,
      "loop": true,
      "defaultFacing": "left",
      "description": "待机"
    }
  }
}
```

## 精灵图转换工具

将 ObsH5-DanMuPet 项目的 GIF 动画转换为精灵图：

```bash
# 运行转换
node scripts/convert-mage-sprites.mjs

# 输入源
H:/Code/Vue/ObsH5-DanMuPet/public/images/mage/

# 输出
src/assets/sprites/mage/<Skin>.png
src/assets/sprites/mage/<skin>.json
tests/mage-characters.json
```

每个皮肤包含 5 个动作：idle, walk, dance, seat(crouch), lie

## 测试规范

所有测试脚本和测试数据统一存放于 `tests/` 目录，**不通过 git 提交**。

### 测试脚本

| 文件 | 用途 |
|------|------|
| `check-browser.mjs` | 浏览器集成测试（Playwright） |
| `test-ai-bot.mjs` | AI Bot 单元测试 |

### 测试数据

| 文件 | 用途 |
|------|------|
| `mage-characters.json` | 皮肤清单（转换脚本输出） |

### 运行测试

```bash
# 浏览器集成测试
node tests/check-browser.mjs

# AI Bot 单元测试
node tests/test-ai-bot.mjs
```

## 构建命令

```bash
# 开发
npx vite

# 构建
npx vite build

# 类型检查
npx vue-tsc --noEmit
```

## 资源管理规范

1. **精灵图资源**：统一存放于 `src/assets/sprites/`
   - Kirby 资源：直接放在 `sprites/` 下
   - 魔界人资源：放在 `sprites/mage/` 子目录
2. **JSON 命名**：`<角色名>.json`（不带 Animations 后缀）
   - 示例：`kirby.json`, `angry.json`, `mage.json`
3. **测试资源**：统一存放于 `tests/`，不提交 git
4. **项目文档**：统一存放于 `docs/`

## 关键实现

### 精灵图加载

精灵图通过 Vite 资产导入，构建时生成带 hash 的 URL：

```typescript
import kirbySpriteSheet from "../assets/sprites/Kirby.png";
import angrySpriteSheet from "../assets/sprites/mage/Angry.png";

function getSpriteSheetUrl(): string {
  if (characterType.value === "kirby") return kirbySpriteSheet;
  return characterSpriteSheets[mageSkin.value] || mageSpriteSheet;
}
```

### 皮肤切换

切换皮肤时自动重新加载精灵图：

```typescript
watch(() => animator.mageSkin, async () => {
  if (!ctx || animator.characterType !== "mage") return;
  const sheet = await loadSpriteSheet();
  animator.setSpriteSheet(sheet);
  renderer?.setSpriteSheet(sheet);
});
```

### 角色大小补偿

魔界人精灵图原始分辨率（68×102）远大于 Kirby（20×18），在统一世界缩放下会显得过大。

通过 `characterScaleMultiplier` 字段补偿：

| 角色 | 倍数 | 说明 |
|------|------|------|
| Kirby | 1.0 | 不变 |
| Mage | 0.22 | 缩小至接近 Kirby 大小 |

实现方式：`RenderState` 新增 `characterScaleMultiplier` 可选字段，`drawCharacter` 将其乘入 `finalScale`。Bot 始终使用 1.0 倍率，保持视觉一致。

### 缩放系统

缩放系统由三层组成：

```
finalScale = displayScale × SPRITE_BASE_SCALE × characterScaleMultiplier
```

| 层 | 字段 | 默认值 | 作用 |
|---|------|--------|------|
| 用户缩放 | `displayScale` | 1.0 | "1x" = 当前默认视觉大小，"2x" = 2 倍 |
| 基础缩放 | `SPRITE_BASE_SCALE` | 2.0 (= 10 × WORLD_SCALE) | 历史默认有效缩放 |
| 角色补偿 | `characterScaleMultiplier` | 1.0 / 0.22 | 魔界人尺寸补偿 |

实际生效示例：
- Kirby @ 1x：1.0 × 2.0 × 1.0 = **2.0**
- Kirby @ 2x：2.0 × 2.0 × 1.0 = **4.0**
- Mage  @ 1x：1.0 × 2.0 × 0.22 = **0.44**
- Mage  @ 2x：2.0 × 2.0 × 0.22 = **0.88**

注：`worldSize = viewport.height × factor × WORLD_SCALE`（平台/砖块等世界几何仍用 `WORLD_SCALE`）。

碰撞盒 (`buildPlayerCollisionRef`) 与精灵尺寸同步缩放，确保 `displayScale` 改变时碰撞行为正确。

### 面板职责划分

角色控制统一放在「🎭 角色生成」面板，动画控制只管玩家角色自己的动画。

**🎲️ 动画控制** — 分成两段，用分隔线隔开，因为作用对象不同：

| 段 | 项 | 作用对象 |
|---|---|---|
| 上段 | 状态 | 玩家角色，按玩家类型过滤（Kirby 全量 / 魔界人 5 个） |
| 下段（分隔线以下） | 速度、缩放 | 全局显示参数，与当前是哪个角色无关 |

**未生成 / 未选择角色时，状态区显示提示而不是 Kirby 动作**：

```html
<div v-if="animator.controlledEntity === null" class="state-empty">
  请先在「🎭 角色生成」面板生成角色，再用「🎮 选择模式」选中一个
</div>
<div v-else class="state-btn-group">…</div>
```

没有可操作对象时列出动作没有意义（点了也不会有任何角色在播），所以此时提示
用户先生成、再选中。

状态列出来自**当前被操作角色**自己的图集——被接管的 bot 是魔界人就只列
5 个，被操作的是 Kirby 就列全量。这个映射由 `effectiveAnimData` /
`effectiveCharacterType` 完成，它返回「正被驱动」的那个角色，而不是某个
孤立的全局设置：

```typescript
const effectiveCharacterType = computed<CharType>(() => {
  const c = controlledEntity.value;
  if (c === null || c === "kirby") return characterType.value;
  const bot = bots.value.find(b => b.id === c);
  return (bot?.characterType as CharType) ?? "kirby";
});

const playerAnimStates = computed<readonly string[]>(() => {
  const anims = effectiveAnimData.value.animations;
  const list =
    effectiveCharacterType.value === "mage" ? MAGE_PANEL_STATES : PANEL_STATES;
  return list.filter((s) => anims[s]);   // 只列出图集里真实存在的
});

function setPlayerAnimState(animState: string): void {
  if (!playerAnimStates.value.includes(animState)) return;
  const c = controlledEntity.value;
  if (c === null) return;
  if (c === "kirby") { state.value = animState as KirbyState; return; }
  // 被接管的 bot：直接改它的 animState
  const bot = bots.value.find(b => b.id === c);
  if (bot) bot.animState = animState;
}
```

这样做的好处：接管一个魔界人 bot 后，面板立刻反映魔界人图集；切回普通
Kirby 或选别的 bot 也一样——面板始终是「当前被操作角色的」。

**皮肤选择用组合框**：14 个皮肤按钮会把面板撑爆且难以扫读，改为 `<select>`：

```html
<div class="gen-row">
  <label class="gen-label">皮肤</label>
  <select class="gen-select" :value="animator.mageSkin" @change="…">
    <option v-for="s in MAGE_SKINS" :key="s" :value="s">{{ s }}</option>
  </select>
</div>
```

玩家皮肤与生成皮肤两处都用这个组合框。

**🎭 角色生成**（原「🤖 Bot 生成」）— 所有角色相关操作：

| 分区 | 说明 |
|---|---|
| 生成角色 | 类型下拉（Kirby / 魔界人）+ 皮肤下拉 + ×1 / ×3 / ×5 |
| AI 控制 | 停止 / 启动 AI |
| 接管角色 | 选择模式 + 当前接管对象 |
| 管理 | 清空 |

**没有「玩家」这个生成选项。** 玩家、Kirby、魔界人共用同一套 Character 体系，
玩家只是其中被键盘驱动的那一个，不是独立的角色类型；bot 也只是这套体系里的
一种能力（AI 驱动）。所以类型下拉只需要 `CharType`：

```typescript
export type CharType = "kirby" | "mage";   // 只有两种角色类型
const spawnTarget = ref<CharType>("kirby");
```

生成角色时不再隐式把第一个产物提升为「玩家」——所有产物都是普通 bot：

```typescript
function spawnCharacters(count: number): void {
  const n = Math.min(20, Math.max(1, Math.floor(count) || 1));
  for (let i = 0; i < n; i++) spawnCharacter();
}
```

启动后画布为空，点 ×1 只生成 1 个 bot；想要操作它得点「🎮 选择模式」然后点选。
`applyPlayerType()` 这种「第一个生成的不是 bot」的做法已删除。

### 停止 AI ≠ 删除角色

「停止 AI」只让角色停止行动，**不会删除任何角色**。原实现是直接 `bots.value = []`，暂停一次就清空全场。

新增 `AIBot.aiStopped`，在 `runStateMachine()` 里紧随 `manualDriven` 提前返回：

```typescript
// AI paused from the panel: the character stays on the field but acts out
// no script. Checked after manualDriven so a hand-driven bot keeps moving.
if (this.aiStopped) {
  this.targetEnemy = null;
  this.state = BotState.IDLE;
  this.vx = 0;
  this.setAnimState("idle");
  return;
}
```

配套地，角色更新循环**不再**被 `botEnabled` 整体跳过：

```typescript
// 这个块总是执行：暂停 AI 是让全场站定，而不是跳过更新
{
  for (const bot of botList) {
    bot.aiStopped = !botEnabled.value;
    bot.update(/* … */);
  }
}
```

这样暂停的角色仍会正常下落、碰撞与播放 idle 动画，不会卡在迈步的姿势上。`aiStopped` 排在 `manualDriven` 之后，所以被手动接管的角色依然可以正常操作。

`botEnabled` 现在是纯粹的**全局模式开关**（默认 `true`），生成角色和「清除全部 Bot」都不再改写它——暂停状态不会被一次生成意外重置。

### 无 leader 时 bot 完全静止

没有玩家角色、也没有任何接管目标时，bot 没有「该追谁」的目标。旧的实现把
bot 自己的位置当作 leader（`targetX = bot.x`），结果 distance 算出来是 0
确实 idle，但每帧 soft-push 会让一群 bot 在原地交替动画 walk/idle，视觉上
就是「原地乱走」。

修复方式是改用 `null` 表示无 leader：

```typescript
let leaderX: number | null = null;
let leaderY: number | null = null;
if (controlledBotId !== null) {
  leaderX = leaderBot.x;
  leaderY = leaderBot.y;
} else if (kirbyEnabled.value) {
  leaderX = kirby.x + viewport.width / 2;
  leaderY = groundYVal + kirby.y;
}

bot.update(/* … */, leaderX, leaderY);   // 两个都可能是 null
```

AIBot 早返回：

```typescript
// 排在 pushWalkTimer 之前——soft-push 不能在「无目标」之上画 walk 动画
if (playerX === null && playerY === null) {
  this.targetEnemy = null;
  this.state = BotState.IDLE;
  this.vx = 0;
  this.setAnimState("idle");
  return;
}
```

测试覆盖：`tests/test-ai-bot.mjs` 第 7 项——以 `vx=5, animState="walk"` 启动的
bot 在 60 个 null-leader tick 后应回到 `vx=0, animState="idle", state="IDLE"`。

### 手动接管的 bot 也支持跳跃

键盘方向键映射到 `manualDriveDir`，所以方向控制一直能用；跳跃走的是单独
的 one-shot 通道 `manualJump`，避免「按住 C 就无限跳」：

```typescript
// AIBot.ts
if (this.manualDriven) {
  this.targetEnemy = null;
  if (this.manualJump && this.onGround && this.jumpCooldown <= 0) {
    this.vy = this.config.jumpImpulse;
    this.onGround = false;
    this.jumpArc = true;
    this.jumpCooldown = 500;
    this.manualJump = false;
    this.animState = "jump";
    return;
  }
  // …方向控制保持原样
}
```

```typescript
// stores/animator.ts — handleKeydown
if (controlledEntity.value !== "kirby") {
  if (LEFT_KEYS.includes(e.key) || RIGHT_KEYS.includes(e.key)) {
    heldDirKeys.add(e.key);
    manualControl.value = heldDirKeys.size > 0;
  }
  const c = e.key.toLowerCase();
  if (c === "c" || c === " ") {
    const bot = bots.value.find(b => b.id === controlledEntity.value);
    if (bot) bot.manualJump = true;
  }
  return;
}
```

`jumpCooldown` 还在，所以即便 `manualJump` 因连按被多次置位也只会触发一次。
落地之后只要再按一次 C 就会重新起跳——和 Kirby 自己的手感一致。
注意：魔界人图集里没有 `jump` 动画，所以魔界人 bot 物理上会跳起来，但视觉
回落到单帧 fallback，这是素材决定而不是逻辑 bug。

### 多个 bot 跟随玩家时不再「挤压玩家」

当玩家原地不动，一群 bot 围过来与玩家重叠时，旧实现里每个 bot 都会把它自己
和玩家之间的软冲突都解算一遍——其中也包含作为 leader 的那个被接管 bot。
结果是这一帧 leader 被稍稍推走，下一帧其它 bot 追上来、又把它推一遍，永远
落不下来，视觉就是「bot 在挤压玩家移动」。

修复方式是让 leader bot 在 `separateBots` 里跳过自己这一轮：

```typescript
function separateBots(frameData: Frame | undefined): void {
  // ……
  const leaderId =
    controlledEntity.value !== null && controlledEntity.value !== "kirby"
      ? controlledEntity.value
      : null;

  for (const botA of botList) {
    if (leaderId !== null && botA.id === leaderId) continue;   // ← leader 豁免
    // ……
    botA.handleCharacterCollisions(others);
  }
}
```

效果：其它 bot 仍然把 leader 当作 `other` 来推开自己，但 leader 自己不会被
推——所以一帧下来 leader 的 x 不变，follower 收敛到 leader 周围后就稳定下来，
不再抖。`kirby` 作为 leader 时本来就走 planck.js，软推不会移动它，所以
这条豁免只对「被接管的 bot 当 leader」这一种情况有实际意义。

### 每个 bot 有自己的「应该站位」，到达后进入 idle

光让 leader 不被推还不够——所有 follower 仍然在追同一个目标点（leader.x），
堆在一起还是会互相推挤、互相朝门口蹭。先前的代码还有一个症状：玩家原地
不动时，一圈 bot 在原地来回转身、左右各走两步，视觉上就是「原地乱走」。

修复方法：每个 bot 在出生时分配一个固定的 `slotOffset`，follow 阶段的目标
X 变成 `leader.x + slotOffset`，到达后进入 idle：

```typescript
// AIBot.ts — slot offset 固定在构造时
constructor(config, appearance?: { slotOffset?: number; /* … */ }) {
  this.slotOffset = appearance?.slotOffset ?? 0;
  // ……
}

// AIBot.ts — follow 分支
const targetX = px + this.slotOffset;
const dx = targetX - this.x;

if (Math.abs(dx) <= FOLLOW_SLOT_SETTLE_PX) {   // 25px
  this.vx = 0;
  // 保持当前朝向——别因为 dx 在零附近抖动而每帧翻 dir
  this.setAnimState("idle");
  return;
}
this.dir = dx > 0 ? 1 : dx < 0 ? -1 : this.dir;
// 仍然用 dist(playerFollowRange) 决定走 vs 跑
```

```typescript
// stores/animator.ts — spawnCharacter
const idx = bots.value.length;
const pair = Math.floor(idx / 2);
const sign = idx % 2 === 0 ? -1 : 1;
const slotOffset = sign * (pair + 1) * 60;   // -60, +60, -120, +120, …
```

为什么阈值是 25 px？软推每帧最多把 bot 推 `BOT_COLLIDE_MAX_RESOLVE = 10` px
出去，所以 25 px 的余量足够吞下一次偶然的推挤而不会被拖回 walk。一旦到
达，**不动 dir**——这是关键，先前每帧 `dir = dx >= 0 ? 1 : -1` 让 bot 在
dx 接近 0 的几帧里来回横跳。

### 尾队列：所有 follower 在 leader 同一侧，避免对穿

光是给每个 bot 一个独特 slot 还不够——一开始 slot 是 `-60, +60, -120, +120,
...`（左右交替），4 个 bot 在 leader 四周散开。结果是「A 往前走、B 往后走、
C 往前走、D 往后走」：一半 bot 的 slot 在 leader 左边、一半在右边，他们必
须**互相穿过 leader 的位置**才能到达自己的 slot。

更糟的是：在穿过 leader 的那段路上，软推的方向和 walk 方向会打架——
A 想往左、B 想往右，但都被推「远离对方」，也就是把 A 推得更右、B 推得更左，
每帧 walk 2.5 px、推 10 px，A 永远到不了 slot，整队被锁在 leader 周围。

修了两件事：

1. **slot 改成单边**——全部放在 leader 的 -X 侧（`-60, -120, -180, -240, ...`），
   bot 形成「尾巴」。所有 follower 都在 leader 的同一侧，从来不需要穿过
   leader 的位置就能到达自己的 slot。

   ```typescript
   // stores/animator.ts — spawnCharacter
   const idx = bots.value.length;
   const slotOffset = -(idx + 1) * 60;   // -60, -120, -180, -240, ...
   ```

2. **`handleCharacterCollisions` 加 walk-vs-push 检查**——即使 slot 是左右
   交替（或未来某个 bot 不得不从另一边绕过来），push 方向与本 bot 本 tick
   `vx` 方向相反时跳过 push，让两个 bot 能径直穿过去而不是被互相推回去。

   ```typescript
   // AIBot.ts — handleCharacterCollisions 内层循环
   const away = dx >= 0 ? 1 : -1;
   const push = Math.min(shortfall * BOT_COLLIDE_SOFTNESS, BOT_COLLIDE_MAX_RESOLVE);
   if (this.vx !== 0 && away !== Math.sign(this.vx)) continue;
   this.x += away * push;
   ```

`vx = 0` 的已 settle bot 不受这条规则影响，仍然可以被别的身体推开让出
personal space。

测试覆盖：`tests/test-ai-bot.mjs` 第 12、13 项——4 个 follower 在随机位置出
发都能收敛到各自 slot 并 idle、4 个 follower 从 leader 同侧的最坏位置出发也
能稳定停在正确 slot 上。

### 操控角色移动时 follower 也持续跟随

先前有个保护性的「stand down」逻辑：只要方向键被按住，整队 bot 都被设
`aiSuspended = true`，整帧 `runStateMachine` 提前返回 idle。结果是玩家在
跑、bot 全部钉在原地不动；玩家一松手，slot 早就飞到几百像素外，bot 才
开始「追」——视觉上是「走路时不动、停下才追」，既不自然也容易和尾队列的
settle 检查互相打架。

移除这套机制，靠**前面那条 leader 软推豁免**就够了：leader 不再被 bot
挤动，所以让 bot 继续跑 AI 不会把 leader 推歪。`aiSuspended` 字段也一并
删掉了。

```typescript
// stores/animator.ts — step() 内
const controlled = controlledEntity.value;
const controlledBotId =
  controlled !== null && controlled !== "kirby" ? controlled : null;
// （不再计算 standDown，不再设 bot.aiSuspended）

for (const bot of botList) {
  // …
  bot.manualDriven = driven;
  bot.manualDriveDir = playerDir;
  bot.aiStopped = !botEnabled.value;   // 只剩「面板 AI 总开关」
  // …
}
```

`AIBot.runStateMachine` 里原本的 `if (this.aiSuspended) return` 早返回分支也
删掉了——它现在是死代码。

测试覆盖：`tests/test-ai-bot.mjs` 第 14 项——leader 持续向右走 100 tick
（位移 +250 px），4 个 follower 不再卡在出生点；leader 停下后再走 300 tick，
4 个 follower 各自稳定在 `leader.x + slotOffset` 附近。

### 按类型生成角色

生成的角色各自持有类型、皮肤与动画数据，因此场上可以同时存在玩家、Kirby 与各色魔界人。

配套改动：

- `AIBot` 的 `animData` 改为**构造注入**，不再硬编码 import `kirby.json`；`getFrameCount` / `getLooping` 改为接收数据集参数
- `getBotRenderState()` 每帧带出 `characterType`、`mageSkin`、`sheetUrl`、`animations`、`scaleMultiplier`
- `SpriteRenderer` 增加 `sheetFor(url)` 缓存与 `drawCharacter(..., sheetOverride)`，让不同角色用各自的图集
- 紧边界缓存抽到 `src/engine/tightBox.ts`，key 含图集 URL，避免不同图集同坐标串号

### 默认不生成任何角色

启动时画布为空：在「角色生成」面板选好类型后点 ×1/×3/×5，玩家会作为同类型成员一并生成。

### 接管点击检测

使用角色中心 Y 坐标进行点击检测（而非脚底 Y）：

```typescript
// bot.y 是脚底 Y，centreY 是中心 Y
const centreY = bot.y - bot.h / 2;
if (
  mouseX >= bot.x - hitW &&
  mouseX <= bot.x + hitW &&
  mouseY >= centreY - hitH &&
  mouseY <= centreY + hitH
) { /* 命中 */ }
```

### 接管选择外发光

接管模式下鼠标悬停在角色上时，会绘制一圈粉色发光圆环。该圆环的位置与半径**根据当前精灵图段的紧边界（tight box）计算**，而非硬编码偏移：

```typescript
function frameScreenBox(frame, feetX, feetY, scale, flip, sheet, sheetKey) {
  // 按该角色**实际绘制所用**的图集测量，魔界人不会借用玩家的紧边界
  const tight = getFrameTightBox(sheet ?? null, frame, sheetKey);
  const halfW = (tight.bw * scale) / 2;
  const halfH = (tight.bh * scale) / 2;
  const offX = (flip ? frame.w - tight.bx - tight.bw/2 : tight.bx + tight.bw/2) - frame.w/2;
  const offY = tight.by + tight.bh/2 - frame.h;
  return {
    cx: feetX + offX * scale,
    cy: feetY + offY * scale,
    halfW, halfH,
  };
}
```

外发光半径 = `max(halfW, halfH) + 6`，始终贴合当前帧的实际像素范围。

- **玩家角色**：使用当前 `frame` + `characterScaleMultiplier`
- **Bot**：使用当前 `botFrame` + `characterScaleMultiplier = 1.0`（不受玩家角色影响）
