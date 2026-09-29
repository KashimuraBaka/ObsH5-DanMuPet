/**
 * Minimap geometry: scale the full image into a small overview box and compute
 * the viewport rectangle that is currently visible.
 */

export const MINIMAP_MAX_W = 504
export const MINIMAP_MAX_H = 360

export interface MinimapState {
  scale: number
  width: number
  height: number
}

export interface ViewRect {
  x: number
  y: number
  w: number
  h: number
}

export interface MinimapOptions {
  imageWidth: number
  imageHeight: number
  viewportW: number
  viewportH: number
  viewX: number
  viewY: number
  zoom: number
}

export class MinimapModel {
  /** Scale factor from image pixels to minimap pixels. */
  getScale(opts: MinimapOptions): number {
    if (!opts.imageWidth || !opts.imageHeight) return 0
    return Math.min(
      MINIMAP_MAX_W / opts.imageWidth,
      MINIMAP_MAX_H / opts.imageHeight
    )
  }

  getSize(opts: MinimapOptions): MinimapState {
    const scale = this.getScale(opts)
    return {
      scale,
      width: Math.max(1, Math.round(opts.imageWidth * scale)),
      height: Math.max(1, Math.round(opts.imageHeight * scale))
    }
  }

  /** The rectangle (in minimap pixels) representing the current viewport. */
  getViewRect(opts: MinimapOptions): ViewRect {
    const s = this.getScale(opts)
    if (!s || !opts.viewportW || !opts.viewportH) {
      return { x: 0, y: 0, w: 0, h: 0 }
    }

    // Visible region in image space
    const ix = -opts.viewX / opts.zoom
    const iy = -opts.viewY / opts.zoom
    const iw = opts.viewportW / opts.zoom
    const ih = opts.viewportH / opts.zoom

    // Clamp the rectangle so it always stays inside the minimap box
    const left = Math.max(0, Math.min(ix, opts.imageWidth))
    const top = Math.max(0, Math.min(iy, opts.imageHeight))
    const right = Math.max(0, Math.min(ix + iw, opts.imageWidth))
    const bottom = Math.max(0, Math.min(iy + ih, opts.imageHeight))

    return {
      x: left * s,
      y: top * s,
      w: (right - left) * s,
      h: (bottom - top) * s
    }
  }

  /** Convert a click inside the minimap to a new view origin that centres the clicked image point. */
  navigateTo(opts: MinimapOptions, clientX: number, clientY: number, minimapRect: DOMRect): { x: number; y: number } {
    const s = this.getScale(opts)
    if (!s || !opts.viewportW) return { x: opts.viewX, y: opts.viewY }

    const ix = (clientX - minimapRect.left) / s
    const iy = (clientY - minimapRect.top) / s
    return {
      x: opts.viewportW / 2 - ix * opts.zoom,
      y: opts.viewportH / 2 - iy * opts.zoom
    }
  }
}
