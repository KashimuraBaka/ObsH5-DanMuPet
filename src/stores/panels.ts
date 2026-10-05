import { defineStore } from "pinia";
import { reactive } from "vue";
import type { PageId } from "./ui.ts";

/** Every floating panel that can be toggled from the right rail. */
export type PanelId = "controls" | "frameEditor" | "physics" | "monsterGen" | "botGen";

/** Inline style a panel applies to itself (docking, then drag/resize overrides). */
export interface PanelStyle {
  left?: string;
  top?: string;
  right?: string;
  bottom?: string;
  width?: string;
  height?: string;
  /** CSS custom properties, e.g. '--panel-top', used for viewport clamping. */
  [key: `--${string}`]: string | undefined;
}

export interface PanelState {
  open: boolean;
  collapsed: boolean;
  style: PanelStyle;
}

/** Any combination of n / s / e / w, e.g. 'se' for the bottom-right corner. */
export type ResizeDirection = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

export interface PanelDefinition {
  id: PanelId;
  title: string;
  /** Only shown while this page is active. */
  page: PageId;
  /** Extra CSS class, so a panel can carry its own width rules. */
  className?: string;
  /** Default docking position in px, before the user drags the panel. */
  initialTop: number;
  initialLeft: number;
  /** Size floor for manual resizing. */
  minWidth: number;
  minHeight: number;
}

/**
 * Static panel registry. Order here is the render order, so `controls` docks
 * first and never covers the rail toggles.
 */
export const PANEL_DEFS: PanelDefinition[] = [
  {
    id: "controls",
    title: "🎲️ 动画控制",
    page: "animator",
    initialTop: 16,
    initialLeft: 16,
    minWidth: 220,
    minHeight: 140,
  },
  {
    id: "frameEditor",
    title: "📐 帧编辑器",
    page: "animator",
    className: "frame-editor-panel",
    initialTop: 380,
    initialLeft: 16,
    minWidth: 220,
    minHeight: 140,
  },
  {
    id: "physics",
    title: "🧱 物理调试",
    page: "animator",
    className: "physics-panel",
    initialTop: 16,
    initialLeft: 640,
    minWidth: 220,
    minHeight: 140,
  },
  {
    id: "monsterGen",
    title: "👾 怪物生成",
    page: "animator",
    className: "monster-gen-panel",
    initialTop: 240,
    initialLeft: 640,
    minWidth: 220,
    minHeight: 160,
  },
  {
    id: "botGen",
    title: "🎭 角色生成",
    page: "animator",
    className: "bot-gen-panel",
    initialTop: 440,
    initialLeft: 640,
    minWidth: 220,
    minHeight: 160,
  },
];

/**
 * Open/closed, collapsed and geometry state of every floating panel.
 *
 * Geometry lives here (rather than in the panel component) so a panel that is
 * closed and re-opened, or moved and then collapsed, keeps the place the user
 * put it.
 */
export const usePanelStore = defineStore("panels", () => {
  const panels = reactive<Record<PanelId, PanelState>>({
    controls: { open: true, collapsed: false, style: {} },
    frameEditor: { open: false, collapsed: false, style: {} },
    physics: { open: false, collapsed: false, style: {} },
    monsterGen: { open: false, collapsed: false, style: {} },
    botGen: { open: false, collapsed: false, style: {} },
  });

  function isOpen(id: PanelId): boolean {
    return panels[id].open;
  }

  function toggle(id: PanelId): void {
    panels[id].open = !panels[id].open;
  }

  function open(id: PanelId): void {
    panels[id].open = true;
  }

  function close(id: PanelId): void {
    panels[id].open = false;
  }

  function toggleCollapsed(id: PanelId): void {
    panels[id].collapsed = !panels[id].collapsed;
  }

  /** Merge a partial style into a panel's geometry. */
  function patchStyle(id: PanelId, patch: PanelStyle): void {
    Object.assign(panels[id].style, patch);
  }

  /**
   * Default docking, then whatever drag/resize wrote on top.
   *
   * The resolved offsets are also published as `--panel-top` / `--panel-left`
   * so the stylesheet can cap the panel to the space that is actually left
   * beside and below it - a short or narrow window can then never push the
   * bottom or the right edge of a panel off screen.
   *
   * A collapsed panel is header-only, so an explicit height would leave an
   * empty box under the title bar - drop it while collapsed.
   */
  function styleFor(id: PanelId): PanelStyle {
    const def = PANEL_DEFS.find((d) => d.id === id);
    const style: PanelStyle = def
      ? {
          top: `${def.initialTop}px`,
          left: `${def.initialLeft}px`,
          ...panels[id].style,
        }
      : { ...panels[id].style };
    if (panels[id].collapsed) delete style.height;
    style["--panel-top"] = style.top ?? "0px";
    style["--panel-left"] = style.left ?? "0px";
    return style;
  }

  return {
    panels,
    isOpen,
    toggle,
    open,
    close,
    toggleCollapsed,
    patchStyle,
    styleFor,
  };
});
