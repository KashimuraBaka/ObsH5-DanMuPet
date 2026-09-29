/**
 * Selection rectangle state and math for the sprite extractor.
 *
 * A selection is axis-aligned in image coordinates.  It can be created by
 * dragging, moved, and resized from 8 handles.  Every operation is clamped to
 * the image bounds the model was given, so a selection can never escape the
 * picture.
 */

export interface SelectionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageBounds {
  width: number;
  height: number;
}

export type InteractionKind = "select" | "move" | "resize";
export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const RESIZE_CURSORS: Record<ResizeHandle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

/** Smallest a selection edge may become while resizing. */
const MIN_SIZE = 1;

export class SelectionModel {
  readonly selection: SelectionRect = { x: 0, y: 0, w: 0, h: 0 };
  hasSelection = false;
  interactionKind: InteractionKind | null = null;
  interactionHandle: ResizeHandle | null = null;

  /** Image size, so move / resize / clamp all agree on the limits. */
  imageWidth = 0;
  imageHeight = 0;

  private startX = 0;
  private startY = 0;
  private startSelection: SelectionRect = { x: 0, y: 0, w: 0, h: 0 };
  private currentX = 0;
  private currentY = 0;

  /** Tell the model how big the loaded image is. */
  setImageSize(width: number, height: number): void {
    this.imageWidth = width;
    this.imageHeight = height;
  }

  reset(): void {
    this.hasSelection = false;
    this.selection.x = 0;
    this.selection.y = 0;
    this.selection.w = 0;
    this.selection.h = 0;
    this.interactionKind = null;
    this.interactionHandle = null;
  }

  /** True when the image-space point is inside the current selection. */
  contains(imgX: number, imgY: number): boolean {
    if (!this.hasSelection) return false;
    const s = this.selection;
    return imgX >= s.x && imgX <= s.x + s.w && imgY >= s.y && imgY <= s.y + s.h;
  }

  /** Start a new selection drag. */
  startSelect(imgX: number, imgY: number): void {
    this.interactionKind = "select";
    this.startX = imgX;
    this.startY = imgY;
    this.currentX = imgX;
    this.currentY = imgY;
    this.selection.x = Math.floor(imgX);
    this.selection.y = Math.floor(imgY);
    this.selection.w = 1;
    this.selection.h = 1;
  }

  /** Start moving an existing selection. */
  startMove(imgX: number, imgY: number): void {
    this.interactionKind = "move";
    this.startX = imgX;
    this.startY = imgY;
    this.startSelection = { ...this.selection };
    this.currentX = imgX;
    this.currentY = imgY;
  }

  /** Start resizing from a handle. */
  startResize(handle: ResizeHandle, imgX: number, imgY: number): void {
    this.interactionKind = "resize";
    this.interactionHandle = handle;
    this.startX = imgX;
    this.startY = imgY;
    this.startSelection = { ...this.selection };
    this.currentX = imgX;
    this.currentY = imgY;
  }

  /** Feed a mouse-move update. */
  move(imgX: number, imgY: number): void {
    this.currentX = imgX;
    this.currentY = imgY;

    if (this.interactionKind === "select") {
      this.selection.x = Math.floor(Math.min(this.startX, imgX));
      this.selection.y = Math.floor(Math.min(this.startY, imgY));
      this.selection.w = Math.floor(Math.abs(imgX - this.startX));
      this.selection.h = Math.floor(Math.abs(imgY - this.startY));
    } else if (this.interactionKind === "move") {
      const dx = imgX - this.startX;
      const dy = imgY - this.startY;
      // Clamp while dragging so the box never leaves the image
      this.selection.x = Math.max(
        0,
        Math.min(
          Math.floor(this.startSelection.x + dx),
          this.imageWidth - this.selection.w,
        ),
      );
      this.selection.y = Math.max(
        0,
        Math.min(
          Math.floor(this.startSelection.y + dy),
          this.imageHeight - this.selection.h,
        ),
      );
    } else if (this.interactionKind === "resize") {
      this.applyResize();
    }
  }

  /**
   * Finish the current interaction.
   * @returns true when a usable selection is left behind
   */
  end(): boolean {
    if (!this.interactionKind) return false;

    this.interactionKind = null;
    this.interactionHandle = null;

    this.clamp();

    // A plain click on blank space cancels the selection instead of leaving a
    // degenerate 1x1 selection behind. Dragging still creates a new one.
    if (this.selection.w <= MIN_SIZE && this.selection.h <= MIN_SIZE) {
      this.reset();
      return false;
    }

    this.hasSelection = true;
    return true;
  }

  /** Clamp selection to image bounds. */
  clamp(): void {
    const w = this.imageWidth || 0;
    const h = this.imageHeight || 0;
    this.selection.x = Math.max(0, Math.min(this.selection.x, w - 1));
    this.selection.y = Math.max(0, Math.min(this.selection.y, h - 1));
    this.selection.w = Math.max(
      MIN_SIZE,
      Math.min(this.selection.w, w - this.selection.x),
    );
    this.selection.h = Math.max(
      MIN_SIZE,
      Math.min(this.selection.h, h - this.selection.y),
    );
  }

  /** Update from number inputs (already in image coordinates). */
  updateFromInput(): void {
    this.clamp();
    if (
      !this.hasSelection &&
      this.selection.w >= MIN_SIZE &&
      this.selection.h >= MIN_SIZE
    ) {
      this.hasSelection = true;
    }
  }

  cursorFor(): string {
    if (this.interactionKind === "select") return "crosshair";
    if (this.interactionKind === "move") return "grabbing";
    if (this.interactionKind === "resize")
      return RESIZE_CURSORS[this.interactionHandle ?? "se"];
    return "default";
  }

  /** Coordinates as the clipboard copy expects them. */
  coordsText(): string {
    const s = this.selection;
    return `x: ${s.x}, y: ${s.y}, w: ${s.w}, h: ${s.h}`;
  }

  private applyResize(): void {
    const sel = this.startSelection;
    const dx = this.currentX - this.startX;
    const dy = this.currentY - this.startY;
    const imgW = this.imageWidth;
    const imgH = this.imageHeight;

    let newX = sel.x;
    let newY = sel.y;
    let newW = sel.w;
    let newH = sel.h;

    switch (this.interactionHandle) {
      case "n":
        newY = Math.max(
          0,
          Math.min(Math.floor(sel.y + dy), sel.y + sel.h - MIN_SIZE),
        );
        newH = sel.y + sel.h - newY;
        break;
      case "s":
        newH = Math.max(
          MIN_SIZE,
          Math.min(Math.floor(sel.h + dy), imgH - sel.y),
        );
        break;
      case "w":
        newX = Math.max(
          0,
          Math.min(Math.floor(sel.x + dx), sel.x + sel.w - MIN_SIZE),
        );
        newW = sel.x + sel.w - newX;
        break;
      case "e":
        newW = Math.max(
          MIN_SIZE,
          Math.min(Math.floor(sel.w + dx), imgW - sel.x),
        );
        break;
      case "nw":
        newY = Math.max(
          0,
          Math.min(Math.floor(sel.y + dy), sel.y + sel.h - MIN_SIZE),
        );
        newH = sel.y + sel.h - newY;
        newX = Math.max(
          0,
          Math.min(Math.floor(sel.x + dx), sel.x + sel.w - MIN_SIZE),
        );
        newW = sel.x + sel.w - newX;
        break;
      case "ne":
        newY = Math.max(
          0,
          Math.min(Math.floor(sel.y + dy), sel.y + sel.h - MIN_SIZE),
        );
        newH = sel.y + sel.h - newY;
        newW = Math.max(
          MIN_SIZE,
          Math.min(Math.floor(sel.w + dx), imgW - sel.x),
        );
        break;
      case "sw":
        newH = Math.max(
          MIN_SIZE,
          Math.min(Math.floor(sel.h + dy), imgH - sel.y),
        );
        newX = Math.max(
          0,
          Math.min(Math.floor(sel.x + dx), sel.x + sel.w - MIN_SIZE),
        );
        newW = sel.x + sel.w - newX;
        break;
      case "se":
        newW = Math.max(
          MIN_SIZE,
          Math.min(Math.floor(sel.w + dx), imgW - sel.x),
        );
        newH = Math.max(
          MIN_SIZE,
          Math.min(Math.floor(sel.h + dy), imgH - sel.y),
        );
        break;
    }

    this.selection.x = newX;
    this.selection.y = newY;
    this.selection.w = newW;
    this.selection.h = newH;
  }
}
