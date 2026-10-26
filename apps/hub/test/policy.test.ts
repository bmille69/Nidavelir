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
      "git status && rm -rf src",
      "npm test; curl x",
      "cat > src/a.ts <<'EOF'\nx\nEOF",
      "ls src > liste.txt",
      "(ls src)",
      "npm test &",
      "grep x src/a.ts | rm src/a.ts",
      `cat ${join(dir, "outside.txt")}`,
      "cat ../outside.txt",
      "head -5 .env",
      "find . -name '*.ts' -delete",
      "cd .. && ls",
      "echo $SECRET",
      "cat .env > out.txt",
      "ls `whoami`",
      "npx -y cowsay",
      "npm install left-pad",
      "npm ci",
      "yarn add x",
      "ln -s / sortie",
      "mklink /J sortie C:/",
    ];
    for (const c of bad) expect(d(exec, "Bash", { command: c }), c).toBe("deny");
  });
  it("enchaînements sans danger permis : chaque morceau est jugé seul (ADR-33)", () => {
    const ok = [
      'wc -l src/a.ts; ls src; grep -n "shots\\|sim" src/a.ts',
      "npm test 2>&1 | tail -12",
      "npm test 2>/dev/null",
      "git diff --stat | tail -3; git status --short",
      `cd ${root} && grep -n "x" src/a.ts | head -3`,
      "cd src && ls && cat a.ts",
      "sed -n 5,20p src/a.ts",
      "git grep -n -E 'update\\(|hit' -- src",
      "find src -name '*.ts' | sort",
      "node --version",
    ];
    for (const c of ok) expect(exec.evaluate("Bash", { command: c }), c).toMatchObject({ decision: "allow" });
    // Un morceau hors plan dans un enchaînement : on demande, comme pour la commande seule.
    expect(d(exec, "Bash", { command: "git status && rm src/a.ts" })).toBe("ask");
    expect(d(exec, "Bash", { command: "git status && rm src/old.ts" })).toBe("allow");
    // Le refus dit quoi faire à la place.
    expect(exec.evaluate("Bash", { command: "cat > src/a.ts <<'EOF'\nx\nEOF" }).reason).toMatch(/utilise l'outil Write ou Edit/);
  });
  it("suit le dossier courant du terminal de l'agent, qui persiste d'une commande à l'autre (ADR-38)", () => {
    mkdirSync(join(root, "packages", "client", "src"), { recursive: true });
    const inClient = join(root, "packages", "client");
    // Constaté le 15/10 : après « cd packages/client », « cat ../../package.json » était refusé à tort.
    expect(exec.evaluate("Bash", { command: "cat ../../package.json" }, inClient)).toMatchObject({ decision: "allow" });
    expect(exec.evaluate("Bash", { command: "grep -n x ../../src/a.ts" }, inClient)).toMatchObject({ decision: "allow" });
    expect(exec.evaluate("Bash", { command: "cat ../../../outside.txt" }, inClient)).toMatchObject({ decision: "deny" });
    expect(exec.evaluate("Bash", { command: "cd ../.. && ls" }, inClient)).toMatchObject({ decision: "allow" });
    expect(exec.evaluate("Bash", { command: "cd ../../.." }, inClient)).toMatchObject({ decision: "deny" });
    // Revenir à la racine de la copie avec un chemin à la Git Bash (/c/…).
    const bashRoot = root.replace(/^([A-Za-z]):\\/, (_m, l: string) => `/${l.toLowerCase()}/`).replace(/\\/g, "/");
    expect(exec.evaluate("Bash", { command: `cd ${bashRoot} && ls src` }, inClient)).toMatchObject({ decision: "allow" });
    // Un dossier courant hors de la copie ne donne aucun droit : on repart de la racine.
    expect(exec.evaluate("Bash", { command: "cat ../outside.txt" }, dir)).toMatchObject({ decision: "deny" });
  });
  it("scripts du projet permis au testeur, jamais ceux qui publient ou installent", () => {
    const game = join(dir, "jeu");
    mkdirSync(join(game, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(game, "node_modules", ".bin", "vitest.cmd"), "");
    writeFileSync(join(game, "package.json"), JSON.stringify({ scripts: { test: "vitest", simulate: "x", deploy: "y" } }));
    const verify = new PolicyEngine({ mode: "verify", root: game, plan: { ...plan, commands: [] } });
    for (const c of ["npm test", "npm run simulate -- --games 1000 --seed 42 2>&1 | tail -40", "npx vitest run src"]) expect(verify.evaluate("Bash", { command: c }), c).toMatchObject({ decision: "allow" });
    for (const c of ["npm run deploy", "npm run inexistant", "npx cowsay"]) expect(d(verify, "Bash", { command: c }), c).toBe("deny");
    expect(d(new PolicyEngine({ mode: "plan", root: game }), "Bash", { command: "npm test" })).toBe("deny");
  });
  it("le jeu lui-même est lisible (modules partagés), jamais modifiable", () => {
    const game = join(dir, "jeu-partage");
    mkdirSync(game, { recursive: true });
    writeFileSync(join(game, "regles.ts"), "");
    writeFileSync(join(game, ".env"), "");
    const withGame = new PolicyEngine({ mode: "execute", root, plan, readable: [game] });
    expect(d(withGame, "Read", { file_path: join(game, "regles.ts") })).toBe("allow");
    expect(d(withGame, "Bash", { command: `cat ${join(game, "regles.ts")}` })).toBe("allow");
    expect(d(withGame, "Read", { file_path: join(game, ".env") })).toBe("deny");
    expect(d(withGame, "Write", { file_path: join(game, "regles.ts") })).toBe("deny");
    expect(d(exec, "Read", { file_path: join(game, "regles.ts") })).toBe("deny");
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

describe("Godot (ADR-73)", () => {
  const verify = new PolicyEngine({ mode: "verify", root, plan });
  it("import, tests du studio et scène qui tourne quelques images : sans fenêtre, dans la copie", () => {
    for (const c of [
      "godot --version",
      "godot --headless --path . --import",
      "godot --headless --path . -s res://addons/studio_tests/run.gd",
      "godot --headless --path . -s addons/studio_tests/run.gd -- --only=joueur",
      "godot --headless --path . res://scenes/main.tscn --quit-after 120",
      "godot --headless --path . --import && godot --headless --path . -s res://addons/studio_tests/run.gd 2>&1 | tail -40",
    ]) {
      expect(d(exec, "Bash", { command: c }), c).toBe("allow");
      expect(d(verify, "Bash", { command: c }), c).toBe("allow");
    }
    expect(d(planning, "Bash", { command: "godot --headless --path . --import" })).toBe("deny");
  });
  it("jamais l'éditeur, une fenêtre, un autre script, un export, ni un dossier hors de la copie", () => {
    for (const c of [
      "godot --path . --import",
      "godot -e --path .",
      "godot --headless --path . -s res://outils/pirate.gd",
      "godot --headless --path . --export-release Windows jeu.exe",
      "godot --headless --path . --remote-debug tcp://1.2.3.4:6007 --quit",
      "godot --headless --path . -s res://addons/studio_tests/run.gd -- --rm=tout",
      "godot --headless --path .",
    ]) expect(d(exec, "Bash", { command: c }), c).toBe("ask");
    expect(d(exec, "Bash", { command: "godot --headless --path ../.. --import" })).toBe("deny");
    expect(d(verify, "Bash", { command: "godot -e --path ." })).toBe("deny");
  });
});
