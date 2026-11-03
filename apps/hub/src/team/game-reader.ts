import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

/**
 * Lecture du jeu par les agents en conversation (ADR-101) : lire, lister, chercher, en lecture seule, dans le dossier
 * du jeu seulement. Le hub filtre lui-même ce qui est sensible (secrets, .git) et borne la taille des réponses.
 */

/** Dossiers jamais lus ni parcourus. */
const SKIP_DIRS = new Set([".git", "node_modules", ".godot", ".import", "dist", "build", ".vite", "coverage", ".venv", "__pycache__"]);
/** Fichiers sensibles : jamais lus, même demandés par leur chemin exact. */
const SECRET = /^(\.env.*|.*\.(pem|key|pfx|p12|keystore|jks)|id_(rsa|ed25519|ecdsa).*|.*credentials.*|.*secrets?\..*|\.npmrc|\.netrc)$/i;
/** Extensions lues comme du texte par la recherche. */
const TEXT = /\.(gd|cs|ts|tsx|js|jsx|mjs|cjs|json|md|txt|tscn|tres|godot|cfg|ini|yaml|yml|toml|html|css|scss|glsl|gdshader|shader|py|lua|xml|csv)$/i;

const MAX_READ = 200_000;
const MAX_LINES = 400;

export class GameReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameReaderError";
  }
}

export class GameReader {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  /** Un chemin relatif du jeu, vérifié : dans le dossier, hors .git et des secrets (liens suivis compris). */
  #resolve(rel: string): string {
    const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim() || ".";
    const abs = resolve(this.#root, clean);
    const inside = (p: string) => p === this.#root || p.startsWith(this.#root + sep);
    if (!inside(abs)) throw new GameReaderError("Chemin hors du jeu");
    const parts = relative(this.#root, abs).split(sep).filter(Boolean);
    if (parts.some((p) => SKIP_DIRS.has(p))) throw new GameReaderError(`Dossier non lisible : ${parts.find((p) => SKIP_DIRS.has(p))}`);
    if (parts.length && SECRET.test(basename(abs))) throw new GameReaderError("Fichier sensible : non lisible");
    if (!existsSync(abs)) throw new GameReaderError(`Introuvable : ${clean}`);
    const real = realpathSync(abs);
    let rootReal = this.#root;
    try {
      rootReal = realpathSync(this.#root);
    } catch {
      /* racine introuvable : le test ci-dessous refusera */
    }
    if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new GameReaderError("Lien vers l'extérieur du jeu : non lisible");
    return abs;
  }

  /** Lit un fichier texte, au plus 400 lignes à partir de `from` (1 = début). */
  read(rel: string, from = 1, lines = MAX_LINES): string {
    const abs = this.#resolve(rel);
    const st = statSync(abs);
    if (st.isDirectory()) throw new GameReaderError("C'est un dossier : utilise lister");
    if (st.size > 5_000_000) throw new GameReaderError("Fichier trop gros pour être lu");
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new GameReaderError("Fichier binaire (image, son, modèle…) : non lisible comme du texte");
    const all = buf.toString("utf8").slice(0, MAX_READ * 5).split(/\r?\n/);
    const start = Math.max(1, Math.floor(from));
    const count = Math.min(Math.max(1, Math.floor(lines)), MAX_LINES);
    const slice = all.slice(start - 1, start - 1 + count);
    const body = slice.map((l, i) => `${start + i}\t${l.slice(0, 400)}`).join("\n").slice(0, MAX_READ);
    const more = start - 1 + count < all.length ? `\n… (${all.length} lignes en tout ; suite avec debut=${start + count})` : "";
    return `${rel.replace(/\\/g, "/")} (lignes ${start} à ${start + slice.length - 1})\n${body}${more}`;
  }

  /** Liste un dossier (un niveau), dossiers d'abord ; 300 entrées au plus. */
  list(rel = "."): string {
    const abs = this.#resolve(rel);
    if (!statSync(abs).isDirectory()) throw new GameReaderError("C'est un fichier : utilise lire_fichier");
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)) && !SECRET.test(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const shown = entries.slice(0, 300).map((e) => {
      if (e.isDirectory()) return `${e.name}/`;
      try {
        return `${e.name} (${Math.max(1, Math.round(statSync(join(abs, e.name)).size / 1024))} Ko)`;
      } catch {
        return e.name;
      }
    });
    const where = relative(this.#root, abs).replace(/\\/g, "/") || ".";
    return `${where}/ — ${entries.length} entrée(s)${entries.length > 300 ? " (300 premières)" : ""}\n${shown.join("\n") || "(vide)"}`;
  }

  /** Cherche un motif (texte ou expression régulière, sans casse) dans les fichiers texte ; 80 résultats au plus. */
  search(pattern: string, rel = "."): string {
    const motif = String(pattern ?? "").trim();
    if (!motif || motif.length > 200) throw new GameReaderError("Motif vide ou trop long");
    let re: RegExp;
    try {
      re = new RegExp(motif, "i");
    } catch {
      re = new RegExp(motif.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const start = this.#resolve(rel);
    const hits: string[] = [];
    let files = 0;
    const walk = (dir: string) => {
      if (hits.length >= 80 || files >= 4000) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (hits.length >= 80 || files >= 4000) return;
        const abs = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(abs);
          continue;
        }
        if (!e.isFile() || SECRET.test(e.name) || !TEXT.test(e.name)) continue;
        files++;
        let text: string;
        try {
          if (statSync(abs).size > 1_000_000) continue;
          text = readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < 80; i++) {
          if (re.test(lines[i]!)) hits.push(`${relative(this.#root, abs).replace(/\\/g, "/")}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
        }
      }
    };
    if (statSync(start).isDirectory()) walk(start);
    else throw new GameReaderError("Donne un dossier où chercher (ou rien pour tout le jeu)");
    return hits.length ? `${hits.length}${hits.length >= 80 ? "+" : ""} résultat(s) pour « ${motif} »\n${hits.join("\n")}` : `Aucun résultat pour « ${motif} » (${files} fichier(s) texte parcourus)`;
  }
}
