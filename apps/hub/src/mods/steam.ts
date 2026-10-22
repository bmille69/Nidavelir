import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Un jeu installé par Steam : lu dans le manifeste `appmanifest_<id>.acf` de sa bibliothèque (ADR-65). */
export type SteamGame = { appid: string; name: string; dir: string; buildid: string; library: string };

/** Les valeurs « clé » « valeur » d'un fichier VDF de Steam, sans en interpréter l'imbrication. */
function vdfPairs(text: string): [string, string][] {
  return [...text.matchAll(/"([^"\n]+)"\s+"([^"\n]*)"/g)].map((m) => [m[1]!, m[2]!.replace(/\\\\/g, "\\")]);
}

/** Les dossiers de Steam habituels sous Windows, plus celui donné par la variable d'environnement STEAM_DIR. */
export function steamRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [env.STEAM_DIR, env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Steam"), env.ProgramFiles && join(env.ProgramFiles, "Steam")];
  return [...new Set(roots.filter((r): r is string => !!r && existsSync(join(r, "steamapps"))))];
}

/** Les bibliothèques Steam (`libraryfolders.vdf`) : chacune a son dossier `steamapps`. */
export function steamLibraries(roots = steamRoots()): string[] {
  const libs = new Set<string>(roots);
  for (const root of roots) {
    const file = join(root, "steamapps", "libraryfolders.vdf");
    if (!existsSync(file)) continue;
    for (const [k, v] of vdfPairs(readFileSync(file, "utf8"))) if (k === "path" && existsSync(join(v, "steamapps"))) libs.add(v);
  }
  return [...libs];
}

/** Les jeux installés, d'après les manifestes de chaque bibliothèque. Lecture seule. */
export function installedGames(libraries = steamLibraries()): SteamGame[] {
  const games: SteamGame[] = [];
  for (const lib of libraries) {
    const apps = join(lib, "steamapps");
    let files: string[] = [];
    try {
      files = readdirSync(apps).filter((f) => /^appmanifest_\d+\.acf$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const pairs = Object.fromEntries(vdfPairs(readFileSync(join(apps, f), "utf8")));
        const dir = join(apps, "common", pairs.installdir ?? "");
        if (pairs.appid && pairs.name && pairs.installdir && existsSync(dir)) games.push({ appid: pairs.appid, name: pairs.name, dir, buildid: pairs.buildid ?? "", library: lib });
      } catch {
        /* manifeste illisible : ignoré */
      }
    }
  }
  return games.sort((a, b) => a.name.localeCompare(b.name));
}

/** La version installée d'un jeu (son « buildid » Steam), relue à chaque fois : Steam la change à chaque mise à jour. */
export function gameBuild(game: Pick<SteamGame, "appid" | "library">): string {
  const file = join(game.library, "steamapps", `appmanifest_${game.appid}.acf`);
  if (!existsSync(file)) return "";
  return vdfPairs(readFileSync(file, "utf8")).find(([k]) => k === "buildid")?.[1] ?? "";
}
