import * as THREE from "three";
import type { ActorKind } from "./model.ts";
import { Vox } from "./voxel.ts";

/** Un nain de la Forge (ADR-106), en voxels de 0,1 : jambes, corps, bras et tête articulés pour l'animation. */
export type Dwarf = {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
};

const SKIN = "#e9b48a";
const PANTS = "#3b3f4f";
const BOOTS = "#2a1f18";
const BELT = "#5a3a22";
const GOLD = "#f0c040";
const STEEL = "#aab4c0";
const WOOD = "#7a5232";
const CYAN = "#00e5ff";

const BEARD: Record<ActorKind, string> = {
  director: "#ececec",
  concepteur: "#c8642c",
  art_director: "#8a3b22",
  archivist: "#f4f4f4",
  developer: "#2a2220",
  qa: "#d8b060",
  guardian: "#8e8e8e",
  foreman: "#6b4a2f",
};
const DEV_BEARDS = ["#2a2220", "#c8642c", "#d8b060", "#6b4a2f"];

function darker(hex: string, k = 0.7): string {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
}

function part(material: THREE.Material, build: (v: Vox) => void): THREE.Mesh {
  const v = new Vox(0.1, 11);
  build(v);
  const m = v.mesh(material);
  return m;
}

/** Construit le nain d'un rôle. `variant` change la barbe des développeurs (un par établi). */
export function buildDwarf(kind: ActorKind, color: string, material: THREE.Material, variant = 0): Dwarf {
  const root = new THREE.Group();
  const beard = kind === "developer" ? DEV_BEARDS[variant % DEV_BEARDS.length]! : BEARD[kind];
  const tunic = color;
  const tunicDark = darker(color, 0.62);

  // Jambes : pivot à la hanche (y = 3 voxels).
  const leg = (side: number) => {
    const g = new THREE.Group();
    g.position.set(side * 0.13, 0.3, 0);
    g.add(
      part(material, (v) => {
        v.box(-1, -2.2, -1, 2, 2.2, 2, PANTS);
        v.box(-1.1, -3, -1.1, 2.2, 0.8, 2.6, BOOTS);
      }),
    );
    root.add(g);
    return g;
  };
  const legL = leg(-1);
  const legR = leg(1);

  // Corps : pivot à la taille.
  const body = new THREE.Group();
  body.position.y = 0.3;
  root.add(body);
  body.add(
    part(material, (v) => {
      v.box(-3, 0, -2, 6, 4.6, 4, tunic);
      v.box(-3.2, -0.4, -2.2, 6.4, 1.4, 4.4, tunicDark); // bas de la tunique
      v.box(-3.1, 1.2, -2.1, 6.2, 0.8, 4.2, BELT);
      v.box(-0.6, 1.1, 2.0, 1.2, 1, 0.3, GOLD); // boucle
      if (kind === "developer") {
        v.box(-2.4, -0.3, 2.0, 4.8, 4.2, 0.4, "#6a4428"); // tablier de cuir
        v.box(-2.6, 3.6, 2.05, 5.2, 0.4, 0.4, "#4a2e1a");
      }
      if (kind === "director") v.box(-3.2, 0.2, -2.6, 6.4, 4.6, 0.6, darker(CYAN, 0.45)); // cape
      if (kind === "guardian") {
        v.box(-3.2, 2.2, -2.2, 6.4, 2.6, 4.4, STEEL); // cuirasse
        v.box(-3.4, 4.2, -2.3, 6.8, 0.6, 4.6, "#7d8794");
      }
      if (kind === "archivist") v.box(-3.3, -0.6, -2.3, 6.6, 1.2, 4.6, "#4b3f78"); // robe longue
    }),
  );

  // Bras : pivot à l'épaule.
  const arm = (side: number) => {
    const g = new THREE.Group();
    g.position.set(side * 0.39, 0.42, 0);
    g.add(
      part(material, (v) => {
        v.box(-0.9, -3, -0.9, 1.8, 3, 1.8, tunic);
        v.box(-0.95, -4, -0.95, 1.9, 1, 1.9, SKIN);
      }),
    );
    body.add(g);
    return g;
  };
  const armL = arm(-1);
  const armR = arm(1);

  // Outils, tenus dans la main droite (au bout du bras, vers l'avant).
  const tool = (build: (v: Vox) => void, hand = armR) => {
    const m = part(material, build);
    hand.add(m);
    return m;
  };
  if (kind === "developer")
    tool((v) => {
      v.box(-0.35, -4.4, -0.35, 0.7, 0.7, 4.2, WOOD); // manche, vers l'avant
      v.box(-1.1, -4.9, 3.2, 2.2, 1.7, 1.5, "#4d5560"); // tête du marteau
    });
  if (kind === "guardian") {
    tool((v) => {
      v.box(-0.35, -5.5, 1.0, 0.7, 10, 0.7, WOOD); // manche, tenu droit devant la main
      v.box(-0.4, 1.6, 1.6, 0.8, 2.8, 2.2, STEEL); // fer de hache
    });
    tool((v) => {
      v.box(-1.4, -4.2, -2.6, 0.6, 5.2, 5.2, "#7a2e2e"); // bouclier rond (carré !)
      v.box(-1.5, -2.2, -0.6, 0.6, 1.2, 1.2, GOLD);
    }, armL);
  }
  if (kind === "qa")
    tool((v) => {
      v.box(-0.3, -4.6, -0.3, 0.6, 0.6, 2.4, WOOD);
      v.box(-1.2, -5.4, 2.1, 2.4, 2.4, 0.4, CYAN); // loupe
    });
  if (kind === "art_director")
    tool((v) => {
      v.box(-0.25, -4.4, -0.25, 0.5, 0.5, 3.2, WOOD);
      v.box(-0.4, -4.55, 3.0, 0.8, 0.8, 0.9, "#ff5a00"); // pinceau trempé de braise
    });
  if (kind === "archivist")
    tool((v) => {
      v.box(-1.6, -4.8, 0.2, 3.2, 0.9, 2.4, "#6b2f3a"); // livre
      v.box(-1.4, -4.1, 0.4, 2.8, 0.3, 2.0, "#f1e4c4");
    }, armL);
  if (kind === "concepteur")
    tool((v) => {
      v.box(-0.5, -4.6, 0.1, 1, 1, 3, "#f1e4c4"); // rouleau
      v.box(-0.6, -4.7, 0.0, 1.2, 1.2, 0.3, WOOD);
    }, armL);
  if (kind === "foreman")
    tool((v) => {
      v.box(-1.4, -4.8, 0.2, 2.8, 0.4, 3.2, WOOD); // planchette
      v.box(-1.1, -4.5, 0.5, 2.2, 0.2, 2.6, "#f1e4c4");
    }, armL);

  // Tête : pivot au cou.
  const head = new THREE.Group();
  head.position.y = 0.46;
  body.add(head);
  head.add(
    part(material, (v) => {
      v.box(-2.5, 0, -2.5, 5, 4.4, 5, SKIN);
      v.box(-1.4, 2.4, 2.45, 0.9, 0.9, 0.2, "#1a1a22"); // yeux
      v.box(0.5, 2.4, 2.45, 0.9, 0.9, 0.2, "#1a1a22");
      v.box(-0.6, 1.4, 2.4, 1.2, 1.2, 0.7, "#d99a72"); // nez
      // Barbe : longue chez l'archiviste, tressée chez les autres.
      const long = kind === "archivist" || kind === "director";
      v.box(-2.6, long ? -3.2 : -2.2, 1.6, 5.2, long ? 4.6 : 3.6, 1.4, beard);
      v.box(-2.6, 0.2, -2.6, 0.6, 2.2, 4.4, beard); // favoris
      v.box(2.0, 0.2, -2.6, 0.6, 2.2, 4.4, beard);
      v.box(-1.8, 0.9, 2.5, 3.6, 0.6, 0.5, beard); // moustache
      // Cheveux / coiffe.
      const hair = kind === "concepteur" ? "#5e3a7a" : kind === "qa" ? "#3f7a55" : beard;
      v.box(-2.7, 3.7, -2.7, 5.4, 1.2, 5.4, hair);
      v.box(-2.7, 0.8, -2.8, 5.4, 3.2, 0.8, hair);
      if (kind === "director") {
        v.box(-2.8, 3.6, -2.8, 5.6, 0.8, 5.6, GOLD); // couronne
        v.box(-0.5, 4.3, 2.6, 1, 1, 0.4, CYAN);
        v.box(-2.8, 4.3, -2.8, 0.8, 0.8, 0.8, GOLD);
        v.box(2.0, 4.3, -2.8, 0.8, 0.8, 0.8, GOLD);
        v.box(-2.8, 4.3, 2.0, 0.8, 0.8, 0.8, GOLD);
        v.box(2.0, 4.3, 2.0, 0.8, 0.8, 0.8, GOLD);
      }
      if (kind === "art_director") v.box(-2.9, 4.6, -3.2, 5.8, 1, 5.4, "#2b2340"); // béret
      if (kind === "archivist") {
        v.box(-2.0, 2.2, 2.55, 1.6, 1.3, 0.2, CYAN); // lunettes
        v.box(0.4, 2.2, 2.55, 1.6, 1.3, 0.2, CYAN);
      }
      if (kind === "developer") v.box(-2.4, 3.5, 2.3, 4.8, 0.9, 0.6, "#3a3a3a"); // lunettes de forge relevées
      if (kind === "guardian") {
        v.box(-2.9, 3.3, -2.9, 5.8, 1.9, 5.8, STEEL); // casque
        v.box(-0.4, 1.0, 2.6, 0.8, 2.6, 0.5, STEEL); // nasal
        v.box(-4.4, 4.0, -0.5, 1.6, 1, 1, "#e8dcc0"); // cornes
        v.box(-4.6, 5.0, -0.5, 1, 1.4, 1, "#e8dcc0");
        v.box(2.8, 4.0, -0.5, 1.6, 1, 1, "#e8dcc0");
        v.box(3.6, 5.0, -0.5, 1, 1.4, 1, "#e8dcc0");
      }
      if (kind === "foreman") {
        v.box(-2.9, 3.6, -2.9, 5.8, 1.6, 5.8, "#e0a020"); // casque de chantier
        v.box(-0.6, 4.0, 2.8, 1.2, 1, 0.5, "#fff3b0"); // lampe
      }
      if (kind === "qa") v.box(-2.8, 4.4, -0.2, 5.6, 0.4, 3.4, "#2d5a3e"); // visière
    }),
  );

  return { root, body, head, armL, armR, legL, legR };
}
