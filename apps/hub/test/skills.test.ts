import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHub, type Hub } from "../src/hub.ts";
import { buildExecArgs } from "../src/executor/claude-code.ts";
import { PolicyEngine } from "../src/executor/policy-engine.ts";
import { buildChatArgs, parseStream } from "../src/llm/claude-cli.ts";
import { scanHermesLibrary } from "../src/skills/hermes-library.ts";
import { DORMANT_AFTER, type SkillAutomation } from "../src/skills/skill-service.ts";
import { FakeExecutor, REPORT, VERIFIED } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox, type Sandbox } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());
const P = "destiny";

async function setup(skills?: SkillAutomation) {
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
    skills,
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

/** Un chantier lancé depuis une discussion, mené jusqu'à la fusion (automatique, ou par vous s'il attend en relecture). */
async function mergedTask(ctx: Awaited<ReturnType<typeof setup>>, report: Omit<typeof REPORT, "deviations"> & { deviations: { what: string; why: string }[] }) {
  const { sb, hub, fake, exec } = ctx;
  exec.scripts.execute.push(async (t) => {
    await t.write("src/enemy.ts", "export const enemy = 1;\n");
    return report;
  });
  exec.scripts.verify.push(() => VERIFIED);
  fake.replies.push("Ok.\n[[CHANTIER: Nouvel ennemi]]\nObjectif : un ennemi qui charge.\n[[/CHANTIER]]");
  const t = hub.conversations.createThread(P, "x");
  await hub.conversations.send(P, t.id, "go");
  await hub.conversations.idle();
  await hub.tasks.idle();
  const [task] = hub.tasks.list(P);
  if (task!.status === "review") {
    const review = await hub.tasks.review(P, task!.id);
    await hub.tasks.merge(sb.human(), P, task!.id, review.head!);
    await hub.tasks.idle();
  }
  expect(hub.tasks.get(P, task!.id).status).toBe("merged");
  return hub.tasks.get(P, task!.id);
}

describe("bibliothèque tenue seule (ADR-97)", () => {
  it("un chantier difficile fusionné devient une procédure active, réversible, mise en sommeil si elle ne sert jamais", async () => {
    const ctx = await setup({ learn: true });
    const { sb, hub, fake } = ctx;
    const procedure = {
      action: "create",
      name: "ajouter-un-ennemi",
      description: "À utiliser quand on ajoute un ennemi au jeu.",
      body: "1. Créer src/enemy.ts\n2. Ajouter son test à côté\n3. Lancer npm test",
      agents: ["developer"],
      scope: "project",
      change: "Procédure d'ajout d'un ennemi",
    };
    // Après la fusion, le carnet « État du jeu » est aussi réécrit : chaque appel reçoit la réponse qui lui revient.
    const answer = (prompt: string) => (/<difficultes>/.test(prompt) ? procedure : { etat: "Le jeu a maintenant un ennemi qui charge le joueur." }) as never;
    fake.extractions.push(answer, answer);
    const task = await mergedTask(ctx, { ...REPORT, deviations: [{ what: "Test ajouté", why: "le plan l'oubliait" }] });
    await hub.skills.idle();

    const call = fake.calls.find((c) => c.kind === "structured" && /CURATEUR DES COMPÉTENCES/.test(c.systemPrompt))!;
    expect(call).toBeTruthy();
    expect(call.prompt).toMatch(/<difficultes>[\s\S]*1 écart\(s\) au plan/);
    const learned = hub.skills.list().find((s) => s.name === "ajouter-un-ennemi")!;
    expect(learned).toMatchObject({ source: "learned", enabled: true, project: P, origin: `${P}/${task.id}`, agents: ["developer"] });
    expect(hub.journal.list({ project: P }).some((e) => e.type === "skill.learned" && e.subject === "ajouter-un-ennemi")).toBe(true);
    expect(hub.skills.status().recent.some((e) => e.type === "skill.learned")).toBe(true);
    // Le développeur la reçoit dès le chantier suivant.
    expect(hub.skills.forAgent("developer", P).map((s) => s.name)).toContain("ajouter-un-ennemi");

    // Retouchée puis remise comme avant d'un clic.
    hub.skills.save(sb.human(), { ...learned, body: "Autre texte" });
    expect(hub.skills.get(learned.id).has_previous).toBe(true);
    expect(hub.skills.revert(sb.human(), learned.id).body).toMatch(/Créer src\/enemy\.ts/);

    // Utilisée (outil Skill) : comptée ; proposée trop souvent sans jamais servir : mise en sommeil.
    hub.skills.recordUse("studio-skills:ajouter-un-ennemi");
    expect(hub.skills.get(learned.id).stats).toMatchObject({ used: 1 });
    for (let i = 0; i < DORMANT_AFTER; i++) hub.skills.pluginFor("developer", P, join(sb.dir, "hub/.data/runs/x"));
    expect(hub.skills.get(learned.id).enabled).toBe(false);
    expect(hub.journal.list({ project: P }).some((e) => e.type === "skill.dormant")).toBe(true);
  });

  it("un chantier sans difficulté n'apprend rien (aucun appel)", async () => {
    const ctx = await setup({ learn: true });
    const before = () => ctx.fake.calls.filter((c) => c.kind === "structured" && /CURATEUR/.test(c.systemPrompt)).length;
    await mergedTask(ctx, { ...REPORT, deviations: [] });
    await ctx.hub.skills.idle();
    expect(before()).toBe(0);
    expect(ctx.hub.skills.list().some((s) => s.source === "learned")).toBe(false);
  });

  it("la bibliothèque d'Hermes : tri, adaptation, annexes, mises à jour, vos retouches et suppressions respectées", async () => {
    const lib = join(tmpdir(), `hermes-skills-${Date.now()}`);
    const write = (rel: string, text: string) => {
      mkdirSync(dirname(join(lib, rel)), { recursive: true });
      writeFileSync(join(lib, rel), text);
    };
    write("software-development/systematic-debugging/SKILL.md", '---\nname: systematic-debugging\ndescription: "4-phase root cause debugging."\n---\n\n# Debug\nUse terminal() then read_file.\n');
    write("software-development/systematic-debugging/references/phases.md", "Phase 1 : reproduire.\n");
    write("email/himalaya/SKILL.md", "---\nname: himalaya\ndescription: Email from terminal.\n---\n\nSend mail.\n");
    try {
      const { sb, hub, fake } = await setup({ hermesDir: lib });
      fake.extractions.push(() => ({ picks: [{ origin: "software-development/systematic-debugging", agents: ["developer", "qa"], why: "débogage des jeux" }] }) as never);
      fake.extractions.push((prompt) => {
        expect(prompt).toMatch(/<annexe chemin="references\/phases\.md">/);
        return { description: "À utiliser quand un bug résiste.", body: "# Débogage\nReproduire, isoler, corriger. Voir references/phases.md.", agents: ["developer", "qa"], keep_files: ["references/phases.md"] } as never;
      });
      expect(await hub.skills.syncHermes()).toEqual({ scanned: 2, imported: 1, updated: 0, ignored: 1, failed: 0 });
      expect(fake.calls[0]!.prompt).toMatch(/origin="email\/himalaya"/);
      const s = hub.skills.list().find((x) => x.name === "systematic-debugging")!;
      expect(s).toMatchObject({ source: "hermes", enabled: true, origin: "hermes:software-development/systematic-debugging", agents: ["developer", "qa"], files: [{ path: "references/phases.md" }] });
      expect(hub.skills.status().hermes).toMatchObject({ imported: 1, ignored: 1 });

      // Le développeur reçoit la compétence et son annexe dans son plugin.
      const plugin = hub.skills.pluginFor("developer", P, join(sb.dir, "hub/.data/runs/y"))!;
      expect(readFileSync(join(plugin.dir, "skills", "systematic-debugging", "references", "phases.md"), "utf8")).toMatch(/reproduire/);
      expect(hub.skills.detail(s.id).file_contents).toEqual([{ path: "references/phases.md", content: "Phase 1 : reproduire.\n" }]);

      // Rien n'a changé : aucun appel.
      const n = fake.calls.length;
      expect(await hub.skills.syncHermes()).toMatchObject({ imported: 0, updated: 0, ignored: 0 });
      expect(fake.calls.length).toBe(n);

      // Modifiée dans Hermes : réadaptée (la version d'avant est gardée).
      write("software-development/systematic-debugging/SKILL.md", '---\nname: systematic-debugging\ndescription: "4-phase root cause debugging."\n---\n\n# Debug v2\n');
      fake.extractions.push(() => ({ description: "À utiliser quand un bug résiste.", body: "# Débogage v2", agents: ["developer"], keep_files: [] }) as never);
      expect(await hub.skills.syncHermes()).toMatchObject({ updated: 1 });
      expect(hub.skills.get(s.id)).toMatchObject({ body: "# Débogage v2", files: [], has_previous: true });

      // Retouchée par vous, puis modifiée dans Hermes : votre version est gardée, sans appel.
      hub.skills.save(sb.human(), { ...hub.skills.get(s.id), body: "Ma version" });
      write("software-development/systematic-debugging/SKILL.md", "---\nname: systematic-debugging\ndescription: x\n---\n\n# v3\n");
      const m = fake.calls.length;
      await hub.skills.syncHermes();
      expect(fake.calls.length).toBe(m);
      expect(hub.skills.get(s.id).body).toBe("Ma version");

      // Supprimée par vous : jamais réimportée.
      hub.skills.remove(sb.human(), s.id);
      write("software-development/systematic-debugging/SKILL.md", "---\nname: systematic-debugging\ndescription: x\n---\n\n# v4\n");
      await hub.skills.syncHermes();
      expect(fake.calls.length).toBe(m);
      expect(hub.skills.list().some((x) => x.name === "systematic-debugging")).toBe(false);
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
  });

  it("directeur : leçons en entier, le reste en index lu avec Read ; l'ouverture d'un SKILL.md est comptée", async () => {
    const { sb, hub, fake } = await setup();
    const feel = hub.skills.list().find((s) => s.name === "game-feel")!;
    hub.skills.save(sb.human(), { ...feel, enabled: true });
    fake.replies.push("Noté.");
    const t = hub.conversations.createThread(P, "x");
    await hub.conversations.send(P, t.id, "Les coups manquent de punch");
    await hub.conversations.idle();
    const call = fake.calls.find((c) => c.kind === "reply")!;
    expect(call.systemPrompt).toMatch(/ouvre son fichier avec l'outil Read/);
    expect(call.systemPrompt).not.toMatch(/hit stop/); // le texte n'est plus collé d'office
    expect(call.skillsDir).toBeTruthy();
    const file = join(call.skillsDir!, "game-feel", "SKILL.md");
    expect(readFileSync(file, "utf8")).toMatch(/hit stop/);
    expect(hub.skills.get(feel.id).stats.offered).toBe(1);
    hub.skills.noteRead(file);
    hub.skills.noteRead(join(sb.dir, "ailleurs", "game-feel", "SKILL.md")); // hors bibliothèque : ignoré
    expect(hub.skills.get(feel.id).stats).toMatchObject({ used: 1, offered: 1 });
  });

  it("appel Claude Code : le dossier des compétences devient lisible (Read seulement) ; les outils utilisés sont relevés", () => {
    const solo = buildChatArgs({ systemPrompt: "s", prompt: "p", model: "sonnet", skillsDir: "C:/cache/abc" }, "sys.txt");
    expect(solo).toEqual(expect.arrayContaining(["--add-dir", "C:/cache/abc", "--allowedTools", "Read"]));
    expect(solo[solo.indexOf("--tools") + 1]).toBe("Read");
    const web = buildChatArgs({ systemPrompt: "s", prompt: "p", model: "sonnet", skillsDir: "C:/cache/abc", tools: ["WebSearch"] }, "sys.txt");
    expect(web[web.indexOf("--allowedTools") + 1]).toBe("Read,WebSearch");
    // Sans compétences : rien ne change (aucun outil).
    const none = buildChatArgs({ systemPrompt: "s", prompt: "p", model: "sonnet" }, "sys.txt");
    expect(none[none.indexOf("--tools") + 1]).toBe("");
    expect(none).not.toContain("--add-dir");
    const stream = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "C:/cache/abc/game-feel/SKILL.md" } }] } }),
      JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
    ].join("\n");
    expect(parseStream(stream).tools).toEqual([{ tool: "Read", input: { file_path: "C:/cache/abc/game-feel/SKILL.md" } }]);
  });

  it("lecture de la bibliothèque d'Hermes : en-têtes YAML variés, annexes texte seulement", () => {
    const lib = join(tmpdir(), `hermes-scan-${Date.now()}`);
    const write = (rel: string, text: string) => {
      mkdirSync(dirname(join(lib, rel)), { recursive: true });
      writeFileSync(join(lib, rel), text);
    };
    write("creative/p5js/SKILL.md", "---\nname: p5js\ndescription: >\n  p5.js sketches\n  and shaders\n---\n\nBody\n".replace(/\n/g, "\r\n"));
    write("creative/p5js/references/api.md", "API");
    write("creative/p5js/assets/logo.png", "binaire");
    write("creative/p5js/notes.md", "hors sous-dossier connu");
    try {
      expect(scanHermesLibrary(lib)).toEqual([expect.objectContaining({ origin: "creative/p5js", name: "p5js", description: "p5.js sketches and shaders", body: "Body", files: [{ path: "references/api.md", content: "API" }] })]);
      expect(scanHermesLibrary(join(lib, "n-existe-pas"))).toEqual([]);
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
  });
});
