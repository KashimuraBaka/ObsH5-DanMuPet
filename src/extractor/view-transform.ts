/**
 * Image viewport transform: zoom, pan, and clamping.
 *
 * The view lives in "screen px" - `view.x / view.y` is the image's top-left
 * offset inside the container.  Rubber-band overscroll is allowed but the
 * image can never be dragged so far that it disappears completely.
 */

export interface ViewTransformOptions {
  container: HTMLElement;
  image: HTMLImageElement;
}

export interface ViewState {
  x: number;
  y: number;
  zoom: number;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

export class ViewTransform {
  readonly view: ViewState = { x: 0, y: 0, zoom: 1 };
  viewportW = 0;
  viewportH = 0;

  constructor(private opts: ViewTransformOptions) {}

  get scaledW(): number {
    return this.opts.image.naturalWidth * this.view.zoom;
  }

  get scaledH(): number {
    return this.opts.image.naturalHeight * this.view.zoom;
  }

  measure(): void {
    this.viewportW = this.opts.container.clientWidth;
    this.viewportH = this.opts.container.clientHeight;
  }

  clamp(x: number, y: number): { x: number; y: number } {
    const sw = this.scaledW;
    const sh = this.scaledH;
    const cw = this.viewportW;
    const ch = this.viewportH;
    if (!cw || !ch || !sw || !sh) return { x, y };

    const minX = cw - sw;
    const minY = ch - sh;
    const loX = Math.min(minX, 0);
    const hiX = Math.max(minX, 0);
    const loY = Math.min(minY, 0);
    const hiY = Math.max(minY, 0);

    const slackX = Math.min(cw, sw) * 0.5;
    const slackY = Math.min(ch, sh) * 0.5;

    return {
      x: Math.min(Math.max(x, loX - slackX), hiX + slackX),
      y: Math.min(Math.max(y, loY - slackY), hiY + slackY),
    };
  }

  setView(x: number, y: number): void {
    const c = this.clamp(x, y);
    this.view.x = c.x;
    this.view.y = c.y;
  }

  /** Reset the view back to the image's top-left corner. */
  reset(): void {
    this.view.x = 0;
    this.view.y = 0;
    this.measure();
  }

  /** Zoom by a factor while keeping the given container-space anchor fixed. */
  zoomAt(factor: number, anchorX: number, anchorY: number): void {
    const oldZoom = this.view.zoom;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * factor));
    if (newZoom === oldZoom) return;

    // Image-space point currently under the anchor
    const ix = (anchorX - this.view.x) / oldZoom;
    const iy = (anchorY - this.view.y) / oldZoom;

    this.view.zoom = newZoom;
    this.setView(anchorX - ix * newZoom, anchorY - iy * newZoom);
  }

  zoomIn(): void {
    this.zoomAt(1.25, this.viewportW / 2, this.viewportH / 2);
  }

  zoomOut(): void {
    this.zoomAt(1 / 1.25, this.viewportW / 2, this.viewportH / 2);
  }

  /**
   * Wheel zoom: the image point under the cursor stays under the cursor.
   * @param containerRect the container's bounding rect, to make the anchor container-relative
   */
  wheel(
    containerRect: DOMRect,
    clientX: number,
    clientY: number,
    deltaY: number,
  ): void {
    const factor = deltaY < 0 ? 1.12 : 1 / 1.12;
    this.zoomAt(
      factor,
      clientX - containerRect.left,
      clientY - containerRect.top,
    );
  }

  /** Convert a container-space point to image coordinates. */
  screenToImage(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.opts.container.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.view.x) / this.view.zoom,
      y: (clientY - rect.top - this.view.y) / this.view.zoom,
    };
  }
}
