import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface VcsPort {
  isRepo(root: string): Promise<boolean>;
  init(root: string): Promise<void>;
  /** Porcelaine courte (`git status --porcelain`). */
  status(root: string): Promise<string>;
  /**
   * Commite uniquement les chemins donnés (pathspec), sans toucher aux autres
   * modifications en cours du dépôt. Renvoie le sha, ou null s'il n'y avait rien.
   */
  commitPaths(root: string, paths: string[], message: string): Promise<string | null>;

  // ── Exécution isolée (phase 2) ──
  head(root: string): Promise<string>;
  /** Vrai si Git ignore ce chemin (relatif au dépôt). */
  isIgnored(root: string, path: string): Promise<boolean>;
  currentBranch(root: string): Promise<string | null>;
  /** Modifications suivies non commitées (hors fichiers non suivis). */
  trackedChanges(root: string): Promise<string[]>;
  addWorktree(repo: string, path: string, branch: string, base: string): Promise<void>;
  removeWorktree(repo: string, path: string): Promise<void>;
  deleteBranch(repo: string, branch: string): Promise<void>;
  branchHead(repo: string, branch: string): Promise<string | null>;
  /** Commite tout le contenu du worktree. Renvoie le sha, ou null s'il n'y avait rien. */
  commitAll(worktree: string, message: string): Promise<string | null>;
  diff(repo: string, base: string, branch: string): Promise<{ files: { status: string; path: string }[]; patch: string }>;
  /**
   * Fusion --no-ff de branch dans la branche courante ; annule proprement en cas de conflit. Un fichier non suivi que la
   * branche ajoute bloquerait Git : celui que Godot régénère seul (.uid, .import) est remplacé par celui de la branche,
   * un autre est rendu dans `untracked` (ADR-76). `keepConflicts` (intégration dans la copie d'un chantier, ADR-104) :
   * en cas de conflit, la fusion reste en cours avec ses marqueurs, pour que le développeur réconcilie.
   */
  merge(
    repo: string,
    branch: string,
    message: string,
    opts?: { keepConflicts?: boolean },
  ): Promise<{ ok: true; sha: string } | { ok: false; conflicts: string[]; untracked?: string[]; detail?: string }>;
  /** Fichiers en conflit de la fusion en cours. */
  conflicts(root: string): Promise<string[]>;
  /** Une version d'un fichier en conflit (1 : base, 2 : la nôtre, 3 : la leur), null si elle n'existe pas. */
  readStage(root: string, stage: 1 | 2 | 3, path: string): Promise<string | null>;
  /** Écrit un fichier résolu et l'indexe. */
  stageFile(root: string, path: string, content: string): Promise<void>;
  /** Complète la fusion en cours. */
  commitMerge(root: string, message: string): Promise<void>;
  /** Annule la fusion en cours, s'il y en a une. */
  abortMerge(root: string): Promise<void>;
  /** Réserve le dépôt : aucune autre écriture Git n'y passe tant que `fn` n'a pas fini (fusion en plusieurs étapes, ADR-119). */
  exclusive<T>(root: string, fn: () => Promise<T>): Promise<T>;
  /** `ancestor` est-il déjà contenu dans `commit` ? */
  isAncestor(repo: string, ancestor: string, commit: string): Promise<boolean>;
  /** Commits annulés par un « git revert » dans l'historique récent de la branche courante. */
  revertedCommits(repo: string): Promise<string[]>;
}

export class GitCli implements VcsPort {
  async #git(root: string, args: string[]): Promise<string> {
    const { stdout } = await run("git", ["-C", root, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  async isRepo(root: string): Promise<boolean> {
    try {
      const out = await this.#git(root, ["rev-parse", "--show-toplevel"]);
      return samePath(out.trim(), root);
    } catch {
      return false;
    }
  }

  async init(root: string): Promise<void> {
    await this.#git(root, ["init", "-b", "main"]);
  }

  async status(root: string): Promise<string> {
    return this.#git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  }

  /** Une seule écriture Git à la fois par dépôt : deux enregistrements simultanés se gêneraient (index.lock). */
  readonly #queues = new Map<string, Promise<unknown>>();

  /** Le dépôt que le code en cours a déjà réservé : ses écritures passent sans refaire la file (sinon il s'attendrait lui-même). */
  readonly #held = new AsyncLocalStorage<string>();

  #enqueue<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const key = root.toLowerCase();
    if (this.#held.getStore() === key) return fn();
    const next = (this.#queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.#held.run(key, fn));
    this.#queues.set(key, next);
    return next;
  }

  exclusive<T>(root: string, fn: () => Promise<T>): Promise<T> {
    return this.#enqueue(root, fn);
  }

  commitPaths(root: string, paths: string[], message: string): Promise<string | null> {
    return this.#enqueue(root, () => this.#commitPaths(root, paths, message));
  }

  async #commitPaths(root: string, paths: string[], message: string): Promise<string | null> {
    if (paths.length === 0) return null;
    // Les fichiers temporaires d'une écriture en cours (« *.tmp ») ne sont jamais commités.
    await this.#git(root, ["add", "--all", "--", ...paths, ":(exclude,glob)**/*.tmp"]);
    // Git ignore un fichier nommé seul quand il est nouveau, dans un dossier nouveau, et qu'une exclusion accompagne la
    // liste (« ?? studio/replays/ » restait non suivi) : les fichiers nommés sont ajoutés une seconde fois, sans exclusion.
    // Même chose pour un dossier nouveau (« ?? studio/references/ », ADR-95) : on ajoute ses nouveaux fichiers un par un,
    // tels que Git les liste (les fichiers ignorés n'y figurent pas).
    const named = paths.filter((p) => existsSync(join(root, p)) && statSync(join(root, p)).isFile());
    const dirs = paths.filter((p) => existsSync(join(root, p)) && statSync(join(root, p)).isDirectory());
    const loose = dirs.length ? (await this.#git(root, ["ls-files", "--others", "--exclude-standard", "--", ...dirs])).split("\n").filter(Boolean) : [];
    const files = [...named, ...loose].filter((p) => !p.endsWith(".tmp"));
    for (let i = 0; i < files.length; i += 200) await this.#git(root, ["add", "--", ...files.slice(i, i + 200)]);
    const staged = await this.#git(root, ["diff", "--cached", "--name-only", "--", ...paths]);
    if (!staged.trim()) return null;
    // `git commit -- <paths>` (mode --only) ignore tout ce qui est indexé hors de ces chemins.
    // Les hooks du dépôt sont respectés : s'ils refusent, l'erreur remonte telle quelle.
    await this.#git(root, ["commit", "--quiet", "-m", message, "--", ...paths]);
    return (await this.#git(root, ["rev-parse", "HEAD"])).trim();
  }

  async head(root: string): Promise<string> {
    return (await this.#git(root, ["rev-parse", "HEAD"])).trim();
  }

  async isIgnored(root: string, path: string): Promise<boolean> {
    try {
      await this.#git(root, ["check-ignore", "-q", "--", path]);
      return true;
    } catch {
      return false;
    }
  }

  async currentBranch(root: string): Promise<string | null> {
    const b = (await this.#git(root, ["branch", "--show-current"])).trim();
    return b || null;
  }

  async trackedChanges(root: string): Promise<string[]> {
    const out = await this.#git(root, ["status", "--porcelain=v1", "--untracked-files=no"]);
    return out.split("\n").filter(Boolean).map((l) => l.slice(3));
  }

  async addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
    await this.#git(repo, ["worktree", "add", "-b", branch, path, base]);
  }

  async removeWorktree(repo: string, path: string): Promise<void> {
    await this.#git(repo, ["worktree", "remove", "--force", path]);
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    await this.#git(repo, ["branch", "-D", branch]);
  }

  async branchHead(repo: string, branch: string): Promise<string | null> {
    try {
      return (await this.#git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`])).trim();
    } catch {
      return null;
    }
  }

  async commitAll(worktree: string, message: string): Promise<string | null> {
    await this.#git(worktree, ["add", "--all"]);
    const staged = await this.#git(worktree, ["diff", "--cached", "--name-only"]);
    if (!staged.trim()) return null;
    await this.#git(worktree, ["commit", "--quiet", "-m", message]);
    return (await this.#git(worktree, ["rev-parse", "HEAD"])).trim();
  }

  async diff(repo: string, base: string, branch: string) {
    const range = `${base}...${branch}`;
    const names = await this.#git(repo, ["diff", "--name-status", "--no-renames", range]);
    const files = names
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [status, ...rest] = l.split("\t");
        return { status: status!, path: rest.join("\t") };
      });
    const patch = await this.#git(repo, ["diff", "--no-renames", "--no-color", range]);
    return { files, patch };
  }

  merge(repo: string, branch: string, message: string, opts: { keepConflicts?: boolean } = {}) {
    // Même file que les enregistrements du hub dans ce dépôt : deux écritures simultanées se gêneraient (index.lock, ADR-104).
    return this.#enqueue(repo, () => this.#mergeNow(repo, branch, message, opts));
  }

  async conflicts(root: string): Promise<string[]> {
    return (await this.#git(root, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
  }

  async readStage(root: string, stage: 1 | 2 | 3, path: string): Promise<string | null> {
    try {
      return await this.#git(root, ["show", `:${stage}:${path}`]);
    } catch {
      return null;
    }
  }

  stageFile(root: string, path: string, content: string): Promise<void> {
    return this.#enqueue(root, async () => {
      writeFileSync(join(root, path), content);
      await this.#git(root, ["add", "--", path]);
    });
  }

  commitMerge(root: string, message: string): Promise<void> {
    return this.#enqueue(root, async () => {
      await this.#git(root, ["commit", "--quiet", "--no-edit", "-m", message]);
    });
  }

  abortMerge(root: string): Promise<void> {
    return this.#enqueue(root, async () => {
      await this.#git(root, ["merge", "--abort"]).catch(() => "");
    });
  }

  async #mergeNow(repo: string, branch: string, message: string, opts: { keepConflicts?: boolean }) {
    const added = (await this.#git(repo, ["diff", "--name-only", "--diff-filter=A", `HEAD...${branch}`]).catch(() => "")).split("\n").filter(Boolean);
    const loose = new Set((await this.#git(repo, ["ls-files", "--others", "--exclude-standard"]).catch(() => "")).split("\n").filter(Boolean));
    const blocking = added.filter((f) => loose.has(f));
    const untracked = blocking.filter((f) => !GODOT_GENERATED.test(f));
    if (untracked.length) return { ok: false as const, conflicts: [], untracked };
    for (const f of blocking) rmSync(join(repo, f), { force: true });
    try {
      await this.#git(repo, ["merge", "--no-ff", "--no-edit", "-m", message, branch]);
      return { ok: true as const, sha: (await this.#git(repo, ["rev-parse", "HEAD"])).trim() };
    } catch (err) {
      const conflicts = (await this.#git(repo, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
        .split("\n")
        .filter(Boolean);
      if (!(opts.keepConflicts && conflicts.length)) await this.#git(repo, ["merge", "--abort"]).catch(() => "");
      // Sans fichier en conflit, la raison de Git est la seule information utile : elle est rendue telle quelle.
      const e = err as { stderr?: string; stdout?: string; message?: string };
      const detail = conflicts.length ? undefined : String(e.stderr || e.stdout || e.message || "").replace(/\s+/g, " ").trim().slice(0, 300) || undefined;
      return { ok: false as const, conflicts, ...(detail ? { detail } : {}) };
    }
  }

  async isAncestor(repo: string, ancestor: string, commit: string): Promise<boolean> {
    try {
      await this.#git(repo, ["merge-base", "--is-ancestor", ancestor, commit]);
      return true;
    } catch {
      return false;
    }
  }

  async revertedCommits(repo: string): Promise<string[]> {
    const log = await this.#git(repo, ["log", "-n", "1000", "--format=%B"]).catch(() => "");
    return [...log.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)].map((m) => m[1]!);
  }
}

/** Fichiers que Godot écrit seul à l'import : sans valeur propre, ils se régénèrent. */
const GODOT_GENERATED = /\.(uid|import)$/;

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
