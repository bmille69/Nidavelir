import { existsSync, lstatSync, readdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { VcsPort } from "../vcs/git.ts";

/**
 * Dossiers lourds et non versionnés (dépendances) partagés entre votre projet et
 * la copie de travail via une jonction Windows, pour que les tests du jeu puissent
 * tourner sans copier ni télécharger.
 *
 * DANGER constaté le 14/10/2026 : `git worktree remove --force` SUIT les jonctions et
 * efface leur cible. Toute suppression d'une copie de travail doit donc passer par
 * `unlinkAllLinks()` d'abord.
 */
export const SHARED_DIRS = ["node_modules"];

/** Crée les jonctions possibles ; renvoie les dossiers liés. N'en crée aucune pour un dossier versionné. */
export async function linkSharedDirs(repo: string, worktree: string, vcs: VcsPort): Promise<string[]> {
  const linked: string[] = [];
  for (const dir of SHARED_DIRS) {
    const target = join(repo, dir);
    const link = join(worktree, dir);
    if (!existsSync(target) || !statSync(target).isDirectory() || existsSync(link)) continue;
    if (!(await vcs.isIgnored(repo, dir))) continue; // versionné : surtout pas de lien
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    linked.push(dir);
  }
  return linked;
}

/**
 * Supprime TOUS les liens symboliques et jonctions de la copie de travail (sans
 * jamais toucher à leur cible), avant toute suppression récursive.
 */
export function unlinkAllLinks(root: string): string[] {
  const removed: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === ".git") continue;
      const p = join(dir, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        unlinkSync(p);
        removed.push(p);
      } else if (st.isDirectory()) walk(p);
    }
  };
  if (existsSync(root)) walk(root);
  return removed;
}
