import * as THREE from "three";

/**
 * Petit constructeur de voxels (ADR-106) : des boîtes colorées fusionnées en une seule géométrie (couleurs par sommet).
 * Tout le décor et les personnages de la Forge sont faits ainsi, en code, sans fichier graphique.
 */

// Chaque face : sa normale et ses 4 coins (cube unité), dans le sens trigonométrique vu de l'extérieur.
const FACES: { n: [number, number, number]; c: [number, number, number][] }[] = [
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];

/** Générateur pseudo-aléatoire déterministe : le décor est le même à chaque ouverture. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10_000) / 10_000;
  };
}

const tmp = new THREE.Color();

export class Vox {
  readonly #pos: number[] = [];
  readonly #nor: number[] = [];
  readonly #col: number[] = [];
  readonly #rand: () => number;
  readonly unit: number;

  constructor(unit = 1, seed = 7) {
    this.unit = unit;
    this.#rand = rng(seed);
  }

  get empty(): boolean {
    return this.#pos.length === 0;
  }

  /**
   * Une boîte : coin minimal (x, y, z), taille (w, h, d), en unités du constructeur. `jitter` fait varier un peu la teinte
   * (pierre, bois) ; `bottom` à false omet la face du dessous (invisible au sol).
   */
  box(x: number, y: number, z: number, w: number, h: number, d: number, color: string | number, jitter = 0, bottom = true): this {
    const u = this.unit;
    tmp.set(color);
    if (jitter) tmp.multiplyScalar(1 + (this.#rand() * 2 - 1) * jitter);
    for (const f of FACES) {
      if (!bottom && f.n[1] === -1) continue;
      const v = f.c.map(([a, b, c]) => [(x + a * w) * u, (y + b * h) * u, (z + c * d) * u] as const);
      for (const i of [0, 1, 2, 0, 2, 3]) {
        this.#pos.push(...v[i]!);
        this.#nor.push(...f.n);
        this.#col.push(tmp.r, tmp.g, tmp.b);
      }
    }
    return this;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.#pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.#nor, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.#col, 3));
    g.computeBoundingSphere();
    return g;
  }

  mesh(material: THREE.Material, shadows = true): THREE.Mesh {
    const m = new THREE.Mesh(this.geometry(), material);
    m.castShadow = shadows;
    m.receiveShadow = shadows;
    return m;
  }
}
