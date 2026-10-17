import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model3DSpec } from "./model3d.ts";

/**
 * Le manifeste des assets (ADR-43) : `studio/art/assets.json` dans le dépôt du jeu. C'est le contrat entre le
 * Directeur artistique et le développeur : ce qu'il faut produire, où se trouve le fichier validé, où le brancher.
 */

export type AssetStatus = "propose" | "production" | "a_valider" | "valide" | "integration" | "integre";
export const ASSET_STATUSES: AssetStatus[] = ["propose", "production", "a_valider", "valide", "integration", "integre"];

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
  /** Rendus déposés, du plus ancien au plus récent (chemins relatifs à studio/art). */
  renders: string[];
  verdict: Verdict | null;
  created_at: string;
  updated_at: string;
};

export type ModelInfo = {
  /** Fichier .glb fini (chemin relatif à studio/art). */
  file: string;
  /** Image validée qui a servi de modèle. */
  source: string;
  /** Photos sous quatre angles, pour le validateur et pour vous. */
  renders: string[];
  tris: number;
  /** Dimensions en mètres (x, y, z de Blender : largeur, profondeur, hauteur). */
  dims: number[];
  animations: string[];
  verdict: Verdict | null;
};

export type InGame = { task: string; file: string; visible: boolean; ok: boolean; summary: string; points: string[]; retried: boolean; at: string };

export type Manifest = { version: 1; assets: Asset[] };

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
