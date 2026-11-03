import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model3DSpec, Orientation } from "./model3d.ts";

/**
 * Le manifeste des assets (ADR-43) : `studio/art/assets.json` dans le dépôt du jeu. C'est le contrat entre le
 * Directeur artistique et le développeur : ce qu'il faut produire, où se trouve le fichier validé, où le brancher.
 */

/** « ecarte » : mis de côté par vous (ADR-62), personne n'y touche tant que vous ne le remettez pas en file. */
export type AssetStatus = "propose" | "production" | "a_valider" | "valide" | "integration" | "integre" | "ecarte";
export const ASSET_STATUSES: AssetStatus[] = ["propose", "production", "a_valider", "valide", "integration", "integre", "ecarte"];

export type Verdict = {
  ok: boolean;
  /** Le jugement en une ou deux phrases. */
  summary: string;
  /** Ce qui va, ce qui ne va pas, précisément. */
  points: string[];
  /** Prompt Midjourney corrigé, pour refaire. */
  prompt: string | null;
  /** Rendu jugé (chemin relatif à studio/art). */
  file: string;
  /** « validator » : le validateur ; « human » : le directeur créatif a tranché. */
  by: "validator" | "human";
  at: string;
  /** Image de référence d'une 3D : l'angle sous lequel elle montre le sujet (ADR-115) ; absent = de face. */
  orientation?: Orientation;
};

export type Asset = {
  id: string;
  name: string;
  /** illustration, icône, texture, modèle 3D, interface, décor… */
  type: string;
  /** Où et comment il sert dans le jeu. */
  usage: string;
  /** Format, dimensions, budget, contraintes techniques. */
  specs: string;
  status: AssetStatus;
  /** Prompts Midjourney prêts à copier. */
  prompts: string[];
  /** Images du moodboard à joindre dans Midjourney (chemins relatifs à studio/art). */
  refs: string[];
  /** Format du générateur local, « 1024x1536 » (ADR-46). */
  format?: string | null;
  /** L'asset est un modèle 3D : ses mesures et animations (ADR-47). L'image validée sert de modèle à Tripo. */
  model3d?: Model3DSpec | null;
  /** Le modèle fabriqué (dernier tour) et son jugement. */
  model?: ModelInfo | null;
  /** Vérification dans le jeu, après la fusion du chantier d'intégration (capture du hub). */
  ingame?: InGame | null;
  /** Les fichiers que le jeu a chargés sur la scène vitrine de l'asset, au dernier lancement par le hub (bilan, ADR-71). */
  proof?: { loaded: string[]; at: string } | null;
  /** La dernière comparaison de sa scène vitrine à la photo de référence (ADR-84). */
  look?: Look | null;
  /** Une nouvelle photo de référence que vous avez acceptée (« Accepter le nouvel aspect ») ; sinon celle de `ingame`. */
  lookRef?: string | null;
  /** Validé, mais son intégration attend que ce chantier ait posé sa place dans le jeu (ADR-60). */
  waitsFor?: string | null;
  /** Confié au Directeur artistique par la file des visuels ou par « Lancer » (ADR-62) : il est en cours tant qu'il n'est pas validé. */
  launchedAt?: string | null;
  /** Croquis du cadrage (ADR-49) : plusieurs directions, dont le directeur créatif choisit une. */
  sketches?: Sketch[] | null;
  /** Référence de style (Flux Kontext, ADR-51) : l'image dans le style de laquelle cet asset est dessiné. */
  styleRef?: string | null;
  /** Le croquis choisi : la fabrication en tire des variantes. */
  direction?: Sketch | null;
  /** Rendus déposés, du plus ancien au plus récent (chemins relatifs à studio/art). */
  renders: string[];
  verdict: Verdict | null;
  created_at: string;
  updated_at: string;
};

export type Sketch = { file: string; label: string; prompt: string };

export type ModelInfo = {
  /** Fichier .glb fini (chemin relatif à studio/art). */
  file: string;
  /** Image validée qui a servi de modèle (null pour un objet simple, modélisé sans image). */
  source: string | null;
  /** La planche dessinée par Tripo avant la 3D : face, gauche, dos, droite (ADR-50). */
  views?: string[];
  /** Ce que l'artisan 3D a fait dans Blender, en clair (ADR-49). */
  workshop?: string | null;
  /** La forme que Tripo a reconnue pour le squelette (biped, quadruped…), et les animations demandées qu'il n'a pas pu poser. */
  rigType?: string | null;
  missingAnimations?: string[];
  /** La tâche Tripo du squelette : d'autres animations s'y posent pour 10 crédits chacune, sans refaire le modèle (ADR-56). */
  rigTask?: string | null;
  /** La version du squelette Tripo (absente : v1.0) ; le v3.0 ne connaît que les animations de base. */
  rigModel?: string | null;
  /** Une bande d'images par animation, pour juger le mouvement (ADR-56). */
  bandes?: string[];
  /** Photos sous quatre angles, pour le validateur et pour vous. */
  renders: string[];
  tris: number;
  /** Dimensions en mètres (x, y, z de Blender : largeur, profondeur, hauteur). */
  dims: number[];
  animations: string[];
  verdict: Verdict | null;
};

/**
 * Contrôle des vitrines (ADR-84). « same » : comme la référence ; « changed » : l'aspect a changé, `file` est la nouvelle
 * photo (dans production/) ; « unstable » : la vitrine bouge d'une photo à l'autre, la comparaison ne dit rien.
 */
export type Look = { status: "same" | "changed" | "unstable"; file: string | null; ref: string; changed: number; where: string | null; tasks: string[]; at: string };

export type InGame = { task: string; file: string; visible: boolean; ok: boolean; summary: string; points: string[]; retried: boolean; at: string };

export type Manifest = { version: 1; assets: Asset[] };

/** En tête de la section des chantiers qui posent un provisoire en attendant des visuels (ADR-59, ADR-60). */
export const PENDING_VISUALS = "Visuels confiés au Directeur artistique, pas encore faits";

/**
 * Les visuels d'un chantier : celui que son titre nomme (« A-0002 … », un chantier d'intégration ou de retouche), ou
 * ceux que sa consigne attend (liste après PENDING_VISUALS, ADR-59).
 */
export function visualsOfTask(t: { title: string; goal: string }): string[] {
  const own = /^A-\d{4,}/.exec(t.title)?.[0];
  return own ? [own] : t.goal.includes(PENDING_VISUALS) ? [...t.goal.matchAll(/\n- (A-\d{4,}) «/g)].map((m) => m[1]!) : [];
}

export const ART_DIR = join("studio", "art");
export const artRoot = (gameRoot: string) => join(gameRoot, ART_DIR);
const manifestPath = (gameRoot: string) => join(artRoot(gameRoot), "assets.json");

export function readManifest(gameRoot: string): Manifest {
  const file = manifestPath(gameRoot);
  if (!existsSync(file)) return { version: 1, assets: [] };
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    return { version: 1, assets: Array.isArray(m.assets) ? m.assets : [] };
  } catch {
    return { version: 1, assets: [] };
  }
}

export function writeManifest(gameRoot: string, m: Manifest): void {
  writeAtomic(manifestPath(gameRoot), `${JSON.stringify(m, null, 2)}\n`);
}

/** Écrit d'abord un « .tmp », jamais commité, puis le renomme : un commit ne voit jamais un fichier à moitié écrit. */
export function writeAtomic(file: string, content: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

export function nextAssetId(m: Manifest): string {
  const max = m.assets.reduce((n, a) => Math.max(n, Number(/^A-(\d+)$/.exec(a.id)?.[1] ?? 0)), 0);
  return `A-${String(max + 1).padStart(4, "0")}`;
}

/** Ce que le directeur du projet doit savoir des visuels (contexte de ses réponses). */
export function manifestSummary(gameRoot: string): string | null {
  const m = readManifest(gameRoot);
  const hasBible = existsSync(join(artRoot(gameRoot), "bible.md"));
  if (!m.assets.length && !hasBible) return null;
  const ready = m.assets.filter((a) => a.status === "valide" || a.status === "integration");
  const lines = [
    "Direction artistique (ADR-43) : le Directeur artistique tient la bible visuelle (studio/art/bible.md) et le manifeste des assets (studio/art/assets.json).",
    `Assets : ${m.assets.length} au total, ${m.assets.filter((a) => a.status === "integre").length} intégrés.`,
  ];
  if (ready.length) {
    lines.push("Validés, à brancher dans le jeu (le chantier d'intégration porte l'identifiant A-xxxx dans son titre) :");
    for (const a of ready.slice(0, 20)) {
      const file = a.model?.file ?? a.verdict?.file;
      lines.push(`- ${a.id} ${a.name} (${a.type}) : ${a.usage} — fichier ${file ? `studio/art/${file}` : "?"}`);
    }
  }
  return lines.join("\n");
}
