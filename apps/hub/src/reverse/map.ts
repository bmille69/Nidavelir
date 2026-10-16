import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/**
 * La carte du jeu démonté (ADR-42, inspirée de REA « l'inventaire d'abord ») : un sommaire calculé par le hub,
 * sans IA, que l'Archéologue lit avant d'explorer. Il cherche au bon endroit au lieu de tout parcourir.
 */

/** Fichiers de code et de données : ceux qu'on indexe et qu'on compare d'une version à l'autre. */
const CODE = new Set([".cs", ".gd"]);
const DATA = new Set([".json", ".tres", ".tscn", ".csv", ".cfg", ".ini", ".txt", ".xml", ".yaml", ".yml", ".godot"]);
const MAX_READ = 2_000_000;
const MAX_FILES = 200_000;

type Entry = { rel: string; ext: string; size: number };

function walk(root: string): Entry[] {
  const out: Entry[] = [];
  const go = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) go(p);
      else if (e.isFile()) {
        let size = 0;
        try {
          size = statSync(p).size;
        } catch {
          /* fichier disparu : compté sans taille */
        }
        out.push({ rel: relative(root, p).replace(/\\/g, "/"), ext: extname(e.name).toLowerCase(), size });
      }
    }
  };
  go(root);
  return out;
}

function read(root: string, rel: string): string {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return "";
  }
}

export type CodeType = { name: string; kind: string; base: string | null; file: string; line: number };

/** Types déclarés dans un fichier C# ou GDScript (repérage simple par motifs, pas un vrai analyseur). */
export function typesIn(text: string, file: string): CodeType[] {
  const found: CodeType[] = [];
  if (file.endsWith(".gd")) {
    const name = /^class_name\s+(\w+)/m.exec(text)?.[1];
    const base = /^extends\s+([\w.]+)/m.exec(text)?.[1] ?? null;
    if (name) found.push({ name, kind: "class", base, file, line: lineOf(text, /^class_name\s/m) });
    return found;
  }
  const ns = /^\s*namespace\s+([\w.]+)/m.exec(text)?.[1];
  const re = /^[ \t]*(?:(?:public|internal|private|protected|static|abstract|sealed|partial|readonly|unsafe|new)\s+)*(class|struct|record|interface|enum)\s+(\w+)(?:<[^>{]*>)?(?:\s*\([^)]*\))?(?:\s*:\s*([\w.<>, ]+?))?\s*(?:where\s[^{]*)?(?:\{|;|$)/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const base = m[3]?.split(",")[0]?.trim().replace(/<.*$/, "") || null;
    found.push({ name: ns ? `${ns}.${m[2]}` : m[2]!, kind: m[1]!, base, file, line: text.slice(0, m.index).split("\n").length });
  }
  return found;
}

function lineOf(text: string, re: RegExp): number {
  const m = re.exec(text);
  return m ? text.slice(0, m.index).split("\n").length : 1;
}

const ko = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

/** Construit la carte (Markdown) et l'index des types (une ligne par type, à chercher avec Grep). */
export function buildMap(root: string, name: string): { map: string; index: string; types: number } {
  const files = walk(root);
  const code = files.filter((f) => CODE.has(f.ext));
  const types: CodeType[] = [];
  for (const f of code) if (f.size <= MAX_READ) types.push(...typesIn(read(root, f.rel), f.rel));

  const lines: string[] = [`# Carte de « ${name} »`, "", "Calculée par le hub à partir des fichiers démontés (repérage automatique, sans IA). Les chemins partent de `jeu/`.", ""];

  // Projet Godot : scène de départ et « autoloads », les systèmes toujours chargés.
  const godot = files.find((f) => f.rel === "project.godot") ? read(root, "project.godot") : "";
  if (godot) {
    lines.push("## Projet Godot");
    const main = /run\/main_scene="([^"]+)"/.exec(godot)?.[1];
    if (main) lines.push(`- Scène de départ : \`${main}\``);
    const autoload = /\[autoload\]([\s\S]*?)(?:\n\[|$)/.exec(godot)?.[1] ?? "";
    const singletons = [...autoload.matchAll(/^(\w+)="\*?([^"]+)"/gm)];
    if (singletons.length) {
      lines.push("- Autoloads (systèmes toujours chargés, souvent les « chefs d'orchestre » du jeu) :");
      for (const s of singletons.slice(0, 40)) lines.push(`  - ${s[1]} : \`${s[2]}\``);
    }
    lines.push("");
  }

  // Dossiers : où est quoi, en nombre de fichiers.
  const byDir = new Map<string, { n: number; code: number; data: number }>();
  for (const f of files) {
    const parts = f.rel.split("/");
    const dir = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts.length === 2 ? parts[0]! : ".";
    const d = byDir.get(dir) ?? { n: 0, code: 0, data: 0 };
    d.n++;
    if (CODE.has(f.ext)) d.code++;
    if (DATA.has(f.ext)) d.data++;
    byDir.set(dir, d);
  }
  lines.push(`## Dossiers (${files.length.toLocaleString("fr-FR")} fichiers)`);
  for (const [dir, d] of [...byDir].sort((a, b) => b[1].n - a[1].n).slice(0, 40)) lines.push(`- \`${dir}/\` : ${d.n} fichiers (${d.code} de code, ${d.data} de données)`);
  lines.push("");

  // Familles : les classes de base dont beaucoup d'autres héritent sont les grands systèmes (cartes, ennemis, reliques…).
  const families = new Map<string, number>();
  for (const t of types) if (t.base) families.set(t.base, (families.get(t.base) ?? 0) + 1);
  const big = [...families].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 30);
  if (big.length) {
    lines.push("## Familles de classes");
    lines.push("Une classe de base dont héritent beaucoup d'autres est souvent un système du jeu : chaque carte, ennemi ou objet en est une variante.");
    for (const [base, n] of big) {
      const where = types.find((t) => t.name === base || t.name.endsWith(`.${base}`));
      lines.push(`- \`${base}\` : ${n} variantes${where ? ` (définie dans \`${where.file}:${where.line}\`)` : ""}`);
    }
    lines.push("");
  }

  // Espaces de noms : le découpage du code.
  const byNs = new Map<string, number>();
  for (const t of types) {
    const ns = t.name.includes(".") ? t.name.slice(0, t.name.lastIndexOf(".")) : "(sans espace de noms)";
    byNs.set(ns, (byNs.get(ns) ?? 0) + 1);
  }
  if (byNs.size) {
    lines.push(`## Code : ${types.length.toLocaleString("fr-FR")} types dans ${code.length.toLocaleString("fr-FR")} fichiers`);
    for (const [ns, n] of [...byNs].sort((a, b) => b[1] - a[1]).slice(0, 40)) lines.push(`- \`${ns}\` : ${n} types`);
    if (byNs.size > 40) lines.push(`- … et ${byNs.size - 40} autres espaces de noms`);
    lines.push("", "Tous les types sont dans `index-code.txt` (une ligne par type : nom, sorte, parent, fichier:ligne). Cherchez-y avec Grep.", "");
  }

  // Données : où sont décrits cartes, ennemis, textes…
  const dataDirs = new Map<string, Map<string, number>>();
  for (const f of files.filter((x) => DATA.has(x.ext))) {
    const dir = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : ".";
    const m = dataDirs.get(dir) ?? new Map<string, number>();
    m.set(f.ext, (m.get(f.ext) ?? 0) + 1);
    dataDirs.set(dir, m);
  }
  const dataTop = [...dataDirs].map(([dir, m]) => ({ dir, n: [...m.values()].reduce((a, b) => a + b, 0), m })).sort((a, b) => b.n - a.n).slice(0, 25);
  if (dataTop.length) {
    lines.push("## Données (fichiers de configuration, textes, scènes)");
    for (const d of dataTop) lines.push(`- \`${d.dir}/\` : ${[...d.m].map(([e, n]) => `${n} ${e}`).join(", ")}`);
    lines.push("");
  }

  // Gros fichiers : à lire par extraits.
  const heavy = [...code].sort((a, b) => b.size - a.size).slice(0, 15);
  if (heavy.length) {
    lines.push("## Les plus gros fichiers de code (à lire par extraits, après un Grep)");
    for (const f of heavy) lines.push(`- \`${f.rel}\` : ${ko(f.size)}`);
    lines.push("");
  }

  const index = types
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `${t.name} | ${t.kind}${t.base ? ` : ${t.base}` : ""} | ${t.file}:${t.line}`)
    .join("\n");
  return { map: lines.join("\n"), index: index ? `${index}\n` : "", types: types.length };
}

export type Changes = { added: string[]; removed: string[]; changed: string[]; types: { added: string[]; removed: string[] } };

function digest(root: string, rel: string): string {
  try {
    return createHash("sha1").update(readFileSync(join(root, rel))).digest("hex");
  } catch {
    return "";
  }
}

/** Ce qui a changé entre deux versions démontées, pour le code et les données seulement (pas les images ni les sons). */
export function compareVersions(before: string, after: string): Changes {
  const keep = (f: Entry) => CODE.has(f.ext) || DATA.has(f.ext);
  const a = new Map(walk(before).filter(keep).map((f) => [f.rel, f]));
  const b = new Map(walk(after).filter(keep).map((f) => [f.rel, f]));
  const added = [...b.keys()].filter((k) => !a.has(k)).sort();
  const removed = [...a.keys()].filter((k) => !b.has(k)).sort();
  const changed = [...b.keys()]
    .filter((k) => a.has(k) && (a.get(k)!.size !== b.get(k)!.size || (a.get(k)!.size <= MAX_READ && digest(before, k) !== digest(after, k))))
    .sort();
  const names = (root: string, list: Map<string, Entry>) =>
    new Set([...list.values()].filter((f) => CODE.has(f.ext) && f.size <= MAX_READ).flatMap((f) => typesIn(read(root, f.rel), f.rel).map((t) => t.name)));
  const ta = names(before, a);
  const tb = names(after, b);
  return { added, removed, changed, types: { added: [...tb].filter((t) => !ta.has(t)).sort(), removed: [...ta].filter((t) => !tb.has(t)).sort() } };
}

/** Le relevé des changements, en Markdown, pour l'Archéologue et pour vous. */
export function changesReport(name: string, c: Changes): string {
  const list = (title: string, items: string[], max = 150) =>
    items.length ? [`## ${title} (${items.length})`, ...items.slice(0, max).map((i) => `- \`${i}\``), ...(items.length > max ? [`- … et ${items.length - max} autres`] : []), ""] : [];
  return [
    `# Changements de « ${name} » depuis le démontage précédent`,
    "",
    "Calculés par le hub : fichiers de code et de données seulement. L'ancienne version est dans `ancien/`, la nouvelle dans `jeu/`.",
    "",
    ...list("Fichiers modifiés", c.changed, 300),
    ...list("Fichiers ajoutés", c.added),
    ...list("Fichiers retirés", c.removed),
    ...list("Types (classes…) apparus", c.types.added),
    ...list("Types disparus", c.types.removed),
    ...(c.changed.length + c.added.length + c.removed.length === 0 ? ["Aucun fichier de code ou de données n'a changé.", ""] : []),
  ].join("\n");
}

/** Empreinte des fichiers du jeu installé (taille et date) : elle change quand le jeu est mis à jour. */
export function fingerprint(paths: (string | null)[]): string {
  return paths
    .filter((p): p is string => !!p && existsSync(p))
    .map((p) => {
      const s = statSync(p);
      return `${s.size}:${Math.round(s.mtimeMs)}`;
    })
    .join("|");
}
