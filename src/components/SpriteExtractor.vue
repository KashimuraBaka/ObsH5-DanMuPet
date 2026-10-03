<template>
  <div class="extractor-container">
    <!-- Toolbar strip (not a floating window): tools + coordinates + status, top-left.
         Debug control panel - only shown with ?debug=true -->
    <div class="extractor-toolbar" v-if="isDebug">
      <div class="tb-group">
        <button class="palette-btn" title="打开本地图片" @click="triggerFileInput">📂</button>
        <button class="palette-btn" title="加载 Kirby.png" @click="loadKirbyImage">🌸</button>
      </div>

      <div class="tb-sep"></div>

      <div class="tb-group">
        <button class="palette-btn" title="复制坐标" :disabled="!hasSelection" @click="copyCoords">📋</button>
      </div>

      <div class="tb-sep"></div>

      <div class="tb-group">
        <button class="palette-btn" title="缩小画布" @click="zoomOut" :disabled="zoom <= MIN_ZOOM">➖</button>
        <span class="tb-zoom">{{ (zoom * 100).toFixed(0) }}%</span>
        <button class="palette-btn" title="放大画布" @click="zoomIn" :disabled="zoom >= MAX_ZOOM">➕</button>
      </div>

      <div class="tb-sep"></div>

      <div class="tb-group coord-group">
        <div class="info-item" v-if="hasSelection">
          <span class="info-label">X:</span>
          <input type="number" v-model.number="selectionModel.selection.x" class="coord-input" @input="updateSelectionFromInput" />
        </div>
        <div class="info-item" v-if="hasSelection">
          <span class="info-label">Y:</span>
          <input type="number" v-model.number="selectionModel.selection.y" class="coord-input" @input="updateSelectionFromInput" />
        </div>
        <div class="info-item" v-if="hasSelection">
          <span class="info-label">W:</span>
          <input type="number" v-model.number="selectionModel.selection.w" class="coord-input" min="1"
            @input="updateSelectionFromInput" />
        </div>
        <div class="info-item" v-if="hasSelection">
          <span class="info-label">H:</span>
          <input type="number" v-model.number="selectionModel.selection.h" class="coord-input" min="1"
            @input="updateSelectionFromInput" />
        </div>
        <div class="info-item" v-if="hasSelection">
          <span class="info-label">尺寸:</span>
          <span class="info-value">{{ selectionModel.selection.w }}×{{ selectionModel.selection.h }}</span>
        </div>
        <div class="info-item" v-if="!hasSelection">
          <span class="info-hint">拖拽图片创建选区以获取坐标</span>
        </div>
      </div>

      <div class="tb-sep"></div>

      <div class="tb-group status-group">
        <span class="status-item">📄 <b>{{ fileName }}</b></span>
        <span class="status-item">📐 {{ imageWidth }}×{{ imageHeight }}</span>
      </div>
    </div>

    <!-- Hidden file input for local image loading -->
    <input ref="fileInputRef" type="file" accept="image/*" class="file-input" @change="handleFileSelect" />

    <div class="cropper-workspace" :class="{ 'toolbar-hidden': !isDebug }">
      <div class="image-container" ref="containerRef"
        :class="{ dragging: selectionModel.interactionKind !== null, panning: isMiddlePanning }"
        @mousedown="handleMouseDown" @mousemove="handleMouseMove" @mouseup="handleMouseUp" @mouseleave="handleMouseUp"
        @wheel.prevent="handleWheel" @contextmenu.prevent>
        <div class="image-content" ref="contentRef" :style="viewStyle">
          <canvas ref="canvasRef" class="image-canvas"></canvas>
          <div class="selection-wrapper" ref="selectionBoxRef" :style="selectionWrapperStyle"
            v-show="shouldShowSelection">
            <div class="selection-box"></div>
            <!-- Resize handles -->
            <div class="handle handle-nw" @mousedown.stop="startResize('nw', $event)"></div>
            <div class="handle handle-n" @mousedown.stop="startResize('n', $event)"></div>
            <div class="handle handle-ne" @mousedown.stop="startResize('ne', $event)"></div>
            <div class="handle handle-e" @mousedown.stop="startResize('e', $event)"></div>
            <div class="handle handle-se" @mousedown.stop="startResize('se', $event)"></div>
            <div class="handle handle-s" @mousedown.stop="startResize('s', $event)"></div>
            <div class="handle handle-sw" @mousedown.stop="startResize('sw', $event)"></div>
            <div class="handle handle-w" @mousedown.stop="startResize('w', $event)"></div>
          </div>
        </div>
      </div>

      <!-- Minimap: overview of the whole image + the current view rectangle -->
      <div class="minimap" ref="minimapRef" v-if="minimapScale > 0" :style="minimapBoxStyle"
        :class="{ 'minimap-dragging': isMinimapDragging }"
        @mousedown.stop="minimapMouseDown" @mousemove="minimapMouseMove">
        <div class="minimap-img" :style="{ backgroundImage: 'url(' + imageSrc + ')' }"></div>
        <div class="minimap-view" :style="minimapViewStyle"></div>
      </div>
    </div>

    <div class="extractor-tips" v-if="isDebug">
      <p>💡 拖拽创建选区 | 拖拽移动选区 | 拖拽边缘调整大小 | <b>点击空白处取消选区</b> | <b>中键拖拽平移画布</b> | <b>滚轮缩放</b></p>
    </div>

    <div class="copy-feedback" v-if="showCopyFeedback">
      <span>✅ 已复制到剪贴板!</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted, onUnmounted } from 'vue'
import { ViewTransform, SelectionModel, MinimapModel, MINIMAP_MAX_W, MINIMAP_MAX_H } from '../extractor'
import type { ResizeHandle } from '../extractor'
import kirbySpriteSheet from '../assets/sprites/Kirby.png'

// The coordinate toolbar is a debug control panel: only shown with ?debug=true
const isDebug = new URLSearchParams(window.location.search).get('debug') === 'true'

const canvasRef = ref<HTMLCanvasElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)
const contentRef = ref<HTMLDivElement | null>(null)
const selectionBoxRef = ref<HTMLDivElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const minimapRef = ref<HTMLDivElement | null>(null)

// Image state
const image = ref<HTMLImageElement | null>(null)
const zoom = ref(1)
const showCopyFeedback = ref(false)
const fileName = ref('未加载')
let currentObjectUrl: string | null = null

// Image dimensions (reactive for display)
const imageWidth = computed(() => image.value ? image.value.naturalWidth : 0)
const imageHeight = computed(() => image.value ? image.value.naturalHeight : 0)
const imageSrc = computed(() => image.value ? image.value.src : '')

const MIN_ZOOM = 0.1
const MAX_ZOOM = 4

const minimapScale = computed(() => {
  if (!imageWidth.value || !imageHeight.value) return 0
  return Math.min(
    MINIMAP_MAX_W / imageWidth.value,
    MINIMAP_MAX_H / imageHeight.value
  )
})

// Selection wrapper style
const selectionWrapperStyle = computed(() => {
  const sel = selectionModel.selection
  const z = zoom.value
  return {
    left: `${sel.x * z}px`,
    top: `${sel.y * z}px`,
    width: `${sel.w * z}px`,
    height: `${sel.h * z}px`
  }
})

// Image transform: replaces native scrolling so overscroll can be expressed
const viewStyle = computed(() => {
  const v = viewTransform.view
  return {
    transform: `translate3d(${v.x}px, ${v.y}px, 0)`
  }
})

// Minimap box size (the overview image itself, no padding/border)
const minimapBoxStyle = computed(() => {
  const size = minimapModel.getSize({
    imageWidth: imageWidth.value,
    imageHeight: imageHeight.value,
    viewportW: 0,
    viewportH: 0,
    viewX: viewTransform.view.x,
    viewY: viewTransform.view.y,
    zoom: zoom.value
  })
  return {
    width: `${size.width}px`,
    height: `${size.height}px`
  }
})

// Current-view rectangle drawn on top of the minimap
const minimapViewStyle = computed(() => {
  const v = minimapModel.getViewRect({
    imageWidth: imageWidth.value,
    imageHeight: imageHeight.value,
    viewportW: viewTransform.viewportW,
    viewportH: viewTransform.viewportH,
    viewX: viewTransform.view.x,
    viewY: viewTransform.view.y,
    zoom: zoom.value
  })
  return {
    left: `${v.x}px`,
    top: `${v.y}px`,
    width: `${Math.max(2, v.w)}px`,
    height: `${Math.max(2, v.h)}px`
  }
})

// Show selection when there's a valid selection or active interaction
const shouldShowSelection = computed(() => {
  const sel = selectionModel
  if (sel.hasSelection && sel.selection.w >= 1 && sel.selection.h >= 1) return true
  if (sel.interactionKind === 'select' && sel.selection.w >= 1 && sel.selection.h >= 1) return true
  return false
})

// The coordinate toolbar is a debug control panel: only shown with ?debug=true
const isMinimapDragging = ref(false)
let panStart: { clientX: number; clientY: number; viewX: number; viewY: number } | null = null
let isMiddlePanning = ref(false)
let ctx: CanvasRenderingContext2D | null = null

// ---- extracted models ----
const viewTransform = reactive(new ViewTransform({
  get container() { return containerRef.value! },
  get image() { return image.value! }
}))

const selectionModel = reactive(new SelectionModel())
const minimapModel = new MinimapModel()

// Single source of truth: whether a usable selection exists
const hasSelection = computed(() => selectionModel.hasSelection)

// Load the built-in Kirby.png
function loadKirbyImage() {
  loadImageFromSource(kirbySpriteSheet, 'Kirby.png')
}

// Open the local file picker
function triggerFileInput() {
  if (fileInputRef.value) fileInputRef.value.click()
}

// Handle local file selection
function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files && input.files[0]
  if (!file) return
  if (!file.type.startsWith('image/')) {
    fileName.value = '文件类型不支持'
    return
  }
  const url = URL.createObjectURL(file)
  loadImageFromSource(url, file.name)
  // Allow selecting the same file again
  input.value = ''
}

// Generic image loader (used by Kirby.png and local files)
function loadImageFromSource(src: string, name: string) {
  const img = new Image()
  img.onload = () => {
    // Release the previous object URL to avoid leaks
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl)
      currentObjectUrl = null
    }
    if (src.startsWith('blob:')) currentObjectUrl = src

    image.value = img
    fileName.value = name
    // Hand the image size to the selection model so it can clamp live
    selectionModel.setImageSize(img.naturalWidth, img.naturalHeight)
    selectionModel.reset()
    viewTransform.reset()
    zoom.value = viewTransform.view.zoom
    drawImage()
  }
  img.onerror = () => {
    fileName.value = `${name} 加载失败`
    if (src.startsWith('blob:')) URL.revokeObjectURL(src)
  }
  img.src = src
}

// Draw image on canvas
function drawImage() {
  if (!image.value || !ctx) return

  const canvas = canvasRef.value
  if (!canvas) return
  canvas.width = image.value.naturalWidth * zoom.value
  canvas.height = image.value.naturalHeight * zoom.value

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(image.value, 0, 0, canvas.width, canvas.height)
}

// Zoom by a factor, keeping the given container-space anchor point fixed
function zoomAt(factor: number, anchorX: number, anchorY: number) {
  if (!image.value) return
  viewTransform.zoomAt(factor, anchorX, anchorY)
  zoom.value = viewTransform.view.zoom
  drawImage()
}

// Zoom in / out around the centre of the viewport
function zoomIn() {
  zoomAt(1.25, viewTransform.viewportW / 2, viewTransform.viewportH / 2)
}

function zoomOut() {
  zoomAt(1 / 1.25, viewTransform.viewportW / 2, viewTransform.viewportH / 2)
}

// Wheel zoom: the image point under the cursor stays under the cursor
function handleWheel(e: WheelEvent) {
  if (!image.value) return
  e.preventDefault()
  const container = containerRef.value
  if (!container) return
  const rect = container.getBoundingClientRect()
  viewTransform.wheel(rect, e.clientX, e.clientY, e.deltaY)
  zoom.value = viewTransform.view.zoom
  drawImage()
}

// CSS cursor based on current interaction
function updateCursor() {
  const container = containerRef.value
  if (!container) return

  if (isMiddlePanning.value) {
    container.style.cursor = 'grabbing'
    return
  }

  container.style.cursor = selectionModel.cursorFor()
}

// Get mouse position in image coordinates
function getMousePos(e: MouseEvent) {
  return viewTransform.screenToImage(e.clientX, e.clientY)
}

// Start resize from handle
function startResize(handle: ResizeHandle, e: MouseEvent) {
  e.stopPropagation()
  const pos = getMousePos(e)
  selectionModel.startResize(handle, pos.x, pos.y)
  updateCursor()
}

// Mouse down handler
function handleMouseDown(e: MouseEvent) {
  if (!image.value) return

  // Middle button: start panning the canvas instead of creating a selection
  if (e.button === 1) {
    e.preventDefault()
    isMiddlePanning.value = true
    panStart = {
      clientX: e.clientX,
      clientY: e.clientY,
      viewX: viewTransform.view.x,
      viewY: viewTransform.view.y
    }
    return
  }

  // Ignore non-left buttons so native scrolling works
  if (e.button !== 0) return

  const pos = getMousePos(e)

  // Check if clicking inside existing selection - start moving
  if (selectionModel.hasSelection && selectionModel.contains(pos.x, pos.y)) {
    selectionModel.startMove(pos.x, pos.y)
  } else {
    selectionModel.startSelect(pos.x, pos.y)
    selectionModel.hasSelection = false
  }
  updateCursor()
}

// Mouse move handler
function handleMouseMove(e: MouseEvent) {
  if (!image.value) return

  // Middle-button drag: pan the canvas by the pointer delta.
  // clampView() lets the drag continue past the image edge (rubber band) while
  // guaranteeing part of the image always stays visible.
  if (isMiddlePanning.value) {
    e.preventDefault()
    if (panStart) {
      viewTransform.setView(
        panStart.viewX + (e.clientX - panStart.clientX),
        panStart.viewY + (e.clientY - panStart.clientY)
      )
    }
    return
  }

  const pos = getMousePos(e)

  if (!selectionModel.interactionKind) {
    updateCursor()
    return
  }

  selectionModel.move(pos.x, pos.y)
}

// Mouse up handler
function handleMouseUp() {
  // Releasing the middle button ends canvas panning
  if (isMiddlePanning.value) {
    isMiddlePanning.value = false
    panStart = null
    updateCursor()
    return
  }

  if (!selectionModel.interactionKind) return

  selectionModel.end()
  updateCursor()
}

// Update selection from input
function updateSelectionFromInput() {
  if (!image.value) return
  selectionModel.updateFromInput()
}

// Copy coordinates to clipboard
async function copyCoords() {
  if (!hasSelection.value) return

  try {
    await navigator.clipboard.writeText(selectionModel.coordsText())
    showCopyFeedback.value = true
    setTimeout(() => {
      showCopyFeedback.value = false
    }, 2000)
  } catch (err) {
    console.error('Failed to copy:', err)
  }
}

// Move the main view so the clicked minimap point is centred in the viewport
function minimapNavigate(e: MouseEvent) {
  const el = minimapRef.value
  if (!el || !image.value) return
  const target = minimapModel.navigateTo(
    {
      imageWidth: image.value.naturalWidth,
      imageHeight: image.value.naturalHeight,
      viewportW: viewTransform.viewportW,
      viewportH: viewTransform.viewportH,
      viewX: viewTransform.view.x,
      viewY: viewTransform.view.y,
      zoom: zoom.value
    },
    e.clientX,
    e.clientY,
    el.getBoundingClientRect()
  )
  viewTransform.setView(target.x, target.y)
}

function minimapMouseDown(e: MouseEvent) {
  e.preventDefault()
  isMinimapDragging.value = true
  minimapNavigate(e)
  // Track the drag at window level so it continues even when the
  // pointer leaves the minimap bounds.
  window.addEventListener('mousemove', minimapWindowMove)
  window.addEventListener('mouseup', minimapWindowUp)
}

// Element-level handlers: immediate feedback while the pointer stays on the minimap
function minimapMouseMove(e: MouseEvent) {
  if (!isMinimapDragging.value) return
  minimapNavigate(e)
}

function minimapMouseUp() {
  if (!isMinimapDragging.value) return
  isMinimapDragging.value = false
  window.removeEventListener('mousemove', minimapWindowMove)
  window.removeEventListener('mouseup', minimapWindowUp)
}

// Window-level fallback: keeps tracking if the pointer leaves the minimap during drag
function minimapWindowMove(e: MouseEvent) {
  if (!isMinimapDragging.value) return
  minimapNavigate(e)
}

function minimapWindowUp() {
  isMinimapDragging.value = false
  window.removeEventListener('mousemove', minimapWindowMove)
  window.removeEventListener('mouseup', minimapWindowUp)
}

onMounted(() => {
  const canvas = canvasRef.value
  if (canvas) {
    const context = canvas.getContext('2d')
    if (context) {
      ctx = context
      ctx.imageSmoothingEnabled = false
    }
  }

  viewTransform.measure()
  window.addEventListener('resize', handleWindowResize)

  // Auto-load the default Kirby.png
  loadKirbyImage()
})

onUnmounted(() => {
  window.removeEventListener('resize', handleWindowResize)
  // Release any pending object URL
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl)
  // Safety: drop minimap drag listeners if the component unmounts mid-drag
  if (isMinimapDragging.value) {
    window.removeEventListener('mousemove', minimapWindowMove)
    window.removeEventListener('mouseup', minimapWindowUp)
  }
})

// Keep the viewport measurement and the clamped view in sync on resize
function handleWindowResize() {
  viewTransform.measure()
  viewTransform.setView(viewTransform.view.x, viewTransform.view.y)
}
</script>

<style scoped>
/* Fullscreen extractor: image fills the page, controls live in floating panels */
.extractor-container {
  position: fixed;
  inset: 0;
  overflow: hidden;
}

/* ---------- Toolbar strip (plain bar, not a floating window), top-left ---------- */
.extractor-toolbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 45;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px calc(var(--panel-w, 48px) + 16px) 8px 16px;
  background: rgba(20, 20, 35, 0.88);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid rgba(255, 105, 180, 0.3);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}

.tb-group {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.tb-sep {
  width: 1px;
  height: 22px;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.15);
}

.tb-zoom {
  min-width: 38px;
  text-align: center;
  color: #ff69b4;
  font-size: 0.7em;
  font-weight: bold;
  white-space: nowrap;
}

/* Square icon buttons inside the toolbar */
.palette-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  font-size: 0.85em;
  line-height: 1;
  transition: all 0.15s;
}

.palette-btn:hover:not(:disabled) {
  background: rgba(255, 105, 180, 0.25);
  border-color: rgba(255, 105, 180, 0.45);
}

.palette-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* Toolbar content: coordinates + status laid out in a row */
.coord-group {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}

.status-group {
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 0.85em;
  color: #aaa;
  white-space: nowrap;
}

.info-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.info-label {
  color: #ff69b4;
  font-weight: bold;
  font-size: 0.9em;
}

.info-hint {
  color: #888;
  font-size: 0.85em;
}

.info-value {
  color: #fff;
  font-weight: bold;
  font-size: 0.95em;
}

.coord-input {
  width: 68px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  color: #fff;
  font-size: 0.9em;
}

.coord-input:focus {
  outline: none;
  border-color: #ff69b4;
}

.file-input {
  display: none;
}

/* Workspace: the canvas fills the whole page below the toolbar strip */
.cropper-workspace {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 46px 0 0 0;
}

/* When the toolbar is hidden (?debug absent) the canvas uses the full height */
.cropper-workspace.toolbar-hidden {
  padding: 0;
}

/* The viewport: clipping is done here, panning is done by translating .image-content */
.image-container {
  overflow: hidden;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  border: 0;
  border-radius: 0;
  cursor: default;
  background: #1a1a2e;
  background-image:
    linear-gradient(45deg, #2a2a3e 25%, transparent 25%),
    linear-gradient(-45deg, #2a2a3e 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #2a2a3e 75%),
    linear-gradient(-45deg, transparent 75%, #2a2a3e 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
  scrollbar-gutter: stable;
  scrollbar-color: rgba(255, 105, 180, 0.5) transparent;
  user-select: none;
  -webkit-user-select: none;
}

.status-item b {
  color: #fff;
  font-weight: 600;
}

/* Middle-button drag: grabbing cursor (clipping is always hidden now) */
.image-container.panning {
  cursor: grabbing;
}

/* The translated image layer */
.image-content {
  position: relative;
  display: inline-block;
  transform-origin: 0 0;
  will-change: transform;
}

.image-canvas {
  display: block;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}

.selection-wrapper {
  position: absolute;
  pointer-events: none;
  z-index: 10;
}

.selection-box {
  position: absolute;
  inset: 0;
  border: 2px solid #ff69b4;
  background-color: rgba(255, 105, 180, 0.15);
  pointer-events: none;
}

/* Resize handles - centered ON the selection border lines (not outside) */
.handle {
  position: absolute;
  width: 10px;
  height: 10px;
  background: #fff;
  border: 2px solid #ff69b4;
  border-radius: 50%;
  pointer-events: auto;
  z-index: 11;
  box-sizing: border-box;
  box-shadow: 0 0 0 4px transparent;
  transition: box-shadow 0.1s, background-color 0.1s;
}

.handle:hover {
  background: #ff69b4;
  box-shadow: 0 0 0 4px rgba(255, 105, 180, 0.3);
}

/* Offsets are -5px (half the 10px handle) so the circle center sits exactly on the border line */
.handle-nw {
  top: -5px;
  left: -5px;
  cursor: nw-resize;
}

.handle-n {
  top: -5px;
  left: calc(50% - 5px);
  cursor: n-resize;
}

.handle-ne {
  top: -5px;
  right: -5px;
  cursor: ne-resize;
}

.handle-e {
  top: calc(50% - 5px);
  right: -5px;
  cursor: e-resize;
}

.handle-se {
  bottom: -5px;
  right: -5px;
  cursor: se-resize;
}

.handle-s {
  bottom: -5px;
  left: calc(50% - 5px);
  cursor: s-resize;
}

.handle-sw {
  bottom: -5px;
  left: -5px;
  cursor: sw-resize;
}

.handle-w {
  top: calc(50% - 5px);
  left: -5px;
  cursor: w-resize;
}

/* ---------- Minimap: overview of the whole image + current view rectangle ---------- */
.minimap {
  position: fixed;
  right: calc(var(--panel-w, 48px) + 16px);
  bottom: 16px;
  z-index: 45;
  border: 1px solid rgba(255, 105, 180, 0.4);
  border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55);
  overflow: hidden;
  cursor: pointer;
  background: #101020;
  user-select: none;
  -webkit-user-select: none;
}

/* Thumbnail of the whole image, pixelated so it stays crisp */
.minimap-img {
  position: absolute;
  inset: 0;
  background-size: 100% 100%;
  background-repeat: no-repeat;
  image-rendering: pixelated;
  opacity: 0.85;
}

/* The rectangle representing what the main viewport is showing.
   Its huge spread shadow darkens everything outside the rect. */
.minimap-view {
  position: absolute;
  border: 1.5px solid #ff69b4;
  background: rgba(255, 105, 180, 0.18);
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
  pointer-events: none;
}

.minimap-dragging .minimap-view {
  border-color: #fff;
  background: rgba(255, 105, 180, 0.3);
}

/* Floating tips - bottom left */
.extractor-tips {
  position: fixed;
  bottom: 16px;
  left: 16px;
  z-index: 40;
  padding: 10px 16px;
  background: rgba(20, 20, 35, 0.78);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 105, 180, 0.28);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  text-align: left;
  max-width: calc(100vw - var(--panel-w, 48px) - 44px);
}

.extractor-tips p {
  color: #aaa;
  font-size: 0.8em;
  margin: 0;
}

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
  0% {
    opacity: 0;
    transform: translateX(-50%) translateY(20px);
  }

  20% {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  80% {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  100% {
    opacity: 0;
    transform: translateX(-50%) translateY(0);
  }
}
</style>
