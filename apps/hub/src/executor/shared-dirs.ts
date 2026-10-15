import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
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
    if (dir === "node_modules" && hasWorkspaceLinks(target, repo)) mirrorModules(target, link, repo, worktree);
    else symlinkSync(target, link, LINK);
    linked.push(dir);
  }
  return linked;
}

const LINK = process.platform === "win32" ? "junction" : "dir";
/** Caches d'outils : propres à chaque copie, jamais partagés. */
const OWN_CACHES = new Set([".vite", ".vite-temp", ".cache"]);

/**
 * npm workspaces (ADR-38) : node_modules contient des liens vers les paquets du projet lui-même
 * (ex. @bordee/rules → packages/rules). Partagé tel quel, il ferait utiliser au chantier les paquets
 * du jeu principal : tests et lancement mélangeraient le code du chantier et l'ancien.
 * Renvoie le même paquet dans la copie, ou null si ce n'est pas un paquet du projet.
 */
function ownPackage(entry: string, repo: string, worktree: string): string | null {
  try {
    if (!lstatSync(entry).isSymbolicLink()) return null;
    const rel = relative(realpathSync.native(repo), realpathSync.native(entry));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return join(worktree, rel);
  } catch {
    return null;
  }
}

function entries(modules: string): { name: string; path: string }[] {
  return readdirSync(modules).flatMap((name) => {
    const path = join(modules, name);
    if (name.startsWith("@") && !lstatSync(path).isSymbolicLink() && statSync(path).isDirectory()) {
      return readdirSync(path).map((sub) => ({ name: `${name}/${sub}`, path: join(path, sub) }));
    }
    return [{ name, path }];
  });
}

function hasWorkspaceLinks(modules: string, repo: string): boolean {
  return entries(modules).some((e) => ownPackage(e.path, repo, repo) !== null);
}

/**
 * Un vrai dossier node_modules dans la copie : une jonction par dépendance vers celle du jeu
 * (rien n'est copié ni téléchargé), sauf les paquets du projet, qui visent ceux de la copie.
 */
function mirrorModules(modules: string, link: string, repo: string, worktree: string): void {
  mkdirSync(link);
  for (const e of entries(modules)) {
    if (OWN_CACHES.has(e.name)) continue;
    const to = join(link, e.name);
    if (e.name.includes("/")) mkdirSync(join(link, e.name.split("/")[0]!), { recursive: true });
    const own = ownPackage(e.path, repo, worktree);
    if (own) symlinkSync(own, to, LINK);
    else if (statSync(e.path).isDirectory()) symlinkSync(realpathSync.native(e.path), to, LINK);
    else copyFileSync(e.path, to);
  }
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
