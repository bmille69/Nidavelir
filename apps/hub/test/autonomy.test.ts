import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHub, type Hub } from "../src/hub.ts";
import type { CheckerPort, CheckOutcome } from "../src/quality/checks.ts";
import { parseDirectives, parseDuration, parseImplement } from "../src/conversation/conversation-service.ts";
import { parseStream } from "../src/llm/claude-cli.ts";
import { UsageService } from "../src/usage/usage-service.ts";
import { FakeExecutor, planOutput, REPORT, VERIFIED } from "./fake-executor.ts";
import { extracted, FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, DIRECTOR, fakeClock, git, msg, sandbox, type Sandbox } from "./helpers.ts";

const P = "destiny";
// Plusieurs commits Git par test : plus lent que la moyenne quand toute la suite tourne en parallèle.
vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());

/** Vérificateur scripté : une réponse par appel, dans l'ordre ; note où il a vérifié (copie du chantier ou jeu). */
class FakeChecker implements CheckerPort {
  readonly calls: string[] = [];
  readonly answers: { tests: CheckOutcome[]; launch: CheckOutcome[]; replays: CheckOutcome[] } = { tests: [], launch: [], replays: [] };
  readonly gameRoot: () => string;
  constructor(gameRoot: () => string) {
    this.gameRoot = gameRoot;
  }
  #where(cwd: string) {
    return cwd === this.gameRoot() ? "jeu" : "chantier";
  }
  async tests(cwd: string) {
    this.calls.push(`tests:${this.#where(cwd)}`);
    return this.answers.tests.shift() ?? { status: "pass" as const, detail: "ok" };
  }
  /** Vos parties rejouées (ADR-85) : notées seulement quand le test en prévoit. */
  async replays(cwd: string) {
    if (!this.answers.replays.length) return { status: "none" as const, detail: "aucune partie gardée comme test" };
    this.calls.push(`replays:${this.#where(cwd)}`);
    return this.answers.replays.shift()!;
  }
  async launch(_key: string, cwd: string, screenshot?: string) {
    this.calls.push(`launch:${this.#where(cwd)}`);
    if (screenshot) writeFileSync(screenshot, "PNG");
    return { ...(this.answers.launch.shift() ?? { status: "pass" as const, detail: "ok" }), screenshot: screenshot ?? null };
  }
}

/** Attend que tout soit retombé : discussions, chantiers, et ce qu'ils déclenchent les uns chez les autres. */
async function settle(hub: Hub) {
  for (let k = 0; k < 6; k++) {
    await hub.conversations.idle();
    await hub.tasks.idle();
    await hub.autopilot?.idle();
    await hub.gameState.idle();
    await hub.conceptions.idle();
  }
}

/** Hub avec pilote automatique (délai nul) et exécuteur factice. */
async function setup(checker?: CheckerPort) {
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
    checker,
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
      request: { title: "Balles lumineuses", goal: "Ajouter un sillage aux balles", decisions: ["D-0026", "D-0029"], reworks: [] },
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
    const failed = { ...VERIFIED, verdict: "fail", summary_simple: "Le test de la scène échoue (polices bloquées).", checks: [{ criterion: "La scène se lance", result: "fail", evidence: "polices bloquées" }] };
    exec.scripts.verify.push(() => failed);
    // Deux corrections automatiques d'après le testeur, qui refuse encore : le chantier attend votre avis.
    for (const v of ["v2", "v3"]) {
      exec.scripts.execute.push(async (t) => {
        await t.write("src/boss.ts", `export const balles = 'lumineuses ${v}';\n`);
        return { ...REPORT, how_to_test: ["Lancez une partie avec ?seed=1", "Tirez au fusil auto : les balles laissent un sillage"] };
      });
      exec.scripts.verify.push(() => failed);
    }
    fake.replies.push(BRIEF);
    const t = hub.conversations.createThread(P, "Tirs");
    const { human, director } = await hub.conversations.send(P, t.id, "Les balles du perso font cheap. go");
    await settle(hub);

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
    expect(notes[1]).toMatch(/↻ Chantier T-0001 « Balles lumineuses » : le testeur a trouvé des problèmes .* Le développeur corrige/);
    expect(exec.requests.map((r) => r.kind)).toEqual(["execute", "verify", "execute", "verify", "execute", "verify"]);
    expect(exec.requests[2]!.prompt).toMatch(/Le testeur a relevé : Le test de la scène échoue[\s\S]*La scène se lance : polices bloquées/);
    expect(hub.tasks.escalations(P)).toEqual([]);
    const report = notes.at(-1)!;
    expect(report).toMatch(/⚠ Chantier T-0001 « Balles lumineuses » terminé — le testeur a trouvé des problèmes/);
    expect(report).toMatch(/Avis du testeur : Le test de la scène échoue/);
    expect(report).toMatch(/Pour essayer :\n  1\. Lancez une partie avec \?seed=1/);
    expect(report).toMatch(/Il attend votre avis : essayez-le \(« ▶ Essayer » à droite\), puis dites-moi ici « fusionne »/);
    expect(hub.tasks.get(P, "T-0001").status).toBe("review");

    // Votre « fusionne » dans la discussion suffit : le directeur voit le chantier et le fait fusionner.
    fake.replies.push("Je fusionne.\n[[FUSIONNER: T-0001]]");
    await hub.conversations.send(P, t.id, "c'est bon, fusionne");
    await settle(hub);
    expect(fake.calls.filter((c) => c.kind === "reply").at(-1)!.systemPrompt).toMatch(/<chantiers>\n- T-0001 « Balles lumineuses » : à relire : attend le directeur créatif/);
    expect(hub.tasks.get(P, "T-0001").status).toBe("merged");
    expect(hub.conversations.messages(P, t.id).at(-1)!.text).toBe("✓ T-0001 fusionné dans votre jeu.");
    expect(git(hub.projects.get(P).root, "show", "HEAD:src/boss.ts")).toMatch(/lumineuses v3/);
    // La qualité distingue la correction d'office (testeur) d'une intervention de votre part.
    expect((await hub.quality.report(P)).chantiers[0]).toMatchObject({ first_try: false, corrections: 2, interventions: 0 });
  });

  it("exécution directe : pas de phase de plan, la consigne va droit au développeur, fusion dès que le testeur valide", async () => {
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
    await settle(hub);

    expect(exec.requests.map((r) => r.kind)).toEqual(["execute", "verify"]);
    expect(exec.requests[0]!.prompt).toMatch(/<consigne_du_directeur>[\s\S]*sillage 0,12 s/);
    expect(exec.requests[0]!.systemPrompt).toMatch(/réalise-la directement/);
    const [task] = hub.tasks.list(P);
    expect(task).toMatchObject({ direct: true, status: "merged" });
    const events = hub.tasks.events(hub.tasks.runs(P, task!.id)[0]!.id).map((e) => e.text);
    expect(events.join("\n")).not.toMatch(/Hors plan/);
    const messages = hub.conversations.messages(P, t.id);
    const report = messages.at(-1)!.text;
    expect(report).toMatch(/✓ Chantier T-0001 « Balles lumineuses » terminé, vérifié par le testeur et fusionné dans votre jeu\./);
    expect(report).toMatch(/Coût de ce chantier : environ 0,02 \$/);
    // Un seul compte rendu : pas de second message « fusionné ».
    expect(messages.filter((m) => /fusionné/.test(m.text))).toHaveLength(1);
    expect(git(hub.projects.get(P).root, "show", "HEAD:src/boss.ts")).toBe("export {};\n");
    const approval = hub.db.prepare("SELECT session, note FROM approvals WHERE subject_kind = 'merge'").get() as { session: string; note: string };
    expect(approval).toMatchObject({ note: "Validé par le testeur" });
    expect(approval.session).toMatch(/workshop$/);
  });

  it("deux chantiers d'un coup : le second attend son tour et part du jeu qui contient le premier", async () => {
    const { sb, hub, fake, exec } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    exec.scripts.execute.push(async (t) => {
      await t.write("src/grille.ts", "export const taille = 10;\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    exec.scripts.execute.push(async (t, req) => {
      // Le premier chantier est déjà dans la copie du second : plus de conflit à la fusion (incident T-0013).
      expect(existsSync(join(req.cwd, "src/grille.ts"))).toBe(true);
      await t.write("src/grille.ts", "export const taille = 12;\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    fake.replies.push("Deux étapes.\n[[CHANTIER: Grille]]\nObjectif : une grille.\n[[/CHANTIER]]\n[[CHANTIER: Grille plus grande]]\nObjectif : 12 cases.\n[[/CHANTIER]]");
    const t = hub.conversations.createThread(P, "Règles");
    const { director } = await hub.conversations.send(P, t.id, "go");
    expect(director.text.match(/§CONSIGNE§/g)).toHaveLength(2);
    await settle(hub);

    const launch = hub.conversations.messages(P, t.id)[2]!.text;
    expect(launch).toMatch(/→ Chantier T-0001 « Grille » lancé/);
    expect(launch).toMatch(/⏳ Chantier T-0002 « Grille plus grande » en attente : il partira tout seul après T-0001\./);
    const [second, first] = hub.tasks.list(P);
    expect([first!.status, second!.status]).toEqual(["merged", "merged"]);
    expect(second!.base_commit).not.toBe(first!.base_commit);
    expect(git(hub.projects.get(P).root, "show", "HEAD:src/grille.ts")).toBe("export const taille = 12;\n");
  });

  it("ADR-41 : un chantier « (gros) » est signalé au développeur, et la file attend quand l'abonnement est presque épuisé", async () => {
    const { sb, hub, fake, exec } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    exec.scripts.execute.push(async (t) => {
      await t.write("src/grille.ts", "export const taille = 10;\n");
      // Claude Code rapporte une fenêtre de 5 heures presque pleine pendant ce chantier.
      hub.usage.record({ agent: "developer", tokens: null, costUsd: null, limits: { status: "allowed", windows: { five_hour: { utilization: 0.9, resetsAt: "2026-10-13T14:00:00.000Z" } } } });
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    fake.replies.push("Deux étapes.\n[[CHANTIER: Grille (gros)]]\nObjectif : une grille.\n[[/CHANTIER]]\n[[CHANTIER: Grille plus grande]]\nObjectif : 12 cases.\n[[/CHANTIER]]");
    const t = hub.conversations.createThread(P, "Règles");
    await hub.conversations.send(P, t.id, "go");
    await settle(hub);

    expect(exec.requests.map((r) => [r.kind, r.big])).toEqual([
      ["execute", true],
      ["verify", true],
    ]);
    const [second, first] = hub.tasks.list(P);
    expect(first!.status).toBe("merged");
    expect(second).toMatchObject({ status: "draft", queued_at: expect.any(String) });
    expect(hub.journal.list({ subject: second!.id, latest: true }).find((e) => e.type === "queue.paused")).toMatchObject({ payload: { until: "2026-10-13T14:00:00.000Z", window: "five_hour" } });
  });

  it("ADR-83 : un jeu Godot créé avant une mise à jour du relais la reçoit avant son prochain chantier", async () => {
    const { sb, hub, fake, exec } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    const root = hub.projects.get(P).root;
    writeFileSync(join(root, "project.godot"), `config_version=5\n\n[autoload]\n\nStudioBridge="*res://addons/studio_bridge/bridge.gd"\n`);
    mkdirSync(join(root, "addons", "studio_bridge"), { recursive: true });
    writeFileSync(join(root, "addons", "studio_bridge", "bridge.gd"), "extends Node\nconst VERSION := 1\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "godot");
    exec.scripts.execute.push(async (t) => {
      await t.write("src/a.ts", "export {};\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    fake.replies.push("[[CHANTIER: Un]]\nObjectif : un.\n[[/CHANTIER]]");
    await hub.conversations.send(P, hub.conversations.createThread(P, "x").id, "go");
    await settle(hub);
    const bridge = readFileSync(join(root, "addons", "studio_bridge", "bridge.gd"), "utf8");
    expect(bridge).toMatch(/const VERSION := \d+[\s\S]*"perf":/);
    expect(bridge).toBe(readFileSync(join(process.cwd(), "apps", "hub", "src", "godot", "addons", "studio_bridge", "bridge.gd"), "utf8"));
    expect(existsSync(join(root, "addons", "studio_tests", "run.gd"))).toBe(true);
    expect(git(root, "log", "--format=%s")).toMatch(/outils du studio Godot mis à jour/);
    expect(git(root, "status", "--porcelain", "--", "addons")).toBe("");
  });

  it("ADR-77 : un chantier de la file échoue, les suivants l'attendent ; un jeu Godot n'importe pas studio/", async () => {
    const { sb, hub, fake, exec } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    const root = hub.projects.get(P).root;
    writeFileSync(join(root, "project.godot"), "config_version=5\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "godot");
    exec.scripts.execute.push(async (t) => {
      // Écrits par un outil (Godot) hors du contrôle des outils de l'agent. Un .import du DA : effacé sans faute.
      mkdirSync(join(t.req.cwd, "studio", "art", "choix"), { recursive: true });
      writeFileSync(join(t.req.cwd, "studio", "art", "choix", "m1.png.import"), "[remap]\n");
      await t.write("src/degats.ts", "export const pv = 10;\n");
      // Autre chose dans studio/ : le chantier échoue.
      writeFileSync(join(t.req.cwd, "studio", "BRIEF.md"), "réécrit\n");
      return REPORT;
    });
    fake.replies.push("Deux étapes.\n[[CHANTIER: Dégâts]]\nObjectif : des dégâts.\n[[/CHANTIER]]\n[[CHANTIER: Carabine]]\nObjectif : une carabine qui fait des dégâts.\n[[/CHANTIER]]");
    const t = hub.conversations.createThread(P, "Combat");
    await hub.conversations.send(P, t.id, "go");
    await settle(hub);

    const [second, first] = hub.tasks.list(P);
    expect(first!.status).toBe("failed");
    expect(exec.requests.filter((r) => r.kind === "execute")).toHaveLength(1);
    expect(second).toMatchObject({ status: "draft", queued_at: null });
    expect(hub.tasks.runs(P, first!.id).at(-1)!.error).toMatch(/interdites détectées : studio\/BRIEF\.md$/);
    expect(hub.conversations.messages(P, t.id).at(-1)!.text).toMatch(new RegExp(`⏸ La file s'arrête là : ${second!.id} s'appuient`));
    expect(git(root, "log", "-1", "--format=%s", "--", "studio/.gdignore")).toMatch(/Godot n'importe pas le dossier du studio/);

    // Relancer le chantier en échec puis celui qui attendait : il repart de zéro, sur la version actuelle du jeu.
    for (const file of ["src/degats.ts", "src/carabine.ts"]) {
      exec.scripts.execute.push(async (x) => {
        await x.write(file, "export {};\n");
        return REPORT;
      });
      exec.scripts.verify.push(() => VERIFIED);
    }
    fake.replies.push(`Je relance.\n[[LANCER: ${first!.id}, ${second!.id}]]`);
    await hub.conversations.send(P, t.id, `relance ${first!.id} et enchaîne`);
    await settle(hub);
    expect(hub.tasks.get(P, first!.id).status).toBe("merged");
    expect(hub.tasks.get(P, second!.id).status).toBe("merged");
    expect(existsSync(join(root, "src", "carabine.ts"))).toBe(true);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("vos corrections dites dans la discussion repartent au développeur, dans la même copie", async () => {
    const { sb, hub, fake, exec } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    for (const v of ["1", "2", "2.5"]) {
      exec.scripts.execute.push(async (t) => {
        await t.write("src/boss.ts", `export const v = ${v};\n`);
        return REPORT;
      });
      exec.scripts.verify.push(() => ({ ...VERIFIED, verdict: "fail" }));
    }
    exec.scripts.execute.push(async (t) => {
      await t.write("src/boss.ts", "export const v = 3;\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    fake.replies.push(BRIEF, "Je transmets.\n[[CORRIGER: T-0001]]\nLe sillage doit durer 0,2 s.\n[[/CORRIGER]]");
    const t = hub.conversations.createThread(P, "Tirs");
    await hub.conversations.send(P, t.id, "go");
    await settle(hub);
    expect(hub.tasks.get(P, "T-0001").status).toBe("review");
    await hub.conversations.send(P, t.id, "le sillage doit durer 0,2 s");
    await settle(hub);

    expect(exec.requests.at(-2)!.prompt).toMatch(/Le sillage doit durer 0,2 s/);
    expect(hub.tasks.get(P, "T-0001").status).toBe("merged");
    expect(hub.conversations.messages(P, t.id).map((m) => m.text).join("\n")).toMatch(/↻ T-0001 : le développeur corrige selon vos remarques/);
    expect((await hub.quality.report(P)).chantiers[0]).toMatchObject({ corrections: 3, interventions: 1 });
  });

  it("séance autonome : le directeur planifie, le hub enchaîne et lui redonne la main, puis bilan", async () => {
    const { sb, hub, fake, exec } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    for (const name of ["a", "b"]) {
      exec.scripts.execute.push(async (t) => {
        await t.write(`src/${name}.ts`, "export {};\n");
        return REPORT;
      });
      exec.scripts.verify.push(() => VERIFIED);
    }
    fake.replies.push(
      "Plan de séance : le bot d'abord.\n[[SEANCE: 2h | Bot jouable]]\n[[CHANTIER: Bot qui joue]]\nObjectif : un bot.\n[[/CHANTIER]]",
      "Suite logique.\n[[CHANTIER: Bot qui vise]]\nObjectif : il vise.\n[[/CHANTIER]]",
      "Objectif atteint : le bot joue et vise. [[FIN_SEANCE]]",
    );
    const t = hub.conversations.createThread(P, "Séance");
    await hub.conversations.send(P, t.id, "bosse en autonomie 2h sur le bot");
    expect(hub.autopilot!.session(P)).toMatchObject({ goal: "Bot jouable" });
    await settle(hub);

    const texts = hub.conversations.messages(P, t.id).map((m) => m.text);
    expect(texts[2]).toMatch(/^▶ Séance autonome jusqu'à \d\dh\d\d : Bot jouable\./);
    // Le hub redonne la main au directeur avec le bilan, sans message de votre part.
    const hubTurns = fake.calls.filter((c) => c.prompt.includes("<hub>"));
    expect(hubTurns).toHaveLength(2);
    expect(hubTurns[0]!.prompt).toMatch(/Point d'étape de la séance autonome « Bot jouable »[\s\S]*T-0001 « Bot qui joue » : ✓ fusionné/);
    expect(hubTurns[0]!.systemPrompt).toMatch(/<seance objectif="Bot jouable"/);
    expect(texts.filter((x) => /^Objectif atteint/.test(x))).toHaveLength(1);
    const bilan = texts.at(-1)!;
    expect(bilan).toMatch(/■ Fin de la séance « Bot jouable » \(objectif atteint ou choix à faire\), après \d+ min : 2 chantier\(s\) fusionné\(s\) sur 2\./);
    expect(bilan).toMatch(/T-0002 « Bot qui vise » : ✓ fusionné/);
    expect(hub.autopilot!.session(P)).toBeNull();
    expect(hub.tasks.list(P).map((x) => x.status)).toEqual(["merged", "merged"]);
  });
});

describe("balises du directeur en atelier", () => {
  it("lit chantiers, séance, fusion, abandon, lancement et corrections", () => {
    const { text, directives } = parseDirectives(
      [
        "Voilà le plan.",
        "[[SEANCE: 1h30 | IA du bot]]",
        "[[CHANTIER: A]]\nObjectif : a.\n[[/CHANTIER]]",
        "[[CHANTIER: B]]\nObjectif : b.\n[[/CHANTIER]]",
        "[[FUSIONNER: T-0004]] [[ABANDONNER: T-0005]] [[LANCER: T-0006, T-0007]]",
        "[[CORRIGER: T-0008]]\nPlus rapide.\n[[/CORRIGER]]",
      ].join("\n"),
    );
    expect(text).toBe("Voilà le plan.");
    expect(directives).toMatchObject({
      session: { minutes: 90, goal: "IA du bot" },
      merge: ["T-0004"],
      abandon: ["T-0005"],
      launch: ["T-0006", "T-0007"],
      fixes: [{ task: "T-0008", note: "Plus rapide." }],
      endSession: false,
    });
    expect(directives.requests.map((r) => r.title)).toEqual(["A", "B"]);
    expect(parseDirectives("Fini. [[FIN_SEANCE]]").directives.endSession).toBe(true);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("45 min")).toBe(45);
    expect(parseDuration("12h")).toBe(480);
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

describe("tableau Qualité", () => {
  it("réussite, premier coup, coût par fusionné, interventions et votre avis", async () => {
    const { sb, hub, fake, exec } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    const brief = (title: string) => `Proposition.\n[[CHANTIER: ${title}]]\nObjectif : ${title}.\n[[/CHANTIER]]`;
    // Le premier passe le testeur (fusionné tout seul) ; le second échoue deux fois et attend.
    for (const [name, verdict] of [["a.ts", "pass"], ["b.ts", "fail"], ["b.ts", "fail"]] as const) {
      exec.scripts.execute.push(async (t) => {
        await t.write(`src/${name}`, `export const v = "${verdict}${exec.requests.length}";\n`);
        return REPORT;
      });
      exec.scripts.verify.push(() => ({ ...VERIFIED, verdict }));
    }
    fake.replies.push(brief("Premier"), brief("Second"));
    const t = hub.conversations.createThread(P, "x");
    await hub.conversations.send(P, t.id, "go");
    await settle(hub);
    const first = hub.tasks.list(P).find((x) => x.title === "Premier")!;
    expect(first.status).toBe("merged");
    hub.quality.rate(sb.human(), P, first.id, "up", "exactement ça");

    await hub.conversations.send(P, t.id, "go");
    await settle(hub);
    const second = hub.tasks.list(P).find((x) => x.title === "Second")!;
    await hub.tasks.abandon(sb.human(), P, second.id);

    const draft = hub.tasks.create(sb.human(), P, { decisions: ["D-0001"] });
    expect(() => hub.quality.rate(sb.human(), P, draft.id, "down")).toThrow(/terminé/);

    const { overall, weeks, chantiers } = await hub.quality.report(P);
    expect(overall).toMatchObject({ launched: 2, merged: 1, abandoned: 1, first_try: 1, success_rate: 0.5, first_try_rate: 0.5, up: 1, down: 0 });
    // Le chantier abandonné compte aussi : (2 + 4 étapes) × 0,01 $ pour 1 fusionné.
    expect(overall.cost_per_merged).toBeCloseTo(0.06, 5);
    expect(overall.interventions_per_chantier).toBe(0);
    expect(weeks).toHaveLength(1);
    expect(chantiers.find((c) => c.id === first.id)).toMatchObject({ first_try: true, rating: { rating: "up", note: "exactement ça" }, qa: "pass" });
  });
});

describe("qualité fiable (ADR-32)", () => {
  const brief = (title: string, extra = "") => `Proposition.\n[[CHANTIER: ${title}${extra}]]\nObjectif : ${title}.\n[[/CHANTIER]]`;
  const work = (exec: FakeExecutor, file: string, verdicts: ("pass" | "fail")[] = ["pass"]) => {
    for (const verdict of verdicts) {
      exec.scripts.execute.push(async (t) => {
        await t.write(`src/${file}`, `export const n = ${exec.requests.length};\n`);
        return REPORT;
      });
      exec.scripts.verify.push(() => ({ ...VERIFIED, verdict }));
    }
  };

  it("le testeur valide mais les tests du jeu ne passent plus : pas de fusion, le développeur corrige", async () => {
    let root = "";
    const checker = new FakeChecker(() => root);
    const { sb, hub, fake, exec } = await setup(checker);
    root = hub.projects.get(P).root;
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    work(exec, "a.ts", ["pass", "pass"]);
    let screenshotRead: unknown = null;
    exec.scripts.verify[0] = async (_t, req) => {
      screenshotRead = await req.bridge.preTool("Read", { file_path: hub.checks!.screenshotPath(P, "T-0001") });
      return VERIFIED;
    };
    // 1er passage : tests cassés dans la copie, alors qu'ils passent sur le jeu actuel → régression.
    checker.answers.tests.push({ status: "fail", detail: "1 test failed: grille.test.ts" }, { status: "pass", detail: "ok" });
    fake.replies.push(brief("Grille"));
    const t = hub.conversations.createThread(P, "x");
    await hub.conversations.send(P, t.id, "go");
    await settle(hub);

    expect(checker.calls).toEqual(["tests:chantier", "launch:chantier", "tests:jeu", "tests:chantier", "launch:chantier"]);
    // Le testeur reçoit les faits mesurés et la capture du jeu (ADR-33).
    const shot = hub.checks!.screenshotPath(P, "T-0001");
    expect(exec.requests[1]!.prompt).toMatch(/<verifications_du_hub[\s\S]*Tests du jeu \(npm test\) : ÉCHEC \(ça marchait avant ce chantier : RÉGRESSION\)/);
    expect(exec.requests[1]!.prompt).toContain(`<capture_du_jeu>\nLe hub a lancé le jeu de cette copie et pris une capture de l'écran après quelques secondes : ${shot}`);
    // La capture est lisible par le testeur, hors de sa copie de travail.
    expect(screenshotRead).toMatchObject({ decision: "allow" });
    expect(exec.requests[2]!.prompt).toMatch(/Le hub a vérifié ton travail lui-même[\s\S]*1 test failed: grille.test.ts/);
    const texts = hub.conversations.messages(P, t.id).map((m) => m.text);
    expect(texts.join("\n")).toMatch(/le testeur était d'accord, mais le hub a vérifié lui-même/);
    expect(texts.at(-1)).toMatch(/fusionné dans votre jeu[\s\S]*Vérifié par le hub : tests du jeu ✓, le jeu se lance ✓\.\n\n§CAPTURE§ T-0001 \S+\n/);
    expect(hub.tasks.get(P, "T-0001").status).toBe("merged");

    const { overall, chantiers } = await hub.quality.report(P);
    expect(chantiers[0]).toMatchObject({ tester_missed: true, held: true, checks: { tests: "pass", launch: "pass", regression: false } });
    expect(overall).toMatchObject({ tests_checked: 1, tests_ok: 1, launch_checked: 1, launch_ok: 1, tester_judged: 1, tester_right: 0, tester_rate: 0 });
  });

  it("des tests déjà cassés avant le chantier ne bloquent pas la fusion", async () => {
    let root = "";
    const checker = new FakeChecker(() => root);
    const { sb, hub, fake, exec } = await setup(checker);
    root = hub.projects.get(P).root;
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    work(exec, "a.ts");
    checker.answers.tests.push({ status: "fail", detail: "x" }, { status: "fail", detail: "x" });
    fake.replies.push(brief("Grille"));
    const t = hub.conversations.createThread(P, "x");
    await hub.conversations.send(P, t.id, "go");
    await settle(hub);
    expect(hub.tasks.get(P, "T-0001").status).toBe("merged");
    expect(hub.conversations.messages(P, t.id).at(-1)!.text).toMatch(/tests du jeu ✗ \(déjà le cas avant ce chantier\), le jeu se lance ✓/);
  });

  it("budget de performance (ADR-83) : un chantier qui ralentit le jeu est corrigé ; un écart dû à la machine ne bloque pas", async () => {
    let root = "";
    const checker = new FakeChecker(() => root);
    const { sb, hub, fake, exec } = await setup(checker);
    root = hub.projects.get(P).root;
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    const perf = (fps: number, draw_calls = 200) => ({ fps, frame_ms_avg: 1000 / fps, frame_ms_p95: 1200 / fps, frame_ms_max: 2000 / fps, draw_calls, primitives: 80_000, objects: 120, video_mem_mb: 300, static_mem_mb: 90, nodes: 400, scene: "res://scenes/main.tscn", seconds: 3, frames: fps * 3 });
    const ran = (fps: number, draw = 200) => ({ status: "pass" as const, detail: "ok", perf: perf(fps, draw) });
    const t = hub.conversations.createThread(P, "x");

    // 1er chantier : la mesure de référence (200 images/s).
    work(exec, "a.ts");
    checker.answers.launch.push(ran(200));
    fake.replies.push(brief("Décor"));
    await hub.conversations.send(P, t.id, "go");
    await settle(hub);
    expect(hub.tasks.get(P, "T-0001").status).toBe("merged");
    expect(hub.conversations.messages(P, t.id).at(-1)!.text).toMatch(/performances ✓ \(200 images\/s\)/);

    // 2e chantier : 110 images/s et deux fois plus d'appels de dessin ; le jeu actuel, remesuré, fait 195 → régression.
    work(exec, "b.ts", ["pass", "pass"]);
    checker.answers.launch.push(ran(110, 450), ran(195), ran(190));
    fake.replies.push(brief("Forêt"));
    checker.calls.length = 0;
    await hub.conversations.send(P, t.id, "go");
    await settle(hub);
    expect(checker.calls).toEqual(["tests:chantier", "launch:chantier", "launch:jeu", "tests:chantier", "launch:chantier"]);
    const fix = exec.requests.find((r) => /devenu trop lent/.test(r.prompt))!;
    expect(fix.prompt).toMatch(/195 → 110 images\/s \(−44 %\) ; appels de dessin 200 → 450/);
    expect(hub.tasks.get(P, "T-0002").status).toBe("merged");
    expect(hub.checks!.get(P, "T-0002")!.perf).toMatchObject({ status: "pass", regression: false });

    // 3e chantier : 120 images/s, mais le jeu actuel aussi (machine occupée) : rien à corriger.
    work(exec, "c.ts");
    checker.answers.launch.push(ran(120), ran(118));
    fake.replies.push(brief("Pluie"));
    await hub.conversations.send(P, t.id, "go");
    await settle(hub);
    expect(hub.tasks.get(P, "T-0003").status).toBe("merged");
    expect(hub.checks!.get(P, "T-0003")!.perf).toMatchObject({ status: "pass", regression: false, detail: expect.stringMatching(/l'écart venait de la machine/) });
  });

  it("vos parties rejouées (ADR-85) : une partie qui diverge dans la copie, mais pas dans le jeu, fait corriger le chantier", async () => {
    let root = "";
    const checker = new FakeChecker(() => root);
    const { sb, hub, fake, exec } = await setup(checker);
    root = hub.projects.get(P).root;
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    work(exec, "a.ts", ["pass", "pass"]);
    checker.answers.replays.push(
      { status: "fail", detail: "0/1 partie(s) rejouée(s) à l'identique\n✗ « Vague 2 » : à 12 s, l'état du jeu était {\"or\":40} quand vous avez joué, et {\"or\":25} en rejouant la même partie (ce que vous vérifiiez : la prime de vague)" },
      { status: "pass", detail: "1/1" },
      { status: "pass", detail: "1/1 partie(s) rejouée(s) à l'identique" },
    );
    fake.replies.push(brief("Économie"));
    const t = hub.conversations.createThread(P, "x");
    await hub.conversations.send(P, t.id, "go");
    await settle(hub);
    expect(checker.calls).toEqual(["tests:chantier", "launch:chantier", "replays:chantier", "replays:jeu", "tests:chantier", "launch:chantier", "replays:chantier"]);
    expect(exec.requests[1]!.prompt).toMatch(/Les parties du directeur créatif, rejouées à l'identique : ÉCHEC \(ça marchait avant ce chantier : RÉGRESSION\)/);
    expect(exec.requests[2]!.prompt).toMatch(/Une partie que le directeur créatif a jouée puis gardée comme test ne se rejoue plus à l'identique[\s\S]*la prime de vague/);
    expect(hub.tasks.get(P, "T-0001").status).toBe("merged");
    expect(hub.conversations.messages(P, t.id).at(-1)!.text).toMatch(/vos parties rejouées ✓/);
  });

  it("un chantier repris ou annulé ne compte plus comme réussi, et le testeur est noté en conséquence", async () => {
    const { sb, hub, fake, exec } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    work(exec, "a.ts");
    work(exec, "b.ts");
    work(exec, "c.ts");
    fake.replies.push(brief("Tirs"), "Je reprends.\n" + brief("Tirs, la fuite", " | reprend T-0001, T-0099"), brief("Sons"));
    const t = hub.conversations.createThread(P, "x");
    for (let k = 0; k < 3; k++) {
      await hub.conversations.send(P, t.id, "go");
      await settle(hub);
    }
    // Le directeur voit les chantiers fusionnés, pour pouvoir dire lequel il reprend.
    expect(fake.calls.filter((c) => c.kind === "reply")[1]!.systemPrompt).toMatch(/- T-0001 « Tirs » : fusionné/);
    expect(hub.tasks.get(P, "T-0002").reworks).toEqual(["T-0001"]);

    // Vous annulez le 3e avec Git.
    const root = hub.projects.get(P).root;
    const merge = git(root, "log", "-n", "1", "--format=%H").trim();
    git(root, "revert", "--no-edit", "-m", "1", merge);

    const { overall, chantiers } = await hub.quality.report(P);
    const row = (id: string) => chantiers.find((c) => c.id === id)!;
    expect(row("T-0001")).toMatchObject({ held: false, first_try: false, reworked_by: ["T-0002"], reverted: false });
    expect(row("T-0003")).toMatchObject({ held: false, reverted: true });
    expect(row("T-0002")).toMatchObject({ held: true, first_try: true });
    expect(overall).toMatchObject({ merged: 3, held: 1, reworked: 2, tester_judged: 3, tester_right: 1 });
    expect(overall.success_rate).toBeCloseTo(1 / 3, 5);
  });
});

describe("état du jeu (ADR-33)", () => {
  it("réécrit après chaque fusion, puis donné au directeur et au développeur", async () => {
    const { sb, hub, fake, exec } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    for (const f of ["a.ts", "b.ts"]) {
      exec.scripts.execute.push(async (t) => {
        await t.write(`src/${f}`, "export {};\n");
        return REPORT;
      });
      exec.scripts.verify.push(() => VERIFIED);
    }
    fake.replies.push("Ok.\n[[CHANTIER: Grille]]\nObjectif : une grille 10×10.\n[[/CHANTIER]]", "Ensuite.\n[[CHANTIER: Flotte]]\nObjectif : 5 navires.\n[[/CHANTIER]]");
    fake.extractions.push({ etat: "## Ce qui existe\n- Grille de 10×10 cases.\n## Choix déjà faits\n- Le rendu ne touche pas aux règles." } as never);
    const t = hub.conversations.createThread(P, "x");
    await hub.conversations.send(P, t.id, "go");
    await settle(hub);

    // Le carnet part du chantier fusionné : consigne et rapport.
    const update = fake.calls.find((c) => c.kind === "structured")!;
    expect(update.systemPrompt).toMatch(/Tu tiens le carnet « État du jeu »/);
    expect(update.prompt).toMatch(/<carnet_actuel>\n\(vide : premier carnet\)[\s\S]*<chantier_qui_vient_d_entrer>\nTitre : Grille\nConsigne : Objectif : une grille 10×10\.[\s\S]*Rapport du développeur : Les boss ont maintenant/);
    expect(hub.gameState.get(P)).toMatchObject({ task: "T-0001", text: expect.stringMatching(/^## Ce qui existe\n- Grille de 10×10 cases\./) });

    await hub.conversations.send(P, t.id, "la flotte maintenant, go");
    await settle(hub);
    expect(fake.calls.filter((c) => c.kind === "reply")[1]!.systemPrompt).toMatch(/<etat_du_jeu [^>]*>\n## Ce qui existe\n- Grille de 10×10 cases\./);
    expect(exec.requests.find((r) => r.kind === "execute" && r.prompt.includes("Flotte"))!.systemPrompt).toMatch(/<etat_du_jeu [^>]*>\n## Ce qui existe/);
    // Le 2e carnet repart du premier ; un échec (ici, pas de réponse valable) garde l'ancien.
    expect(fake.calls.filter((c) => c.kind === "structured")[1]!.prompt).toMatch(/<carnet_actuel>\n## Ce qui existe\n- Grille de 10×10/);
    expect(hub.gameState.get(P)!.task).toBe("T-0001");
  });
});

describe("Concepteur, directeur et développeur se passent la main (ADR-34)", () => {
  const conceptTurn = (over: Record<string, unknown> = {}) => ({
    reply: "Voici le dossier du système de craft.",
    questions: [],
    title: "Système de craft",
    engine: "",
    dossier: "# Système de craft\n## En une phrase\nFabriquer ses armes avec les débris des boss.",
    chantiers: [
      { title: "Recettes", goal: "Objectif : un fichier de recettes et ses tests." },
      { title: "Établi", goal: "Objectif : l'écran d'établi qui utilise les recettes." },
    ],
    ready: true,
    claude_md: "",
    sources: [],
    transmettre: false,
    ...over,
  });
  const twoChantiers = (exec: FakeExecutor) => {
    for (const f of ["recettes.ts", "etabli.ts"]) {
      exec.scripts.execute.push(async (t) => {
        await t.write(`src/${f}`, "export {};\n");
        return REPORT;
      });
      exec.scripts.verify.push(() => VERIFIED);
    }
  };

  it("« transmets » au Concepteur : dossier dans le jeu, chantiers en file, consigne complète au développeur", async () => {
    const { sb, hub, fake, exec } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    twoChantiers(exec);
    fake.extractions.push(() => conceptTurn({ transmettre: true }) as never);
    const c = hub.conceptions.start(sb.human(), { kind: "feature", project: P, idea: "un système de craft" });
    await settle(hub);

    // Le Concepteur voyait l'état du projet (chantiers, séance…) comme le directeur.
    expect(fake.calls.find((x) => x.kind === "structured")!.systemPrompt).toMatch(/<chantiers>/);
    const last = hub.conceptions.messages(c.id).at(-1)!.text;
    expect(last).toMatch(/^✓ C'est transmis à l'équipe : 2 chantier\(s\) \(T-0001, T-0002\)\./);
    expect(last).toMatch(/Suivez-les dans la discussion du projet : #\/p\/destiny\/t\/[\w-]+/);
    expect(hub.conceptions.get(c.id).status).toBe("done");
    const root = hub.projects.get(P).root;
    expect(git(root, "show", "HEAD~2:studio/conceptions/systeme-de-craft.md")).toMatch(/débris des boss/);
    // Un par un, dans l'ordre, sans copier-coller : la consigne complète et le chemin du dossier.
    expect(exec.requests.filter((r) => r.kind === "execute").map((r) => /<consigne_du_directeur>\n(T-\d+)/.exec(r.prompt)![1])).toEqual(["T-0001", "T-0002"]);
    expect(exec.requests[0]!.prompt).toMatch(/Objectif : un fichier de recettes et ses tests\.\n\nDossier de conception complet : studio\/conceptions\/systeme-de-craft\.md/);
    expect(hub.tasks.list(P).map((t) => t.status)).toEqual(["merged", "merged"]);
  });

  it("pas prêt : le Concepteur le dit, rien n'est créé", async () => {
    const { sb, hub, fake } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    fake.extractions.push(() => conceptTurn({ ready: false, transmettre: true }) as never);
    const c = hub.conceptions.start(sb.human(), { kind: "feature", project: P, idea: "un système de craft" });
    await settle(hub);
    expect(hub.conceptions.messages(c.id).at(-1)!.text).toMatch(/Je ne peux pas encore transmettre/);
    expect(hub.conceptions.get(c.id).status).toBe("open");
    expect(hub.tasks.list(P)).toEqual([]);
  });

  it("le directeur confie une grosse demande au Concepteur ; les chantiers reviennent dans la discussion", async () => {
    const { sb, hub, fake, exec } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    twoChantiers(exec);
    fake.replies.push("C'est un gros sujet : je le confie au Concepteur.\n[[CONCEVOIR]]\nUn système de craft à partir des débris des boss. Le directeur créatif veut que ça reste simple.\n[[/CONCEVOIR]]");
    fake.extractions.push(() => conceptTurn({ ready: false, questions: [{ question: "Combien de recettes ?", why: "Périmètre", options: [{ label: "5", detail: "" }, { label: "10", detail: "" }], recommended: "5" }] }) as never);
    const t = hub.conversations.createThread(P, "Craft");
    const { director } = await hub.conversations.send(P, t.id, "je veux un système de craft complet");
    await settle(hub);

    expect(director.text).toBe("C'est un gros sujet : je le confie au Concepteur.");
    const [c] = hub.conceptions.list();
    expect(c).toMatchObject({ kind: "feature", project: P, data: { thread: t.id } });
    expect(hub.conceptions.messages(c!.id)[0]!.text).toMatch(/^\(Demande transmise par le directeur, depuis votre discussion\)\n\nUn système de craft à partir des débris/);
    expect(hub.conversations.messages(P, t.id).at(-1)!.text).toMatch(new RegExp(`✦ Conception confiée au Concepteur : « .+ »\. .*#/c/${c!.id}`));
    // Le directeur voit la conception en cours.
    fake.replies.push("Le Concepteur attend vos réponses.");
    await hub.conversations.send(P, t.id, "où en est le craft ?");
    expect(fake.calls.filter((x) => x.kind === "reply").at(-1)!.systemPrompt).toMatch(/<conceptions [^>]*>\n- « Système de craft » : attend les réponses du directeur créatif/);

    // Vous répondez au Concepteur et dites « transmets » : les chantiers reviennent dans la discussion d'origine.
    fake.extractions.push(() => conceptTurn({ transmettre: true }) as never);
    hub.conceptions.reply(sb.human(), c!.id, "5 recettes, c'est bon, transmets");
    await settle(hub);
    expect(hub.tasks.list(P).map((x) => x.origin?.thread)).toEqual([t.id, t.id]);
    expect(hub.conversations.messages(P, t.id).map((m) => m.text).join("\n")).toMatch(/Conception « Système de craft » transmise par le Concepteur/);
    expect(hub.tasks.list(P).map((x) => x.status)).toEqual(["merged", "merged"]);
  });
});

describe("Concevoir depuis une discussion (ADR-35)", () => {
  it("les chantiers reviennent dans la discussion d'où vous êtes parti, pas dans une nouvelle", async () => {
    const { sb, hub, fake, exec } = await setup();
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    exec.scripts.execute.push(async (t) => {
      await t.write("src/a.ts", "export {};\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    const t = hub.conversations.createThread(P, "Le combat");
    fake.extractions.push(
      () =>
        ({
          reply: "Dossier prêt, je transmets.",
          questions: [],
          title: "Résolution en 3D",
          engine: "",
          dossier: "# Résolution en 3D",
          chantiers: [{ title: "Scène", goal: "Objectif : la scène." }],
          ready: true,
          claude_md: "",
          sources: [],
          transmettre: true,
        }) as never,
    );
    const c = hub.conceptions.start(sb.human(), { kind: "feature", project: P, idea: "la résolution en 3D", thread: t.id });
    await settle(hub);

    expect(hub.conversations.listThreads(P).map((x) => x.title)).toEqual(["Le combat"]);
    const texts = hub.conversations.messages(P, t.id).map((m) => m.text);
    expect(texts[0]).toMatch(new RegExp(`^✦ Conception ouverte avec le Concepteur : « la résolution en 3D »\. Répondez-lui sur sa page : #/c/${c.id}`));
    expect(texts.join("\n")).toMatch(/Conception « Résolution en 3D » transmise par le Concepteur/);
    expect(hub.tasks.list(P)[0]).toMatchObject({ origin: { thread: t.id }, status: "merged" });
    // Une discussion d'un autre projet est refusée.
    expect(() => hub.conceptions.start(sb.human(), { kind: "feature", project: P, idea: "x", thread: "inconnue" })).toThrow();
  });
});
