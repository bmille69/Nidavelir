import * as THREE from "three";
import { MAX_BENCHES } from "./model.ts";
import { Vox } from "./voxel.ts";

/**
 * Le décor de la Forge (ADR-106) : une forge de nains taillée dans la montagne, vue en diorama.
 * Fond (z = 0) et gauche (x = 0) sont des murs ; le sol va de x 0 à 26 et de z 0 à 18.
 *   - au fond : la salle du conseil (Directeur, Concepteur), le scriptorium (Archiviste), l'atelier d'art (DA, son) ;
 *   - au centre : la grande forge (le creuset), autour de laquelle on se repose ; une rigole de métal en fusion
 *     en part et nourrit les postes de forge ;
 *   - devant : les postes de forge (un par chantier simultané), le banc d'essai (Testeur), les rails et le trésor ;
 *   - à gauche : la porte (Gardien), la file des caisses et le tableau du chef de chantier ; devant : votre trône.
 * Les matériaux lumineux sont « au-delà du blanc » (couleurs > 1) : c'est ce qui brille dans le halo (bloom).
 */

export type P = { x: number; z: number };
export type Station = P & { yaw: number; sit?: boolean; exit?: P[] };

export type Fire = { mat: THREE.MeshBasicMaterial; light: THREE.PointLight | null; flames: THREE.Object3D[]; base: number; phase: number };

export type Anvil = {
  group: THREE.Group;
  furnace: Fire;
  crate: THREE.Mesh;
  crateMat: THREE.MeshLambertMaterial;
  sign: THREE.Object3D;
  /** Le même objet pour toute la vie de la scène : seules ses coordonnées changent avec le nombre de postes. */
  station: Station;
  spark: THREE.Vector3;
};

export type World = {
  group: THREE.Group;
  sky: THREE.MeshBasicMaterial;
  sun: THREE.Mesh;
  moon: THREE.Mesh;
  fires: Fire[];
  hearth: Fire;
  lava: THREE.MeshBasicMaterial;
  runes: THREE.MeshBasicMaterial;
  embers: THREE.Vector3[];
  anvils: Anvil[];
  queueCrates: THREE.Mesh[];
  qaCrate: THREE.Mesh;
  scrolls: THREE.Mesh[];
  tableLamp: Fire;
  gateLamp: { mat: THREE.MeshBasicMaterial; light: THREE.PointLight | null };
  cart: THREE.Group;
  cartCrate: THREE.Mesh;
  rails: THREE.Vector3[];
  vaultLid: THREE.Group;
  anchors: { queue: THREE.Object3D; table: THREE.Object3D; vault: THREE.Object3D; qa: THREE.Object3D; board: THREE.Object3D };
  pickables: THREE.Object3D[];
  stations: Record<"director" | "concepteur" | "archivist" | "art_director" | "qa" | "guardian" | "foreman", Station>;
  idle: Station[];
  readonly benchCount: number;
  /** Place les postes pour n chantiers simultanés ; rend true si la disposition a changé. */
  layoutBenches(n: number): boolean;
};

export const BOUNDS = { w: 26, d: 18 };

const BASALT = ["#323845", "#2d323e", "#363c4a", "#2a2f3a"];
const WALL = "#323845";
const WALL_D = "#272c36";
const STONE = "#3a3f4b";
const BRONZE = "#b07a3a";
const BRONZE_D = "#7a5228";
const GOLD = "#e8b84a";
const IRON = "#4b525d";
const IRON_D = "#30353e";
const WOOD = "#5a3a22";
const WOOD_D = "#3c2616";
const PARCH = "#e9dcb8";

/** Une couleur « lumineuse » : au-delà de 1, elle passe le seuil du halo. */
export function hdr(hex: string, k: number): THREE.Color {
  return new THREE.Color(hex).multiplyScalar(k);
}

function crateVox(v: Vox, x: number, y: number, z: number, s: number) {
  v.box(x, y, z, s, s, s, "#8a5e36", 0.06);
  const b = s * 0.12;
  v.box(x - 0.01, y, z - 0.01, s + 0.02, b, s + 0.02, IRON_D);
  v.box(x - 0.01, y + s - b, z - 0.01, s + 0.02, b, s + 0.02, IRON_D);
  v.box(x + s / 2 - b / 2, y, z - 0.015, b, s, s + 0.03, IRON_D);
  v.box(x + s / 2 - b, y + s / 2 - b, z + s, b * 2, b * 2, 0.02, GOLD);
}

export function crateGeometry(s = 0.6): THREE.BufferGeometry {
  const v = new Vox(1, 5);
  crateVox(v, -s / 2, 0, -s / 2, s);
  return v.geometry();
}

function fire(group: THREE.Group, x: number, y: number, z: number, size: number, opts: { light: boolean; intensity: number; distance: number; color?: string }): Fire {
  const mat = new THREE.MeshBasicMaterial({ color: hdr(opts.color ?? "#ff7a1a", 2.6) });
  const inner = new THREE.MeshBasicMaterial({ color: hdr("#ffd27a", 3.2) });
  const flames: THREE.Object3D[] = [];
  const f = new THREE.Group();
  f.position.set(x, y, z);
  const a = new THREE.Mesh(new THREE.BoxGeometry(size, size * 1.3, size), mat);
  a.position.y = size * 0.65;
  const b = new THREE.Mesh(new THREE.BoxGeometry(size * 0.55, size * 0.9, size * 0.55), inner);
  b.position.y = size * 0.5;
  f.add(a, b);
  flames.push(a, b);
  group.add(f);
  let light: THREE.PointLight | null = null;
  if (opts.light) {
    light = new THREE.PointLight(opts.color ?? "#ff8a3c", opts.intensity, opts.distance, 1.6);
    light.position.set(x, y + size + 0.3, z);
    group.add(light);
  }
  return { mat, light, flames, base: opts.intensity, phase: Math.random() * 10 };
}

export function buildWorld(material: THREE.Material, mini: boolean): World {
  const group = new THREE.Group();
  const pickables: THREE.Object3D[] = [];
  const fires: Fire[] = [];
  const embers: THREE.Vector3[] = [];
  const add = (v: Vox, shadows = true) => {
    const m = v.mesh(material, shadows && !mini);
    group.add(m);
    return m;
  };
  const pickGroup = (id: string, ...objs: THREE.Object3D[]) => {
    for (const o of objs) {
      o.userData.pick = id;
      pickables.push(o);
    }
  };
  const lava = new THREE.MeshBasicMaterial({ color: hdr("#ff3c00", 2.4) });
  const runes = new THREE.MeshBasicMaterial({ color: hdr("#00e5ff", 1.3) });
  const lavaV = new Vox(1, 41);
  const runeV = new Vox(1, 43);

  // ── Le socle : basalte, liseré de bronze, dalles ──
  const floor = new Vox(1, 3);
  floor.box(-1.3, -1.6, -1.3, BOUNDS.w + 1.6, 1.25, BOUNDS.d + 1.6, "#12151c");
  floor.box(-1.35, -0.42, -1.35, BOUNDS.w + 1.7, 0.1, BOUNDS.d + 1.7, BRONZE_D);
  floor.box(-1.2, -0.34, -1.2, BOUNDS.w + 1.4, 0.14, BOUNDS.d + 1.4, "#1a1e26");
  // Bas-reliefs sur les faces avant du socle.
  for (let x = 0; x < BOUNDS.w; x += 2) floor.box(x + 0.3, -1.3, BOUNDS.d + 0.3, 1.4, 0.7, 0.05, "#1c2029");
  for (let z = 0; z < BOUNDS.d; z += 2) floor.box(BOUNDS.w + 0.3, -1.3, z + 0.3, 0.05, 0.7, 1.4, "#1c2029");
  for (let x = 0; x < BOUNDS.w; x++)
    for (let z = 0; z < BOUNDS.d; z++) floor.box(x + 0.03, -0.2, z + 0.03, 0.94, 0.2, 0.94, BASALT[(x * 7 + z * 13 + ((x * z) % 3)) % BASALT.length]!, 0.06, false);
  // Liserés de bronze au sol : ils dessinent les ateliers.
  const inlay = (x: number, z: number, w: number, d: number) => {
    floor.box(x, 0, z, w, 0.02, 0.08, BRONZE);
    floor.box(x, 0, z + d - 0.08, w, 0.02, 0.08, BRONZE);
    floor.box(x, 0, z, 0.08, 0.02, d, BRONZE);
    floor.box(x + w - 0.08, 0, z, 0.08, 0.02, d, BRONZE);
  };
  inlay(2, 1.2, 6.6, 4.4);
  inlay(17.6, 1.2, 6.8, 4.4);
  inlay(9.9, 5.4, 6.2, 4.6);
  inlay(18.6, 11.9, 4.4, 3.2);
  floor.box(2.5, 0, 1.7, 5.6, 0.03, 3.4, "#0d2f39");
  floor.box(2.8, 0.005, 2.0, 5.0, 0.03, 2.8, "#103a46");
  floor.box(18.1, 0, 1.7, 5.8, 0.03, 3.4, "#32180e");
  floor.box(10.9, 0, 15.8, 4.2, 0.03, 2.0, "#32180e");
  add(floor);

  // ── La rigole de métal en fusion : du creuset aux postes de forge ──
  const channel = new Vox(1, 44);
  const chan = (x: number, z: number, w: number, d: number) => {
    // Bords de fer surélevés, métal en fusion entre les deux.
    channel.box(x - 0.14, 0, z - 0.14, w + 0.28, 0.12, 0.14, IRON_D);
    channel.box(x - 0.14, 0, z + d, w + 0.28, 0.12, 0.14, IRON_D);
    channel.box(x - 0.14, 0, z, 0.14, 0.12, d, IRON_D);
    channel.box(x + w, 0, z, 0.14, 0.12, d, IRON_D);
    lavaV.box(x, 0, z, w, 0.07, d, "#ffffff");
  };
  chan(12.75, 9.1, 0.5, 1.75);
  chan(4.3, 10.8, 13.0, 0.5);
  // Croûtes sombres (le métal refroidit en surface).
  for (let i = 0; i < 26; i++) {
    const x = 4.4 + ((i * 37) % 128) / 10;
    channel.box(x, 0.07, 10.88 + ((i * 7) % 3) * 0.1, 0.18 + (i % 3) * 0.08, 0.02, 0.12, "#3a1a0c");
  }
  for (let x = 4.3; x < 17.3; x += 1.6) embers.push(new THREE.Vector3(x + 0.4, 0.1, 11.05));
  embers.push(new THREE.Vector3(13, 0.1, 10));
  add(channel, false);

  // ── Les murs : pierres taillées, piliers à chapiteau de bronze, runes cyan, fenêtres, la porte ──
  const wall = new Vox(1, 9);
  const backHole = (x: number, y: number) => (x >= 9 && x < 11 && y >= 1 && y < 4) || (x >= 15 && x < 17 && y >= 1 && y < 4);
  const leftHole = (z: number, y: number) => (z >= 3 && z < 5 && y >= 1 && y < 4) || (z >= 9 && z < 11 && y < 3);
  for (let y = 0; y < 5; y++) {
    for (let x = -1; x < BOUNDS.w; x++) if (!backHole(x, y)) wall.box(x + 0.03, y + 0.03, -1 + ((x + y) % 2) * 0.05, 0.94, 0.94, 1, (x + y) % 3 ? WALL : WALL_D, 0.08);
    for (let z = 0; z < BOUNDS.d; z++) if (!leftHole(z, y)) wall.box(-1 + ((z + y) % 2) * 0.05, y + 0.03, z + 0.03, 1, 0.94, 0.94, (z + y) % 3 ? WALL : WALL_D, 0.08);
  }
  wall.box(-1.2, 5, -1.2, BOUNDS.w + 1.2, 0.18, 1.4, BRONZE_D);
  wall.box(-1.2, 5, -1.2, 1.4, 0.18, BOUNDS.d + 1.2, BRONZE_D);
  wall.box(-1.3, 5.18, -1.3, BOUNDS.w + 1.3, 0.3, 1.5, "#2b303a");
  wall.box(-1.3, 5.18, -1.3, 1.5, 0.3, BOUNDS.d + 1.3, "#2b303a");
  const pillar = (x: number, z: number) => {
    wall.box(x - 0.35, 0, z - 0.35, 0.7, 5, 0.7, "#2c323d", 0.04);
    wall.box(x - 0.45, 0, z - 0.45, 0.9, 0.35, 0.9, "#343a46");
    wall.box(x - 0.45, 4.55, z - 0.45, 0.9, 0.45, 0.9, BRONZE);
    wall.box(x - 0.38, 2.4, z - 0.38, 0.76, 0.12, 0.76, BRONZE_D);
  };
  for (const x of [0.4, 8.2, 13.0, 17.8, 25.4]) pillar(x, 0.05);
  for (const z of [6.6, 12.3, 17.6]) pillar(0.05, z);
  // Bande de runes au pied des murs, et au-dessus des fenêtres.
  for (let x = 0.9; x < BOUNDS.w - 0.5; x += 0.9) if (!(x > 7.6 && x < 8.8) && !(x > 12.4 && x < 13.6) && !(x > 17.2 && x < 18.4)) runeV.box(x, 0.55 + ((x * 10) % 3) * 0.04, -0.02, 0.45, 0.06, 0.04, "#fff");
  for (let z = 0.9; z < BOUNDS.d - 0.5; z += 0.9) if (!(z > 8.4 && z < 11.6) && !(z > 6 && z < 7.2) && !(z > 11.7 && z < 12.9)) runeV.box(-0.02, 0.55 + ((z * 10) % 3) * 0.04, z, 0.04, 0.06, 0.45, "#fff");
  for (const x0 of [9, 15]) runeV.box(x0 + 0.3, 4.32, -0.02, 1.4, 0.07, 0.04, "#fff");
  for (const x0 of [9, 15]) {
    wall.box(x0 - 0.15, 0.82, -0.2, 2.3, 0.18, 0.4, BRONZE_D);
    wall.box(x0 - 0.15, 4, -0.2, 2.3, 0.2, 0.4, BRONZE_D);
    wall.box(x0 + 0.95, 1, -0.55, 0.1, 3, 0.1, "#15171c");
    wall.box(x0, 2.45, -0.55, 2, 0.1, 0.1, "#15171c");
  }
  wall.box(-0.2, 0.82, 2.85, 0.4, 0.18, 2.3, BRONZE_D);
  wall.box(-0.2, 4, 2.85, 0.4, 0.2, 2.3, BRONZE_D);
  wall.box(-0.55, 1, 3.95, 0.1, 3, 0.1, "#15171c");
  // La porte : grande arche de pierre, battants bardés de fer.
  wall.box(-0.35, 3, 8.6, 0.6, 0.6, 2.8, "#343a46");
  wall.box(-0.35, 0, 8.6, 0.6, 3, 0.4, "#343a46");
  wall.box(-0.35, 0, 11.0, 0.6, 3, 0.4, "#343a46");
  wall.box(-0.3, 3.3, 9.6, 0.62, 0.35, 0.8, BRONZE);
  wall.box(-0.75, 0, 9, 0.2, 2.95, 1, WOOD, 0.05);
  wall.box(-0.75, 0, 10, 0.2, 2.95, 1, WOOD_D, 0.05);
  for (const y of [0.5, 1.5, 2.5]) wall.box(-0.6, y, 9, 0.1, 0.16, 2, IRON);
  wall.box(-0.58, 1.3, 9.85, 0.1, 0.3, 0.3, GOLD);
  // Boucliers.
  for (const [z, c] of [[7.6, "#6a1e1e"], [13.4, "#1e4a6a"]] as const) {
    wall.box(-0.1, 1.8, z - 0.45, 0.1, 0.9, 0.9, c);
    wall.box(-0.05, 2.1, z - 0.15, 0.1, 0.3, 0.3, GOLD);
    wall.box(-0.08, 1.75, z - 0.5, 0.12, 0.1, 1.0, BRONZE_D);
  }
  add(wall, false);

  // Chaînes qui pendent de la corniche.
  const chains = new Vox(1, 19);
  for (const [x, z] of [[4, 0.3], [21, 0.3], [0.3, 15]] as const) for (let y = 3.6; y < 5; y += 0.2) chains.box(x - 0.05, y, z - 0.05, 0.1, 0.12, 0.1, IRON);
  add(chains, false);

  // Le ciel derrière les fenêtres, qui suit l'heure.
  const sky = new THREE.MeshBasicMaterial({ color: "#8fd0ff" });
  for (const x0 of [9, 15]) {
    const pane = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 0.05), sky);
    pane.position.set(x0 + 1, 2.5, -0.7);
    group.add(pane);
  }
  const lpane = new THREE.Mesh(new THREE.BoxGeometry(0.05, 3, 2), sky);
  lpane.position.set(-0.7, 2.5, 4);
  group.add(lpane);
  const sun = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.05), new THREE.MeshBasicMaterial({ color: hdr("#fff0b0", 2) }));
  const moon = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.05), new THREE.MeshBasicMaterial({ color: hdr("#e6ecff", 1.6) }));
  sun.position.set(16, 3, -0.66);
  moon.position.set(10, 3, -0.66);
  group.add(sun, moon);

  // ── Bannières ──
  const deco = new Vox(1, 21);
  const banner = (x: number, cloth: string, sign: (cx: number) => void) => {
    deco.box(x - 0.1, 4.3, -0.14, 2.0, 0.12, 0.16, BRONZE);
    deco.box(x, 1.5, -0.08, 1.8, 2.8, 0.08, cloth);
    deco.box(x, 1.25, -0.08, 0.6, 0.3, 0.08, cloth);
    deco.box(x + 1.2, 1.25, -0.08, 0.6, 0.3, 0.08, cloth);
    deco.box(x + 0.08, 1.6, -0.03, 0.08, 2.6, 0.04, GOLD);
    deco.box(x + 1.64, 1.6, -0.03, 0.08, 2.6, 0.04, GOLD);
    sign(x + 0.9);
  };
  banner(4.1, "#0a4a58", (cx) => {
    deco.box(cx - 0.12, 2.3, -0.02, 0.24, 1.2, 0.05, GOLD); // marteau d'or
    deco.box(cx - 0.5, 3.2, -0.02, 1.0, 0.38, 0.05, GOLD);
  });
  banner(20.1, "#6a220a", (cx) => {
    deco.box(cx - 0.35, 2.4, -0.02, 0.7, 0.7, 0.05, "#ff5a00");
    deco.box(cx - 0.15, 3.2, -0.02, 0.3, 0.6, 0.05, "#ffb070");
  });

  // ── La salle du conseil : table de pierre, carte runique ──
  deco.box(3, 0, 3.1, 4, 0.7, 1.6, STONE, 0.05);
  deco.box(2.9, 0.7, 3.0, 4.2, 0.12, 1.8, "#4a505e");
  deco.box(2.88, 0.66, 2.98, 4.24, 0.06, 1.84, BRONZE);
  deco.box(3.3, 0.82, 3.25, 3.4, 0.03, 1.3, PARCH);
  deco.box(3.8, 0.85, 3.5, 0.9, 0.02, 0.6, "#7cc0a0");
  deco.box(5.2, 0.85, 3.7, 1.0, 0.02, 0.5, "#6a9fd0");
  runeV.box(4.45, 0.85, 3.55, 0.1, 0.25, 0.1, "#fff");
  runeV.box(5.75, 0.85, 3.85, 0.1, 0.25, 0.1, "#fff");
  for (const x of [3.6, 6.0]) {
    deco.box(x, 0, 1.4, 0.6, 0.45, 0.6, STONE);
    deco.box(x, 0.45, 1.3, 0.6, 0.6, 0.12, STONE);
  }

  // ── Le scriptorium ──
  deco.box(11.3, 0, 0, 3.4, 3.4, 0.8, WOOD_D, 0.04);
  deco.box(11.25, 3.4, -0.05, 3.5, 0.15, 0.9, BRONZE_D);
  for (let s = 0; s < 4; s++) {
    deco.box(11.4, 0.15 + s * 0.8, 0.1, 3.2, 0.08, 0.7, "#2a1a0e");
    let x = 11.5;
    let k = s * 5;
    while (x < 14.5) {
      const w = 0.12 + ((k * 37) % 5) * 0.03;
      const h = 0.45 + ((k * 13) % 4) * 0.06;
      deco.box(x, 0.23 + s * 0.8, 0.2, w, h, 0.5, ["#6a2626", "#264a6a", "#4a6a26", "#6a5a26", "#40366a", "#266a5a"][k % 6]!, 0.1);
      x += w + 0.03;
      k++;
    }
  }
  deco.box(12.6, 0, 2.6, 0.8, 0.85, 0.6, STONE, 0.05);
  deco.box(12.45, 0.85, 2.5, 1.1, 0.1, 0.8, BRONZE_D);
  deco.box(12.55, 0.95, 2.6, 0.9, 0.04, 0.6, PARCH);
  deco.box(13.7, 0, 2.8, 0.25, 0.9, 0.25, IRON_D);

  // ── L'atelier d'art et de son ──
  deco.box(18.5, 0, 3.0, 0.1, 1.6, 0.1, WOOD);
  deco.box(19.9, 0, 3.0, 0.1, 1.6, 0.1, WOOD);
  deco.box(19.2, 0, 2.6, 0.1, 1.8, 0.1, WOOD);
  deco.box(18.35, 0.75, 3.0, 1.8, 1.3, 0.06, BRONZE_D);
  deco.box(18.4, 0.8, 3.05, 1.7, 1.2, 0.08, "#f2ead8");
  deco.box(18.5, 1.45, 3.14, 1.5, 0.45, 0.02, "#7cc0e8");
  deco.box(18.6, 1.1, 3.14, 0.6, 0.45, 0.02, "#e8eef6");
  deco.box(19.1, 1.0, 3.14, 0.8, 0.6, 0.02, "#c8d4e4");
  deco.box(19.5, 1.6, 3.15, 0.3, 0.3, 0.02, "#ff5a00");
  deco.box(18.5, 0.88, 3.14, 1.5, 0.15, 0.02, "#3a6a4a");
  deco.box(21.8, 0, 1.6, 1.4, 0.75, 0.9, STONE, 0.05);
  deco.box(21.75, 0.72, 1.55, 1.5, 0.06, 1.0, BRONZE_D);
  ["#ff5a00", "#00e5ff", "#7cc79a", GOLD, "#a99be0"].forEach((c, i) => deco.box(21.9 + i * 0.26, 0.78, 1.85, 0.2, 0.22, 0.2, c));
  // Une statue en cours de taille, et le grand tambour du directeur sonore.
  deco.box(22.6, 0, 3.8, 0.9, 0.4, 0.9, STONE);
  deco.box(22.75, 0.4, 3.95, 0.6, 1.0, 0.6, "#8a8f9a", 0.08);
  deco.box(22.85, 1.4, 4.05, 0.4, 0.4, 0.4, "#9aa0aa");
  deco.box(23.8, 0, 2.0, 1.0, 0.8, 1.0, "#5a1e0a");
  deco.box(23.75, 0.8, 1.95, 1.1, 0.08, 1.1, PARCH);
  deco.box(23.75, 0.1, 1.95, 1.1, 0.08, 1.1, GOLD);

  // ── La grande forge : creuset, gueules de feu, hotte de bronze ──
  deco.box(11.6, 0, 6.6, 2.8, 0.35, 2.4, "#343a46", 0.05);
  deco.box(11.85, 0.35, 6.85, 2.3, 1.5, 1.9, "#2c313c", 0.06);
  deco.box(11.8, 0.9, 6.8, 2.4, 0.14, 2.0, BRONZE);
  deco.box(11.8, 1.85, 6.8, 2.4, 0.16, 2.0, BRONZE_D);
  for (let k = 0; k < 5; k++) {
    const w = 2.0 - k * 0.3;
    deco.box(13 - w / 2, 2.0 + k * 0.55, 7.8 - w / 2 + 0.1, w, 0.55, w * 0.85, k % 2 ? "#2c313c" : "#343a46", 0.05);
    deco.box(13 - w / 2 - 0.03, 2.0 + k * 0.55, 7.8 - w / 2 + 0.07, w + 0.06, 0.08, w * 0.85 + 0.06, BRONZE_D);
  }
  // Bancs de pierre autour.
  deco.box(11.4, 0, 5.75, 3.2, 0.3, 0.45, STONE, 0.05);
  deco.box(11.4, 0, 9.55, 1.2, 0.3, 0.45, STONE, 0.05);
  deco.box(13.4, 0, 9.55, 1.2, 0.3, 0.45, STONE, 0.05);
  deco.box(10.2, 0, 6.8, 0.45, 0.3, 2.2, STONE, 0.05);
  deco.box(15.35, 0, 6.8, 0.45, 0.3, 2.2, STONE, 0.05);
  // Minerai : wagonnet de mithril (cristaux cyan) et tas de charbon.
  deco.box(16.4, 0.12, 5.0, 1.0, 0.55, 0.7, IRON, 0.05);
  deco.box(16.35, 0.62, 4.95, 1.1, 0.08, 0.8, IRON_D);
  for (const [x, z] of [[16.5, 5.4], [17.1, 5.4], [16.5, 4.95], [17.1, 4.95]] as const) deco.box(x, 0, z, 0.14, 0.16, 0.08, "#15171c");
  deco.box(9.0, 0, 5.4, 0.9, 0.25, 0.8, "#15171c", 0.2);
  deco.box(9.15, 0.25, 5.55, 0.6, 0.18, 0.5, "#1c1e24", 0.2);
  add(deco);
  for (const [x, y, z, s] of [[16.55, 0.68, 5.1, 0.12], [16.85, 0.7, 5.25, 0.14], [17.1, 0.68, 5.05, 0.1]] as const) runeV.box(x, y, z, s, s * 1.6, s, "#fff");

  // Les gueules de la grande forge et le métal qui coule vers la rigole.
  lavaV.box(12.35, 0.45, 8.72, 1.3, 0.4, 0.06, "#fff");
  lavaV.box(11.82, 0.45, 7.35, 0.06, 0.4, 0.9, "#fff");
  lavaV.box(14.12, 0.45, 7.35, 0.06, 0.4, 0.9, "#fff");
  lavaV.box(12.85, 0.35, 8.75, 0.3, 0.06, 0.4, "#fff");
  const hearth = fire(group, 13, 0.36, 8.95, 0.32, { light: true, intensity: 28, distance: 12 });
  fires.push(hearth);
  embers.push(new THREE.Vector3(13, 2.3, 7.75), new THREE.Vector3(13, 0.6, 8.8));

  // ── Torches et feux ──
  const torch = (x: number, y: number, z: number, side: "back" | "left") => {
    const v = new Vox(1);
    if (side === "back") {
      v.box(x - 0.06, y - 0.45, -0.05, 0.12, 0.55, 0.3, IRON_D);
      v.box(x - 0.14, y - 0.05, 0.1, 0.28, 0.08, 0.28, BRONZE);
    } else {
      v.box(-0.05, y - 0.45, z - 0.06, 0.3, 0.55, 0.12, IRON_D);
      v.box(0.1, y - 0.05, z - 0.14, 0.28, 0.08, 0.28, BRONZE);
    }
    add(v, false);
    fires.push(fire(group, side === "back" ? x : 0.24, y + 0.03, side === "back" ? 0.24 : z, 0.16, { light: !mini, intensity: 9, distance: 8 }));
  };
  torch(7.0, 2.7, 0, "back");
  torch(19.0, 2.7, 0, "back");
  torch(0, 2.7, 5.8, "left");
  torch(0, 2.7, 15.0, "left");
  fires.push(fire(group, 13.82, 0.9, 2.92, 0.07, { light: !mini, intensity: 3, distance: 3.5, color: "#ffc070" }));
  const tableLamp = fire(group, 14.1, 0.88, 16.75, 0.1, { light: !mini, intensity: 4, distance: 4, color: "#ff7a2a" });
  fires.push(tableLamp);

  // Lanterne de la porte : cyan au calme, braise quand le Gardien bloque une action.
  const gateMat = new THREE.MeshBasicMaterial({ color: hdr("#00e5ff", 2.2) });
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 0.22), gateMat);
  lamp.position.set(0.28, 3.25, 11.75);
  group.add(lamp);
  const gateLight = mini ? null : new THREE.PointLight("#00e5ff", 3, 5, 1.6);
  if (gateLight) {
    gateLight.position.set(0.6, 3.1, 11.75);
    group.add(gateLight);
  }

  // ── Les postes de forge ──
  // Repère local : le développeur au centre, l'enclume devant lui (vers vous), son fourneau derrière à gauche,
  // la caisse du chantier sur un billot à gauche, le bac de trempe à droite. Il arrive par la droite.
  const crateGeo = crateGeometry();
  const anvils: Anvil[] = [];
  for (let i = 0; i < MAX_BENCHES; i++) {
    const g = new THREE.Group();
    const v = new Vox(1, 30 + i);
    v.box(-1.8, 0, -1.55, 1.3, 1.25, 1.2, "#2e333e", 0.08); // fourneau
    v.box(-1.85, 0.6, -1.6, 1.4, 0.1, 1.3, BRONZE_D);
    v.box(-1.88, 1.25, -1.63, 1.46, 0.14, 1.36, BRONZE);
    v.box(-1.45, 1.39, -1.3, 0.6, 1.3, 0.6, "#2a2f39", 0.06); // cheminée
    v.box(-1.5, 2.3, -1.35, 0.7, 0.1, 0.7, BRONZE_D);
    v.box(-1.62, 0.2, -0.38, 0.95, 0.6, 0.04, "#120806");
    v.box(-0.45, 0, -1.2, 0.35, 0.3, 0.7, "#4a2e1a"); // soufflet
    v.box(-0.42, 0.3, -1.15, 0.3, 0.08, 0.6, "#2a1a0e");
    v.box(-0.25, 0, 0.75, 0.5, 0.36, 0.42, IRON_D); // enclume
    v.box(-0.5, 0.36, 0.62, 1.0, 0.24, 0.68, "#5f6773");
    v.box(0.5, 0.42, 0.8, 0.28, 0.12, 0.32, "#5f6773");
    v.box(-0.52, 0.58, 0.6, 1.04, 0.03, 0.72, "#8a929e");
    v.box(-1.45, 0, 0.5, 0.7, 0.35, 0.7, WOOD_D); // billot de la caisse
    v.box(0.8, 0, 0.55, 0.65, 0.42, 0.65, IRON); // bac de trempe
    v.box(0.86, 0.42, 0.61, 0.53, 0.02, 0.53, "#1d3b55");
    v.box(0.78, 0.38, 0.53, 0.69, 0.06, 0.69, BRONZE_D);
    v.box(1.1, 0, -0.9, 0.08, 1.2, 0.08, WOOD_D); // râtelier à outils
    v.box(0.75, 1.1, -0.9, 0.8, 0.08, 0.08, WOOD_D);
    v.box(0.85, 0.6, -0.88, 0.06, 0.5, 0.06, IRON);
    v.box(1.3, 0.55, -0.88, 0.06, 0.55, 0.06, IRON);
    const m = v.mesh(material, !mini);
    g.add(m);
    const mouthMat = new THREE.MeshBasicMaterial({ color: hdr("#ff6a1a", 2.6) });
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.5, 0.04), mouthMat);
    mouth.position.set(-1.15, 0.5, -0.34);
    g.add(mouth);
    let light: THREE.PointLight | null = null;
    if (!mini) {
      light = new THREE.PointLight("#ff7a2a", 7, 5, 1.6);
      light.position.set(-1.1, 0.8, 0.1);
      g.add(light);
    }
    const crateMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color("#ff5a00"), emissiveIntensity: 0 });
    const crate = new THREE.Mesh(crateGeo, crateMat);
    crate.position.set(-1.1, 0.35, 0.85);
    crate.castShadow = !mini;
    g.add(crate);
    const sign = new THREE.Object3D();
    sign.position.set(0, 0, 2.0);
    g.add(sign);
    group.add(g);
    pickGroup(`bench:${i}`, m, crate);
    anvils.push({
      group: g,
      furnace: { mat: mouthMat, light, flames: [mouth], base: 7, phase: i * 1.7 },
      crate,
      crateMat,
      sign,
      station: { x: 0, z: 12.95, yaw: 0, exit: [{ x: 0, z: 12.95 }] },
      spark: new THREE.Vector3(),
    });
  }
  // Grilles posées sur la rigole, là où l'on passe pour rejoindre son poste.
  const grateV = new Vox(1, 50);
  grateV.box(-0.4, 0.04, -0.3, 0.8, 0.05, 0.6, IRON_D);
  for (let k = 0; k < 4; k++) grateV.box(-0.38 + k * 0.22, 0.09, -0.3, 0.08, 0.03, 0.6, IRON);
  const grateGeo = grateV.geometry();
  const grates: THREE.Mesh[] = [];
  for (let i = 0; i < MAX_BENCHES; i++) {
    const gm = new THREE.Mesh(grateGeo, material);
    gm.receiveShadow = !mini;
    group.add(gm);
    grates.push(gm);
  }
  const bridge = new THREE.Mesh(grateGeo, material);
  bridge.position.set(13, 0, 10.45);
  bridge.rotation.y = Math.PI / 2;
  group.add(bridge);

  let benchCount = 0;
  const layoutBenches = (n: number) => {
    if (n === benchCount) return false;
    benchCount = n;
    anvils.forEach((a, i) => {
      const x = 10 + (i - (n - 1) / 2) * 3.4;
      a.group.visible = i < n;
      grates[i]!.visible = i < n;
      a.group.position.set(x, 0, 12.95);
      grates[i]!.position.set(x + 0.95, 0, 11.05);
      // Mêmes objets, nouvelles coordonnées : un nain en route garde sa destination.
      a.station.x = x;
      a.station.exit = [{ x: x + 0.95, z: 12.95 }];
      a.spark.set(x, 0.62, 13.9);
    });
    return true;
  };
  layoutBenches(2);

  // ── La file et le tableau du chef de chantier ──
  const rack = new Vox(1, 61);
  rack.box(0.9, 0, 12.75, 1.9, 0.1, 1.9, IRON_D);
  for (const [x, z] of [[0.9, 12.75], [2.7, 12.75], [0.9, 14.55], [2.7, 14.55]] as const) rack.box(x, 0, z, 0.1, 1.55, 0.1, IRON);
  rack.box(0.9, 1.5, 12.75, 1.9, 0.08, 0.1, BRONZE_D);
  rack.box(0.9, 1.5, 14.55, 1.9, 0.08, 0.1, BRONZE_D);
  rack.box(-0.12, 1.0, 15.6, 0.12, 1.6, 2.0, "#1a3328");
  rack.box(-0.14, 0.92, 15.5, 0.14, 0.1, 2.2, BRONZE_D);
  rack.box(-0.14, 2.6, 15.5, 0.14, 0.1, 2.2, BRONZE_D);
  for (let i = 0; i < 4; i++) rack.box(-0.02, 1.25 + i * 0.32, 15.8, 0.03, 0.05, 0.6 + ((i * 7) % 4) * 0.25, "#e8efe8");
  add(rack);
  const queueCrates: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) {
    const c = new THREE.Mesh(crateGeo, material);
    c.position.set(1.4 + (i % 2) * 0.85, 0.1 + Math.floor(i / 4) * 0.64, 13.25 + (Math.floor(i / 2) % 2) * 0.85);
    c.castShadow = !mini;
    c.visible = false;
    group.add(c);
    queueCrates.push(c);
  }

  // ── Le banc d'essai ──
  const bench = new Vox(1, 62);
  bench.box(19.2, 0, 13.0, 2.6, 0.75, 1.0, STONE, 0.05);
  bench.box(19.1, 0.75, 12.9, 2.8, 0.1, 1.2, IRON);
  bench.box(19.08, 0.7, 12.88, 2.84, 0.05, 1.24, BRONZE);
  bench.box(21.3, 0.85, 13.2, 0.1, 0.5, 0.1, BRONZE); // balance
  bench.box(21.0, 1.3, 13.2, 0.7, 0.05, 0.1, BRONZE);
  bench.box(20.95, 1.05, 13.15, 0.2, 0.05, 0.2, GOLD);
  bench.box(21.55, 1.05, 13.15, 0.2, 0.05, 0.2, GOLD);
  add(bench);
  // Runes de test gravées sur le plateau.
  runeV.box(19.4, 0.851, 13.1, 0.3, 0.01, 0.05, "#fff");
  runeV.box(19.4, 0.851, 13.3, 0.22, 0.01, 0.05, "#fff");
  runeV.box(19.8, 0.851, 13.1, 0.05, 0.01, 0.3, "#fff");
  const qaCrate = new THREE.Mesh(crateGeo, material);
  qaCrate.position.set(20.6, 0.85, 13.45);
  qaCrate.castShadow = !mini;
  qaCrate.visible = false;
  group.add(qaCrate);

  // ── Votre table et votre trône ──
  const throne = new Vox(1, 63);
  throne.box(11.5, 0, 16.4, 3, 0.75, 0.9, STONE, 0.05);
  throne.box(11.4, 0.75, 16.3, 3.2, 0.1, 1.1, "#4a505e");
  throne.box(11.38, 0.72, 16.28, 3.24, 0.05, 1.14, BRONZE);
  throne.box(11.6, 0.85, 16.5, 2.8, 0.02, 0.7, "#6a220a");
  throne.box(12.45, 0, 17.25, 1.1, 0.55, 0.75, STONE);
  throne.box(12.4, 0.55, 17.85, 1.2, 1.6, 0.2, STONE);
  throne.box(12.35, 2.1, 17.8, 1.3, 0.15, 0.3, GOLD);
  throne.box(12.85, 2.25, 17.82, 0.3, 0.3, 0.2, GOLD);
  throne.box(12.4, 0.55, 17.2, 0.15, 0.45, 0.7, BRONZE_D);
  throne.box(13.4, 0.55, 17.2, 0.15, 0.45, 0.7, BRONZE_D);
  throne.box(12.55, 0.55, 17.35, 0.9, 0.06, 0.5, "#6a220a");
  add(throne);
  const scrollMat = new THREE.MeshLambertMaterial({ color: PARCH, emissive: new THREE.Color("#ff5a00"), emissiveIntensity: 0.35 });
  const scrolls: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.14), scrollMat);
    s.position.set(11.9 + i * 0.5, 0.94, 16.75 + (i % 2) * 0.12);
    s.visible = false;
    group.add(s);
    scrolls.push(s);
  }

  // ── Les rails : du banc d'essai (où le wagonnet attend son chargement) jusqu'au trésor ──
  const rails = [new THREE.Vector3(20.4, 0, 14.75), new THREE.Vector3(24.4, 0, 14.75), new THREE.Vector3(24.4, 0, 10.75)];
  const track = new Vox(1, 64);
  for (let x = 19.6; x < 24.7; x += 0.42) track.box(x, 0, 14.4, 0.16, 0.06, 0.7, WOOD_D);
  for (let z = 10.6; z < 14.5; z += 0.42) track.box(24.05, 0, z, 0.7, 0.06, 0.16, WOOD_D);
  track.box(19.6, 0.06, 14.45, 5.12, 0.06, 0.07, "#8a929c");
  track.box(19.6, 0.06, 14.98, 4.6, 0.06, 0.07, "#8a929c");
  track.box(24.1, 0.06, 10.5, 0.07, 0.06, 4.55, "#8a929c");
  track.box(24.63, 0.06, 10.5, 0.07, 0.06, 4.0, "#8a929c");
  track.box(19.35, 0, 14.4, 0.2, 0.35, 0.7, BRONZE_D); // butoir
  track.box(19.3, 0.35, 14.45, 0.3, 0.08, 0.6, "#8a3a1a");
  add(track);

  // ── Le trésor : coffre bardé d'or sous une arche, piles de pièces ──
  const vault = new Vox(1, 65);
  vault.box(23.2, 0, 7.9, 0.4, 3.2, 0.4, "#343a46");
  vault.box(25.2, 0, 7.9, 0.4, 3.2, 0.4, "#343a46");
  vault.box(23.1, 3.2, 7.8, 2.6, 0.45, 0.6, BRONZE);
  vault.box(23.6, 0, 8.8, 1.6, 0.8, 1.2, "#5a3a22", 0.04);
  vault.box(23.55, 0.3, 8.75, 1.7, 0.12, 1.3, GOLD);
  vault.box(23.55, 0, 8.75, 0.12, 0.8, 1.3, GOLD);
  vault.box(25.08, 0, 8.75, 0.12, 0.8, 1.3, GOLD);
  vault.box(24.3, 0.45, 9.98, 0.2, 0.25, 0.06, GOLD);
  for (let i = 0; i < 12; i++) vault.box(23.3 + (i % 4) * 0.28, 0, 10.05 + Math.floor(i / 4) * 0.16, 0.24, 0.1 + ((i * 5) % 3) * 0.1, 0.24, GOLD, 0.15);
  add(vault);
  runeV.box(24.25, 3.3, 8.38, 0.3, 0.25, 0.04, "#fff");

  const vaultLid = new THREE.Group();
  vaultLid.position.set(23.6, 0.8, 8.8);
  const lidV = new Vox(1);
  lidV.box(-0.02, 0, -0.02, 1.64, 0.32, 1.24, "#6a4428", 0.04);
  lidV.box(-0.04, 0.1, -0.04, 1.68, 0.1, 1.28, GOLD);
  vaultLid.add(lidV.mesh(material, !mini));
  group.add(vaultLid);

  const cart = new THREE.Group();
  const cv = new Vox(1);
  cv.box(-0.4, 0.12, -0.3, 0.8, 0.42, 0.6, IRON, 0.05);
  cv.box(-0.45, 0.5, -0.35, 0.9, 0.08, 0.7, BRONZE);
  for (const [x, z] of [[-0.3, -0.36], [0.14, -0.36], [-0.3, 0.28], [0.14, 0.28]] as const) cv.box(x, 0, z, 0.16, 0.2, 0.08, "#1a1a1a");
  cart.add(cv.mesh(material, !mini));
  const cartCrate = new THREE.Mesh(crateGeo, material);
  cartCrate.scale.setScalar(0.85);
  cartCrate.position.y = 0.3;
  cartCrate.visible = false;
  cart.add(cartCrate);
  cart.position.set(rails[0]!.x, 0.08, rails[0]!.z);
  group.add(cart);

  // Tout ce qui brille : métal en fusion, runes.
  if (!lavaV.empty) group.add(new THREE.Mesh(lavaV.geometry(), lava));
  if (!runeV.empty) group.add(new THREE.Mesh(runeV.geometry(), runes));

  // Zones cliquables (invisibles) : la file, votre table, le trésor.
  const zone = (id: string, x: number, y: number, z: number, w: number, h: number, d: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ visible: false }));
    m.position.set(x, y, z);
    group.add(m);
    pickGroup(id, m);
  };
  zone("queue", 1.85, 0.8, 13.65, 2.2, 1.6, 2.2);
  zone("table", 13, 0.8, 17.0, 3.4, 1.6, 2.0);
  zone("vault", 24.3, 0.8, 9.4, 2.4, 1.6, 2.4);

  const anchor = (x: number, y: number, z: number) => {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    group.add(o);
    return o;
  };

  return {
    group,
    sky,
    sun,
    moon,
    fires,
    hearth,
    lava,
    runes,
    embers,
    anvils,
    queueCrates,
    qaCrate,
    scrolls,
    tableLamp,
    gateLamp: { mat: gateMat, light: gateLight },
    cart,
    cartCrate,
    rails,
    vaultLid,
    anchors: { queue: anchor(1.85, 2.0, 13.65), table: anchor(13, 0.2, 18.3), vault: anchor(24.4, 3.9, 8.1), qa: anchor(20.5, 2.4, 13.4), board: anchor(0.2, 3.0, 16.5) },
    pickables,
    stations: {
      director: { x: 4.2, z: 2.3, yaw: 0, exit: [{ x: 2.4, z: 2.3 }] },
      concepteur: { x: 5.9, z: 2.3, yaw: 0, exit: [{ x: 7.6, z: 2.3 }] },
      archivist: { x: 13, z: 2.0, yaw: 0, exit: [{ x: 14.3, z: 2.0 }] },
      art_director: { x: 20.6, z: 3.5, yaw: -Math.PI / 2 },
      qa: { x: 20.5, z: 12.3, yaw: 0 },
      guardian: { x: 1.1, z: 8.0, yaw: Math.PI / 2, exit: [{ x: 3.8, z: 8.0 }] },
      foreman: { x: 1.1, z: 16.4, yaw: Math.PI / 2, exit: [{ x: 3.8, z: 16.4 }] },
    },
    idle: [
      { x: 12.2, z: 6.0, yaw: 0, sit: true },
      { x: 13.8, z: 6.0, yaw: 0, sit: true },
      { x: 10.42, z: 7.3, yaw: Math.PI / 2, sit: true },
      { x: 15.58, z: 7.3, yaw: -Math.PI / 2, sit: true },
      { x: 10.42, z: 8.5, yaw: Math.PI / 2, sit: true },
      { x: 15.58, z: 8.5, yaw: -Math.PI / 2, sit: true },
      { x: 12.0, z: 9.8, yaw: Math.PI, sit: true },
      { x: 14.0, z: 9.8, yaw: Math.PI, sit: true },
      { x: 17.4, z: 6.7, yaw: -2.4 },
      { x: 9.3, z: 6.6, yaw: 2.2 },
      { x: 17.3, z: 8.9, yaw: -1.9 },
    ],
    get benchCount() {
      return benchCount;
    },
    layoutBenches,
  };
}
