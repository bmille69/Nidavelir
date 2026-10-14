import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const cache = new Map<string, { at: number; value: CodeContext }>();
const TTL_MS = 5 * 60_000;

export type CodeContext = { claudeMd: string | null; files: string[]; totalFiles: number };

/**
 * Ce que le directeur sait du code en mode atelier (ADR-24) : les consignes du projet
 * (CLAUDE.md) et la liste des fichiers suivis par Git. Lecture seule, sans exécuter le jeu.
 */
export async function codeContext(root: string, maxFiles = 400): Promise<CodeContext> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const md = join(root, "CLAUDE.md");
  const claudeMd = existsSync(md) ? readFileSync(md, "utf8").slice(0, 12_000) : null;
  let all: string[] = [];
  try {
    const { stdout } = await run("git", ["-C", root, "ls-files"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    all = stdout.split("\n").filter((f) => f && !f.startsWith("studio/") && !/(^|\/)(node_modules|dist|build)\//.test(f));
  } catch {
    /* pas un dépôt Git : on s'en passe */
  }
  // Le code d'abord, les ressources lourdes ensuite.
  const score = (f: string) => (/\.(ts|tsx|js|gd|cs|json|md)$/.test(f) ? 0 : 1);
  const files = [...all].sort((a, b) => score(a) - score(b) || a.localeCompare(b)).slice(0, maxFiles).sort();
  const value = { claudeMd, files, totalFiles: all.length };
  cache.set(root, { at: Date.now(), value });
  return value;
}
