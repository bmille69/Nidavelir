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

  async commitPaths(root: string, paths: string[], message: string): Promise<string | null> {
    if (paths.length === 0) return null;
    await this.#git(root, ["add", "--all", "--", ...paths]);
    const staged = await this.#git(root, ["diff", "--cached", "--name-only", "--", ...paths]);
    if (!staged.trim()) return null;
    // `git commit -- <paths>` (mode --only) ignore tout ce qui est indexé hors de ces chemins.
    // Les hooks du dépôt sont respectés : s'ils refusent, l'erreur remonte telle quelle.
    await this.#git(root, ["commit", "--quiet", "-m", message, "--", ...paths]);
    return (await this.#git(root, ["rev-parse", "HEAD"])).trim();
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
