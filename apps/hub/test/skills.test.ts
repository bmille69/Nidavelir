import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHub, type Hub } from "../src/hub.ts";
import { buildExecArgs } from "../src/executor/claude-code.ts";
import { PolicyEngine } from "../src/executor/policy-engine.ts";
import { FakeExecutor, REPORT, VERIFIED } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox, type Sandbox } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());
const P = "destiny";

async function setup() {
  const fake = new FakeOrchestrator();
  const exec = new FakeExecutor();
  const sb: Sandbox = sandbox();
  sb.hub.close();
  const hub: Hub = createHub({
    databasePath: join(sb.dir, "hub/.data/skills.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    orchestrator: fake,
    executor: exec,
    dataDir: join(sb.dir, "hub/.data"),
    autopilot: { synthesisDelayMs: 600_000 },
  });
  sb.hub = hub;
  const root = sb.makeGameRepo("games/destiny", { "README.md": "# D\n", "src/main.ts": "export {};\n" });
  await hub.projects.register(sb.human(), { path: root, slug: P, name: "Destiny" });
  return { sb, hub, fake, exec };
}

describe("bibliothèque de compétences", () => {
  it("compétences de départ désactivées ; vous activez, elles arrivent aux bons agents", async () => {
    const { sb, hub } = await setup();
    const starters = hub.skills.list();
    expect(starters.map((s) => [s.name, s.enabled])).toEqual([
      ["game-feel", false],
      ["perf-web-3d", false],
      ["testeur-joueur", false],
    ]);
    expect(hub.skills.forAgent("director", P)).toEqual([]);

    const feel = starters.find((s) => s.name === "game-feel")!;
    hub.skills.save(sb.human(), { ...feel, enabled: true });
    expect(hub.skills.forAgent("director", P).map((s) => s.name)).toEqual(["game-feel"]);
    expect(hub.skills.forAgent("qa", P)).toEqual([]);
    expect(hub.skills.promptBlock("director", P)).toMatch(/<competence nom="game-feel"[\s\S]*hit stop/);

    // Vos propres compétences ; noms et suppression contrôlés.
    expect(() => hub.skills.save(sb.human(), { name: "Pas Bon!", description: "x", body: "y", agents: ["qa"], enabled: true })).toThrow(/minuscules/);
    const mine = hub.skills.save(sb.human(), { name: "godot-style", description: "Style GDScript du studio", body: "Toujours typer les variables.", agents: ["developer"], enabled: true });
    expect(() => hub.skills.remove(sb.human(), feel.id)).toThrow(/désactivent/);
    hub.skills.remove(sb.human(), mine.id);
    expect(hub.skills.list().some((s) => s.name === "godot-style")).toBe(false);
    expect(() => hub.skills.save({} as never, { name: "x-y", description: "d", body: "b", agents: [], enabled: true })).toThrow(/humain/);
  });

  it("le développeur reçoit un plugin de compétences ; le gardien n'autorise que celles du studio", async () => {
    const { sb, hub, fake, exec } = await setup();
    const perf = hub.skills.list().find((s) => s.name === "perf-web-3d")!;
    hub.skills.save(sb.human(), { ...perf, enabled: true });
    exec.scripts.execute.push(async (t) => {
      await t.write("src/a.ts", "export {};\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    fake.replies.push("Ok.\n[[CHANTIER: Perf]]\nObjectif : plus rapide.\n[[/CHANTIER]]");
    const t = hub.conversations.createThread(P, "x");
    await hub.conversations.send(P, t.id, "go");
    await hub.conversations.idle();
    await hub.tasks.idle();

    const [execute, verify] = exec.requests;
    expect(execute!.tools).toContain("Skill");
    expect(execute!.systemPrompt).toMatch(/studio-skills:perf-web-3d/);
    const skillFile = join(execute!.pluginDir!, "skills", "perf-web-3d", "SKILL.md");
    expect(readFileSync(skillFile, "utf8")).toMatch(/^---\nname: perf-web-3d\ndescription: "Performance[\s\S]*Zéro allocation/);
    expect(existsSync(join(execute!.pluginDir!, ".claude-plugin", "plugin.json"))).toBe(true);
    // Le testeur n'a pas cette compétence (réservée au développeur).
    expect(verify!.pluginDir).toBeUndefined();
    expect(verify!.tools).not.toContain("Skill");

    const policy = new PolicyEngine({ mode: "execute", root: sb.dir });
    expect(policy.evaluate("Skill", { skill: "studio-skills:perf-web-3d" }).decision).toBe("allow");
    expect(policy.evaluate("Skill", { skill: "schedule" }).decision).toBe("deny");
    expect(buildExecArgs({ tools: ["Read", "Skill"], maxTurns: 5, jsonSchema: {}, pluginDir: "C:/x/studio-skills" }, { settings: "s", mcp: "m", system: "y" }, "sonnet")).toEqual(
      expect.arrayContaining(["--plugin-dir", "C:/x/studio-skills"]),
    );
  });

  it("la mémoire des leçons apprend de votre 👎 et de vos corrections, puis guide les agents", async () => {
    const { sb, hub, fake, exec } = await setup();
    exec.scripts.execute.push(async (t) => {
      await t.write("src/a.ts", "export {};\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    fake.replies.push("Ok.\n[[CHANTIER: Effets de tir]]\nObjectif : tirs premium.\n[[/CHANTIER]]");
    const t = hub.conversations.createThread(P, "x");
    await hub.conversations.send(P, t.id, "go");
    await hub.conversations.idle();
    await hub.tasks.idle();
    const [task] = hub.tasks.list(P);

    // Leçons vides : rien n'est donné aux agents.
    expect(hub.skills.forAgent("developer", P)).toEqual([]);
    fake.extractions.push(() => ({ lessons: "## À faire\n- Garder les effets de tir sobres : pas de flash plein écran\n\n## À éviter\n- Les sillages de plus de 0,2 s", change: "Ajout : effets sobres" }) as never);
    hub.quality.rate(sb.human(), P, task!.id, "down", "trop flashy");
    await hub.skills.idle();

    const lessons = hub.skills.lessons(P);
    expect(lessons.body).toMatch(/effets de tir sobres/);
    expect(fake.calls.at(-1)!.prompt).toMatch(/<signal>[\s\S]*👎[\s\S]*trop flashy/);
    expect(hub.journal.list({ project: P }).some((e) => e.type === "lessons.updated")).toBe(true);
    // Désormais, le directeur et le développeur reçoivent les leçons du projet.
    expect(hub.skills.forAgent("developer", P).map((s) => s.name)).toEqual(["lecons-destiny"]);
    expect(hub.skills.promptBlock("director", P)).toMatch(/lecons-destiny[\s\S]*pas de flash plein écran/);

    // Un 👍 sans un mot n'apprend rien (pas d'appel).
    const calls = fake.calls.length;
    hub.quality.rate(sb.human(), P, task!.id, "up");
    await hub.skills.idle();
    expect(fake.calls.length).toBe(calls);
  });
});
