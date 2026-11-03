import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import type { Missing } from "./playable.ts";

/**
 * Recréer ce qui manque (ADR-120). Un démontage ne rend pas toujours tout : un script vide dans le paquet, une scène
 * absente, une image perdue. Pour que le jeu démarre quand même, le hub reconstitue le fichier au plus juste — un
 * script avec la bonne classe et le bon parent, une scène minimale, une image d'un pixel — et le DIT : rien n'est
 * présenté comme l'original. Quand le fichier existe encore à côté du jeu installé (bibliothèques natives), il est
 * recopié au lieu d'être inventé.
 */

export type RepairKind = "script" | "scene" | "resource" | "image" | "audio" | "native";

/** Un fichier à écrire, avec son contenu prêt et la raison de sa forme. */
export type PlannedRepair = Repair & { body: Buffer | string };

/** Ce qui a été recréé (la forme gardée dans le rapport : jamais le contenu). */
export type Repair = {
  /** Chemin relatif au projet. */
  file: string;
  kind: RepairKind;
  /** Comment il a été reconstitué : ce qui a servi à deviner. */
  note: string;
};

const HEADER: Record<string, string> = {
  script: "// Reconstitué par Nidavellir (ADR-120) : ce fichier manquait ou était vide dans le paquet du jeu.",
  scene: "; Reconstitué par Nidavellir (ADR-120) : scène minimale, le jeu la réclame.",
  resource: "; Reconstitué par Nidavellir (ADR-120) : ressource vide, le jeu la réclame.",
};

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * Ce qu'on peut recréer pour ces fichiers réclamés. `game` (le dossier du jeu installé) sert aux bibliothèques
 * natives : on les recopie plutôt que de les inventer, quand elles sont encore là.
 */
export function planRepairs(dir: string, missing: Missing[], game?: string): PlannedRepair[] {
  const bases = scriptBases(dir);
  const out: PlannedRepair[] = [];
  const done = new Set<string>();
  for (const m of missing) {
    if (done.has(m.path)) continue;
    const plan = planOne(dir, m, bases, game);
    if (!plan) continue;
    done.add(m.path);
    out.push(plan);
  }
  for (const plan of planNatives(dir, game)) if (!done.has(plan.file)) out.push(plan);
  return out.slice(0, 60);
}

function planOne(dir: string, m: Missing, bases: Map<string, { type: string; node: string; scene: string }>, game?: string): PlannedRepair | null {
  const abs = join(dir, m.path);
  const ext = extname(m.path).toLowerCase();
  const name = basename(m.path);
  if (m.kind === "script" && ext === ".cs") {
    const cls = name.replace(/\.cs$/i, "").replace(/[^\w]/g, "_");
    const where = bases.get(m.path.toLowerCase());
    const parent = (/^[A-Za-z_][\w]*$/.test(where?.type ?? "") ? where!.type : "Node") || "Node";
    const note = where
      ? `classe ${cls} héritant de ${parent}, d'après la scène ${where.scene} (nœud ${where.node}) — le corps est vide, à compléter si le jeu s'en sert`
      : `classe ${cls} héritant de Node : aucune scène ne l'utilise, son parent réel est inconnu — à compléter`;
    const body = `${HEADER.script}\nusing Godot;\n\npublic partial class ${cls} : ${parent}\n{\n}\n`;
    return { file: m.path, kind: "script", note, body };
  }
  if (m.kind === "script" && ext === ".gd") {
    return { file: m.path, kind: "script", note: "extends Node : le parent réel est inconnu", body: `${HEADER.script}\nextends Node\n# Corps vide : à compléter si le jeu s'en sert.\n` };
  }
  if (ext === ".tscn" || ext === ".scn") {
    // Une scène vide s'ouvre et se charge : le jeu démarre, l'écran est vide à cet endroit.
    const root = name.replace(/\.tscn$/i, "").replace(/[^\w]/g, "_");
    return { file: m.path, kind: "scene", note: `scène vide avec un seul nœud ${root} (Node)`, body: `[gd_scene load_steps=1 format=3]\n\n[node name="${root}" type="Node"]\n` };
  }
  if (ext === ".tres") {
    return { file: m.path, kind: "resource", note: "ressource générique vide (type Resource)", body: `[gd_resource type="Resource" format=3]\n\n[resource]\n` };
  }
  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp"].includes(ext)) {
    return { file: m.path, kind: "image", note: "image d'un pixel, transparente (l'image d'origine est perdue)", body: PNG_1PX };
  }
  if (ext === ".svg") {
    return { file: m.path, kind: "image", note: "image d'un pixel, transparente (l'image d'origine est perdue)", body: `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n` };
  }
  if ([".wav", ".ogg", ".mp3"].includes(ext)) {
    // Un WAV silencieux : Godot l'importe quel que soit l'extension demandée.
    return { file: m.path, kind: "audio", note: "son silencieux de 100 ms (le son d'origine est perdu)", body: silentWav() };
  }
  if (ext === ".dll" || ext === ".so" || ext === ".dylib") {
    const found = game ? findBeside(game, name) : null;
    if (!found) return null;
    return { file: m.path, kind: "native", note: `bibliothèque recopiée depuis le jeu installé (${relative(game!, found)})`, body: readFileSync(found) };
  }
  return null;
}

/**
 * Les bibliothèques natives que les `.gdextension` réclament dans le projet (`res://…dll`) et qui n'y sont pas : Godot
 * ne les met pas toujours dans le paquet, elles vivent à côté de l'exécutable du jeu. On les recopie de là.
 */
export function planNatives(dir: string, game?: string): PlannedRepair[] {
  if (!game) return [];
  const out: PlannedRepair[] = [];
  for (const file of walk(dir, [".gdextension"], 20_000)) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/=\s*"res:\/\/([^"]+\.(?:dll|so|dylib))"/g)) {
      const rel = m[1]!;
      if (existsSync(join(dir, rel))) continue;
      const found = findBeside(game, basename(rel));
      if (!found) continue;
      out.push({ file: rel, kind: "native", note: `bibliothèque recopiée depuis le jeu installé (${relative(game, found)})`, body: readFileSync(found) });
    }
  }
  return out;
}

export function applyRepairs(dir: string, planned: PlannedRepair[]): Repair[] {
  const written: Repair[] = [];
  for (const p of planned) {
    const abs = join(dir, p.file);
    try {
      // Un fichier déjà présent et non vide n'est jamais écrasé : on ne défait pas ce que le paquet a rendu.
      if (existsSync(abs) && statSync(abs).size >= 32) continue;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, p.body);
      written.push({ file: p.file, kind: p.kind, note: p.note });
    } catch {
      /* chemin invalide ou disque plein : le fichier reste manquant, le rapport le dira */
    }
  }
  return written;
}

/**
 * Pour chaque script du projet, la scène qui l'utilise et le type du nœud qui le porte : c'est ce qui permet de donner
 * au script reconstitué le bon parent (`Button`, `Node2D`…) au lieu d'un `Node` générique.
 */
export function scriptBases(dir: string): Map<string, { type: string; node: string; scene: string }> {
  const out = new Map<string, { type: string; node: string; scene: string }>();
  for (const file of walk(dir, [".tscn"], 8_000)) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const ids = new Map<string, string>();
    for (const m of text.matchAll(/\[ext_resource[^\]]*type="Script"[^\]]*path="res:\/\/([^"]+)"[^\]]*id="([^"]+)"\]/g)) ids.set(m[2]!, m[1]!.toLowerCase());
    if (!ids.size) continue;
    for (const section of text.split(/^(?=\[)/m)) {
      const header = /^\[node\s([^\]]*)\]/.exec(section);
      if (!header) continue;
      const script = /script\s*=\s*ExtResource\("([^"]+)"\)/.exec(section);
      if (!script) continue;
      const path = ids.get(script[1]!);
      if (!path || out.has(path)) continue;
      const type = /type="([^"]+)"/.exec(header[1]!)?.[1] ?? (/instance=ExtResource\(/.test(header[1]!) ? "Node" : "Node");
      const node = /name="([^"]*)"/.exec(header[1]!)?.[1] ?? "";
      out.set(path, { type, node, scene: relative(dir, file).replace(/\\/g, "/") });
    }
  }
  return out;
}

function walk(root: string, exts: string[], limit: number): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const go = (p: string) => {
    if (found.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= limit) return;
      if (e.name === ".godot" || e.name === "node_modules" || e.name === ".git") continue;
      const abs = join(p, e.name);
      if (e.isDirectory()) {
        if (seen.has(abs)) continue;
        seen.add(abs);
        go(abs);
      } else if (exts.includes(extname(e.name).toLowerCase())) found.push(abs);
    }
  };
  go(root);
  return found;
}

/** Cherche un fichier par son nom dans le dossier du jeu (deux niveaux : racine, puis un sous-dossier). */
export function findBeside(game: string, name: string): string | null {
  const direct = join(game, name);
  if (existsSync(direct)) return direct;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(game, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(game, e.name));
  } catch {
    return null;
  }
  for (const d of dirs) {
    const hit = join(d, name);
    if (existsSync(hit)) return hit;
  }
  for (const d of dirs) {
    let subs: string[] = [];
    try {
      subs = readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(d, e.name));
    } catch {
      continue;
    }
    for (const s of subs) {
      const hit = join(s, name);
      if (existsSync(hit)) return hit;
    }
  }
  return null;
}

/** Un PNG transparent d'un pixel (67 octets). */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Un WAV de 100 ms de silence, 8 kHz mono 8 bits : de quoi remplacer un son perdu sans faire échouer l'import. */
function silentWav(): Buffer {
  const samples = 800;
  const b = Buffer.alloc(44 + samples, 128);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + samples, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(samples, 40);
  return b;
}

/** Le résumé en une ligne, pour le journal du hub. */
export const repairsSummary = (r: Repair[]) =>
  r.length ? `${plural(r.length, "fichier recréé", "fichiers recréés")} : ${r.slice(0, 3).map((x) => x.file).join(", ")}${r.length > 3 ? "…" : ""}` : "rien à recréer";
