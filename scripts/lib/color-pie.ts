// Draws the color identity pies: one small image per color identity (a subset of WUBRG, or colorless), as a
// PNG made in memory. The pies are our own drawing, flat wedges of five colors: nothing is read from Scryfall,
// Wizards of the Coast or anywhere else, and no mana symbol artwork is used. No dependency: the pixels are
// computed here and the PNG is written with Node's zlib.
import { crc32, deflateSync } from "node:zlib";

type Rgb = readonly [number, number, number];

export const PIE_CONFIG = {
  /** Discord asks for 128x128 emoji images. */
  size: 128,
  /** Samples per pixel along each axis (4 means 16 samples), for smooth edges. */
  supersample: 4,
  /** Fractions of the image size: the pie's radius, the width of the ring around it, and of the line between wedges. */
  radius: 0.47,
  ring: 0.07,
  gap: 0.05,
  /** The colorless pie is a ring with nothing inside; this is the ring's width. */
  colorlessRing: 0.15,
  /** Where the first wedge is centered, in degrees clockwise from the top, by number of colors (0 when not
   *  listed). Two colors are split down the middle, the first color on the left, so they read left to right. */
  firstWedgeAt: { 2: -90 } as Record<number, number>,
  /**
   * Wedges are equal, in WUBRG order, clockwise, the first one centered at the top (so the five-color pie is
   * the color wheel on the back of a card); see firstWedgeAt for two colors. The ring and the lines between wedges are a mid grey, because the
   * white wedge needs an edge on Discord's light background and the black wedge on its dark one.
   */
  colors: {
    W: [0xfb, 0xf6, 0xe0], U: [0x2a, 0x82, 0xd8], B: [0x1c, 0x1a, 0x20], R: [0xdc, 0x3a, 0x3c], G: [0x2f, 0xa3, 0x5c],
    ring: [0x8c, 0x91, 0x9b],
  } as Record<"W" | "U" | "B" | "R" | "G" | "ring", Rgb>,
} as const;

/** RGBA pixels of the pie for `colors` (a subset of "WUBRG" in that order; "" is colorless), `size` pixels square. */
export function renderPie(colors: string, size: number = PIE_CONFIG.size): Uint8Array {
  const c = PIE_CONFIG;
  const wedges = [...colors].map((l) => {
    if (!(l in c.colors) || l === "ring") throw new Error(`not a color: ${l}`);
    return c.colors[l as "W" | "U" | "B" | "R" | "G"];
  });
  const n = wedges.length;
  const ss = c.supersample;
  const center = size / 2;
  const radius = c.radius * size;
  const inner = radius - (n === 0 ? c.colorlessRing : c.ring) * size;
  const halfGap = (c.gap * size) / 2;
  const step = (2 * Math.PI) / Math.max(n, 1);
  const first = ((c.firstWedgeAt[n] ?? 0) * Math.PI) / 180;
  const out = new Uint8Array(size * size * 4);

  /** The color at a point, or null where the image is transparent. */
  const at = (x: number, y: number): Rgb | null => {
    const dx = x - center;
    const dy = y - center;
    const d = Math.hypot(dx, dy);
    if (d > radius) return null;
    if (d > inner) return c.colors.ring;
    if (n === 0) return null;
    if (n === 1) return wedges[0]!;
    // Angle clockwise from the center of wedge 0, shifted by half a wedge so that wedge 0 starts at zero.
    const angle = (Math.atan2(dx, -dy) - first + step / 2 + 4 * Math.PI) % (2 * Math.PI);
    const index = Math.min(n - 1, Math.floor(angle / step));
    // Distance to the nearer edge of the wedge, measured across the edge.
    const within = angle - index * step;
    const edge = Math.min(within, step - within);
    if (edge < Math.PI / 2 && d * Math.sin(edge) < halfGap) return c.colors.ring;
    return wedges[index]!;
  };

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const color = at(px + (sx + 0.5) / ss, py + (sy + 0.5) / ss);
          if (!color) continue;
          r += color[0]; g += color[1]; b += color[2]; hits++;
        }
      }
      if (hits === 0) continue;
      const o = (py * size + px) * 4;
      out[o] = Math.round(r / hits);
      out[o + 1] = Math.round(g / hits);
      out[o + 2] = Math.round(b / hits);
      out[o + 3] = Math.round((255 * hits) / (ss * ss));
    }
  }
  return out;
}

/** An 8-bit RGBA PNG. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  if (rgba.length !== width * height * 4) throw new Error("pixel data does not match the image size");
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits per channel, RGBA, deflate, no filter choice, not interlaced
  const rows = Buffer.alloc(height * (width * 4 + 1)); // each row starts with filter type 0
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The pie for `colors` as a PNG file. */
export const piePng = (colors: string, size: number = PIE_CONFIG.size): Buffer => encodePng(renderPie(colors, size), size, size);

/**
 * One image for looking at every pie before uploading: each row is one background (Discord's light and dark
 * ones), with the pies at full size and then at the sizes Discord shows them in a message. Review aid only.
 */
export function contactSheet(identities: readonly string[], backgrounds: readonly Rgb[] = [[0xff, 0xff, 0xff], [0x31, 0x33, 0x38]], sizes: readonly number[] = [64, 44, 22]): Buffer {
  const pad = 8;
  const rowHeight = (size: number) => size + 2 * pad;
  const bandHeight = sizes.reduce((sum, size) => sum + rowHeight(size), 0);
  const width = identities.length * (sizes[0]! + pad) + pad;
  const height = backgrounds.length * bandHeight;
  const sheet = new Uint8Array(width * height * 4);
  backgrounds.forEach((bg, band) => {
    for (let y = band * bandHeight; y < (band + 1) * bandHeight; y++) {
      for (let x = 0; x < width; x++) sheet.set([bg[0], bg[1], bg[2], 255], (y * width + x) * 4);
    }
    let top = band * bandHeight;
    for (const size of sizes) {
      identities.forEach((identity, i) => {
        const pie = renderPie(identity, size);
        const left = pad + i * (sizes[0]! + pad);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const a = pie[(y * size + x) * 4 + 3]! / 255;
            if (a === 0) continue;
            const o = ((top + pad + y) * width + left + x) * 4;
            for (let k = 0; k < 3; k++) sheet[o + k] = Math.round(pie[(y * size + x) * 4 + k]! * a + bg[k]! * (1 - a));
          }
        }
      });
      top += rowHeight(size);
    }
  });
  return encodePng(sheet, width, height);
}
