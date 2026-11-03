import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Les registres du jeu (ADR-119) : des fichiers où chaque chantier n'ajoute que ses propres clés ou lignes. Git y voit un
 * conflit dès que deux branches insèrent au même endroit (fin d'objet, fin de fichier) : ils se fusionnent donc clé par clé,
 * et ne bloquent plus le travail en parallèle. Un vrai désaccord sur une même clé n'est jamais tranché : il rend un conflit.
 */

/** Forme comparable d'un chemin : « / », sans « ./ », en minuscules (Windows). */
export function normaliseRegistre(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

export function isRegistre(path: string): boolean {
  const p = normaliseRegistre(path);
  return /^data\/.+\.json$/i.test(p) || /^data\/.+\.csv$/i.test(p) || /^docs\/visuels_en_attente\.md$/i.test(p);
}

/** Un membre d'objet, avec tout son texte source : blancs avant la clé, clé, « : » et ses blancs, blancs avant la virgule. */
interface Membre {
  cle: string;
  avant: string;
  cleRaw: string;
  entre: string;
  apres: string;
  noeud: Noeud;
}

/** Un nœud JSON et son texte source exact (`raw`) : ce que la fusion n'a pas touché ressort tel quel (`6.0` reste `6.0`). */
type Noeud =
  | { type: "objet"; raw: string; membres: Membre[]; index: Map<string, Membre>; fin: string }
  | { type: "tableau"; raw: string; elements: Noeud[] }
  | { type: "nombre" | "chaine" | "litteral"; raw: string };

/** Découpe un texte déjà validé par JSON.parse (d'où un analyseur sans contrôle de grammaire). Une clé en double lève : en garder une perdrait l'autre. */
function analyserJson(texte: string): { avant: string; noeud: Noeud; apres: string } {
  JSON.parse(texte.replace(/^﻿/, ""));
  let i = 0;
  const blancs = (): string => {
    const debut = i;
    while (i < texte.length && " \t\r\n﻿".includes(texte[i]!)) i++;
    return texte.slice(debut, i);
  };
  const chaine = (): string => {
    const debut = i++;
    while (texte[i] !== '"') i += texte[i] === "\\" ? 2 : 1;
    i++;
    return texte.slice(debut, i);
  };
  const noeud = (): Noeud => {
    const debut = i;
    const c = texte[i];
    if (c === "{") {
      i++;
      const membres: Membre[] = [];
      const index = new Map<string, Membre>();
      let fin = blancs();
      while (texte[i] !== "}") {
        const avant = fin;
        const cleRaw = chaine();
        const debutEntre = i;
        blancs();
        i++; // « : »
        blancs();
        const entre = texte.slice(debutEntre, i);
        const valeur = noeud();
        const blancsApres = blancs();
        const cle = JSON.parse(cleRaw) as string;
        if (index.has(cle)) throw new Error(`clé en double : ${cle}`);
        const membre: Membre = { cle, avant, cleRaw, entre, apres: "", noeud: valeur };
        membres.push(membre);
        index.set(cle, membre);
        if (texte[i] === ",") {
          membre.apres = blancsApres;
          i++;
          fin = blancs();
        } else fin = blancsApres;
      }
      i++;
      return { type: "objet", raw: texte.slice(debut, i), membres, index, fin };
    }
    if (c === "[") {
      i++;
      const elements: Noeud[] = [];
      blancs();
      while (texte[i] !== "]") {
        elements.push(noeud());
        blancs();
        if (texte[i] === ",") {
          i++;
          blancs();
        }
      }
      i++;
      return { type: "tableau", raw: texte.slice(debut, i), elements };
    }
    if (c === '"') return { type: "chaine", raw: chaine() };
    while (i < texte.length && !",}] \t\r\n".includes(texte[i]!)) i++;
    const raw = texte.slice(debut, i);
    return { type: /^[-\d]/.test(raw) ? "nombre" : "litteral", raw };
  };
  const avant = blancs();
  const racine = noeud();
  return { avant, noeud: racine, apres: texte.slice(i) };
}

/** Même contenu ? Feuilles : même texte source. Objets : mêmes clés, quel que soit leur ordre. Tableaux : mêmes éléments dans l'ordre. */
function pareil(a: Noeud | undefined, b: Noeud | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.type === "objet") return b.type === "objet" && a.membres.length === b.membres.length && a.membres.every((m) => pareil(m.noeud, b.index.get(m.cle)?.noeud));
  if (a.type === "tableau") return b.type === "tableau" && a.elements.length === b.elements.length && a.elements.every((e, k) => pareil(e, b.elements[k]));
  return a.raw === b.raw;
}

/** Le retrait de la ligne d'un membre (ce qui suit son dernier retour à la ligne), ou null s'il est sur la ligne précédente. */
const retraitDe = (avant: string): string | null => (avant.includes("\n") ? avant.slice(avant.lastIndexOf("\n") + 1) : null);

/** Un texte venu de « theirs » prend les fins de ligne de « ours » et, s'il change de profondeur, le retrait de sa nouvelle place. */
function importer(texte: string, avantSource: string, avantCible: string, eol: string): string {
  const [de, vers] = [retraitDe(avantSource), retraitDe(avantCible)];
  const recale = de !== null && vers !== null && de !== vers ? texte.replace(/\r?\n/g, "\n").split(`\n${de}`).join(`\n${vers}`) : texte;
  return recale.replace(/\r?\n/g, eol);
}

type Fusion = { ok: true; noeud: Noeud | undefined } | { ok: false; ou: string };

/** Fusion à trois sur les nœuds. Un objet modifié des deux côtés part de « ours » : ses membres gardent leur texte, les clés nouvelles de « theirs » suivent. */
function fusionnerNoeuds(base: Noeud | undefined, ours: Noeud | undefined, theirs: Noeud | undefined, cle: string, eol: string): Fusion {
  if (pareil(ours, theirs)) return { ok: true, noeud: ours };
  if (pareil(ours, base)) return { ok: true, noeud: theirs };
  if (pareil(theirs, base)) return { ok: true, noeud: ours };
  if (base?.type !== "objet" || ours?.type !== "objet" || theirs?.type !== "objet") return { ok: false, ou: cle };
  const membres: Membre[] = [];
  const index = new Map<string, Membre>();
  for (const k of new Set([...ours.index.keys(), ...theirs.index.keys(), ...base.index.keys()])) {
    const [mo, mt] = [ours.index.get(k), theirs.index.get(k)];
    const res = fusionnerNoeuds(base.index.get(k)?.noeud, mo?.noeud, mt?.noeud, cle ? `${cle}.${k}` : k, eol);
    if (!res.ok) return res;
    if (!res.noeud) continue;
    let membre: Membre;
    if (mo) {
      const venuDeTheirs = mt !== undefined && res.noeud === mt.noeud;
      membre = { ...mo, noeud: venuDeTheirs ? { ...res.noeud, raw: importer(res.noeud.raw, mt.avant, mo.avant, eol) } : res.noeud };
    } else {
      // Clé nouvelle : à la place et au retrait des dernières clés de « ours ».
      const m = mt!;
      const avant = ours.membres.at(-1)?.avant ?? m.avant.replace(/\r?\n/g, eol);
      membre = { ...m, avant, entre: m.entre.replace(/\r?\n/g, eol), apres: "", noeud: { ...res.noeud, raw: importer(res.noeud.raw, m.avant, avant, eol) } };
    }
    membres.push(membre);
    index.set(k, membre);
  }
  const fin = ours.membres.length ? ours.fin : theirs.fin.replace(/\r?\n/g, eol);
  const corps = membres.map((m, n) => `${m.avant}${m.cleRaw}${m.entre}${m.noeud.raw}${n < membres.length - 1 ? m.apres : ""}`).join(",");
  return { ok: true, noeud: { type: "objet", raw: `{${corps}${fin}}`, membres, index, fin } };
}

/** Fusion à trois de valeurs JSON (la même mécanique que pour les fichiers). */
export function mergeJson3(base: unknown, ours: unknown, theirs: unknown, cle = ""): { ok: true; value: unknown } | { ok: false; ou: string } {
  const lire = (v: unknown) => (v === undefined ? undefined : analyserJson(JSON.stringify(v)).noeud);
  const res = fusionnerNoeuds(lire(base), lire(ours), lire(theirs), cle, "\n");
  if (!res.ok) return res;
  return { ok: true, value: res.noeud && (JSON.parse(res.noeud.raw) as unknown) };
}

/** Fusion à trois de fichiers JSON. Tout ce que la fusion n'a pas touché ressort au caractère près : le diff ne montre que les clés ajoutées. */
export function mergeJsonTexte3(base: string, ours: string, theirs: string): { ok: true; value: string } | { ok: false; ou: string } {
  let lus: ReturnType<typeof analyserJson>[];
  try {
    lus = [base, ours, theirs].map(analyserJson);
  } catch {
    return { ok: false, ou: "JSON invalide ou clé en double" };
  }
  const [b, o, t] = lus as [ReturnType<typeof analyserJson>, ReturnType<typeof analyserJson>, ReturnType<typeof analyserJson>];
  const eol = finDeLigne(ours);
  const res = fusionnerNoeuds(b.noeud, o.noeud, t.noeud, "", eol);
  if (!res.ok) return res;
  const raw = res.noeud === t.noeud ? t.noeud.raw.replace(/\r?\n/g, eol) : res.noeud!.raw;
  return { ok: true, value: `${o.avant}${raw}${o.apres}` };
}

/** Sépare les enregistrements : un retour à la ligne entre guillemets reste dans sa cellule. Null si un guillemet reste ouvert. */
function lignesCsv(texte: string): string[] | null {
  const lignes: string[] = [];
  let courante = "";
  let cite = false;
  for (const c of texte.replace(/\r\n/g, "\n")) {
    if (c === '"') cite = !cite;
    if (c === "\n" && !cite) {
      lignes.push(courante);
      courante = "";
    } else courante += c;
  }
  if (cite) return null;
  if (courante) lignes.push(courante);
  return lignes;
}

/** La clé d'une ligne : sa première colonne, sans ses guillemets. */
function cleCsv(ligne: string): string {
  let cite = false;
  let fin = ligne.length;
  for (let i = 0; i < ligne.length; i++) {
    if (ligne[i] === '"') cite = !cite;
    else if (ligne[i] === "," && !cite) {
      fin = i;
      break;
    }
  }
  const brut = ligne.slice(0, fin);
  return brut.startsWith('"') && brut.endsWith('"') && brut.length > 1 ? brut.slice(1, -1).replace(/""/g, '"') : brut;
}

/** Clé → ligne (lignes vides écartées). `doublon` : première clé rencontrée deux fois. */
function tableCsv(lignes: string[]): { table: Map<string, string>; doublon: string | null } {
  const table = new Map<string, string>();
  let doublon: string | null = null;
  for (const ligne of lignes) {
    if (!ligne.trim()) continue;
    const cle = cleCsv(ligne);
    if (table.has(cle)) doublon ??= cle;
    table.set(cle, ligne);
  }
  return { table, doublon };
}

/** Fusion à trois d'une valeur simple ; `conflit` si les deux côtés ont changé différemment. */
function choisir(base: string | undefined, ours: string | undefined, theirs: string | undefined): string | undefined | typeof CONFLIT {
  if (ours === theirs || theirs === base) return ours;
  return ours === base ? theirs : CONFLIT;
}
const CONFLIT = Symbol("conflit");

function finDeLigne(texte: string): "\r\n" | "\n" {
  return texte.includes("\r\n") ? "\r\n" : "\n";
}

export function mergeCsv3(base: string, ours: string, theirs: string): { ok: true; value: string } | { ok: false; ou: string } {
  const [b, o, t] = [lignesCsv(base), lignesCsv(ours), lignesCsv(theirs)];
  if (!b || !o || !t) return { ok: false, ou: "guillemet non refermé" };
  const premiere = choisir(b[0], o[0], t[0]);
  if (premiere === CONFLIT) return { ok: false, ou: "première ligne" };

  const tb = tableCsv(b.slice(1));
  const to = tableCsv(o.slice(1));
  const tt = tableCsv(t.slice(1));
  const doublon = tb.doublon ?? to.doublon ?? tt.doublon;
  if (doublon !== null) return { ok: false, ou: doublon };

  const sortie = premiere === undefined ? [] : [premiere];
  for (const ligne of o.slice(1)) {
    if (!ligne.trim()) {
      sortie.push(ligne);
      continue;
    }
    const cle = cleCsv(ligne);
    const v = choisir(tb.table.get(cle), ligne, tt.table.get(cle));
    if (v === CONFLIT) return { ok: false, ou: cle };
    if (v !== undefined) sortie.push(v);
  }
  for (const [cle, ligne] of tt.table) {
    if (to.table.has(cle)) continue;
    const v = choisir(tb.table.get(cle), undefined, ligne);
    if (v === CONFLIT) return { ok: false, ou: cle };
    if (v !== undefined) sortie.push(v);
  }
  if (!sortie.length) return { ok: true, value: "" };
  const modele = ours || theirs || base;
  const texte = sortie.join("\n") + (modele.endsWith("\n") ? "\n" : "");
  return { ok: true, value: texte.replace(/\n/g, finDeLigne(modele)) };
}

/** L'union colle le titre d'un camp à la dernière ligne de l'autre : une ligne vide les sépare (hors bloc de code). N'enlève jamais rien. */
function aereTitres(texte: string): string {
  const lignes = texte.split("\n");
  const sortie: string[] = [];
  let bloc = false;
  lignes.forEach((ligne, n) => {
    if (/^\s*```/.test(ligne)) bloc = !bloc;
    if (!bloc && /^#{1,6}(\s|$)/.test(ligne) && n > 0 && lignes[n - 1]!.trim()) sortie.push(ligne.endsWith("\r") ? "\r" : "");
    sortie.push(ligne);
  });
  return sortie.join("\n");
}

/** Carnet en ajout seul : l'union des deux versions, par Git. Null si la commande échoue. */
export function mergeTexte3(base: string, ours: string, theirs: string): string | null {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "studio-registre-"));
    const [b, o, t] = [join(dir, "base"), join(dir, "ours"), join(dir, "theirs")];
    writeFileSync(b, base);
    writeFileSync(o, ours);
    writeFileSync(t, theirs);
    const res = spawnSync("git", ["merge-file", "-p", "--union", o, b, t], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return res.status === 0 ? aereTitres(res.stdout) : null;
  } catch {
    return null;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** Les opérations Git de la résolution (VcsPort les fournit). */
export interface RegistresIo {
  conflicts(root: string): Promise<string[]>;
  readStage(root: string, stage: 1 | 2 | 3, path: string): Promise<string | null>;
  stageFile(root: string, path: string, content: string): Promise<void>;
  commitMerge(root: string, message: string): Promise<void>;
  abortMerge(root: string): Promise<void>;
}

/** Le contenu fusionné d'un registre, ou null si la fusion n'est pas sûre (désaccord, fichier illisible, suppression d'un côté). */
async function fusionner(io: RegistresIo, root: string, path: string): Promise<string | null> {
  const [base, ours, theirs] = await Promise.all([io.readStage(root, 1, path), io.readStage(root, 2, path), io.readStage(root, 3, path)]);
  if (ours === null || theirs === null) return null;
  // Un fichier qui n'est pas en UTF-8 serait abîmé en le réécrivant.
  if ([base, ours, theirs].some((t) => t?.includes("�"))) return null;
  const p = normaliseRegistre(path);
  if (p.endsWith(".md")) return mergeTexte3(base ?? "", ours, theirs);
  if (p.endsWith(".csv")) {
    const res = mergeCsv3(base ?? "", ours, theirs);
    return res.ok ? res.value : null;
  }
  // Fichier ajouté des deux côtés : sa base est un objet vide, pour que leurs clés s'additionnent.
  const res = mergeJsonTexte3(base?.trim() ? base : "{}", ours, theirs);
  return res.ok ? res.value : null;
}

/**
 * Résout une fusion en cours si tous ses conflits sont des registres fusionnables : indexe les résultats et commite. S'il reste
 * un conflit, rien n'est touché (les marqueurs restent, ADR-104) et `remaining` le dit. Ne lève jamais : null si Git a échoué,
 * le comportement d'avant s'applique alors.
 */
export async function resoudreRegistres(io: RegistresIo, root: string, message: string): Promise<{ resolved: string[]; remaining: string[] } | null> {
  try {
    const conflits = await io.conflicts(root);
    if (!conflits.length) return null;
    const fusions = new Map<string, string>();
    const remaining: string[] = [];
    for (const path of conflits) {
      const contenu = isRegistre(path) ? await fusionner(io, root, path) : null;
      if (contenu === null) remaining.push(path);
      else fusions.set(path, contenu);
    }
    const resolved = [...fusions.keys()];
    if (remaining.length) return { resolved, remaining };
    for (const [path, contenu] of fusions) await io.stageFile(root, path, contenu);
    await io.commitMerge(root, message);
    return { resolved, remaining: [] };
  } catch {
    return null;
  }
}
