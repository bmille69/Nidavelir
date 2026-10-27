import { inflateSync } from "node:zlib";

/**
 * Comparaison de deux photos du jeu (ADR-84), sans dépendance : un petit décodeur PNG (8 bits, non entrelacé) et une
 * comparaison par cases. Chaque photo est réduite à une grille de cases (couleur moyenne) ; une case « change » si sa
 * couleur s'écarte nettement. Le grain, l'anticrénelage ou un léger décalage disparaissent dans la moyenne, un modèle
 * absent, retourné, d'une autre couleur ou d'une autre taille, non.
 */

export type Pixels = { width: number; height: number; rgb: Uint8Array };

export function decodePng(buf: Buffer): Pixels {
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error("pas une image PNG");
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  for (let p = 8; p + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]!;
      type = data[9]!;
      interlace = data[12]!;
    } else if (kind === "PLTE") palette = Buffer.from(data);
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    p += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (depth !== 8 || !channels || interlace) throw new Error(`PNG non pris en charge (profondeur ${depth}, type ${type}, entrelacé ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 3);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      const x = line[i]!;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    for (let xPix = 0; xPix < width; xPix++) {
      const o = (y * width + xPix) * 3;
      const s = xPix * channels;
      if (type === 2 || type === 6) {
        out[o] = cur[s]!;
        out[o + 1] = cur[s + 1]!;
        out[o + 2] = cur[s + 2]!;
      } else if (type === 3) {
        const k = cur[s]! * 3;
        out[o] = palette?.[k] ?? 0;
        out[o + 1] = palette?.[k + 1] ?? 0;
        out[o + 2] = palette?.[k + 2] ?? 0;
      } else out[o] = out[o + 1] = out[o + 2] = cur[s]!;
    }
    prev = cur;
  }
  return { width, height, rgb: out };
}

/** La photo réduite à une grille de cases de couleur moyenne (même grille quelle que soit la taille de la photo). */
function grid(p: Pixels, cols: number, rows: number): Float32Array {
  const g = new Float32Array(cols * rows * 3);
  const n = new Uint32Array(cols * rows);
  for (let y = 0; y < p.height; y++) {
    const r = Math.min(rows - 1, Math.floor((y * rows) / p.height));
    for (let x = 0; x < p.width; x++) {
      const c = Math.min(cols - 1, Math.floor((x * cols) / p.width));
      const k = r * cols + c;
      const o = (y * p.width + x) * 3;
      g[k * 3] = g[k * 3]! + p.rgb[o]!;
      g[k * 3 + 1] = g[k * 3 + 1]! + p.rgb[o + 1]!;
      g[k * 3 + 2] = g[k * 3 + 2]! + p.rgb[o + 2]!;
      n[k] = n[k]! + 1;
    }
  }
  for (let k = 0; k < cols * rows; k++) for (let ch = 0; ch < 3; ch++) g[k * 3 + ch] = g[k * 3 + ch]! / Math.max(1, n[k]!);
  return g;
}

export type ShotDiff = {
  /** Part des cases qui ont changé (0 à 1). */
  changed: number;
  /** Écart moyen de couleur (0 à 1). */
  mean: number;
  /** Où se trouve le changement, en clair (« en haut à gauche », « au centre »…), ou null. */
  where: string | null;
};

const COLS = 32;
const ROWS = 18;
/** Une case a changé si une de ses couleurs moyennes bouge de plus de 12 %. */
const CELL = 0.12 * 255;

export function compareShots(a: Buffer, b: Buffer): ShotDiff {
  const ga = grid(decodePng(a), COLS, ROWS);
  const gb = grid(decodePng(b), COLS, ROWS);
  let changed = 0;
  let sum = 0;
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < COLS * ROWS; k++) {
    let worst = 0;
    for (let ch = 0; ch < 3; ch++) {
      const d = Math.abs(ga[k * 3 + ch]! - gb[k * 3 + ch]!);
      worst = Math.max(worst, d);
      sum += d;
    }
    if (worst > CELL) {
      changed++;
      cx += k % COLS;
      cy += Math.floor(k / COLS);
    }
  }
  let where: string | null = null;
  if (changed) {
    const row = Math.min(2, Math.floor((((cy / changed + 0.5) * 3) / ROWS)));
    const col = Math.min(2, Math.floor((((cx / changed + 0.5) * 3) / COLS)));
    where = [["en haut", "au centre", "en bas"][row], ["à gauche", "", "à droite"][col]].filter(Boolean).join(" ");
  }
  return { changed: changed / (COLS * ROWS), mean: sum / (COLS * ROWS * 3 * 255), where };
}

/** Au-delà de 6 % des cases changées, l'aspect a changé ; deux photos d'une même vitrine animée dépassent 3 %. */
export const LOOK_CHANGED = 0.06;
export const LOOK_UNSTABLE = 0.03;
