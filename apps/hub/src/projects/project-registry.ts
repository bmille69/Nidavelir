import { ProjectManifest, ProjectSlug, type Engine } from "@studio/contracts";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { stringify } from "yaml";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import type { Journal } from "../journal/journal.ts";
import type { VcsPort } from "../vcs/git.ts";

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

export type Project = { slug: string; name: string; root: string; engine: Engine; created_at: string };

export type ProjectAnalysis = {
  root: string;
  suggestedName: string;
  suggestedSlug: string;
  engine: Engine;
  isGitRepo: boolean;
  hasStudio: boolean;
  /** Documents candidats à l'amorçage de la vision, relatifs à root. */
  documents: string[];
  /** Raisons bloquant l'import ; vide si l'import est possible. */
  problems: string[];
};

export type RegistryOptions = {
  /** Racines interdites ainsi que tout leur contenu (hub, données, config des agents). */
  forbiddenTrees: string[];
  /** Chemins interdits eux-mêmes, mais pas leurs sous-dossiers (profil utilisateur, etc.). */
  forbiddenExact: string[];
};

export function defaultRegistryOptions(hubRoot: string, dataDir: string): RegistryOptions {
  const env = process.env;
  const home = env.USERPROFILE ?? env.HOME ?? "";
  const trees = [hubRoot, dataDir, env.WINDIR, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData];
  if (env.LOCALAPPDATA) trees.push(join(env.LOCALAPPDATA, "hermes"));
  if (home) trees.push(join(home, ".claude"), join(home, ".ssh"));
  return {
    forbiddenTrees: trees.filter((p): p is string => !!p),
    forbiddenExact: [home, env.LOCALAPPDATA, env.APPDATA].filter((p): p is string => !!p),
  };
}

const MAX_DOCUMENTS = 50;

/** Registre des jeux et contrôle de l'isolation des répertoires (docs/SECURITY.md §2). */
export class ProjectRegistry {
  readonly #db: Db;
  readonly #journal: Journal;
  readonly #clock: Clock;
  readonly #vcs: VcsPort;
  readonly #options: RegistryOptions;

  constructor(db: Db, journal: Journal, clock: Clock, vcs: VcsPort, options: RegistryOptions) {
    this.#db = db;
    this.#journal = journal;
    this.#clock = clock;
    this.#vcs = vcs;
    this.#options = options;
  }

  list(): Project[] {
    return this.#db.prepare("SELECT * FROM projects ORDER BY name").all() as Project[];
  }

  get(slug: string): Project {
    const p = this.#db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as Project | undefined;
    if (!p) throw new ProjectError(`Projet inconnu : ${slug}`);
    return p;
  }

  /** Raisons d'isolation qui empêcheraient l'import de ce dossier (synchrone, lecture seule). */
  problemsFor(path: string): string[] {
    try {
      return this.#isolationProblems(this.#canonical(path));
    } catch (err) {
      return [(err as Error).message];
    }
  }

  /** Analyse en lecture seule d'un dossier candidat à l'import. N'écrit rien. */
  async analyze(path: string): Promise<ProjectAnalysis> {
    const problems: string[] = [];
    let root = path;
    try {
      root = this.#canonical(path);
    } catch (err) {
      problems.push((err as Error).message);
      return emptyAnalysis(path, problems);
    }
    problems.push(...this.#isolationProblems(root));
    const name = basename(root);
    return {
      root,
      suggestedName: name,
      suggestedSlug: toSlug(name),
      engine: detectEngine(root),
      isGitRepo: await this.#vcs.isRepo(root),
      hasStudio: existsSync(join(root, "studio", "project.yaml")),
      documents: findDocuments(root),
      problems,
    };
  }

  /**
   * Enregistre un dossier existant comme projet, après votre confirmation.
   * N'écrit que dans studio/ et ne commite que studio/.
   */
  async register(
    session: HumanSession,
    input: { path: string; slug: string; name: string; initGit?: boolean },
  ): Promise<Project> {
    assertHumanSession(session);
    const slug = ProjectSlug.parse(input.slug);
    const root = this.#canonical(input.path);
    const problems = this.#isolationProblems(root);
    if (problems.length) throw new ProjectError(problems.join(" ; "));
    if (this.#db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(slug)) {
      throw new ProjectError(`Le slug « ${slug} » est déjà utilisé`);
    }
    if (!(await this.#vcs.isRepo(root))) {
      if (!input.initGit) throw new ProjectError("Ce dossier n'est pas un dépôt Git : confirmez l'initialisation de Git");
      await this.#vcs.init(root);
    }

    const engine = detectEngine(root);
    const manifestPath = join(root, "studio", "project.yaml");
    const manifest = existsSync(manifestPath)
      ? null
      : ProjectManifest.parse({ studio_version: 1, slug, name: input.name, engine, created_at: this.#clock.now() });
    mkdirSync(join(root, "studio", "items"), { recursive: true });
    if (manifest) writeFileSync(manifestPath, stringify(manifest), "utf8");
    const keep = join(root, "studio", "items", ".gitkeep");
    if (!existsSync(keep)) writeFileSync(keep, "", "utf8");

    const project: Project = { slug, name: input.name, root, engine, created_at: this.#clock.now() };
    this.#db
      .prepare("INSERT INTO projects (slug, name, root, engine, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(project.slug, project.name, project.root, project.engine, project.created_at);
    this.#db.prepare("INSERT OR IGNORE INTO vision_revs (project, rev) VALUES (?, 0)").run(slug);

    const sha = await this.#vcs.commitPaths(root, ["studio"], `studio: enregistrement du projet ${input.name} dans Game Studio Hub`);
    this.#journal.append({
      project: slug,
      actor: { kind: "human" },
      type: "project.registered",
      subject: slug,
      payload: { root, engine, commit: sha },
    });
    return project;
  }

  #canonical(path: string): string {
    if (!isAbsolute(path)) throw new ProjectError("Le chemin doit être absolu");
    if (!existsSync(path)) throw new ProjectError("Le dossier n'existe pas");
    const real = realpathSync.native(resolve(path));
    if (!statSync(real).isDirectory()) throw new ProjectError("Le chemin n'est pas un dossier");
    return real;
  }

  #isolationProblems(root: string): string[] {
    const problems: string[] = [];
    if (/^[A-Za-z]:\\?$/.test(root) || root === "/") problems.push("Une racine de disque ne peut pas être un projet");
    for (const exact of this.#options.forbiddenExact) {
      if (samePath(root, exact)) problems.push(`Dossier système interdit : ${root}`);
    }
    for (const tree of this.#options.forbiddenTrees) {
      if (samePath(root, tree) || isWithin(root, tree) || isWithin(tree, root)) {
        problems.push(`Dossier protégé (${tree}) : import refusé`);
      }
    }
    for (const p of this.list()) {
      if (samePath(p.root, root)) problems.push(`Déjà enregistré sous « ${p.slug} »`);
      else if (isWithin(root, p.root) || isWithin(p.root, root)) {
        problems.push(`Chevauche le projet « ${p.slug} » (${p.root})`);
      }
    }
    return problems;
  }
}

function emptyAnalysis(path: string, problems: string[]): ProjectAnalysis {
  return {
    root: path,
    suggestedName: basename(path),
    suggestedSlug: toSlug(basename(path)),
    engine: "unknown",
    isGitRepo: false,
    hasStudio: false,
    documents: [],
    problems,
  };
}

export function detectEngine(root: string): Engine {
  if (existsSync(join(root, "project.godot"))) return "godot";
  if (existsSync(join(root, "package.json")) || existsSync(join(root, "index.html"))) return "web";
  return "unknown";
}

function findDocuments(root: string): string[] {
  const docs = ["README.md", "CLAUDE.md", "AGENTS.md", "GDD.md"].filter((f) => existsSync(join(root, f)));
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || docs.length >= MAX_DOCUMENTS) return;
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") walk(rel, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && docs.length < MAX_DOCUMENTS) {
        docs.push(rel.replace(/\\/g, "/"));
      }
    }
  };
  for (const dir of ["docs", "design", "doc"]) if (existsSync(join(root, dir))) walk(dir, 1);
  return docs;
}

export function toSlug(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return slug || "projet";
}

function norm(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

/** Vrai si child est strictement à l'intérieur de parent. */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(norm(parent), norm(child));
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}
