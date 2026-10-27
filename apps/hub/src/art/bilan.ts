import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { artRoot, readManifest, type Asset } from "./manifest.ts";

/**
 * Le bilan des visuels (ADR-71), d'après OhMyGame : « la liste des assets face aux fichiers réels et à ce que le jeu
 * charge ». Pour chaque visuel donné pour intégré, le hub cherche sa copie dans les fichiers du jeu (même contenu, octet
 * pour octet), repère une ancienne version restée en place, et regarde si le jeu l'a vraiment chargé la dernière fois
 * qu'il a été lancé sur sa scène vitrine. Aucun appel à un modèle : des fichiers et des faits.
 */

export type BilanLevel = "verifie" | "a_retoucher" | "charge" | "non_prouve" | "pas_charge" | "ancienne_version" | "absent" | "source_absente" | "en_cours" | "aspect_change";

export type BilanRow = {
  id: string;
  name: string;
  type: string;
  level: BilanLevel;
  /** Un problème que le hub peut faire réparer (« Faire réintégrer »). */
  problem: boolean;
  /** En clair, pour vous. */
  text: string;
  /** Fichier validé, relatif à studio/art. */
  source: string | null;
  /** Ses copies dans le jeu, relatives au dépôt du jeu. */
  copies: string[];
  /** Une ancienne version de ce visuel trouvée dans le jeu à la place de la bonne. */
  stale: string[];
  thumb: string | null;
  proofAt: string | null;
  /** L'aspect a changé dans le jeu (ADR-84) : la photo de référence et la nouvelle. */
  look?: { ref: string; file: string; changed: number; where: string | null; tasks: string[] } | null;
};

/** La preuve au lancement : les fichiers que le jeu a chargés sur la scène vitrine de l'asset. */
export type Proof = { loaded: string[]; at: string };

const RESOURCE = /\.(png|jpe?g|webp|avif|gif|svg|glb|gltf|bin|ktx2|hdr|mp3|ogg|wav|m4a)$/i;
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".vite", "coverage", "test-results", "playwright-report", ".worktrees", ".cache"]);
const MAX_FILES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;

/** Empreintes déjà calculées : un fichier qui n'a pas bougé (taille, date) n'est pas relu à chaque visite. */
const hashes = new Map<string, { size: number; mtime: number; sha: string }>();

function sha1(file: string): string | null {
  try {
    const st = statSync(file);
    if (st.size > MAX_BYTES) return null;
    const known = hashes.get(file);
    if (known && known.size === st.size && known.mtime === st.mtimeMs) return known.sha;
    const sha = createHash("sha1").update(readFileSync(file)).digest("hex");
    hashes.set(file, { size: st.size, mtime: st.mtimeMs, sha });
    return sha;
  } catch {
    return null;
  }
}

/** Les ressources du jeu (images, modèles, sons), hors studio/art, dépendances et sorties de construction. */
function gameResources(gameRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, top: boolean) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (SKIP.has(e.name) || (top && e.name === "studio")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, false);
      else if (e.isFile() && RESOURCE.test(e.name)) out.push(p);
    }
  };
  walk(gameRoot, true);
  return out;
}

const posix = (p: string) => p.replace(/\\/g, "/");

/**
 * Le jeu a-t-il chargé cette copie ? Le serveur du jeu la sert sous son chemin dans le dépôt (« /assets/studio/x.glb »)
 * ou, pour un dossier public, sans ce premier dossier (« public/x.png » → « /x.png »).
 */
export function wasLoaded(copy: string, loaded: string[]): boolean {
  const rel = posix(copy).replace(/^\/+/, "");
  const short = rel.split("/").slice(1).join("/");
  return loaded.some((u) => {
    const path = decodeURIComponent(u.split(/[?#]/)[0]!).replace(/^\/+/, "");
    return path === rel || path.endsWith(`/${rel}`) || (short !== "" && (path === short || path.endsWith(`/${short}`)));
  });
}

export const sourceOf = (a: Asset): string | null => a.model?.file ?? a.verdict?.file ?? null;

export function computeBilan(gameRoot: string): BilanRow[] {
  const art = artRoot(gameRoot);
  const assets = readManifest(gameRoot).assets.filter((a) => a.status === "integre" || a.status === "integration");
  if (!assets.length) return [];
  const byHash = new Map<string, string[]>();
  for (const f of gameResources(gameRoot)) {
    const h = sha1(f);
    if (h) (byHash.get(h) ?? byHash.set(h, []).get(h)!).push(posix(relative(gameRoot, f)));
  }
  // Les fichiers plus anciens de chaque visuel (versions refaites ou retouchées), pour reconnaître une ancienne version.
  const older = (a: Asset, current: string | null): string[] => {
    const prefix = `${a.id.toLowerCase()}-`;
    const files: string[] = [];
    for (const dir of ["models", "production"]) {
      const d = join(art, dir);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) if (f.toLowerCase().startsWith(prefix) && RESOURCE.test(f) && `${dir}/${f}` !== current) files.push(`${dir}/${f}`);
    }
    return files;
  };
  return assets.map((a) => {
    const source = sourceOf(a);
    const thumb = a.model?.renders[0] ?? a.verdict?.file ?? a.renders.at(-1) ?? null;
    const base = { id: a.id, name: a.name, type: a.type, source, copies: [] as string[], stale: [] as string[], thumb, proofAt: a.proof?.at ?? null };
    const sourceHash = source ? sha1(join(art, source)) : null;
    if (!source || !sourceHash) {
      return { ...base, level: "source_absente" as const, problem: false, text: `Le fichier validé (studio/art/${source ?? "?"}) n'existe plus : le hub ne peut pas le comparer au jeu.` };
    }
    const copies = byHash.get(sourceHash) ?? [];
    if (!copies.length) {
      if (a.status === "integration") return { ...base, level: "en_cours" as const, problem: false, text: "Intégration en cours : pas encore copié dans le jeu." };
      const stale = older(a, source).flatMap((f) => {
        const h = sha1(join(art, f));
        return h ? (byHash.get(h) ?? []) : [];
      });
      if (stale.length) return { ...base, stale, level: "ancienne_version" as const, problem: true, text: `Le jeu a encore une ancienne version (${stale.join(", ")}), pas celle qui a été validée.` };
      return { ...base, level: "absent" as const, problem: true, text: `Donné pour intégré, mais aucun fichier du jeu n'est la copie du fichier validé (${basename(source)}).` };
    }
    const proof = a.proof ?? null;
    const loaded = proof ? copies.some((c) => wasLoaded(c, proof.loaded)) : null;
    const seen = a.ingame;
    const row = { ...base, copies };
    if (loaded === false) return { ...row, level: "pas_charge" as const, problem: true, text: `Copié dans le jeu (${copies[0]}), mais le jeu ne l'a pas chargé sur sa scène vitrine.` };
    // Le bon fichier, chargé, mais sa scène vitrine ne ressemble plus à la photo validée (ADR-84).
    const look = a.look?.status === "changed" && a.look.file ? a.look : null;
    if (look) {
      return {
        ...row,
        thumb: look.file,
        look: { ref: look.ref, file: look.file!, changed: look.changed, where: look.where, tasks: look.tasks },
        level: "aspect_change" as const,
        problem: true,
        text: `Son aspect dans le jeu a changé${look.tasks.length ? ` après ${look.tasks.join(", ")}` : ""} : ${Math.round(look.changed * 100)} % de sa scène vitrine${look.where ? `, surtout ${look.where}` : ""}, face à la photo validée (${look.ref}). Le fichier est le bon : c'est son branchement, sa scène ou l'éclairage qui a bougé.`,
      };
    }
    if (loaded === null) {
      return { ...row, level: "non_prouve" as const, problem: false, text: `Copié dans le jeu (${copies[0]}), mais jamais vu chargé en lançant le jeu.${seen?.visible ? " Le validateur l'a reconnu sur une photo du jeu." : ""}` };
    }
    if (seen?.visible && seen.ok) return { ...row, level: "verifie" as const, problem: false, text: `Chargé par le jeu et vu sur sa scène vitrine : ${seen.summary || "rend bien."}` };
    if (seen?.visible) return { ...row, level: "a_retoucher" as const, problem: false, text: `Chargé par le jeu, mais à retoucher : ${seen.summary}` };
    return { ...row, level: "charge" as const, problem: false, text: "Chargé par le jeu ; pas encore regardé sur une photo de sa scène vitrine." };
  });
}
