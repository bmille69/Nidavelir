import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { artRoot, writeAtomic } from "./manifest.ts";

/**
 * La direction visuelle (ADR-58) : `studio/art/direction.json` dans le dépôt du jeu. Ce que le directeur créatif a
 * tranché avec les yeux, gardé pour toujours et relu par le Directeur artistique à chaque tour :
 * - les choix de goût (question, réponse, image de l'option) : on ne repose pas une question tranchée ;
 * - les références trouvées sur le web (source, ce qu'on en prend) et son avis : aimée ou à éviter ;
 * - les duels de styles (un même sujet dessiné dans plusieurs styles) et le style retenu, qui sert ensuite de
 *   référence de style (« | ref style ») à tous les visuels.
 */

export type Verdict = "aime" | "evite";
export type Reference = {
  /** Image dans studio/art (moodboard/web-…). */
  file: string;
  /** La planche d'où elle vient (P-01) et son thème. */
  board: string;
  theme: string;
  /** Page d'origine : on ne garde jamais une image sans savoir d'où elle vient. */
  source: string;
  title: string;
  /** Ce que le Directeur artistique veut en prendre. */
  why: string;
  verdict: Verdict | null;
  at: string;
};
export type Board = { id: string; theme: string; at: string; failed: { url: string; reason: string }[] };
export type TasteChoice = { question: string; answer: string; image: string | null; at: string };
export type StyleOption = { label: string; prompt: string; file: string };
export type Duel = { id: string; subject: string; options: StyleOption[]; chosen: number | null; at: string };
export type ChosenStyle = { duel: string; label: string; prompt: string; file: string; at: string };
export type Direction = { version: 1; choices: TasteChoice[]; boards: Board[]; references: Reference[]; duels: Duel[]; style: ChosenStyle | null };

const EMPTY: Direction = { version: 1, choices: [], boards: [], references: [], duels: [], style: null };
const file = (gameRoot: string) => join(artRoot(gameRoot), "direction.json");

export function readDirection(gameRoot: string): Direction {
  const f = file(gameRoot);
  if (!existsSync(f)) return structuredClone(EMPTY);
  try {
    const d = JSON.parse(readFileSync(f, "utf8")) as Partial<Direction>;
    const list = <T>(v: T[] | undefined) => (Array.isArray(v) ? v : []);
    return { version: 1, choices: list(d.choices), boards: list(d.boards), references: list(d.references), duels: list(d.duels), style: d.style ?? null };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function writeDirection(gameRoot: string, d: Direction): void {
  writeAtomic(file(gameRoot), `${JSON.stringify(d, null, 2)}\n`);
}

/** Un choix de goût : la réponse la plus récente à une même question remplace l'ancienne. */
export function recordChoice(d: Direction, c: TasteChoice): void {
  d.choices = [...d.choices.filter((x) => norm(x.question) !== norm(c.question)), c].slice(-200);
}

export const nextId = (prefix: "P" | "S", items: { id: string }[]) =>
  `${prefix}-${String(items.reduce((n, x) => Math.max(n, Number(/-(\d+)$/.exec(x.id)?.[1] ?? 0)), 0) + 1).padStart(2, "0")}`;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Ce que le Directeur artistique doit savoir de la direction à chaque tour : borné, du plus récent au plus ancien. */
export function directionContext(d: Direction, opts: { bible: boolean; generator: boolean }): string {
  const liked = d.references.filter((r) => r.verdict === "aime").slice(-15);
  const avoided = d.references.filter((r) => r.verdict === "evite").slice(-15);
  const waiting = d.references.filter((r) => !r.verdict).length;
  const pending = d.duels.filter((x) => x.chosen === null && x.options.every((o) => o.file)).at(-1);
  const step = opts.bible && !d.style && !d.duels.length
    ? "La bible existe déjà (direction posée avant les planches et les duels) : continue les visuels. Propose une planche de références ou un duel de styles seulement s'il veut revoir ou enrichir la direction, ou si un visuel manque de repères."
    : !d.choices.length && !d.references.length
    ? "1. INTENTIONS : rien n'est encore tranché. Commence par deux ou trois questions d'intention (émotion, références, lisibilité), illustrées."
    : !liked.length && !avoided.length
      ? "2. RÉFÉRENCES : propose une planche de références trouvées sur le web ([[REFERENCES]]) à partir de ce qu'il a dit, pour qu'il réagisse avec les yeux."
      : !d.style
        ? opts.generator
          ? "3. STYLES : propose un duel de styles ([[STYLES]]) sur un sujet représentatif du jeu, nourri des références aimées."
          : "3. STYLES : le générateur d'images n'est pas installé, le duel de styles attendra ; propose une direction en mots appuyée sur les références aimées."
        : !opts.bible
          ? "4. BIBLE : le style est retenu ; rédige la bible complète ([[BIBLE]]) à partir des choix, des références et du style."
          : "5. VISUELS : la direction est posée ; propose et fabrique les visuels du jeu (circuit d'un visuel).";
  return [
    `<direction_visuelle source="direction.json">`,
    `Où en est la conception visuelle : ${step}`,
    d.style ? `Style retenu (duel ${d.style.duel}) : « ${d.style.label} », image ${d.style.file}. Prompt de style : ${d.style.prompt}\nPour dessiner un visuel dans ce style : « | ref style » sur [[CROQUIS]] ou [[GENERER]].` : "Pas encore de style retenu.",
    pending ? `Duel ${pending.id} « ${pending.subject} » en attente de son choix : n'en relance pas un autre.` : "",
    d.choices.length
      ? `Choix déjà tranchés (ne les repose pas ; pour revenir dessus, dis-le et explique pourquoi) :\n${d.choices.slice(-40).map((c) => `- ${c.question} → ${c.answer}`).join("\n")}`
      : "",
    liked.length ? `Références qu'il aime (moodboard) :\n${liked.map((r) => `- ${r.file} « ${r.title} » (${r.theme}) : ${r.why}`).join("\n")}` : "",
    avoided.length ? `Références qu'il veut éviter :\n${avoided.map((r) => `- ${r.file} « ${r.title} » (${r.theme}) : ${r.why}`).join("\n")}` : "",
    waiting ? `${waiting} référence(s) sans avis encore.` : "",
    `</direction_visuelle>`,
  ]
    .filter(Boolean)
    .join("\n");
}
