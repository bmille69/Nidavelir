import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHub, type Hub } from "../src/hub.ts";
import { parseImplement } from "../src/conversation/conversation-service.ts";
import { parseStream } from "../src/llm/claude-cli.ts";
import { UsageService } from "../src/usage/usage-service.ts";
import { FakeExecutor, planOutput, REPORT, VERIFIED } from "./fake-executor.ts";
import { extracted, FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, DIRECTOR, fakeClock, git, msg, sandbox, type Sandbox } from "./helpers.ts";

const P = "destiny";
// Plusieurs commits Git par test : plus lent que la moyenne quand toute la suite tourne en parallèle.
vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());

/** Hub avec pilote automatique (délai nul) et exécuteur factice. */
async function setup() {
  const fake = new FakeOrchestrator();
  const exec = new FakeExecutor();
  const sb: Sandbox = sandbox();
  sb.hub.close();
  const hub: Hub = createHub({
    databasePath: join(sb.dir, "hub/.data/auto.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    orchestrator: fake,
    executor: exec,
    dataDir: join(sb.dir, "hub/.data"),
    autopilot: { synthesisDelayMs: 0 },
  });
  sb.hub = hub;
  const root = sb.makeGameRepo("games/destiny", { "README.md": "# Destiny\n", "src/main.ts": "export {};\n" });
  await hub.projects.register(sb.human(), { path: root, slug: P, name: "Destiny Survivor" });
  hub.projects.setAutonomy(sb.human(), P, "balanced");
  // Une décision déjà au canon (D-0001), validée par vous.
  hub.vision.capture(P, DIRECTOR, { type: "mechanic", title: "Boss au minuteur", statement: "Le boss arrive au bout de 5 minutes.", source: msg("m", "x") });
  const { proposal, hash } = hub.vision.submitProposal(P, DIRECTOR, {
    title: "Apparition des boss",
    statement: "Le boss arrive au bout de 5 minutes.",
    source: { kind: "message", ref: "m" },
    details: { based_on: ["M-0001"] },
  });
  await hub.vision.decideProposal(P, hub.approvals.record(sb.human(), { project: P, subject: { kind: "proposal", id: proposal.id, hash }, verdict: "approved" }).id);
  return { sb, hub, fake, exec, root };
}

const group = (title: string, based_on: string[], extra: Record<string, unknown> = {}) => ({
  title,
  nature: "creative",
  summary: `En bref : ${title}.`,
  statement: `${title} : la règle retenue.`,
  rationale: "Cohérent.",
  based_on,
  supersedes: [],
  conflict_notes: [],
  questions: [],
  domain: ["boss"],
  ...extra,
});

describe("autonomie « équilibré »", () => {
  it("le directeur décide seul ce qui ne fait pas débat ; conflits et alternatives vous reviennent", async () => {
    const { sb, hub, fake, root } = await setup();
    const t = hub.conversations.createThread(P, "Les boss");
    fake.replies.push("Je retiens 30 secondes de calme avant chaque boss, avec une musique qui retombe.");
    fake.extractions.push(
      [extracted({ title: "Calme avant les boss", quote: "un moment de calme" })],
      [
        extracted({ title: "Durée du calme", quote: "30 secondes de calme" }),
        extracted({ title: "Musique", quote: "une musique qui retombe" }),
      ],
      () =>
        ({
          proposals: [
            group("Calme avant les boss", ["I-0001", "I-0002"]),
            group("Musique du calme", ["I-0003"], { questions: ["Silence total ou musique douce ?"] }),
          ],
          left_out: [],
        }) as never,
    );
    await hub.conversations.send(P, t.id, "J'aimerais un moment de calme avant chaque boss");
    await hub.conversations.idle();
    await hub.autopilot!.idle();

    // La réponse du directeur a été lue elle aussi (3 appels structurés : vous, lui, regroupement).
    expect(fake.calls.filter((c) => c.kind === "structured")).toHaveLength(3);
    const calm = hub.vision.list(P, { type: "decision", status: "validated" }).find((d) => d.title === "Calme avant les boss")!;
    expect(calm.validated_by?.kind).toBe("delegated");
    expect(hub.vision.get(P, "P-0003")).toMatchObject({ status: "submitted" });
    expect(git(root, "log", "--format=%s")).toMatch(/Calme avant les boss/);
    const approval = hub.approvals.get(P, calm.validated_by!.approval)!;
    expect(approval.session).toBe("delegation:balanced");
    void sb;
  });

  it("un conflit avec le canon attend votre arbitrage ; en « autonome », le directeur le tranche", async () => {
    const { sb, hub } = await setup();
    hub.vision.capture(P, DIRECTOR, { type: "mechanic", title: "Boss à l'arène", statement: "Le boss surgit à l'entrée de l'arène.", source: msg("m2", "y") });
    hub.vision.submitProposal(P, DIRECTOR, {
      title: "Boss à l'arène",
      statement: "Le boss surgit à l'entrée de l'arène.",
      source: { kind: "message", ref: "m2" },
      details: { based_on: ["M-0002"], supersedes: ["D-0001"], conflict_notes: ["minuteur → arène"] },
    });
    hub.vision.capture(P, DIRECTOR, { type: "idea", title: "Coffres", statement: "Coffre de 60 ou 100 places", source: msg("m3", "z") });
    hub.vision.submitProposal(P, DIRECTOR, {
      title: "Taille du coffre",
      statement: "Coffre de 60 places.",
      source: { kind: "message", ref: "m3" },
      details: { based_on: ["I-0001"], questions: ["60 ou 100 places ?"] },
    });

    expect(await hub.autopilot!.decidePending(sb.human(), P)).toEqual({ decided: [], left: 2 });
    hub.projects.setAutonomy(sb.human(), P, "autonomous");
    const r = await hub.autopilot!.decidePending(sb.human(), P);
    expect(r.left).toBe(1);
    expect(hub.vision.get(P, "D-0001").status).toBe("superseded");
    expect(hub.vision.get(P, r.decided[0]!).validated_by?.kind).toBe("delegated");
    expect(hub.vision.list(P, { type: "proposal", status: "submitted" }).map((p) => p.title)).toEqual(["Taille du coffre"]);
  });
});

describe("vrai choix : des options cliquables", () => {
  it("une proposition à options vous revient, avec la version conseillée", async () => {
    const { hub, fake } = await setup();
    const t = hub.conversations.createThread(P, "Tirs");
    fake.replies.push("Deux façons de faire pour les tirs ennemis.");
    fake.extractions.push(
      [extracted({ title: "Tirs ennemis lisibles", quote: "des tirs ennemis lisibles" })],
      [],
      () =>
        ({
          proposals: [
            group("Tirs des ennemis", ["I-0001"], {
              options: [
                { key: "A", label: "Orbes rouges", statement: "Orbes rouge-orangé à halo.", tradeoffs: "Lisible." },
                { key: "B", label: "Comme le joueur", statement: "Mêmes balles que le joueur.", tradeoffs: "Cohérent." },
              ],
              recommended_option: "A",
            }),
          ],
          left_out: [],
        }) as never,
    );
    await hub.conversations.send(P, t.id, "Je veux des tirs ennemis lisibles");
    await hub.conversations.idle();
    await hub.autopilot!.idle();
    const [p] = hub.vision.list(P, { type: "proposal", status: "submitted" });
    expect(p!.proposal).toMatchObject({ recommended_option: "A" });
    expect(p!.proposal!.options.map((o) => o.label)).toEqual(["Orbes rouges", "Comme le joueur"]);
  });
});

describe("« go » : le directeur confie le travail au développeur", () => {
  it("lit la balise et la retire du texte", () => {
    expect(parseImplement("Parfait.\n[[IMPLEMENTER: Balles lumineuses | Ajouter un sillage aux balles | D-0026, D-0029]]")).toEqual({
      text: "Parfait.",
      request: { title: "Balles lumineuses", goal: "Ajouter un sillage aux balles", decisions: ["D-0026", "D-0029"] },
    });
    expect(parseImplement("Rien à faire.").request).toBeNull();
  });

  it("décide ce qui vient d'être dit, crée la tâche et le développeur prépare son plan", async () => {
    const { hub, fake, exec } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    exec.scripts.plan.push(async () => {
      await gate;
      return planOutput();
    });
    const t = hub.conversations.createThread(P, "Tirs");
    fake.replies.push("Je retiens un sillage de 0,12 s derrière chaque balle.\n[[IMPLEMENTER: Sillage des balles | Ajouter un sillage lumineux de 0,12 s aux balles du fusil | D-0001]]");
    fake.extractions.push(
      [extracted({ title: "Balles visibles", quote: "des balles bien visibles" })],
      [extracted({ title: "Sillage", quote: "un sillage de 0,12 s" })],
      () => ({ proposals: [group("Sillage des balles", ["I-0001", "I-0002"])], left_out: [] }) as never,
    );
    const { director } = await hub.conversations.send(P, t.id, "Je veux des balles bien visibles, go");
    expect(director.text).toMatch(/^Je retiens un sillage/);
    expect(director.text).toMatch(/Je confie ce travail au développeur/);
    expect(director.text).not.toMatch(/IMPLEMENTER/);
    await hub.conversations.idle();

    const [task] = hub.tasks.list(P);
    expect(task).toMatchObject({ title: "Sillage des balles", status: "planning" });
    expect(task!.authorized_by).toEqual(["D-0001", "D-0002"]);
    expect(hub.tasks.activeRuns().map((r) => r.kind)).toEqual(["plan"]);
    const last = hub.conversations.messages(P, t.id).at(-1)!;
    expect(last.text).toMatch(/Tâche T-0001 « Sillage des balles » confiée au développeur/);
    release();
    await hub.tasks.idle();
    expect(hub.tasks.get(P, task!.id).status).toBe("plan_review");
  });
});

describe("« Je valide tout »", () => {
  it("rien n'est décidé seul et la réponse du directeur n'est pas notée", async () => {
    const { sb, hub, fake } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "supervised");
    const t = hub.conversations.createThread(P, "x");
    fake.extractions.push([extracted({ title: "Calme", quote: "un moment de calme" })]);
    await hub.conversations.send(P, t.id, "J'aimerais un moment de calme avant chaque boss");
    await hub.conversations.idle();
    await hub.autopilot!.idle();
    expect(fake.calls.filter((c) => c.kind === "structured")).toHaveLength(1);
    expect(hub.vision.list(P, { type: "proposal", status: "submitted" })).toEqual([]);
    expect(() => hub.projects.setAutonomy({} as never, P, "autonomous")).toThrow(/humain/);
  });
});

describe("« Autonome » : plans sans risque", () => {
  it("le plan sans risque est validé et lancé ; la fusion reste à vous", async () => {
    const { sb, hub, exec } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "autonomous");
    exec.scripts.plan.push(() => planOutput());
    exec.scripts.execute.push(async (t) => {
      await t.write("src/boss.ts", "export const rule = 'arène';\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    const task = hub.tasks.create(sb.human(), P, { decisions: ["D-0001"] });
    await hub.tasks.startPlanning(P, task.id);
    await hub.tasks.idle();
    expect(hub.tasks.get(P, task.id).status).toBe("review");
    expect(hub.journal.list({ project: P }).some((e) => e.type === "plan.approved" && e.payload.delegated === true)).toBe(true);

    // Un plan qui supprime un fichier vous revient.
    exec.scripts.plan.push(() => planOutput({ files_to_delete: ["README.md"] }));
    const risky = hub.tasks.create(sb.human(), P, { decisions: ["D-0001"] });
    await hub.tasks.startPlanning(P, risky.id);
    await hub.tasks.idle();
    expect(hub.tasks.get(P, risky.id).status).toBe("plan_review");
  });
});

describe("atelier (par défaut)", () => {
  const BRIEF = [
    "Je propose un noyau blanc-chaud et un sillage de 0,12 s, sans toucher à la simulation.",
    "[[CHANTIER: Balles lumineuses]]",
    "Objectif : des tirs lisibles et premium.",
    "À faire : noyau blanc-chaud, sillage 0,12 s teinté de l'élément.",
    "Où : src/main.ts",
    "Vérification : npm test",
    "[[/CHANTIER]]",
  ].join("\n");

  it("nouveau projet en atelier ; « go » lance le chantier sans fiche ni décision, jusqu'au résultat à relire", async () => {
    const { sb, hub, fake, exec } = await setup();
    const fresh = sb.makeGameRepo("games/neuf");
    expect((await hub.projects.register(sb.human(), { path: fresh, slug: "neuf", name: "Neuf" })).autonomy).toBe("workshop");
    hub.projects.setAutonomy(sb.human(), P, "workshop");

    exec.scripts.plan.push(() => planOutput());
    exec.scripts.execute.push(async (t) => {
      await t.write("src/boss.ts", "export const balles = 'lumineuses';\n");
      // Hors plan, sans danger : en atelier, ça passe sans vous déranger.
      expect(await t.write("src/extra.ts", "export {};\n")).toBe("ok");
      return { ...REPORT, how_to_test: ["Lancez une partie avec ?seed=1", "Tirez au fusil auto : les balles laissent un sillage"] };
    });
    exec.scripts.verify.push(() => ({ ...VERIFIED, verdict: "fail", summary_simple: "Le test de la scène échoue (polices bloquées)." }));
    fake.replies.push(BRIEF);
    const t = hub.conversations.createThread(P, "Tirs");
    const { human, director } = await hub.conversations.send(P, t.id, "Les balles du perso font cheap. go");
    await hub.conversations.idle();
    await hub.tasks.idle();

    // Aucune fiche notée, aucun regroupement : un seul appel, la réponse du directeur.
    expect(fake.calls.map((c) => c.kind)).toEqual(["reply"]);
    expect(human.extraction).toBe("none");
    expect(fake.calls[0]!.systemPrompt).toMatch(/<fichiers_du_jeu total="\d+">[\s\S]*src\/main.ts/);
    expect(director.text).toMatch(/^Je propose un noyau/);
    expect(director.text).toMatch(/§CONSIGNE§ Balles lumineuses\nObjectif : des tirs lisibles/);

    const [task] = hub.tasks.list(P);
    expect(task).toMatchObject({ title: "Balles lumineuses", authorized_by: [], origin: { thread: t.id }, status: "review" });
    expect(task!.goal).toMatch(/sillage 0,12 s/);
    const notes = hub.conversations.messages(P, t.id).slice(2).map((m) => m.text);
    expect(notes[0]).toMatch(/Chantier T-0001 « Balles lumineuses » lancé/);
    expect(hub.tasks.escalations(P)).toEqual([]);
    const report = notes.at(-1)!;
    expect(report).toMatch(/⚠ Chantier T-0001 « Balles lumineuses » terminé — le testeur a trouvé des problèmes/);
    expect(report).toMatch(/Avis du testeur : Le test de la scène échoue/);
    expect(report).toMatch(/Pour essayer :\n  1\. Lancez une partie avec \?seed=1/);
    expect(report).toMatch(/« ▶ Essayer »/);
  });

  it("exécution directe : pas de phase de plan, la consigne va droit au développeur, le coût est indiqué", async () => {
    const { sb, hub, fake, exec } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    exec.scripts.execute.push(async (t) => {
      await t.write("src/boss.ts", "export {};\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    fake.replies.push(BRIEF);
    const t = hub.conversations.createThread(P, "Tirs");
    await hub.conversations.send(P, t.id, "go");
    await hub.conversations.idle();
    await hub.tasks.idle();

    expect(exec.requests.map((r) => r.kind)).toEqual(["execute", "verify"]);
    expect(exec.requests[0]!.prompt).toMatch(/<consigne_du_directeur>[\s\S]*sillage 0,12 s/);
    expect(exec.requests[0]!.systemPrompt).toMatch(/réalise-la directement/);
    const [task] = hub.tasks.list(P);
    expect(task).toMatchObject({ direct: true, status: "review" });
    const events = hub.tasks.events(hub.tasks.runs(P, task!.id)[0]!.id).map((e) => e.text);
    expect(events.join("\n")).not.toMatch(/Hors plan/);
    expect(hub.conversations.messages(P, t.id).at(-1)!.text).toMatch(/Coût de ce chantier : environ 0,02 \$/);
  });
});

describe("plan avec une commande interdite", () => {
  it("la commande est retirée et le plan reste validable", async () => {
    const { sb, hub, exec } = await setup();
    exec.scripts.plan.push(() =>
      planOutput({ commands: [{ cmd: "npm test", purpose: "tests" }, { cmd: "node tests/shots/ballistics.mjs out", purpose: "captures" }] }),
    );
    const task = hub.tasks.create(sb.human(), P, { decisions: ["D-0001"] });
    await hub.tasks.startPlanning(P, task.id);
    await hub.tasks.idle();
    const plan = hub.tasks.plan(P, hub.tasks.get(P, task.id).plan!);
    expect(plan.problems).toEqual([]);
    expect(plan.commands.map((c) => c.cmd)).toEqual(["npm test"]);
    expect(plan.assumptions.join(" ")).toMatch(/Commande retirée par le gardien : « node tests\/shots\/ballistics.mjs out »/);
  });
});

describe("compteur d'utilisation", () => {
  it("lit les jetons et vos limites dans le flux de Claude Code", () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","rateLimitType":"seven_day","utilization":0.68,"resetsAt":1792418400,"unifiedWindows":{"five_hour":{"utilization":0.16,"resetsAt":1791979200},"seven_day":{"utilization":0.68,"resetsAt":1792418400}}}}',
      '{"type":"result","subtype":"success","result":"ok","total_cost_usd":0.0006,"usage":{"input_tokens":2,"cache_creation_input_tokens":2998,"cache_read_input_tokens":535,"output_tokens":4}}',
    ].join("\n");
    const { result, limits } = parseStream(stdout);
    expect(result?.result).toBe("ok");
    expect(limits?.windows.five_hour?.utilization).toBe(0.16);
    expect(limits?.windows.seven_day?.resetsAt).toBe(new Date(1792418400 * 1000).toISOString());

    const sb = sandbox();
    const usage = new UsageService(sb.hub.db, { now: () => new Date().toISOString() });
    usage.record({ project: P, agent: "director", tokens: { input: 2, output: 4, cacheRead: 535, cacheWrite: 2998 }, costUsd: 0.0006, limits });
    usage.record({ project: P, agent: "archivist", tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, costUsd: null });
    const snap = usage.snapshot();
    expect(snap.today).toMatchObject({ tokens: 3559, calls: 2 });
    expect(snap.limits?.windows.seven_day?.utilization).toBe(0.68);
    expect(snap.byAgent[0]!.agent).toBe("director");
  });
});

describe("historique compact du directeur", () => {
  it("réduit une consigne envoyée à son titre et tronque les longs comptes rendus", async () => {
    const { renderHistory } = await import("../src/conversation/prompts.ts");
    const msg = (role: "human" | "director", text: string) => ({ id: "x", thread: "t", seq: 1, role, text, at: "", extraction: "none" as const, cost_usd: null });
    const out = renderHistory([
      msg("director", "Je propose un sillage.\n\n§CONSIGNE§ Balles lumineuses\nObjectif : très long détail…"),
      msg("director", "✓ Chantier terminé. " + "x".repeat(3000)),
    ]);
    expect(out).toMatch(/\[consigne envoyée au développeur : Balles lumineuses\]/);
    expect(out).not.toMatch(/très long détail/);
    expect(out).toMatch(/x{1000} \[…\]/);
    expect(out.length).toBeLessThan(2000);
  });
});
