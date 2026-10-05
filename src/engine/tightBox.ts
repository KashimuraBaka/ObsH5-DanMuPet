/**
 * Pixel-tight bounding boxes for sprite frames.
 *
 * Animation JSON records where each frame sits in the sheet, which usually
 * includes transparent padding. Collision, hover glow and hit-testing want the
 * real pixel bounds instead, so each frame is rasterised once and scanned for
 * opaque pixels.
 *
 * The cache is keyed by sheet URL *and* frame rect: a frame rect means
 * different pixels in different sheets, and a field can hold characters drawn
 * from several sheets at once.
 */

const ALPHA_THRESHOLD = 16;

export interface TightBox {
  bx: number;
  by: number;
  bw: number;
  bh: number;
}

export interface TightBoxFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

const cache = new Map<string, TightBox>();

/** The rect-only box used when no pixels can be read (no sheet, tainted canvas). */
function fullFrame(frame: TightBoxFrame): TightBox {
  return { bx: 0, by: 0, bw: frame.w, bh: frame.h };
}

/**
 * Tight box for `frame` within `sheet`.
 *
 * `sheet` may be null or not decoded yet, in which case the full frame rect is
 * returned — the same fallback the engine has always used.
 */
export function getFrameTightBox(
  sheet: CanvasImageSource | null,
  frame: TightBoxFrame,
  sheetKey = "default",
): TightBox {
  const key = `${sheetKey}|${frame.x},${frame.y},${frame.w},${frame.h}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let box = fullFrame(frame);

  if (sheet) {
    const c = document.createElement("canvas");
    c.width = frame.w;
    c.height = frame.h;
    const g = c.getContext("2d");
    if (g) {
      g.drawImage(sheet, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
      try {
        const data = g.getImageData(0, 0, frame.w, frame.h).data;
        let minX = frame.w;
        let minY = frame.h;
        let maxX = -1;
        let maxY = -1;
        for (let py = 0; py < frame.h; py++) {
          for (let px = 0; px < frame.w; px++) {
            if (data[(py * frame.w + px) * 4 + 3] >= ALPHA_THRESHOLD) {
              if (px < minX) minX = px;
              if (px > maxX) maxX = px;
              if (py < minY) minY = py;
              if (py > maxY) maxY = py;
            }
          }
        }
        if (maxX >= minX && maxY >= minY) {
          box = { bx: minX, by: minY, bw: maxX - minX + 1, bh: maxY - minY + 1 };
        }
      } catch (_e) {
        // Tainted canvas — fall back to the full frame.
      }
    }
  }

  cache.set(key, box);
  return box;
}

/** Drop every cached box (used when a sheet is replaced and rects shift). */
export function clearTightBoxCache(): void {
  cache.clear();
}