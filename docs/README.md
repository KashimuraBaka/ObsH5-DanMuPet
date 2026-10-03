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

### Bot 接管点击检测

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
