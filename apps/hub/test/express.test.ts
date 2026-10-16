import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExpressCheck, ExpressChecker } from "../src/express/checker.ts";
import { gameFile } from "../src/express/checker.ts";
import { slugify } from "../src/express/express-service.ts";
import { writeTemplate } from "../src/express/template.ts";
import { createHub } from "../src/hub.ts";
import { FakeExecutor } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox } from "./helpers.ts";

afterEach(() => cleanupSandboxes());

const CONCEPT = {
  title: "Serpent Stellaire",
  pitch: "Un serpent de lumière avale des étoiles sans se mordre la queue.",
  dimension: "2d",
  genre: "arcade",
  controls: ["Flèches : tourner"],
  loop: "Avaler des étoiles, grandir, éviter sa queue.",
  goal: "Le score monte à chaque étoile ; la vitesse augmente.",
  style: "Néon sur fond nuit : #05060a, #7df0ff, #ff4fd8, #ffe066",
  features: ["Déplacement", "Étoiles", "Défaite"],
  juice: ["Particules à chaque étoile"],
};
const REPORT = { summary: "Le serpent avance et grandit.", how_to_play: "Flèches pour tourner.", known_issues: [] };

/** Testeur factice : renvoie les résultats prévus, dans l'ordre. */
class Checks implements ExpressChecker {
  results: ExpressCheck[] = [];
  seen: string[] = [];
  async check(root: string): Promise<ExpressCheck> {
    this.seen.push(readFileSync(join(root, "src", "main.js"), "utf8"));
    return this.results.shift() ?? { ok: true, errors: [], screenshot: null };
  }
}

function setup() {
  const sb = sandbox();
  sb.hub.close();
  const orchestrator = new FakeOrchestrator();
  const executor = new FakeExecutor();
  const checks = new Checks();
  const hub = createHub({
    databasePath: join(sb.dir, "hub/.data/express.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    orchestrator,
    executor,
    dataDir: join(sb.dir, "hub/.data"),
    expressChecker: checks,
  });
  sb.hub = hub;
  hub.express.gamesRoot = join(sb.dir, "games");
  return { sb, hub, orchestrator, executor, checks };
}

const log = (repo: string) => execFileSync("git", ["-C", repo, "log", "--format=%s"], { encoding: "utf8" });

describe("Jeu express (ADR-44)", { timeout: 30_000 }, () => {
  it("Éclair : idée → fiche → dossier prototypes/ → code → test → jouable, sans plan ni installation", async () => {
    const { sb, hub, orchestrator, executor, checks } = setup();
    orchestrator.extractions.push(CONCEPT as never);
    executor.scripts.execute.push(async (t) => {
      await t.write("src/main.js", "// le jeu\nconsole.log('serpent');\n");
      expect(await t.bash("npm install three")).toBe("refused"); // le gardien veille toujours
      return REPORT;
    });

    const started = hub.express.create(sb.human(), "un serpent dans l'espace qui mange des étoiles", "eclair");
    expect(started).toMatchObject({ status: "running", phase: "idee", mode: "eclair" });
    expect(() => hub.express.create(sb.human(), "un autre jeu", "eclair")).toThrow(/déjà en cours/);
    await hub.express.idle();

    const g = hub.express.get(started.id);
    expect(g).toMatchObject({ status: "ready", phase: "pret", title: "Serpent Stellaire", slug: "serpent-stellaire", summary: REPORT.summary, how_to_play: REPORT.how_to_play });
    expect(g.root).toBe(join(sb.dir, "games", "prototypes", "serpent-stellaire"));
    expect(readFileSync(join(g.root, "src", "main.js"), "utf8")).toMatch(/le jeu/);
    expect(readFileSync(join(g.root, "index.html"), "utf8")).toMatch(/<title>Serpent Stellaire<\/title>[\s\S]*src="\.\/src\/main\.js"/);
    expect(existsSync(join(g.root, "lib"))).toBe(false); // 2D : pas de Three.js
    expect(log(g.root)).toMatch(/express: première version de « Serpent Stellaire »\nexpress: modèle de départ/);

    // Un seul passage du développeur, en Sonnet, dans le dossier du prototype, avec la fiche dans la consigne.
    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]).toMatchObject({ kind: "execute", cwd: g.root, model: "sonnet" });
    expect(executor.requests[0]!.runId).toMatch(/^XRUN-/);
    expect(executor.requests[0]!.prompt).toMatch(/# Serpent Stellaire \(2D, arcade\)[\s\S]*Flèches : tourner/);
    expect(executor.requests[0]!.systemPrompt).toMatch(/DÉVELOPPEUR EXPRESS[\s\S]*canvas plein écran/);
    expect(checks.seen).toHaveLength(1);
    expect(g.events.map((e) => e.text).join("\n")).toMatch(/Idée[\s\S]*Serpent Stellaire : Un serpent[\s\S]*Code[\s\S]*Test[\s\S]*sans erreur[\s\S]*Jouable !/);
    expect(hub.journal.list({}).map((e) => e.type)).toContain("express.ready");

    // Le jeu est servi tel quel, jamais en dehors de son dossier.
    expect(gameFile(g.root, "src/main.js")?.mime).toMatch(/javascript/);
    expect(gameFile(g.root, "")?.path).toBe(join(g.root, "index.html"));
    expect(gameFile(g.root, "../../hub/.data/express.db")).toBeNull();
    expect(gameFile(g.root, ".git/config")).toBeNull();
  });

  it("une erreur au test : une correction, puis nouvel essai ; Soigné ajoute la finition sur Opus ; Three.js fourni en 3D", async () => {
    const { sb, hub, orchestrator, executor, checks } = setup();
    orchestrator.extractions.push({ ...CONCEPT, title: "Cube Fou", dimension: "3d" } as never);
    executor.scripts.execute.push(
      async (t) => (await t.write("src/main.js", "import * as THREE from 'three'; bug();\n"), REPORT),
      async (t) => (await t.write("src/main.js", "import * as THREE from 'three';\n"), REPORT),
      async (t) => (await t.write("src/main.js", "import * as THREE from 'three'; // finition\n"), { ...REPORT, summary: "Finition faite." }),
    );
    checks.results.push({ ok: false, errors: ["bug is not defined"], screenshot: null }, { ok: true, errors: [], screenshot: null }, { ok: true, errors: [], screenshot: null });

    const { id } = hub.express.create(sb.human(), "un cube qui saute", "soigne");
    await hub.express.idle();
    const g = hub.express.get(id);
    expect(g).toMatchObject({ status: "ready", summary: "Finition faite." });
    expect(executor.requests.map((r) => r.model)).toEqual(["opus", "opus", "opus"]);
    expect(executor.requests[1]!.prompt).toMatch(/bug is not defined/);
    expect(executor.requests[2]!.prompt).toMatch(/FINITION/);
    expect(existsSync(join(g.root, "lib", "three", "three.module.min.js"))).toBe(true);
    expect(existsSync(join(g.root, "lib", "three", "addons", "postprocessing", "UnrealBloomPass.js"))).toBe(true);
    expect(readFileSync(join(g.root, "index.html"), "utf8")).toMatch(/importmap[\s\S]*"three": "\.\/lib\/three\/three\.module\.min\.js"/);
    expect(log(g.root)).toMatch(/express: finition[\s\S]*express: correction[\s\S]*express: première version/);
  });

  it("améliorer, puis en faire un vrai projet du studio ; refus si l'abonnement est presque épuisé", async () => {
    const { sb, hub, orchestrator, executor } = setup();
    orchestrator.extractions.push(CONCEPT as never);
    executor.scripts.execute.push(
      async (t) => (await t.write("src/main.js", "// v1\n"), REPORT),
      async (t) => (await t.write("src/main.js", "// v2 avec un boss\n"), { ...REPORT, summary: "Un boss apparaît." }),
    );
    const { id } = hub.express.create(sb.human(), "serpent", "eclair");
    await hub.express.idle();

    hub.express.improve(sb.human(), id, "ajoute un boss toutes les 30 secondes");
    await hub.express.idle();
    const g = hub.express.get(id);
    expect(g).toMatchObject({ status: "ready", version: 1, summary: "Un boss apparaît." });
    expect(executor.requests[1]).toMatchObject({ model: "sonnet" });
    expect(executor.requests[1]!.prompt).toMatch(/ajoute un boss toutes les 30 secondes/);

    const { project, thread } = await hub.express.promote(sb.human(), id);
    expect(project).toBe("serpent-stellaire");
    expect(hub.projects.get(project)).toMatchObject({ name: "Serpent Stellaire", autonomy: "workshop", root: g.root });
    expect(hub.conversations.messages(project, thread)[0]!.text).toMatch(/vient du Jeu express[\s\S]*Vite avec des tests/);
    await vi.waitFor(() => expect(hub.conversations.messages(project, thread)).toHaveLength(2), { timeout: 10_000 });
    await hub.conversations.idle();
    await expect(hub.express.promote(sb.human(), id)).rejects.toThrow(/déjà un projet/);
    await hub.conversations.idle();

    // Jauge des 5 heures à 95 % : on ne lance pas une démonstration vouée à s'arrêter en route.
    hub.usage.record({ project: null, agent: "test", model: "sonnet", tokens: null, costUsd: null, limits: { status: "allowed", windows: { five_hour: { utilization: 0.95, resetsAt: "2099-01-01T00:00:00.000Z" } } } });
    expect(() => hub.express.create(sb.human(), "encore un jeu", "eclair")).toThrow(/Abonnement presque épuisé \(95 %\)/);
  });

  it("le noms de dossier et un échec lisible", async () => {
    expect(slugify("Cœur d'Étoile : le Retour !")).toBe("coeur-d-etoile-le-retour");
    expect(slugify("???")).toBe("jeu-express");
    const { sb, hub, orchestrator } = setup();
    orchestrator.extractions.push(new Error("limite atteinte"));
    const { id } = hub.express.create(sb.human(), "un jeu", "eclair");
    await hub.express.idle();
    expect(hub.express.get(id)).toMatchObject({ status: "failed", error: "limite atteinte" });
    expect(hub.express.running()).toBeNull();
  });

  it("le modèle de départ se charge seul (2D) et embarque Three.js (3D)", () => {
    const sb = sandbox();
    const root = join(sb.dir, "p");
    writeTemplate(root, { ...CONCEPT, dimension: "2d" } as never);
    expect(readFileSync(join(root, "src", "main.js"), "utf8")).toMatch(/en construction/);
    expect(readFileSync(join(root, "index.html"), "utf8")).not.toMatch(/importmap/);
  });
});
