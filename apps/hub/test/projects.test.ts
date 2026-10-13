import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HumanSessionRequiredError } from "../src/auth/human-session.ts";
import { ProjectError } from "../src/projects/project-registry.ts";
import { git, cleanupSandboxes, sandbox, type Sandbox } from "./helpers.ts";

let sb: Sandbox;
afterEach(cleanupSandboxes);

describe("import d'un projet existant (ADR-12)", () => {
  it("l'analyse est en lecture seule et détecte moteur et documents", async () => {
    sb = sandbox();
    const root = sb.makeGameRepo("survivor", {
      "README.md": "# Survivor",
      "package.json": "{}",
      "CLAUDE.md": "# Consignes",
      "docs/balance-decisions.md": "# Équilibrage",
      "src/main.ts": "",
    });
    writeFileSync(join(root, "wip.txt"), "travail en cours non commité");
    const before = git(root, "status", "--porcelain");

    const analysis = await sb.hub.projects.analyze(root);

    expect(analysis.problems).toEqual([]);
    expect(analysis.engine).toBe("web");
    expect(analysis.isGitRepo).toBe(true);
    expect(analysis.documents).toEqual(expect.arrayContaining(["README.md", "CLAUDE.md", "docs/balance-decisions.md"]));
    expect(git(root, "status", "--porcelain")).toBe(before);
    expect(existsSync(join(root, "studio"))).toBe(false);
  });

  it("détecte un projet Godot", async () => {
    sb = sandbox();
    const root = sb.makeGameRepo("godot-game", { "project.godot": "[application]" });
    expect((await sb.hub.projects.analyze(root)).engine).toBe("godot");
  });

  it("l'enregistrement ne commite que studio/, même avec des modifications en cours", async () => {
    sb = sandbox();
    const root = sb.makeGameRepo("survivor", { "src/main.ts": "v1" });
    writeFileSync(join(root, "src/main.ts"), "v2 en cours");
    git(root, "add", "src/main.ts"); // même indexé, il ne doit pas partir dans le commit du hub

    await sb.hub.projects.register(sb.human(), { path: root, slug: "survivor", name: "Survivor" });

    const files = git(root, "show", "--name-only", "--format=", "HEAD").trim().split("\n");
    expect(files.every((f) => f.startsWith("studio/"))).toBe(true);
    expect(files).toContain("studio/project.yaml");
    expect(git(root, "status", "--porcelain")).toMatch(/^M {2}src\/main\.ts/m);
  });

  it("exige une vraie session humaine", async () => {
    sb = sandbox();
    const root = sb.makeGameRepo("g");
    await expect(sb.hub.projects.register({ id: "faux" } as never, { path: root, slug: "g", name: "G" })).rejects.toThrow(
      HumanSessionRequiredError,
    );
  });

  it("n'initialise Git que sur confirmation explicite", async () => {
    sb = sandbox();
    const root = join(sb.dir, "sans-git");
    mkdirSync(root);
    await expect(sb.hub.projects.register(sb.human(), { path: root, slug: "sans-git", name: "X" })).rejects.toThrow(/Git/);
    expect(existsSync(join(root, "studio"))).toBe(false);
    // Le commit utilise l'identité Git globale de la machine.
    await sb.hub.projects.register(sb.human(), { path: root, slug: "sans-git", name: "X", initGit: true });
    expect(existsSync(join(root, ".git"))).toBe(true);
  });

  it("refuse les dossiers protégés et les chevauchements", async () => {
    sb = sandbox();
    const root = sb.makeGameRepo("jeu");
    await sb.hub.projects.register(sb.human(), { path: root, slug: "jeu", name: "Jeu" });
    const inner = join(root, "sous-dossier");
    mkdirSync(inner);

    expect((await sb.hub.projects.analyze(inner)).problems.join()).toMatch(/Chevauche/);
    expect((await sb.hub.projects.analyze(root)).problems.join()).toMatch(/Déjà enregistré/);
    expect((await sb.hub.projects.analyze(join(sb.dir, "hub"))).problems.join()).toMatch(/protégé/);
    expect((await sb.hub.projects.analyze(sb.dir)).problems.length).toBeGreaterThan(0);
    expect((await sb.hub.projects.analyze("relatif/chemin")).problems.join()).toMatch(/absolu/);
    await expect(sb.hub.projects.register(sb.human(), { path: inner, slug: "inner", name: "I" })).rejects.toThrow(ProjectError);
  });
});
