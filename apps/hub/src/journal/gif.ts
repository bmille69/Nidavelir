import type { Pixels } from "../art/visual-diff.ts";

/**
 * Un GIF animé, sans dépendance (ADR-89) : les captures du jeu, une image par fusion, pour voir le jeu changer au fil de
 * la semaine. Palette fixe de 252 couleurs (6 × 7 × 6) avec un tramage ordonné léger : assez pour des captures d'écran,
 * et la même palette pour toutes les images.
 */

const R = 6;
const G = 7;
const B = 6;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function palette(): Uint8Array {
  const p = new Uint8Array(256 * 3);
  let k = 0;
  for (let r = 0; r < R; r++)
    for (let g = 0; g < G; g++)
      for (let b = 0; b < B; b++) {
        p[k++] = Math.round((r * 255) / (R - 1));
        p[k++] = Math.round((g * 255) / (G - 1));
        p[k++] = Math.round((b * 255) / (B - 1));
      }
  return p;
}

/** Ramène une image à `width` × `height` (moyenne des pixels couverts), en gardant ses proportions au centre, fond noir. */
export function fit(src: Pixels, width: number, height: number): Pixels {
  const out = new Uint8Array(width * height * 3);
  const scale = Math.min(width / src.width, height / src.height);
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const ox = Math.floor((width - w) / 2);
  const oy = Math.floor((height - h) / 2);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * src.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * src.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      // Au plus 4 × 4 échantillons par pixel : assez net, et rapide sur des captures de 1280 × 720.
      const sy = Math.max(1, Math.floor((y1 - y0) / 4));
      const sx = Math.max(1, Math.floor((x1 - x0) / 4));
      for (let yy = y0; yy < y1; yy += sy)
        for (let xx = x0; xx < x1; xx += sx) {
          const i = (yy * src.width + xx) * 3;
          r += src.rgb[i]!;
          g += src.rgb[i + 1]!;
          b += src.rgb[i + 2]!;
          n++;
        }
      const o = ((oy + y) * width + ox + x) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return { width, height, rgb: out };
}

function indexed(img: Pixels): Uint8Array {
  const out = new Uint8Array(img.width * img.height);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const i = y * img.width + x;
      const d = (BAYER[(y & 3) * 4 + (x & 3)]! / 16 - 0.5) * 0.9;
      const q = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.round((v / 255) * (n - 1) + d)));
      out[i] = (q(img.rgb[i * 3]!, R) * G + q(img.rgb[i * 3 + 1]!, G)) * B + q(img.rgb[i * 3 + 2]!, B);
    }
  return out;
}

/** Compression LZW du GIF (codes de 9 à 12 bits), en sous-blocs de 255 octets. */
function lzw(pixels: Uint8Array, minCode = 8): Buffer {
  const clear = 1 << minCode;
  const end = clear + 1;
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  let size = minCode + 1;
  const put = (code: number) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      bytes.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  };
  let dict = new Map<number, number>();
  let next = end + 1;
  put(clear);
  let prefix = pixels[0] ?? 0;
  for (let i = 1; i < pixels.length; i++) {
    const c = pixels[i]!;
    const key = prefix * 256 + c;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    put(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      put(clear);
      dict = new Map();
      next = end + 1;
      size = minCode + 1;
    }
    prefix = c;
  }
  put(prefix);
  put(end);
  if (bits > 0) bytes.push(acc & 0xff);
  const out: number[] = [minCode];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return Buffer.from(out);
}

/** Les images, toutes à la taille de la première ; `delays` en centièmes de seconde. Rejoue en boucle. */
export function encodeGif(frames: Pixels[], delays: number[]): Buffer {
  if (!frames.length) throw new Error("GIF sans image");
  const { width, height } = frames[0]!;
  const parts: Buffer[] = [];
  const u16 = (v: number) => Buffer.from([v & 0xff, (v >> 8) & 0xff]);
  parts.push(Buffer.from("GIF89a", "ascii"), u16(width), u16(height), Buffer.from([0xf7, 0, 0]), Buffer.from(palette()));
  parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("NETSCAPE2.0", "ascii"), Buffer.from([3, 1, 0, 0, 0]));
  frames.forEach((f, k) => {
    const img = f.width === width && f.height === height ? f : fit(f, width, height);
    parts.push(Buffer.from([0x21, 0xf9, 4, 0]), u16(delays[k] ?? 100), Buffer.from([0, 0]));
    parts.push(Buffer.from([0x2c]), u16(0), u16(0), u16(width), u16(height), Buffer.from([0]));
    parts.push(lzw(indexed(img)));
  });
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
