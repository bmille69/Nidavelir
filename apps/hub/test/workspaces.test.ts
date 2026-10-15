import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { workspaceDevDir } from "../src/executor/preview.ts";
import { linkSharedDirs, unlinkAllLinks } from "../src/executor/shared-dirs.ts";
import type { VcsPort } from "../src/vcs/git.ts";

const dir = mkdtempSync(join(tmpdir(), "ws-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const LINK = process.platform === "win32" ? "junction" : "dir";
const vcs = { isIgnored: async () => true } as unknown as VcsPort;

/** Un jeu en npm workspaces : node_modules relie @jeu/rules à packages/rules. */
function game(name: string): string {
  const repo = join(dir, name);
  const put = (rel: string, text: string) => {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };
  put("package.json", JSON.stringify({ name, workspaces: ["packages/*"], scripts: { dev: "npm run dev -w @jeu/client" } }));
  put("packages/client/package.json", JSON.stringify({ name: "@jeu/client", scripts: { dev: "vite" } }));
  put("packages/rules/package.json", JSON.stringify({ name: "@jeu/rules" }));
  put("packages/rules/src/index.ts", "export const version = 'jeu';\n");
  put("node_modules/vite/package.json", "{}");
  put("node_modules/@types/node/index.d.ts", "");
  put("node_modules/.package-lock.json", "{}");
  mkdirSync(join(repo, "node_modules", ".vite"));
  mkdirSync(join(repo, "node_modules", "@jeu"));
  symlinkSync(join(repo, "packages", "client"), join(repo, "node_modules", "@jeu", "client"), LINK);
  symlinkSync(join(repo, "packages", "rules"), join(repo, "node_modules", "@jeu", "rules"), LINK);
  return repo;
}

describe("copies de travail d'un jeu en espaces de travail (ADR-38)", () => {
  it("les paquets du projet visent ceux du chantier, les dépendances celles du jeu", async () => {
    const repo = game("bordee");
    const wt = join(dir, "wt");
    mkdirSync(join(wt, "packages", "rules", "src"), { recursive: true });
    mkdirSync(join(wt, "packages", "client"), { recursive: true });
    writeFileSync(join(wt, "packages", "rules", "src", "index.ts"), "export const version = 'chantier';\n");

    expect(await linkSharedDirs(repo, wt, vcs)).toEqual(["node_modules"]);
    const nm = join(wt, "node_modules");
    expect(lstatSync(nm).isSymbolicLink()).toBe(false);
    // Constaté le 15/10 : le client du chantier importait les règles du jeu principal.
    expect(readFileSync(join(nm, "@jeu", "rules", "src", "index.ts"), "utf8")).toMatch(/chantier/);
    expect(realpathSync.native(join(nm, "vite"))).toBe(realpathSync.native(join(repo, "node_modules", "vite")));
    expect(existsSync(join(nm, "@types", "node", "index.d.ts"))).toBe(true);
    expect(existsSync(join(nm, ".package-lock.json"))).toBe(true);
    expect(existsSync(join(nm, ".vite"))).toBe(false);

    // Nettoyage : les liens partent, le jeu reste intact.
    unlinkAllLinks(wt);
    rmSync(wt, { recursive: true, force: true });
    expect(readFileSync(join(repo, "packages", "rules", "src", "index.ts"), "utf8")).toMatch(/jeu/);
    expect(existsSync(join(repo, "node_modules", "vite", "package.json"))).toBe(true);
  });

  it("un jeu sans espaces de travail garde une simple jonction", async () => {
    const repo = join(dir, "simple");
    mkdirSync(join(repo, "node_modules", "vite"), { recursive: true });
    const wt = join(dir, "wt-simple");
    mkdirSync(wt);
    await linkSharedDirs(repo, wt, vcs);
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
    unlinkAllLinks(wt);
  });

  it("« npm run dev -w <paquet> » : le jeu se lance depuis l'espace de travail, sur un port libre", () => {
    const repo = game("deleg");
    expect(workspaceDevDir(repo, "npm run dev -w @jeu/client")).toBe(join(repo, "packages", "client"));
    expect(workspaceDevDir(repo, "npm run dev --workspace=packages/client")).toBe(join(repo, "packages", "client"));
    expect(workspaceDevDir(repo, "npm run dev -w @jeu/rules")).toBeNull();
    expect(workspaceDevDir(repo, "npm run dev -w @jeu/client && rm -rf /")).toBeNull();
  });
});
