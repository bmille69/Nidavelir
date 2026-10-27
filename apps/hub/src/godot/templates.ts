import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

/**
 * Les modèles d'export de Godot (ADR-90), pour Windows seulement. L'archive officielle pèse 1,25 Go pour toutes les
 * plateformes ; c'est un zip : on lit son sommaire à la fin du fichier, puis on ne télécharge que les fichiers
 * utiles (environ 6 % de l'archive), par plages HTTP. Rangés là où Godot les cherche, pour votre éditeur aussi.
 */

export const WINDOWS_TEMPLATES = ["windows_release_x86_64.exe", "windows_release_x86_64_console.exe", "windows_debug_x86_64.exe", "windows_debug_x86_64_console.exe", "version.txt"] as const;

/** « 4.6.2 » → « 4.6.2.stable » : le dossier que Godot lit. */
export function templatesDir(version: string): string {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const v = /^\d+\.\d+(\.\d+)?$/.test(version) ? `${version}.stable` : version.replace("-", ".");
  return join(appData, "Godot", "export_templates", v);
}

export function hasWindowsTemplates(version: string): boolean {
  const dir = templatesDir(version);
  return existsSync(join(dir, "windows_release_x86_64.exe")) && existsSync(join(dir, "version.txt"));
}

export function templatesUrl(version: string): string {
  const tag = /^\d+\.\d+(\.\d+)?$/.test(version) ? `${version}-stable` : version;
  return `https://github.com/godotengine/godot/releases/download/${tag}/Godot_v${tag}_export_templates.tpz`;
}

type Ranged = (url: string, from: number, to: number) => Promise<Buffer>;

const httpRange: Ranged = async (url, from, to) => {
  const res = await fetch(url, { headers: { range: `bytes=${from}-${to}`, "user-agent": "Nidavellir-studio" }, redirect: "follow" });
  if (res.status !== 206) throw new Error(`Le serveur de Godot ne sert pas les plages (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
};

async function totalSize(url: string): Promise<number> {
  const res = await fetch(url, { headers: { range: "bytes=0-0", "user-agent": "Nidavellir-studio" }, redirect: "follow" });
  const m = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
  await res.arrayBuffer().catch(() => {});
  if (res.status === 404) throw new Error("Pas de modèles d'export publiés pour cette version de Godot");
  if (!m) throw new Error(`Taille de l'archive inconnue (${res.status})`);
  return Number(m[1]);
}

type Entry = { name: string; method: number; compressed: number; size: number; offset: number };

/** Le sommaire d'un zip (fin de fichier), y compris en ZIP64. */
export function readCentralDirectory(tail: Buffer, tailStart: number, fetchDir: (offset: number, size: number) => Promise<Buffer>): Promise<Entry[]> {
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("Archive de modèles illisible (fin du zip introuvable)");
  let dirSize = tail.readUInt32LE(eocd + 12);
  let dirOffset = tail.readUInt32LE(eocd + 16);
  if (dirOffset === 0xffffffff || dirSize === 0xffffffff) {
    const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
    if (loc < 0) throw new Error("Archive de modèles illisible (ZIP64)");
    dirSize = Number(tail.readBigUInt64LE(loc + 40));
    dirOffset = Number(tail.readBigUInt64LE(loc + 48));
  }
  const parse = (dir: Buffer): Entry[] => {
    const out: Entry[] = [];
    let p = 0;
    while (p + 46 <= dir.length && dir.readUInt32LE(p) === 0x02014b50) {
      const method = dir.readUInt16LE(p + 10);
      let compressed = dir.readUInt32LE(p + 20);
      let size = dir.readUInt32LE(p + 24);
      const nameLen = dir.readUInt16LE(p + 28);
      const extraLen = dir.readUInt16LE(p + 30);
      const commentLen = dir.readUInt16LE(p + 32);
      let offset = dir.readUInt32LE(p + 42);
      const name = dir.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      // ZIP64 : les vraies valeurs sont dans le champ supplémentaire 0x0001, dans cet ordre.
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = dir.readUInt16LE(e);
        const len = dir.readUInt16LE(e + 2);
        if (id === 1) {
          let q = e + 4;
          if (size === 0xffffffff) (size = Number(dir.readBigUInt64LE(q)), (q += 8));
          if (compressed === 0xffffffff) (compressed = Number(dir.readBigUInt64LE(q)), (q += 8));
          if (offset === 0xffffffff) offset = Number(dir.readBigUInt64LE(q));
        }
        e += 4 + len;
      }
      out.push({ name, method, compressed, size, offset });
      p = end + commentLen;
    }
    return out;
  };
  if (dirOffset >= tailStart) return Promise.resolve(parse(tail.subarray(dirOffset - tailStart, dirOffset - tailStart + dirSize)));
  return fetchDir(dirOffset, dirSize).then(parse);
}

/**
 * Installe les modèles Windows de `version` : sommaire, puis chaque fichier utile par sa plage. Écrit d'abord dans un
 * dossier temporaire, renommé à la fin : un téléchargement interrompu ne laisse pas de modèles à moitié installés.
 */
export async function installWindowsTemplates(version: string, progress: (step: string, done: number) => void = () => {}, ranged: Ranged = httpRange): Promise<string> {
  const url = templatesUrl(version);
  progress("Lecture du sommaire de l'archive", 0);
  const total = await totalSize(url);
  const tailStart = Math.max(0, total - 256 * 1024);
  const tail = await ranged(url, tailStart, total - 1);
  const entries = await readCentralDirectory(tail, tailStart, (o, s) => ranged(url, o, o + s - 1));
  const wanted = WINDOWS_TEMPLATES.map((n) => {
    const e = entries.find((x) => x.name === `templates/${n}` || x.name.endsWith(`/${n}`) || x.name === n);
    if (!e) throw new Error(`${n} absent de l'archive des modèles`);
    return e;
  });
  const dir = templatesDir(version);
  const tmp = `${dir}.part`;
  mkdirSync(tmp, { recursive: true });
  const bytes = wanted.reduce((a, e) => a + e.compressed, 0);
  let done = 0;
  for (const e of wanted) {
    const name = e.name.split("/").pop()!;
    progress(`Téléchargement de ${name}`, done / bytes);
    const head = await ranged(url, e.offset, e.offset + 29);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`En-tête illisible pour ${name}`);
    const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    // Par morceaux de 32 Mo, pour suivre l'avancement.
    const parts: Buffer[] = [];
    for (let from = start; from < start + e.compressed; from += 32 * 1024 * 1024) {
      const to = Math.min(start + e.compressed, from + 32 * 1024 * 1024) - 1;
      parts.push(await ranged(url, from, to));
      done += to - from + 1;
      progress(`Téléchargement de ${name}`, done / bytes);
    }
    const raw = Buffer.concat(parts);
    const data = e.method === 0 ? raw : e.method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`Compression inconnue (${e.method}) pour ${name}`);
    if (data.length !== e.size) throw new Error(`${name} incomplet (${data.length} octets sur ${e.size})`);
    writeFileSync(join(tmp, name), data);
  }
  mkdirSync(join(dir, ".."), { recursive: true });
  if (existsSync(dir)) {
    for (const n of WINDOWS_TEMPLATES) renameSync(join(tmp, n), join(dir, n));
  } else renameSync(tmp, dir);
  progress("Modèles installés", 1);
  return dir;
}
