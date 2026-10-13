import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PolicyEngine } from "../src/executor/policy-engine.ts";

const dir = mkdtempSync(join(tmpdir(), "policy-"));
const root = join(dir, "worktree");
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(join(root, "studio"), { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "");
writeFileSync(join(dir, "outside.txt"), "");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const plan = {
  files_to_create: ["src/new.ts"],
  files_to_modify: ["src/a.ts"],
  files_to_delete: ["src/old.ts"],
  commands: [{ cmd: "npm test", purpose: "tests" }],
};
const exec = new PolicyEngine({ mode: "execute", root, plan });
const planning = new PolicyEngine({ mode: "plan", root, plan });
const d = (p: PolicyEngine, tool: string, input: Record<string, unknown>) => p.evaluate(tool, input).decision;

describe("écritures", () => {
  it("autorise ce que prévoit le plan, en chemin relatif ou absolu", () => {
    expect(d(exec, "Edit", { file_path: "src/a.ts" })).toBe("allow");
    expect(d(exec, "Edit", { file_path: join(root, "src", "a.ts") })).toBe("allow");
    expect(d(exec, "Write", { file_path: join(root, "SRC", "new.ts") })).toBe(process.platform === "win32" ? "allow" : "ask");
  });
  it("vous demande pour un fichier du projet non prévu", () => {
    expect(d(exec, "Write", { file_path: "src/b.ts" })).toBe("ask");
  });
  it("refuse sans appel : vision, .git, réglages Claude, secrets, hors projet", () => {
    for (const p of ["studio/items/D-0001.md", ".git/config", ".claude/settings.json", ".env", "config/prod.pem", "../outside.txt", join(dir, "outside.txt")]) {
      expect(d(exec, "Edit", { file_path: p }), p).toBe("deny");
    }
  });
  it("aucune écriture pendant le plan ou la vérification", () => {
    expect(d(planning, "Edit", { file_path: "src/a.ts" })).toBe("deny");
    expect(d(new PolicyEngine({ mode: "verify", root, plan }), "Write", { file_path: "src/a.ts" })).toBe("deny");
  });
  it("un lien symbolique ou une jonction vers l'extérieur ne permet pas de sortir", () => {
    try {
      symlinkSync(dir, join(root, "src", "lien"), "junction");
    } catch {
      return; // création de lien non permise sur cette machine : cas non testable
    }
    expect(d(exec, "Write", { file_path: "src/lien/outside.txt" })).toBe("deny");
  });
});

describe("lectures", () => {
  it("lecture libre dans le projet, y compris la vision", () => {
    expect(d(exec, "Read", { file_path: "src/a.ts" })).toBe("allow");
    expect(d(exec, "Read", { file_path: "studio/BRIEF.md" })).toBe("allow");
    expect(d(exec, "Grep", { pattern: "x" })).toBe("allow");
  });
  it("pas de lecture hors projet, des secrets ou de .git", () => {
    expect(d(exec, "Read", { file_path: join(dir, "outside.txt") })).toBe("deny");
    expect(d(exec, "Read", { file_path: ".env.local" })).toBe("deny");
    expect(d(exec, "Glob", { pattern: "*", path: ".." })).toBe("deny");
    expect(d(exec, "Read", { file_path: ".git/config" })).toBe("deny");
  });
});

describe("commandes", () => {
  it("lecture seule toujours permise", () => {
    for (const c of ["git status", "git diff --stat", "git log --oneline -5", "ls -la src", "pwd"]) expect(d(planning, "Bash", { command: c }), c).toBe("allow");
  });
  it("commande du plan permise à l'exécution, pas pendant le plan", () => {
    expect(d(exec, "Bash", { command: "npm test" })).toBe("allow");
    expect(d(planning, "Bash", { command: "npm test" })).toBe("deny");
  });
  it("suppression seulement si prévue", () => {
    expect(d(exec, "Bash", { command: "rm src/old.ts" })).toBe("allow");
    expect(d(exec, "Bash", { command: "rm src/a.ts" })).toBe("ask");
    expect(d(exec, "Bash", { command: "rm studio/vision.md" })).toBe("ask");
  });
  it("refus sans appel : réseau, interpréteurs, Git en écriture, enchaînements", () => {
    const bad = [
      "curl https://example.com",
      "Invoke-WebRequest x",
      'node -e "require(1)"',
      "python script.py",
      "powershell -c ls",
      "git push origin main",
      "git commit -m x",
      "git reset --hard",
      "rm -rf src",
      "git status && rm src/a.ts",
      "npm test; curl x",
      "echo $SECRET",
      "cat .env > out.txt",
      "ls `whoami`",
      "npx -y cowsay",
    ];
    for (const c of bad) expect(d(exec, "Bash", { command: c }), c).toBe("deny");
  });
  it("commande inconnue : on vous demande à l'exécution, refus pendant le plan", () => {
    expect(d(exec, "Bash", { command: "npm run lint" })).toBe("ask");
    expect(d(planning, "Bash", { command: "npm run lint" })).toBe("deny");
  });
  it("le rendu du résultat structuré est toujours permis (sans effet)", () => {
    expect(d(planning, "StructuredOutput", { summary: "x" })).toBe("allow");
  });
  it("outils non prévus refusés", () => {
    for (const t of ["WebFetch", "WebSearch", "Task", "Agent", "mcp__autre__outil"]) expect(d(exec, t, {}), t).toBe("deny");
  });
});

describe("validation d'un plan", () => {
  it("signale les chemins et commandes interdits avant toute validation", () => {
    const problems = planning.validatePlan({
      summary: "s",
      summary_simple: "s",
      acceptance_criteria: ["c"],
      steps: [{ description: "x", files: [] }],
      files_to_create: ["../hors.ts", "studio/vision.md"],
      files_to_modify: [".env", "src/a.ts"],
      files_to_delete: [],
      commands: [{ cmd: "npm test && git push", purpose: "x" }, { cmd: "npm test", purpose: "ok" }],
      new_dependencies: [],
      risks: [],
      assumptions: [],
      questions: [],
    });
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toMatch(/hors du projet[\s\S]*protégée[\s\S]*sensible[\s\S]*Commande refusée/);
  });
});
