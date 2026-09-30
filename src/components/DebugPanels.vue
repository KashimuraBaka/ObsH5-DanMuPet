<template>
  <!-- ===== Right rail: the whole toolbar is debug-only, so a production run
       shows a clean edge instead of a strip of dead buttons ===== -->
  <div class="panel-rail" v-if="ui.isDebug">
    <button
      class="rail-btn"
      :class="{ active: ui.currentPage === 'animator' }"
      title="动画预览"
      @click="ui.setPage('animator')"
    >🎮</button>
    <button
      class="rail-btn"
      :class="{ active: ui.currentPage === 'extractor' }"
      title="精灵坐标"
      @click="ui.setPage('extractor')"
    >📍</button>
    <div class="rail-divider"></div>
    <button
      v-for="def in PANEL_DEFS"
      :key="`rail-${def.id}`"
      class="rail-btn"
      :class="{ active: panels.isOpen(def.id) }"
      :title="`${def.title}面板`"
      @click="panels.toggle(def.id)"
    >{{ railIcon(def.id) }}</button>
  </div>

  <!-- ===== Transparent debug overlay (animator page, debug only) ===== -->
  <div class="state-indicator" :class="animator.displayState || 'idle'" v-if="ui.isDebug && ui.currentPage === 'animator'">
    <div class="dbg-line">STATE&nbsp;&nbsp;{{ animator.displayStateLabel }} <span class="dbg-dim">[{{ animator.displayState || '-' }}]</span></div>
    <div class="dbg-line" v-if="animator.controlledEntity === 'kirby'">FRAME&nbsp;&nbsp;{{ animator.currentFrameInfo }}</div>
    <div class="dbg-line">IMAGE&nbsp;&nbsp;{{ animator.imageSize.width }}×{{ animator.imageSize.height }}<span class="dbg-dim">&nbsp;&nbsp;ANIMS {{ animator.animationCount }}&nbsp;&nbsp;SPEED {{ animator.globalSpeed }}x</span></div>
    <div class="dbg-line">SCALE&nbsp;&nbsp;{{ animator.scale }}x&nbsp;&nbsp;<span class="dbg-dim">{{ Math.round(animator.viewport.width) }}×{{ Math.round(animator.viewport.height) }}</span></div>
  </div>

  <!-- ===== Every floating panel, rendered from one registry ===== -->
  <template v-for="def in PANEL_DEFS" :key="def.id">
    <section
      v-if="ui.isDebug && def.page === ui.currentPage && panels.isOpen(def.id)"
      class="floating-panel"
      :class="[
        def.className,
        {
          collapsed: panels.panels[def.id].collapsed,
          dragging: dragId === def.id,
          resizing: resizeId === def.id
        }
      ]"
      :style="panelStyle(def.id)"
    >
      <!-- Drag handle: only the title, the collapse button and the close button live here -->
      <header class="floating-panel-header" @mousedown="startDrag($event, def)">
        <span class="floating-panel-title">{{ def.title }}</span>
        <div class="floating-panel-actions">
          <button
            class="panel-btn"
            :title="panels.panels[def.id].collapsed ? '展开' : '收缩'"
            @click="panels.toggleCollapsed(def.id)"
          >{{ panels.panels[def.id].collapsed ? '▤' : '▁' }}</button>
          <button class="panel-btn panel-close" title="关闭" @click="panels.close(def.id)">✕</button>
        </div>
      </header>

      <div class="floating-panel-body" v-show="!panels.panels[def.id].collapsed">
        <!-- ---------- Animation controls ---------- -->
        <template v-if="def.id === 'controls'">
          <div class="control-group control-group-states">
            <label>状态</label>
            <div class="state-btn-group">
              <button
                v-for="s in PANEL_STATES"
                :key="s"
                :class="['state-btn', { active: animator.displayState === s }]"
                @click="animator.state = s"
              >
                {{ STATE_LABELS[s] }}
              </button>
            </div>
          </div>
          <div class="control-group">
            <label>速度</label>
            <input
              type="range"
              v-model.number="animator.speed"
              min="0.1"
              max="3"
              step="0.1"
              class="speed-slider"
            />
            <span class="speed-value">{{ animator.speed.toFixed(1) }}x</span>
          </div>
          <div class="control-group">
            <label>缩放</label>
            <input
              type="range"
              v-model.number="animator.scale"
              min="1"
              max="25"
              step="1"
              class="speed-slider"
            />
            <span class="speed-value">{{ animator.scale }}x</span>
          </div>
          <div class="key-hints">
            <span>←/→ 移动</span>
            <span>C 跳跃</span>
            <span>X 攻击</span>
            <span>↓+X 滑锁</span>
          </div>
        </template>

        <!-- ---------- Frame editor with onion skin ---------- -->
        <template v-else-if="def.id === 'frameEditor'">
          <div class="editor-body">
            <!-- The editor pauses playback for as long as it is open; this is a
                 status readout, not a control. -->
            <div class="editor-status">
              <span class="editor-status-dot"></span>
              动画已暂停 · 关闭窗口恢复播放
            </div>
            <div class="editor-left">
              <div class="frame-info">
                <span class="frame-name">{{ animator.currentFrameData.name }}</span>
                <span class="frame-index">[{{ animator.frameIndex }}]</span>
              </div>

              <!-- Frame Properties -->
              <div class="frame-props">
                <div class="prop-row">
                  <label>X:</label>
                  <input type="number" v-model.number="animator.currentFrameData.x" step="1" class="prop-input" />
                </div>
                <div class="prop-row">
                  <label>Y:</label>
                  <input type="number" v-model.number="animator.currentFrameData.y" step="1" class="prop-input" />
                </div>
                <div class="prop-row">
                  <label>W:</label>
                  <input type="number" v-model.number="animator.currentFrameData.w" step="1" min="1" class="prop-input" />
                </div>
                <div class="prop-row">
                  <label>H:</label>
                  <input type="number" v-model.number="animator.currentFrameData.h" step="1" min="1" class="prop-input" />
                </div>
              </div>

              <!-- Frame Navigation -->
              <div class="frame-nav">
                <button @click="animator.prevFrame()" :disabled="animator.frameIndex <= 0">◀ 上一帧</button>
                <span>{{ animator.frameIndex + 1 }} / {{ animator.currentAnim.frames.length }}</span>
                <button @click="animator.nextFrame()" :disabled="animator.frameIndex >= animator.currentAnim.frames.length - 1">下一帧 ▶</button>
              </div>

              <!-- Onion skin controls + JSON output side by side -->
              <div class="editor-row">
                <div class="onion-section">
                  <h5>🧅 洋葱皮预览</h5>
                  <div class="onion-options">
                    <div class="onion-option">
                      <label>模式:</label>
                      <select v-model="animator.onionMode" class="onion-select">
                        <option value="none">无</option>
                        <option value="prev">仅上一帧 (绿)</option>
                        <option value="next">仅下一帧 (红)</option>
                        <option value="both">前后帧 (绿+红)</option>
                      </select>
                    </div>
                    <div class="onion-option">
                      <label>透明度:</label>
                      <input type="range" v-model.number="animator.onionOpacity" min="0.1" max="0.8" step="0.1" class="onion-slider" />
                      <span>{{ (animator.onionOpacity * 100).toFixed(0) }}%</span>
                    </div>
                    <div class="onion-option">
                      <label>距离:</label>
                      <input type="number" v-model.number="animator.onionOffset" min="0" max="50" step="1" class="onion-input" />
                      <span>px</span>
                    </div>
                  </div>
                </div>

                <!-- Read-only JSON output (animations.json format) -->
                <div class="editor-json">
                  <div class="json-header">
                    <h5>📋 {{ animator.state }} 动画 JSON</h5>
                    <button class="json-copy-btn" @click="animator.copyAnimationJson()">复制 JSON</button>
                  </div>
                  <pre class="json-output">{{ animator.animationJson }}</pre>
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- ---------- Physics debug ---------- -->
        <template v-else-if="def.id === 'physics'">
          <div class="phys-body">
            <div class="phys-btns">
              <button class="phys-btn phys-btn-primary" @click="animator.spawnGravityBlocks(animator.spawnCount)">➕ 创建 ×{{ animator.spawnCount }}</button>
              <input
                type="number"
                v-model.number="animator.spawnCount"
                min="1"
                max="200"
                class="phys-count"
                title="每次创建的数量"
              />
              <button class="phys-btn" @click="animator.clearBlocks()">🗑 清空</button>
            </div>

            <div class="phys-stats">
              <div class="phys-stat">
                <span>活动方块</span><b>{{ animator.stats.blocks }}</b>
              </div>
              <div class="phys-stat">
                <span>地面砖块</span><b>{{ animator.stats.ground }}</b>
              </div>
              <div class="phys-stat">
                <span>着地状态</span><b :class="{ 'phys-air': !animator.stats.onGround }">{{ animator.stats.onGround ? '着地' : '空中' }}</b>
              </div>
              <div class="phys-stat">
                <span>像素碰撞盒</span><b>{{ animator.charBoxLabel }}</b>
              </div>
              <div class="phys-stat">
                <span>吸入范围</span><b>{{ animator.inhaleRangeLabel }}</b>
              </div>
            </div>

            <p class="phys-hint">
              按 <kbd>X</kbd> 吸入：方块先缓慢靠近，再被快速吸入口中并播放吞下动画
            </p>
          </div>
        </template>

        <!-- ---------- Monster generation ---------- -->
        <template v-else-if="def.id === 'monsterGen'">
          <div class="gen-body">
            <div class="gen-section">
              <h5>随机生成</h5>
              <div class="gen-btns">
                <button class="gen-btn gen-btn-primary" @click="animator.spawnEnemy()">👾 ×1</button>
                <button class="gen-btn" @click="animator.spawnEnemies(3)">👾 ×3</button>
                <button class="gen-btn" @click="animator.spawnEnemies(5)">👾 ×5</button>
              </div>
            </div>

            <div class="gen-section">
              <h5>指定类型</h5>
              <div class="gen-type-row">
                <button class="gen-type-btn" @click="animator.spawnEnemyOfType('walker')">🔴 Walker</button>
                <button class="gen-type-btn" @click="animator.spawnEnemyOfType('flyer')">🔵 Flyer</button>
                <button class="gen-type-btn" @click="animator.spawnEnemyOfType('jumper')">🟢 Jumper</button>
              </div>
              <div class="gen-count-row">
                <input
                  type="number"
                  v-model.number="monsterGenCount"
                  min="1"
                  max="20"
                  class="gen-count"
                  title="批量生成数量"
                />
                <button class="gen-btn" @click="animator.spawnEnemiesOfType(monsterGenCount, monsterGenType)">生成 ×{{ monsterGenCount }}</button>
                <select v-model="monsterGenType" class="gen-type-select">
                  <option value="walker">Walker</option>
                  <option value="flyer">Flyer</option>
                  <option value="jumper">Jumper</option>
                </select>
              </div>
            </div>

            <div class="gen-section">
              <h5>管理</h5>
              <div class="gen-btns">
                <button class="gen-btn" @click="animator.clearEnemies()">🗑 清除全部</button>
              </div>
            </div>

            <div class="gen-stats">
              <div class="gen-stat">
                <span>怪物数量</span><b>{{ animator.enemies.length }}</b>
              </div>
              <div class="gen-stat">
                <span>上限</span><b>15</b>
              </div>
            </div>

            <p class="gen-hint">
              怪物会自动巡逻，接近 Kirby 时追猎
            </p>
          </div>
        </template>

        <!-- ---------- Bot generation ---------- -->
        <template v-else-if="def.id === 'botGen'">
          <div class="gen-body">
            <div class="gen-section">
              <h5>生成角色</h5>
              <div class="gen-btns">
                <button class="gen-btn gen-btn-primary" @click="animator.spawnKirby()">🤖 ×1</button>
                <button class="gen-btn" @click="animator.spawnCharacters(3)">🤖 ×3</button>
                <button class="gen-btn" @click="animator.spawnCharacters(5)">🤖 ×5</button>
              </div>
            </div>

            <div class="gen-section">
              <h5>AI 控制</h5>
              <div class="gen-btns">
                <button class="gen-btn" :class="{ 'gen-active': animator.botEnabled }" @click="animator.toggleBot()">
                  {{ animator.botEnabled ? '⏸ 暂停 AI' : '▶ 启动 AI' }}
                </button>
              </div>
            </div>

            <div class="gen-section">
              <h5>接管角色</h5>
              <div class="gen-btns">
                <button class="gen-btn" :class="{ 'gen-active': animator.takeoverMode }" @click="animator.toggleTakeoverMode()">
                  🎮 选择模式
                </button>
              </div>
              <div class="gen-controlled">
                <span>当前控制：</span>
                <b v-if="animator.controlledEntity === 'kirby'">Kirby</b>
                <b v-else-if="animator.controlledEntity !== null">Bot #{{ animator.controlledEntity }}</b>
                <span v-else class="gen-dim">无</span>
              </div>
            </div>

            <div class="gen-section">
              <h5>管理</h5>
              <div class="gen-btns">
                <button class="gen-btn" @click="animator.clearBots()">🗑 清除全部 Bot</button>
              </div>
            </div>

            <div class="gen-stats">
              <div class="gen-stat">
                <span>Bot 数量</span><b>{{ animator.bots.length }}</b>
              </div>
              <div class="gen-stat">
                <span>AI 状态</span><b :class="{ 'gen-active': animator.botEnabled }">{{ animator.botEnabled ? '运行中' : '已暂停' }}</b>
              </div>
            </div>

            <p class="gen-hint">
              Bot 使用 Kirby 动画，点击画面中的 Bot 可接管控制
            </p>
          </div>
        </template>
      </div>

      <!-- Resize handles: 4 edges + 4 corners. Hidden while collapsed so the
           header-only panel can never grow an empty box under its title bar. -->
      <template v-if="!panels.panels[def.id].collapsed">
        <div class="rs rs-n"  @mousedown.stop="startResize('n',  $event, def)"></div>
        <div class="rs rs-s"  @mousedown.stop="startResize('s',  $event, def)"></div>
        <div class="rs rs-w"  @mousedown.stop="startResize('w',  $event, def)"></div>
        <div class="rs rs-e"  @mousedown.stop="startResize('e',  $event, def)"></div>
        <div class="rs rs-nw" @mousedown.stop="startResize('nw', $event, def)"></div>
        <div class="rs rs-ne" @mousedown.stop="startResize('ne', $event, def)"></div>
        <div class="rs rs-sw" @mousedown.stop="startResize('sw', $event, def)"></div>
        <div class="rs rs-se" @mousedown.stop="startResize('se', $event, def)"></div>
      </template>
    </section>
  </template>

  <!-- Copy feedback (frame editor JSON) -->
  <div class="copy-feedback" v-if="animator.showCopyFeedback">
    <span>✅ 已复制到剪贴板!</span>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, type CSSProperties } from 'vue'
import {
  PANEL_STATES,
  PANEL_DEFS,
  STATE_LABELS,
  useAnimatorStore,
  usePanelStore,
  useUiStore,
  type PanelDefinition,
  type PanelId,
  type ResizeDirection
} from '../stores'

const ui = useUiStore()
const panels = usePanelStore()
const animator = useAnimatorStore()

/** Panel geometry, typed for Vue's :style binding. */
function panelStyle(id: PanelId): CSSProperties {
  return panels.styleFor(id) as CSSProperties
}

/** Which panel is being dragged / resized right now (drives the CSS state). */
const dragId = ref<PanelId | null>(null)
const resizeId = ref<PanelId | null>(null)

const RAIL_ICONS: Record<PanelId, string> = {
  controls: '🎛️',
  frameEditor: '📐',
  physics: '🧱',
  monsterGen: '👾',
  botGen: '🤖'
}

function railIcon(id: PanelId): string {
  return RAIL_ICONS[id]
}

// ---- Monster generation panel state ----
const monsterGenCount = ref(1)
const monsterGenType = ref<'walker' | 'flyer' | 'jumper'>('walker')

// ============================================================
//  Panel drag / resize
//
//  Geometry is written straight into the panel store, so a panel keeps the
//  place and size the user gave it across open/close and page switches.
// ============================================================

interface DragSession {
  id: PanelId
  startX: number
  startY: number
  startLeft: number
  startTop: number
  startWidth: number
  startHeight: number
}

interface ResizeSession {
  id: PanelId
  dir: ResizeDirection
  startX: number
  startY: number
  startWidth: number
  startHeight: number
  startLeft: number
  startTop: number
  minWidth: number
  minHeight: number
}

/** Breathing room kept between a maximised panel and the viewport edge. */
const RESIZE_EDGE = 8

let drag: DragSession | null = null
let resize: ResizeSession | null = null

/** The panel element an event happened inside. */
function panelElement(e: MouseEvent): HTMLElement | null {
  const target = e.currentTarget as HTMLElement | null
  return (target && target.closest('.floating-panel')) as HTMLElement | null
}

function startDrag(e: MouseEvent, def: PanelDefinition): void {
  if (e.button !== 0) return
  // Never start a drag from an interactive control inside the handle
  if (e.target instanceof Element &&
      e.target.closest('button, input, select, textarea, label, a')) return

  const el = panelElement(e)
  if (!el) return

  const rect = el.getBoundingClientRect()
  drag = {
    id: def.id,
    startX: e.clientX,
    startY: e.clientY,
    startLeft: rect.left,
    startTop: rect.top,
    startWidth: rect.width,
    startHeight: rect.height
  }
  dragId.value = def.id

  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
  e.preventDefault()
}

function onDragMove(e: MouseEvent): void {
  if (!drag) return

  const dx = e.clientX - drag.startX
  const dy = e.clientY - drag.startY
  const maxLeft = Math.max(0, window.innerWidth - drag.startWidth)
  const maxTop = Math.max(0, window.innerHeight - drag.startHeight)
  const left = Math.min(Math.max(0, drag.startLeft + dx), maxLeft)
  const top = Math.min(Math.max(0, drag.startTop + dy), maxTop)

  // Switch positioning to explicit left/top and freeze the current height.
  // An explicit width (set by a previous resize) has to survive the move.
  const current = panels.panels[drag.id].style
  panels.patchStyle(drag.id, {
    left: `${left}px`,
    top: `${top}px`,
    right: 'auto',
    bottom: 'auto',
    height: `${drag.startHeight}px`,
    ...(current.width ? { width: current.width } : {})
  })
}

function onDragEnd(): void {
  drag = null
  dragId.value = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
}

function startResize(dir: ResizeDirection, e: MouseEvent, def: PanelDefinition): void {
  if (e.button !== 0) return
  // Resizing must never also start a panel move
  e.preventDefault()
  e.stopPropagation()

  const el = panelElement(e)
  if (!el) return

  const rect = el.getBoundingClientRect()
  resize = {
    id: def.id,
    dir,
    startX: e.clientX,
    startY: e.clientY,
    startWidth: rect.width,
    startHeight: rect.height,
    startLeft: rect.left,
    startTop: rect.top,
    minWidth: def.minWidth,
    minHeight: def.minHeight
  }
  resizeId.value = def.id

  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup', onResizeEnd)
}

function onResizeMove(e: MouseEvent): void {
  if (!resize) return

  const dx = e.clientX - resize.startX
  const dy = e.clientY - resize.startY

  let w = resize.startWidth
  let h = resize.startHeight
  let left = resize.startLeft
  let top = resize.startTop

  // Growing right/down just adds to the size
  if (resize.dir.includes('e')) w = resize.startWidth + dx
  if (resize.dir.includes('s')) h = resize.startHeight + dy
  // Growing left/up also moves the origin so the opposite edge stays put
  if (resize.dir.includes('w')) {
    w = resize.startWidth - dx
    left = resize.startLeft + dx
  }
  if (resize.dir.includes('n')) {
    h = resize.startHeight - dy
    top = resize.startTop + dy
  }

  // Enforce the minimum, compensating the origin so the dragged edge follows
  // the pointer instead of the fixed edge winning.
  if (w < resize.minWidth) {
    if (resize.dir.includes('w')) left -= resize.minWidth - w
    w = resize.minWidth
  }
  if (h < resize.minHeight) {
    if (resize.dir.includes('n')) top -= resize.minHeight - h
    h = resize.minHeight
  }

  // Never exceed the viewport, and never let the panel escape it
  w = Math.min(w, window.innerWidth - RESIZE_EDGE)
  h = Math.min(h, window.innerHeight - RESIZE_EDGE)
  left = Math.min(Math.max(RESIZE_EDGE / 2, left), window.innerWidth - w - RESIZE_EDGE / 2)
  top = Math.min(Math.max(RESIZE_EDGE / 2, top), window.innerHeight - h - RESIZE_EDGE / 2)

  panels.patchStyle(resize.id, {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${Math.round(w)}px`,
    height: `${Math.round(h)}px`
  })
}

function onResizeEnd(): void {
  resize = null
  resizeId.value = null
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', onResizeEnd)
}

onUnmounted(() => {
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', onResizeEnd)
})
</script>

<style scoped>
/* ============================================================
   Right rail: toggle buttons that open/close each floating panel
   ============================================================ */
.panel-rail,
.rail-btn,
.rail-divider {
  box-sizing: border-box;
}

.panel-rail {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: var(--panel-w, 48px);
  padding: 12px 0;
  background: rgba(20, 20, 35, 0.82);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-left: 1px solid rgba(255, 105, 180, 0.3);
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.45);
  overflow-y: auto;
  scrollbar-color: rgba(255, 105, 180, 0.5) transparent;
}

.rail-btn {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  color: #aaa;
  cursor: pointer;
  font-size: 0.95em;
  line-height: 1;
  transition: all 0.2s;
}

.rail-btn:hover {
  background: rgba(255, 105, 180, 0.2);
  border-color: rgba(255, 105, 180, 0.4);
  color: #fff;
}

.rail-btn.active {
  background: rgba(255, 105, 180, 0.32);
  border-color: #ff69b4;
  color: #fff;
  box-shadow: 0 0 10px rgba(255, 105, 180, 0.35);
}

.rail-divider {
  width: 24px;
  height: 1px;
  flex-shrink: 0;
  margin: 4px 0;
  background: rgba(255, 255, 255, 0.14);
}

/* ============================================================
   Reusable floating panel chrome
   ============================================================ */
.floating-panel {
  position: fixed;
  z-index: 40;
  display: flex;
  flex-direction: column;
  min-width: 160px;
  /* Scrollbar width, shared by the ::-webkit-scrollbar rules and the padding
     compensation below so the two never drift apart. */
  --sb-w: 6px;
  /* Cap the panel by the space that is actually left beside / below its own
     docking offset (published as --panel-left / --panel-top). A plain
     `100vh - 24px` cap would still let a panel docked at top:380px run off the
     bottom of a short window, and one docked at left:640px hide behind the
     rail on a narrow one. Both caps re-evaluate on every window resize. */
  max-width: calc(100vw - var(--panel-left, 16px) - var(--panel-w, 48px) - 16px);
  max-height: calc(100vh - var(--panel-top, 16px) - 16px);
  background: rgba(20, 20, 35, 0.82);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 105, 180, 0.3);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.floating-panel.dragging,
.floating-panel.resizing {
  transition: none;
  user-select: none;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
}

/* Resize handles: 4 edges + 4 corners.
   Invisible hit zones that fade in on hover so the panel stays clean at rest. */
.rs {
  position: absolute;
  z-index: 5;
  opacity: 0;
  transition: opacity 0.15s;
}

.floating-panel:hover .rs,
.floating-panel.resizing .rs {
  opacity: 1;
}

/* Edges */
.rs-n { top: 0; left: 10px; right: 10px; height: 5px; cursor: ns-resize; }
.rs-s { bottom: 0; left: 10px; right: 10px; height: 5px; cursor: ns-resize; }
.rs-w { left: 0; top: 10px; bottom: 10px; width: 5px; cursor: ew-resize; }
.rs-e { right: 0; top: 10px; bottom: 10px; width: 5px; cursor: ew-resize; }

/* Corners */
.rs-nw { top: 0; left: 0; width: 12px; height: 12px; cursor: nwse-resize; }
.rs-ne { top: 0; right: 0; width: 12px; height: 12px; cursor: nesw-resize; }
.rs-sw { bottom: 0; left: 0; width: 12px; height: 12px; cursor: nesw-resize; }
.rs-se { bottom: 0; right: 0; width: 12px; height: 12px; cursor: nwse-resize; }

/* The bottom-right corner carries a visible grip so resizing is discoverable */
.rs-se::after {
  content: '';
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 7px;
  height: 7px;
  border-right: 2px solid rgba(255, 105, 180, 0.75);
  border-bottom: 2px solid rgba(255, 105, 180, 0.75);
}

.floating-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 10px 9px 14px;
  background: rgba(255, 105, 180, 0.14);
  border-bottom: 1px solid rgba(255, 105, 180, 0.25);
  user-select: none;
  flex-shrink: 0;
  cursor: grab;
}

.floating-panel-header:active {
  cursor: grabbing;
}

.floating-panel.collapsed .floating-panel-header {
  border-bottom: none;
}

.floating-panel-title {
  color: #ff69b4;
  font-size: 0.8em;
  font-weight: bold;
  white-space: nowrap;
}

.floating-panel-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.panel-btn {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  color: #aaa;
  cursor: pointer;
  font-size: 0.7em;
  line-height: 1;
  transition: all 0.2s;
}

.panel-btn:hover {
  background: rgba(255, 105, 180, 0.25);
  border-color: rgba(255, 105, 180, 0.4);
  color: #fff;
}

.panel-close:hover {
  background: rgba(255, 80, 80, 0.3);
  border-color: #ff5050;
  color: #fff;
}

.floating-panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* The scrollbar sits inside the right padding instead of next to it, and the
     right padding is reduced by exactly its width - so the two sides stay
     visually equal and the content width never changes when it appears. */
  padding: 12px calc(14px - var(--sb-w, 6px)) 12px 14px;
  /* Column flex so a panel's own content can stretch into whatever height is
     left over, instead of always hugging its content. */
  display: flex;
  flex-direction: column;
  /* Reserve the gutter whether or not the content overflows, so nothing
     reflows when a panel starts or stops scrolling. */
  scrollbar-gutter: stable;
  scrollbar-color: rgba(255, 105, 180, 0.5) transparent;
}

/* ============================================================
   Thin, themed scrollbars
   The browser default (~15px on Windows) eats a real slice of panel width, so
   every scroll container in the panels gets a thin bar instead, and the
   padding is reduced by the same amount so the scrollbar lives *inside* the
   padding rather than stealing content width.
   ============================================================ */
.floating-panel-body,
.json-output,
.panel-rail {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 105, 180, 0.45) transparent;
}

.floating-panel-body::-webkit-scrollbar,
.json-output::-webkit-scrollbar,
.panel-rail::-webkit-scrollbar {
  width: var(--sb-w, 6px);
  height: var(--sb-w, 6px);
}

.floating-panel-body::-webkit-scrollbar-track,
.json-output::-webkit-scrollbar-track,
.panel-rail::-webkit-scrollbar-track {
  background: transparent;
}

.floating-panel-body::-webkit-scrollbar-thumb,
.json-output::-webkit-scrollbar-thumb,
.panel-rail::-webkit-scrollbar-thumb {
  background: rgba(255, 105, 180, 0.4);
  border-radius: 3px;
}

.floating-panel-body::-webkit-scrollbar-thumb:hover,
.json-output::-webkit-scrollbar-thumb:hover,
.panel-rail::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 105, 180, 0.7);
}

.floating-panel-body::-webkit-scrollbar-corner,
.json-output::-webkit-scrollbar-corner {
  background: transparent;
}

/* Per-panel widths (the panel chrome itself is shared) */
.frame-editor-panel {
  width: min(560px, calc(100vw - var(--panel-w, 48px) - 32px));
}

.physics-panel {
  width: min(260px, calc(100vw - var(--panel-w, 48px) - 32px));
}

/* ============================================================
   Transparent debug overlay - top left, like a game debug text
   ============================================================ */
.state-indicator {
  position: fixed;
  top: 14px;
  left: 16px;
  z-index: 20;
  font-size: 0.8em;
  font-weight: bold;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  line-height: 1.6;
  color: #fff;
  text-shadow:
    -1px -1px 0 rgba(0, 0, 0, 0.85),
    1px -1px 0 rgba(0, 0, 0, 0.85),
    -1px 1px 0 rgba(0, 0, 0, 0.85),
    1px 1px 0 rgba(0, 0, 0, 0.85),
    0 0 8px rgba(0, 0, 0, 0.7);
  background: transparent;
  border: none;
  padding: 0;
  transition: all 0.3s;
  pointer-events: none;
}

.dbg-line {
  white-space: nowrap;
}

.dbg-dim {
  color: rgba(255, 255, 255, 0.55);
  font-weight: normal;
}

/* Per-state text colors for the transparent debug overlay */
.state-indicator.idle { color: #6c6; }
.state-indicator.crouch { color: #99f; }
.state-indicator.walk { color: #8af; }
.state-indicator.run { color: #fa6; }
.state-indicator.jump { color: #fc6; }
.state-indicator.attack { color: #f66; }
.state-indicator.holdEnemy { color: #fb8; }
.state-indicator.swallow { color: #f96; }
.state-indicator.walkWithEnemy { color: #8fd; }
.state-indicator.phone { color: #fd8; }
.state-indicator.slide { color: #f8f; }
.state-indicator.jumpWithEnemy { color: #9df; }

/* ============================================================
   Animation controls panel
   ============================================================ */
.control-group {
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.control-group:last-of-type {
  margin-bottom: 0;
}

/* State group: label aligns with the first button row */
.control-group-states {
  align-items: flex-start;
}

.control-group label {
  min-width: 34px;
  flex-shrink: 0;
  color: #aaa;
  font-size: 0.8em;
}

.control-group-states label {
  padding-top: 8px;
}

/* State button grid: auto-wrap inside the side panel */
.state-btn-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.state-btn {
  padding: 6px 10px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  color: #fff;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.3s;
  font-size: 0.78em;
  white-space: nowrap;
}

.state-btn:hover {
  background: rgba(255, 105, 180, 0.2);
  border-color: #ff69b4;
}

.state-btn.active {
  background: rgba(255, 105, 180, 0.3);
  border-color: #ff69b4;
  box-shadow: 0 0 10px rgba(255, 105, 180, 0.3);
}

.speed-slider {
  flex: 1;
  min-width: 0;
  height: 6px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  outline: none;
}

.speed-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  background: #ff69b4;
  border-radius: 50%;
  cursor: pointer;
}

.speed-value {
  min-width: 36px;
  text-align: right;
  color: #ff69b4;
  font-weight: bold;
  font-size: 0.78em;
}

/* Key hints inside the panel */
.key-hints {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.key-hints span {
  padding: 3px 7px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  color: #888;
  font-size: 0.7em;
  white-space: nowrap;
}

/* ============================================================
   Frame editor panel
   ============================================================ */
/* Paused status readout at the top of the frame editor body */
.editor-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  color: #ffb84d;
  font-size: 0.75em;
  white-space: nowrap;
}

.editor-status-dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #ffb84d;
  box-shadow: 0 0 6px rgba(255, 184, 77, 0.8);
}

/* Editing row: onion skin controls (left) + JSON output (right) side by side.
   Sized by its content - no height / min-height forcing, so the bottom
   controls never grow into empty space on their own. */
.editor-row {
  display: grid;
  grid-template-columns: minmax(200px, 1fr) minmax(240px, 1.3fr);
  gap: 15px;
  align-items: stretch;
  margin-top: 12px;
}

.frame-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding: 8px 12px;
  background: rgba(255, 105, 180, 0.1);
  border-radius: 6px;
}

.frame-name {
  color: #fff;
  font-weight: bold;
  font-size: 0.95em;
}

.frame-index {
  color: #ff69b4;
  font-size: 0.9em;
}

.frame-props {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 12px;
}

.prop-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.prop-row label {
  color: #aaa;
  font-size: 0.8em;
  font-weight: bold;
}

.prop-input {
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  color: #fff;
  font-size: 0.9em;
  width: 100%;
  box-sizing: border-box;
}

.prop-input:focus {
  outline: none;
  border-color: #ff69b4;
}

.frame-nav {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 15px;
  margin-bottom: 12px;
}

.frame-nav button {
  padding: 6px 14px;
  background: rgba(255, 105, 180, 0.2);
  border: 1px solid rgba(255, 105, 180, 0.3);
  border-radius: 4px;
  color: #fff;
  cursor: pointer;
  font-size: 0.85em;
  transition: all 0.2s;
}

.frame-nav button:hover:not(:disabled) {
  background: rgba(255, 105, 180, 0.3);
}

.frame-nav button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.frame-nav span {
  color: #aaa;
  font-size: 0.9em;
  min-width: 60px;
  text-align: center;
}

.onion-section {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 12px;
  background: rgba(0, 255, 0, 0.05);
  border: 1px solid rgba(0, 255, 0, 0.2);
  border-radius: 6px;
}

.onion-section h5 {
  margin: 0 0 10px 0;
  color: #00ff00;
  font-size: 0.9em;
}

.onion-options {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 8px;
  flex: 1;
  min-height: 0;
}

.onion-option {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8em;
  color: #aaa;
}

.onion-option label {
  min-width: 50px;
}

.onion-slider {
  width: 80px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  outline: none;
}

.onion-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  background: #00ff00;
  border-radius: 50%;
  cursor: pointer;
}

.onion-select {
  padding: 4px 8px;
  background: rgba(255, 105, 180, 0.15);
  border: 1px solid rgba(255, 105, 180, 0.3);
  border-radius: 4px;
  color: #fff;
  font-size: 0.8em;
  cursor: pointer;
  color-scheme: dark;
}

/* Explicit dark styling so options are readable in the native popup */
.onion-select option {
  background: #1e1e32;
  color: #fff;
}

.onion-select:hover {
  border-color: #ff69b4;
}

.onion-select:focus {
  outline: none;
  border-color: #ff69b4;
}

.onion-input {
  width: 50px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  color: #fff;
  font-size: 0.8em;
  box-sizing: border-box;
}

.onion-input:focus {
  outline: none;
  border-color: #00ff00;
}

/* JSON output panel */
.editor-json {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  box-sizing: border-box;
  padding: 12px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 105, 180, 0.25);
  border-radius: 6px;
}

.json-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.json-header h5 {
  margin: 0;
  color: #ff69b4;
  font-size: 0.9em;
}

.json-copy-btn {
  padding: 4px 12px;
  background: rgba(0, 200, 0, 0.2);
  border: 1px solid rgba(0, 200, 0, 0.3);
  border-radius: 4px;
  color: #fff;
  cursor: pointer;
  font-size: 0.8em;
  transition: all 0.2s;
  white-space: nowrap;
}

.json-copy-btn:hover {
  background: rgba(0, 200, 0, 0.3);
  border-color: #00cc00;
}

/* Read-only JSON text, animations.json format */
.json-output {
  margin: 0;
  flex: 1;
  /* Same scrollbar-in-padding compensation as the panel body, so its own
     scrollbars never make the text look off-centre either. */
  padding: 12px calc(12px - var(--sb-w, 6px)) 12px 12px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  color: #e0e0e0;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 0.8em;
  line-height: 1.5;
  white-space: pre;
  overflow: auto;
  max-height: 420px;
  user-select: text;
  -webkit-user-select: text;
  scrollbar-gutter: stable;
  scrollbar-color: rgba(255, 105, 180, 0.5) transparent;
}

/* Narrow screens: stack the editor columns and widen the floating panel */
@media (max-width: 800px) {
  .editor-row {
    grid-template-columns: 1fr;
  }
  .frame-editor-panel {
    left: 8px;
    width: calc(100vw - var(--panel-w, 48px) - 16px);
    max-height: 55vh;
  }
  .state-indicator {
    font-size: 0.72em;
  }
}

/* ============================================================
   Physics debug panel
   ============================================================ */
/* Physics debug panel: buttons on top, stats filling the middle, hint at the
   bottom - so the middle block adapts to whatever height the panel has. */
.phys-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
}

.phys-btns {
  display: flex;
  gap: 8px;
}

.phys-btn {
  flex: 1;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  font-size: 0.78em;
  white-space: nowrap;
  transition: all 0.15s;
}

.phys-btn:hover {
  background: rgba(255, 105, 180, 0.22);
  border-color: rgba(255, 105, 180, 0.45);
}

.phys-btn-primary {
  background: rgba(255, 105, 180, 0.24);
  border-color: rgba(255, 105, 180, 0.45);
}

.phys-btn-primary:hover {
  background: rgba(255, 105, 180, 0.38);
}

/* Quantity input beside the spawn button (quick batch generation) */
.phys-count {
  width: 48px;
  flex-shrink: 0;
  padding: 8px 6px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  color: #fff;
  font-size: 0.78em;
  text-align: center;
}

.phys-count:focus {
  outline: none;
  border-color: #ff69b4;
}

.phys-stats {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  /* Take the leftover height and centre the rows in it. No min-height:0, so a
     short window scrolls the panel body instead of squeezing the rows. */
  flex: 1;
  justify-content: center;
}

.phys-stat {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  font-size: 0.72em;
  color: #999;
}

.phys-stat b {
  color: #fff;
  font-weight: bold;
}

.phys-stat .phys-air {
  color: #ffb84d;
}

.phys-hint {
  margin: 0;
  font-size: 0.68em;
  line-height: 1.5;
  color: #888;
}

.phys-hint kbd {
  padding: 1px 5px;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  color: #ff69b4;
  font-family: monospace;
  font-size: 0.95em;
}

/* ============================================================
    Monster / Bot generation panels
    ============================================================ */
.monster-gen-panel,
.bot-gen-panel {
  width: min(260px, calc(100vw - var(--panel-w, 48px) - 32px));
}

.gen-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
}

.gen-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gen-section h5 {
  margin: 0 0 2px 0;
  color: #ff69b4;
  font-size: 0.78em;
}

.gen-btns {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.gen-btn {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  font-size: 0.72em;
  white-space: nowrap;
  transition: all 0.15s;
  text-align: center;
}

.gen-btn:hover {
  background: rgba(255, 105, 180, 0.22);
  border-color: rgba(255, 105, 180, 0.45);
}

.gen-btn-primary {
  background: rgba(255, 105, 180, 0.24);
  border-color: rgba(255, 105, 180, 0.45);
}

.gen-btn-primary:hover {
  background: rgba(255, 105, 180, 0.38);
}

.gen-btn.gen-active {
  background: rgba(100, 200, 100, 0.3);
  border-color: rgba(100, 200, 100, 0.6);
  color: #fff;
}

.gen-type-row {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.gen-type-btn {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  font-size: 0.68em;
  white-space: nowrap;
  transition: all 0.15s;
  text-align: center;
}

.gen-type-btn:hover {
  background: rgba(255, 105, 180, 0.22);
  border-color: rgba(255, 105, 180, 0.45);
}

.gen-count-row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 4px;
}

.gen-count {
  width: 48px;
  flex-shrink: 0;
  padding: 6px 6px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  color: #fff;
  font-size: 0.72em;
  text-align: center;
}

.gen-count:focus {
  outline: none;
  border-color: #ff69b4;
}

.gen-type-select {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  background: rgba(255, 105, 180, 0.15);
  border: 1px solid rgba(255, 105, 180, 0.3);
  border-radius: 6px;
  color: #fff;
  font-size: 0.72em;
  cursor: pointer;
  color-scheme: dark;
}

.gen-type-select option {
  background: #1e1e32;
  color: #fff;
}

.gen-controlled {
  padding: 6px 8px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  font-size: 0.72em;
  color: #aaa;
  margin-top: 4px;
}

.gen-controlled b {
  color: #ff69b4;
}

.gen-dim {
  color: #666;
}

.gen-stats {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
}

.gen-stat {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  font-size: 0.72em;
  color: #999;
}

.gen-stat b {
  color: #fff;
  font-weight: bold;
}

.gen-stat b.gen-active {
  color: #6c6;
}

.gen-hint {
  margin: 0;
  font-size: 0.68em;
  line-height: 1.5;
  color: #888;
}

.gen-hint kbd {
  padding: 1px 5px;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  color: #ff69b4;
  font-family: monospace;
  font-size: 0.95em;
}

/* ============================================================
   Copy feedback toast
   ============================================================ */
.copy-feedback {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  padding: 12px 24px;
  background: rgba(0, 200, 0, 0.9);
  color: #fff;
  border-radius: 8px;
  font-weight: bold;
  z-index: 1000;
  animation: fadeInOut 2s ease-out;
}

@keyframes fadeInOut {
  0% { opacity: 0; transform: translateX(-50%) translateY(20px); }
  20% { opacity: 1; transform: translateX(-50%) translateY(0); }
  80% { opacity: 1; transform: translateX(-50%) translateY(0); }
  100% { opacity: 0; transform: translateX(-50%) translateY(0); }
}
</style>
