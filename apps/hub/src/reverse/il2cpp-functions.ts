import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * Le code des fonctions d'un jeu Unity IL2CPP (ADR-96). AssetRipper ne rend que la structure (méthodes vides) ;
 * Cpp2IL relit le code machine de chaque fonction en ISIL, un pseudo-assembleur où les appels sont déjà nommés
 * (« Call PlayerStats.GetStat »). Il reste deux trous que le hub bouche ici, sans IA :
 * - les champs de l'objet apparaissent en décalages (« [rbx+72] ») : on remet leur nom (« [rbx+72 «rb»] »), grâce aux
 *   décalages que donne la sortie « diffable-cs » de Cpp2IL ;
 * - les constantes sont des adresses (« [0x18262EC80] ») : on lit leur valeur dans GameAssembly.dll (« «15» »).
 * Les assemblages du moteur et des bibliothèques connues sont laissés de côté : seul le code du jeu reste.
 */

/** Assemblages qui ne sont pas le jeu lui-même (moteur, système, bibliothèques du commerce). */
const FRAMEWORK = new RegExp(
  "^(" +
    [
      "mscorlib|netstandard|System|System\\..+|Mono\\..+|Microsoft\\..+|UnityEngine|UnityEngine\\..+|Unity\\..+|UnityUIExtensions|__Generated",
      "Newtonsoft\\.Json.*|DOTween.*|Demigiant.*|Rewired.*|Photon.*|quantum\\.core|com\\.rlabrecque\\..+|Facepunch\\..+|Steamworks.*|Discord.*",
      "FMOD.*|Cinemachine.*|Coffee\\..+|QRCoder|DynamicBone|Sirenix\\..+|MK\\..+|AstarPathfindingProject|Febucci\\..+|I2\\..+|Spine\\..+",
      "Coherence(\\..+)?|PlayFab.*|Zenject.*|UniTask.*|UniRx.*|Doozy.*|Dreamteck\\..+|ProCamera2D|SuperTiled2Unity|QFSW\\..+|IngameDebugConsole.*",
      "Tayx\\..+|UIEffect|AppleAuth|lexonegit\\..+|XNode|Unified\\..+|Cyanilux\\..+|GKNativeExtensions|SimpleHttp|UnsafeAccess|Beardy\\..+",
      "Lofelt\\..+|Sentry.*|Mirror.*|FishNet.*|Odin.*|LeanTween|Animancer.*|TextMeshPro|Obi.*|Bosco\\.Core|Shapes|Febucci.*|NaughtyAttributes.*",
    ].join("|") +
    ")$",
  "i",
);

type TypeInfo = {
  base: string | null;
  fields: Map<number, string>;
  staticMethods: Set<string>;
  instanceMethods: Set<string>;
  /** Paramètres de chaque méthode (types simples, dans l'ordre), pour nommer les valeurs d'énumération passées. */
  params: Map<string, string[]>;
  /** Pour une énumération : valeur → nom. */
  values: Map<number, string> | null;
};

/** Ce qu'il faut pour lire un appel : les énumérations et les paramètres des méthodes, par nom simple. */
type CallInfo = { method(type: string, name: string): { params: string[]; static: boolean } | null; enumValue(type: string, n: number): string | null };

export type FunctionsReport = { assemblies: { name: string; classes: number; methods: number }[]; classes: number; methods: number; fields: number; constants: number; enums: number };

function walk(dir: string, ext: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** Les types d'un fichier « diffable-cs » : leurs champs d'instance (décalage → nom), leur parent, leurs méthodes statiques ou non. */
export function parseDiffable(text: string, types: Map<string, TypeInfo>): void {
  const ns = /^namespace\s+([\w.]+)\s*;/m.exec(text)?.[1] ?? "";
  const stack: { name: string; depth: number }[] = [];
  let pending: { name: string; base: string | null; isEnum: boolean } | null = null;
  let depth = 0;
  for (const raw of text.split(/\r?\n/)) {
    const hasBrace = raw.includes("{") || raw.includes("}");
    const cur = stack.at(-1);
    const inside = !!cur && depth === cur.depth + 1;
    // Les lignes sans déclaration, sans accolade et sans intérêt (attributs, commentaires) : rien à lire.
    if (!hasBrace && !inside && !/\b(class|struct|interface|record|enum)\s/.test(raw)) continue;
    const line = raw.includes('"') ? raw.replace(/"(?:[^"\\]|\\.)*"/g, '""') : raw;
    const decl = /\b(class|struct|interface|record|enum)\s+(\w+)(?:<[^>{]*>)?(?:\s*:\s*([\w.<>, `]+))?/.exec(line);
    if (decl && !/\(/.test(line.split(decl[0])[0] ?? ""))
      pending = { name: decl[2]!, base: decl[1] === "enum" ? null : (decl[3]?.split(",")[0]?.trim().replace(/<.*$/, "") ?? null), isEnum: decl[1] === "enum" };
    if (inside && !/^\s*\[/.test(line)) {
      const key = typeKey(ns, stack);
      const info = types.get(key);
      const value = info?.values ? /^\s*(\w+)\s*=\s*(-?\d+)\s*,?\s*$/.exec(line) : null;
      if (value) info!.values!.set(Number(value[2]), value[1]!);
      const field = line.includes("//Field offset") ? /^\s*([^=(]*?)\b(\w+)\s*(?:=[^;]*)?;\s*\/\/Field offset: 0x([0-9A-Fa-f]+)/.exec(line) : null;
      if (info && field && !/\b(static|const)\b/.test(field[1]!)) info.fields.set(parseInt(field[3]!, 16), field[2]!);
      const method = !field && !decl && line.includes("(") ? /\b(\w+)\s*(?:<[^>]*>)?\s*\(([^;)]*)\)\s*(?:\{\s*\}|$)/.exec(line) : null;
      if (info && method) {
        (/\bstatic\b/.test(line) ? info.staticMethods : info.instanceMethods).add(method[1]!);
        // Le type de chaque paramètre (« EStat stat, bool x » → EStat, bool) : on garde la première surcharge.
        if (!info.params.has(method[1]!))
          info.params.set(
            method[1]!,
            method[2]!
              .split(",")
              .map((p) => p.trim().replace(/^(ref|out|in|params)\s+/, "").split(/\s+/)[0] ?? "")
              .filter(Boolean)
              .map((t) => {
                const s = t.replace(/<.*$/, "");
                return s.slice(s.lastIndexOf(".") + 1);
              }),
          );
      }
    }
    if (!hasBrace) continue;
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        if (pending) {
          stack.push({ name: pending.name, depth: depth - 1 });
          types.set(typeKey(ns, stack), { base: pending.base, fields: new Map(), staticMethods: new Set(), instanceMethods: new Set(), params: new Map(), values: pending.isEnum ? new Map() : null });
          pending = null;
        }
      } else if (ch === "}") {
        depth--;
        if (stack.at(-1)?.depth === depth) stack.pop();
      }
    }
  }
}

const typeKey = (ns: string, stack: { name: string }[]) => `${ns ? `${ns}.` : ""}${stack.map((s) => s.name).join("+")}`;

/** Les sections en lecture seule de GameAssembly.dll : c'est là que le compilateur range les constantes. */
class PeConstants {
  readonly #fd: number;
  readonly #base: bigint;
  readonly #sections: { va: number; size: number; raw: number; rawSize: number }[] = [];
  readonly #cache = new Map<string, string | null>();

  constructor(path: string) {
    this.#fd = openSync(path, "r");
    const head = Buffer.alloc(4096);
    readSync(this.#fd, head, 0, 4096, 0);
    this.#base = 0n;
    // Pas un exécutable Windows lisible : aucune constante, sans erreur.
    if (head.toString("latin1", 0, 2) !== "MZ") return;
    const pe = head.readUInt32LE(0x3c);
    if (pe > 4000 || head.toString("latin1", pe, pe + 4) !== "PE\0\0") return;
    const count = head.readUInt16LE(pe + 6);
    const optSize = head.readUInt16LE(pe + 20);
    const opt = pe + 24;
    this.#base = head.readUInt16LE(opt) === 0x20b ? head.readBigUInt64LE(opt + 24) : BigInt(head.readUInt32LE(opt + 28));
    for (let i = 0; i < count; i++) {
      const s = opt + optSize + i * 40;
      const flags = head.readUInt32LE(s + 36);
      // Données initialisées, lisibles, pas écrites : les constantes du code.
      if (flags & 0x40 && !(flags & 0x80000000) && !(flags & 0x20))
        this.#sections.push({ va: head.readUInt32LE(s + 12), size: head.readUInt32LE(s + 8), raw: head.readUInt32LE(s + 20), rawSize: head.readUInt32LE(s + 16) });
    }
  }

  /** La valeur lisible à une adresse absolue, ou null (adresse modifiable, hors du fichier, valeur improbable). */
  value(hex: string): string | null {
    if (this.#cache.has(hex)) return this.#cache.get(hex)!;
    let out: string | null = null;
    const rva = Number(BigInt(`0x${hex}`) - this.#base);
    const s = this.#sections.find((x) => rva >= x.va && rva + 8 <= x.va + Math.min(x.size, x.rawSize));
    if (s) {
      const buf = Buffer.alloc(8);
      readSync(this.#fd, buf, 0, 8, s.raw + (rva - s.va));
      const f = buf.readFloatLE(0);
      const d = buf.readDoubleLE(0);
      out = plausible(f) ? fmt(f) : plausible(d) ? `${fmt(d)} (double)` : null;
    }
    this.#cache.set(hex, out);
    return out;
  }

  close(): void {
    closeSync(this.#fd);
  }
}

const plausible = (v: number) => Number.isFinite(v) && (v === 0 || (Math.abs(v) >= 1e-4 && Math.abs(v) < 1e9));
const fmt = (v: number) => String(Number(v.toPrecision(7)));

const VOLATILE = ["rax", "rcx", "rdx", "r8", "r9", "r10", "r11"];
const WRITES = /^(Move|LoadAddress|Add|Subtract|Multiply|Divide|And|Or|Xor|ShiftLeft|ShiftRight|Not|Negate|Exchange|Pop)$/;

/**
 * Annote les instructions ISIL d'une méthode. Le registre qui porte « this » est suivi en ligne droite (rcx au départ,
 * puis ses copies, effacé quand on y écrit ou après un appel s'il est volatil) : c'est une approximation, d'où des noms
 * présentés comme déduits du décalage, mais elle tient pour l'immense majorité du code généré par IL2CPP.
 */
export function annotate(
  lines: string[],
  fields: Map<number, string> | null,
  instance: boolean,
  constants: { value(hex: string): string | null } | null,
  stats = { fields: 0, constants: 0, enums: 0 },
  calls: CallInfo | null = null,
): string[] {
  const self = new Set<string>(instance ? ["rcx"] : []);
  // Les entiers posés dans un registre juste avant un appel : une valeur d'énumération se nomme (« 26 » → « EStat.JumpHeight »).
  const literal = new Map<string, number>();
  return lines.map((line) => {
    const m = /^(\s*\d+\s+)(\w+)(.*)$/.exec(line);
    if (!m) return line;
    const [, num, op, rest] = m as unknown as [string, string, string, string];
    let text = rest.replace(/\[(r\w+)\+(\d+)\]/g, (all, reg: string, off: string) => {
      const name = fields && self.has(reg) ? fields.get(Number(off)) : undefined;
      if (!name) return all;
      stats.fields++;
      return `[${reg}+${off} «${name}»]`;
    });
    if (constants)
      text = text.replace(/\[0x([0-9A-Fa-f]{6,16})\]/g, (all, hex: string) => {
        const v = constants.value(hex);
        if (v === null) return all;
        stats.constants++;
        return `[0x${hex} «${v}»]`;
      });
    const ops = rest.trim().split(/,\s*/);
    if ((op === "Call" || op === "CallNoReturn") && calls) {
      const target = /^([\w.`<>+]+)\.(\w+)$/.exec(ops[0]?.trim() ?? "");
      const info = target ? calls.method(target[1]!, target[2]!) : null;
      if (info) {
        const regs = info.static ? ["rcx", "rdx", "r8", "r9"] : ["rdx", "r8", "r9"];
        const named = info.params.flatMap((type, i) => {
          const n = regs[i] ? literal.get(regs[i]!) : undefined;
          const name = n === undefined ? null : calls.enumValue(type, n);
          return name ? [`${type}.${name}`] : [];
        });
        if (named.length) {
          stats.enums += named.length;
          text += `   «${named.join(", ")}»`;
        }
      }
    }
    // Le suivi de « this » et des entiers, après lecture de l'instruction.
    const dest = ops[0]?.trim();
    if (op === "Call" || op === "CallNoReturn")
      for (const r of VOLATILE) {
        self.delete(r);
        literal.delete(r);
      }
    else if (dest && /^r\w+$/.test(dest) && WRITES.test(op)) {
      const src = ops[1]?.trim();
      if (op === "Move" && src && self.has(src)) self.add(dest);
      else self.delete(dest);
      const int = op === "Move" && src && /^-?(0x[0-9A-Fa-f]+|\d+)$/.test(src) ? Number(src) : undefined;
      if (int !== undefined && Number.isSafeInteger(int)) literal.set(dest, int);
      else literal.delete(dest);
    }
    return `${num}${op}${text}`;
  });
}

/**
 * Construit `out/<assemblage>/<chemin>.txt` : pour chaque type, ses méthodes avec leur code ISIL annoté (sans le
 * désassemblage brut, deux fois plus long et moins lisible), plus un LISEZMOI pour l'Archéologue.
 */
export function buildFunctions(input: { isilDir: string; csDir: string; binary: string | null; out: string; log?: (line: string) => void }): FunctionsReport {
  const types = new Map<string, TypeInfo>();
  const assemblies = readdirSync(input.isilDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !FRAMEWORK.test(e.name))
    .map((e) => e.name);
  input.log?.(`Lecture de la structure (${assemblies.length} assemblages du jeu)…`);
  for (const asm of assemblies) for (const f of walk(join(input.csDir, asm), ".cs")) parseDiffable(readFileSync(f, "utf8"), types);
  const bySimple = new Map<string, TypeInfo>();
  for (const [k, v] of types) bySimple.set(k.slice(k.lastIndexOf(".") + 1), v);
  // Les champs hérités des classes du jeu comptent aussi : un ennemi lit les champs de sa classe de base.
  const fieldCache = new Map<string, Map<number, string> | null>();
  const allFields = (key: string): Map<number, string> | null => {
    if (fieldCache.has(key)) return fieldCache.get(key)!;
    const merged = new Map<number, string>();
    let info = types.get(key);
    for (let guard = 0; info && guard < 12; guard++) {
      for (const [o, n] of info.fields) if (!merged.has(o)) merged.set(o, n);
      info = info.base ? (types.get(info.base) ?? bySimple.get(info.base.slice(info.base.lastIndexOf(".") + 1))) : undefined;
    }
    const result = merged.size ? merged : null;
    fieldCache.set(key, result);
    return result;
  };

  const lookup = (type: string) => types.get(type) ?? bySimple.get(type.slice(type.lastIndexOf(".") + 1));
  const calls: CallInfo = {
    method(type, name) {
      const info = lookup(type);
      const params = info?.params.get(name);
      return info && params ? { params, static: info.staticMethods.has(name) && !info.instanceMethods.has(name) } : null;
    },
    enumValue: (type, n) => lookup(type)?.values?.get(n) ?? null,
  };
  const constants = input.binary && existsSync(input.binary) ? new PeConstants(input.binary) : null;
  const stats = { fields: 0, constants: 0, enums: 0 };
  const report: FunctionsReport = { assemblies: [], classes: 0, methods: 0, fields: 0, constants: 0, enums: 0 };
  try {
    for (const asm of assemblies) {
      let classes = 0;
      let methods = 0;
      for (const file of walk(join(input.isilDir, asm), ".txt")) {
        const out: string[] = [];
        let type = "";
        let method: string | null = null;
        let mode: "none" | "asm" | "isil" = "none";
        let body: string[] = [];
        const flush = () => {
          if (method === null) return;
          const name = /(\w+)(?:<[^>]*>)?\(/.exec(method)?.[1] ?? "";
          const info = types.get(type);
          const instance = !(info?.staticMethods.has(name) && !info.instanceMethods.has(name));
          out.push(`Méthode : ${method}${instance ? "" : "   [statique]"}`);
          // Pas d'étalement (« ...annotate() ») : une très longue méthode ferait déborder la pile.
          for (const l of annotate(body, allFields(type), instance, constants, stats, calls)) out.push(l);
          out.push("");
          methods++;
          method = null;
          body = [];
        };
        for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
          if (raw.startsWith("Type: ")) {
            flush();
            type = raw.slice(6).trim();
            const base = types.get(type)?.base;
            out.push(`Type : ${type}${base ? ` (hérite de ${base})` : ""}`, "");
            classes++;
            mode = "none";
          } else if (raw.startsWith("Method: ")) {
            flush();
            method = raw.slice(8).trim();
            mode = "none";
          } else if (raw === "Disassembly:") mode = "asm";
          else if (raw === "ISIL:") mode = "isil";
          else if (mode === "isil" && raw.trim()) body.push(raw);
        }
        flush();
        const target = join(input.out, asm, relative(join(input.isilDir, asm), file));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, out.join("\n"), "utf8");
      }
      if (methods) {
        report.assemblies.push({ name: asm, classes, methods });
        input.log?.(`${asm} : ${methods.toLocaleString("fr-FR")} fonctions annotées`);
      }
      report.classes += classes;
      report.methods += methods;
    }
  } finally {
    constants?.close();
  }
  report.fields = stats.fields;
  report.constants = stats.constants;
  report.enums = stats.enums;
  report.assemblies.sort((a, b) => b.methods - a.methods);
  writeFileSync(join(input.out, "LISEZMOI.md"), readme(report), "utf8");
  return report;
}

function readme(r: FunctionsReport): string {
  return [
    "# Le code des fonctions (IL2CPP)",
    "",
    "Récupéré par Cpp2IL dans le code machine du jeu (GameAssembly.dll), puis annoté par le hub. Un fichier par type, au même chemin que sa structure en C#.",
    "",
    "## Comment le lire",
    "- Chaque méthode est une suite d'instructions ISIL numérotées (un pseudo-assembleur).",
    "- `Call PlayerStats.GetStat, rcx, rdx` : appel d'une fonction, ses arguments dans l'ordre rcx, rdx, r8, r9. Le résultat revient dans rax (ou xmm0 pour un nombre à virgule).",
    "- `[rbx+72 «rb»]` : le champ `rb` de l'objet (`this`). Le nom est déduit du décalage : très probable, pas certain.",
    "- `[0x18262EC80 «15»]` : une constante lue dans le jeu (ici 15). Une adresse sans valeur est une variable du jeu, pas une constante.",
    "- `Call PlayerStats.GetStat, rcx, rdx   «EStat.JumpHeight»` : la valeur d'énumération passée à l'appel (ici 26, c'est-à-dire JumpHeight).",
    "- `Compare a, b` puis `JumpIfEqual {12}` : un test, et le saut à l'instruction 12 quand il est vrai. `Goto {n}` : saut sans condition. `Return rax` : la valeur rendue.",
    "- `Move rcx, typeof(X)` : la classe X elle-même (ses champs statiques). Les appels à `il2cpp_codegen_initialize_runtime_metadata` ou `il2cpp_runtime_class_init` sont de la plomberie : on les ignore.",
    "",
    `## Contenu : ${r.methods.toLocaleString("fr-FR")} méthodes dans ${r.classes.toLocaleString("fr-FR")} types`,
    ...r.assemblies.map((a) => `- \`${a.name}/\` : ${a.methods.toLocaleString("fr-FR")} méthodes, ${a.classes.toLocaleString("fr-FR")} types`),
    "",
    `Noms de champs remis : ${r.fields.toLocaleString("fr-FR")} ; constantes lues : ${r.constants.toLocaleString("fr-FR")} ; valeurs d'énumération nommées : ${r.enums.toLocaleString("fr-FR")}. Le moteur Unity et les bibliothèques du commerce sont laissés de côté.`,
    "",
  ].join("\n");
}
