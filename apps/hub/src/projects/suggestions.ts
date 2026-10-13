import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectRegistry } from "./project-registry.ts";

export type FolderSuggestion = { path: string; name: string; registered: string | null; problems: string[] };

/** Sous-dossiers de la racine des jeux qui sont des dépôts Git (ADR-12). Lecture seule. */
export function suggestFolders(gamesRoot: string, registry: ProjectRegistry): FolderSuggestion[] {
  if (!existsSync(gamesRoot)) return [];
  const registered = new Map(registry.list().map((p) => [p.root.toLowerCase(), p.slug]));
  return readdirSync(gamesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(join(gamesRoot, e.name, ".git")))
    .map((e) => {
      const path = join(gamesRoot, e.name);
      const slug = registered.get(path.toLowerCase()) ?? null;
      return { path, name: e.name, registered: slug, problems: slug ? [] : registry.problemsFor(path) };
    });
}
