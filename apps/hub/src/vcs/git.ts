import { execFile } from "node:child_process";
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
  /** Fusion --no-ff de branch dans la branche courante ; annule proprement en cas de conflit. */
  merge(repo: string, branch: string, message: string): Promise<{ ok: true; sha: string } | { ok: false; conflicts: string[] }>;
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

  commitPaths(root: string, paths: string[], message: string): Promise<string | null> {
    const key = root.toLowerCase();
    const next = (this.#queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.#commitPaths(root, paths, message));
    this.#queues.set(key, next);
    return next;
  }

  async #commitPaths(root: string, paths: string[], message: string): Promise<string | null> {
    if (paths.length === 0) return null;
    // Les fichiers temporaires d'une écriture en cours (« *.tmp ») ne sont jamais commités.
    await this.#git(root, ["add", "--all", "--", ...paths, ":(exclude,glob)**/*.tmp"]);
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

  async merge(repo: string, branch: string, message: string) {
    try {
      await this.#git(repo, ["merge", "--no-ff", "--no-edit", "-m", message, branch]);
      return { ok: true as const, sha: (await this.#git(repo, ["rev-parse", "HEAD"])).trim() };
    } catch {
      const conflicts = (await this.#git(repo, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
        .split("\n")
        .filter(Boolean);
      await this.#git(repo, ["merge", "--abort"]).catch(() => "");
      return { ok: false as const, conflicts };
    }
  }

  async revertedCommits(repo: string): Promise<string[]> {
    const log = await this.#git(repo, ["log", "-n", "1000", "--format=%B"]).catch(() => "");
    return [...log.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)].map((m) => m[1]!);
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
