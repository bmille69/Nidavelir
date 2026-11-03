import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, Task, VerificationOutput } from "@studio/contracts";
import { applyReview, reviewBrief } from "../src/autonomy/brief-review.ts";
import { humanRequest } from "../src/conversation/conversation-service.ts";
import { directExecutionPrompt, verificationPrompt } from "../src/executor/prompts.ts";
import { chainRequests } from "../src/executor/task-service.ts";
import { createHub, type Hub } from "../src/hub.ts";
import type { OrchestratorPort } from "../src/orchestrator/port.ts";
import { declaredPoses, relevantPoses, type CheckerPort, type CheckOutcome, type PoseDeclared } from "../src/quality/checks.ts";
import { describeSnapshot, PlayRequest, PlayStep } from "../src/quality/playtest.ts";
import { blockingChecks, effectiveVerdict, verdictBlocks } from "../src/quality/verdict.ts";
import { FakeExecutor, REPORT, VERIFIED } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox, type Sandbox } from "./helpers.ts";

/** La qualité de rendu automatique (ADR-121 à ADR-125). */
vi.setConfig({ testTimeout: 40_000 });
afterEach(() => cleanupSandboxes());

const P = "jeu";
const BRIEF = "Je m'en occupe.\n[[CHANTIER: Viseur net]]\nRendre l'arme semi-transparente en visée.\n[[/CHANTIER]]";

const message = (seq: number, role: Message["role"], text: string): Message => ({ id: `m${seq}`, thread: "t", seq, role, text, at: "2026-10-30T00:00:00.000Z", extraction: "none", cost_usd: null });

type Check = VerificationOutput["checks"][number];
const verdict = (v: VerificationOutput["verdict"], checks: Partial<Check>[]): VerificationOutput => ({
  ...(VERIFIED as VerificationOutput),
  verdict: v,
  checks: checks.map((c) => ({ criterion: "Critère", result: "pass" as const, evidence: "preuve", ...c })),
});

/** Vérificateur scripté : le jeu déclare des poses, et chacune donne une photo ou une erreur. */
class PosingChecker implements CheckerPort {
  declared: PoseDeclared[] = [];
  failing = new Set<string>();
  asked: string[][] = [];
  async tests(): Promise<CheckOutcome> {
    return { status: "pass", detail: "ok" };
  }
  async launch(_key: string, _cwd: string, screenshot?: string): Promise<CheckOutcome> {
    if (screenshot) writeFileSync(screenshot, "PNG");
    return { status: "pass", detail: "ok", screenshot: screenshot ?? null, ...(this.declared.length ? { poses: this.declared } : {}) };
  }
  async poses(_cwd: string, poses: PoseDeclared[], file: (p: PoseDeclared, k: number) => string) {
    this.asked.push(poses.map((p) => p.nom));
    return poses.map((p, k) => {
      if (this.failing.has(p.nom)) return { ...p, file: null, error: "pose impossible" };
      writeFileSync(file(p, k), "JPEG");
      return { ...p, file: file(p, k) };
    });
  }
}

async function settle(hub: Hub) {
  for (let k = 0; k < 8; k++) {
    await hub.conversations.idle();
    await hub.tasks.idle();
    await hub.autopilot?.idle();
    await hub.gameState.idle();
  }
}

async function setup(opts: { review?: boolean; checker?: CheckerPort } = {}) {
  const orch = new FakeOrchestrator();
  const exec = new FakeExecutor();
  const sb: Sandbox = sandbox();
  sb.hub.close();
  const hub = createHub({
    databasePath: join(sb.dir, "hub/.data/rendu.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    orchestrator: orch,
    executor: exec,
    dataDir: join(sb.dir, "hub/.data"),
    autopilot: { synthesisDelayMs: 0 },
    ...(opts.review ? { review: true } : {}),
    ...(opts.checker ? { checker: opts.checker } : {}),
  });
  sb.hub = hub;
  const root = sb.makeGameRepo("games/jeu", { "README.md": "# Jeu\n", "src/main.ts": "export {};\n" });
  await hub.projects.register(sb.human(), { path: root, slug: P, name: "Jeu" });
  hub.projects.setAutonomy(sb.human(), P, "workshop");
  const thread = hub.conversations.createThread(P, "Viseur").id;
  const texts = () => hub.conversations.messages(P, thread).map((m) => m.text);
  const write = (file: string) => async (t: { write(f: string, c: string): Promise<unknown> }) => {
    await t.write(file, "export {};\n");
    return REPORT;
  };
  return { hub, orch, exec, sb, thread, texts, write };
}

describe("la demande du directeur créatif, mot pour mot (ADR-121)", () => {
  it("prend ses messages depuis la dernière consigne, le dernier au moins, tels quels", () => {
    const fil = [
      message(1, "human", "Ancienne demande"),
      message(2, "director", "OK\n\n§CONSIGNE§ Titre\nCorps"),
      message(3, "human", "L'arme est transparente"),
      message(4, "director", "Je regarde."),
      message(5, "human", "go"),
      message(6, "director", "Parti.\n\n§CONSIGNE§ Autre\nCorps"),
    ];
    expect(humanRequest(fil)).toBe("L'arme est transparente\n\ngo");
    expect(humanRequest([...fil, message(7, "human", "encore")])).toBe("encore");
    expect(humanRequest([message(1, "director", "Bonjour")])).toBeNull();
    expect(humanRequest([message(1, "human", "x".repeat(5000))])!.length).toBe(4000);
  });

  it("chaîne les demandes reprises, sans doublon, la plus ancienne d'abord ; l'ancienne tombe faute de place", () => {
    expect(chainRequests([undefined], undefined)).toBeUndefined();
    expect(chainRequests([], "b")).toBe("b");
    const parent = chainRequests(["a"], "b");
    expect(chainRequests([parent, "a"], "c")).toBe("a\n\n---\n\nb\n\n---\n\nc");
    const long = "y".repeat(4000);
    const chain = chainRequests([`1${long}\n\n---\n\n2${long}\n\n---\n\n3${long}`], `4${long.slice(1)}`)!;
    expect(chain.length).toBeLessThanOrEqual(12_000);
    expect(chain.startsWith("3")).toBe(true);
    expect(chain).toContain(`4${long.slice(1)}`);
  });

  it("est enregistrée, chaînée par « reprend », et donnée au développeur et au testeur ; absente, rien ne change", async () => {
    const { hub, orch, exec, thread, write } = await setup();
    exec.scripts.execute.push(write("src/a.ts"), write("src/b.ts"));
    exec.scripts.verify.push(() => VERIFIED, () => VERIFIED);

    orch.replies.push(BRIEF);
    await hub.conversations.send(P, thread, "L'arme est transparente, je n'en veux pas.");
    await settle(hub);
    const first = hub.tasks.get(P, "T-0001");
    expect(first.request).toBe("L'arme est transparente, je n'en veux pas.");
    expect(first.status).toBe("merged");

    orch.replies.push("[[CHANTIER: Viseur encore | reprend T-0001]]\nSurélever le viseur.\n[[/CHANTIER]]");
    await hub.conversations.send(P, thread, "Le viseur flotte !");
    await settle(hub);
    const second = hub.tasks.get(P, "T-0002");
    expect(second.reworks).toEqual(["T-0001"]);
    expect(second.request).toBe("L'arme est transparente, je n'en veux pas.\n\n---\n\nLe viseur flotte !");

    for (const k of [2, 3]) {
      expect(exec.requests[k]!.prompt).toMatch(/<demande_du_directeur_creatif>\nL'arme est transparente[\s\S]*Le viseur flotte ![\s\S]*ils priment sur la consigne du Directeur/);
    }
    expect(exec.requests[3]!.prompt).toMatch(/source="demande"/);
    expect(exec.requests[2]!.prompt).not.toMatch(/source="demande"/);

    const fromHub = hub.tasks.createFromConversation(P, { title: "Sans mots", goal: "Rien" }, thread);
    expect("request" in fromHub).toBe(false);
    expect(hub.tasks.get(P, fromHub.id)).not.toHaveProperty("request");
    const bare = directExecutionPrompt(fromHub, []);
    expect(bare).not.toMatch(/demande_du_directeur_creatif/);
  });

  it("donne au développeur la règle de la mesure, et les poses du nœud studio_test seulement sur un jeu Godot", async () => {
    const { directExecutionSystemPrompt, verificationSystemPrompt } = await import("../src/executor/prompts.ts");
    const web = directExecutionSystemPrompt({ brief: null, claudeMd: null });
    expect(web).toMatch(/test PERMANENT qui mesure le défaut/);
    // ADR-129 : un jeu web a ses propres poses (window.__STUDIO_TEST__), jamais celles du nœud Godot.
    expect(web).not.toMatch(/nœud « studio_test »/);
    expect(directExecutionSystemPrompt({ brief: null, claudeMd: null, godot: true })).toMatch(/Poses de contrôle[\s\S]*poses\(\)/);
    const qa = verificationSystemPrompt({ brief: null, claudeMd: null, godot: true }, true);
    expect(qa).toMatch(/relire la valeur posée par le chantier/);
    expect(qa).toMatch(/"kind"[\s\S]*"source"/);
    expect(qa).toMatch(/mets le jeu dans la pose avec do=pose/);
  });
});

describe("blockingChecks (ADR-124)", () => {
  it("bloque un point de rendu ou de la demande qui n'est pas « pass », jamais une note technique", () => {
    const cases: [Partial<Check>, boolean][] = [
      [{ kind: "rendu", result: "fail" }, true],
      [{ kind: "rendu", result: "not_verifiable" }, true],
      [{ source: "demande", result: "fail" }, true],
      [{ source: "demande", kind: "technique", result: "not_verifiable" }, true],
      [{ kind: "rendu", result: "pass" }, false],
      [{ source: "demande", result: "pass" }, false],
      [{ kind: "technique", result: "not_verifiable" }, false],
      [{ kind: "regle", source: "consigne", result: "not_verifiable" }, false],
      [{ result: "not_verifiable" }, false],
    ];
    for (const [c, blocks] of cases) {
      const v = verdict("pass_with_notes", [c]);
      expect(blockingChecks(v).length > 0, JSON.stringify(c)).toBe(blocks);
      expect(verdictBlocks(v), JSON.stringify(c)).toBe(blocks);
      expect(effectiveVerdict(v)).toBe(blocks ? "fail" : "pass_with_notes");
    }
    expect(verdictBlocks(verdict("fail", []))).toBe(true);
    // Une ancienne vérification, sans « kind » ni « source », garde son sens.
    expect(verdictBlocks(VERIFIED as VerificationOutput)).toBe(false);
  });
});

describe("l'autopilot ne fusionne plus un rendu pas prouvé (ADR-124)", () => {
  const unproved = verdict("pass_with_notes", [{ criterion: "Visée complète vue", kind: "rendu", result: "not_verifiable", evidence: "pas vue à 100 %" }]);

  it("renvoie en correction, liste le point au développeur, le redemande au testeur, puis fusionne une fois prouvé", async () => {
    const { hub, orch, exec, thread, texts, write } = await setup();
    exec.scripts.execute.push(write("src/a.ts"), write("src/a2.ts"));
    exec.scripts.verify.push(() => unproved, () => VERIFIED);
    orch.replies.push(BRIEF);
    await hub.conversations.send(P, thread, "go");
    await settle(hub);

    expect(hub.tasks.get(P, "T-0001").status).toBe("merged");
    expect(exec.requests.map((r) => r.kind)).toEqual(["execute", "verify", "execute", "verify"]);
    expect(exec.requests[2]!.prompt).toMatch(/Visée complète vue : pas vue à 100 % \(non prouvé/);
    expect(exec.requests[3]!.prompt).toMatch(/<verification_precedente>[\s\S]*Visée complète vue/);
    expect(texts().join("\n")).toMatch(/↻ Chantier T-0001 « Viseur net » : le testeur était plutôt d'accord, mais un point de rendu ou de votre demande n'est pas prouvé : Visée complète vue/);
  });

  it("après les tentatives automatiques, attend votre avis et montre le point en ✗", async () => {
    const { hub, orch, exec, thread, texts, write } = await setup();
    exec.scripts.execute.push(write("src/a.ts"), write("src/a2.ts"), write("src/a3.ts"));
    exec.scripts.verify.push(() => unproved, () => unproved, () => unproved);
    orch.replies.push(BRIEF);
    await hub.conversations.send(P, thread, "go");
    await settle(hub);

    expect(hub.tasks.get(P, "T-0001").status).toBe("review");
    expect(exec.requests.filter((r) => r.kind === "verify")).toHaveLength(3);
    const report = texts().at(-1)!;
    expect(report).toMatch(/^⚠ Chantier T-0001 « Viseur net » terminé — un point de rendu ou de votre demande n'est pas prouvé\./);
    expect(report).toMatch(/ {2}✗ Visée complète vue \(non prouvé\)/);
    expect(report).toMatch(/Il attend votre avis/);
  });

  it("fusionne toujours avec une simple note technique", async () => {
    const { hub, orch, exec, thread, write } = await setup();
    exec.scripts.execute.push(write("src/a.ts"));
    exec.scripts.verify.push(() => verdict("pass_with_notes", [{ kind: "technique", result: "not_verifiable", evidence: "non couvert" }]));
    orch.replies.push(BRIEF);
    await hub.conversations.send(P, thread, "go");
    await settle(hub);
    expect(hub.tasks.get(P, "T-0001").status).toBe("merged");
    expect(exec.requests.filter((r) => r.kind === "verify")).toHaveLength(1);
  });
});

describe("la contre-expertise de la consigne (ADR-125)", () => {
  const launch = async (review: unknown, opts: { review?: boolean } = { review: true }) => {
    const ctx = await setup(opts);
    ctx.exec.scripts.execute.push(ctx.write("src/a.ts"));
    ctx.exec.scripts.verify.push(() => VERIFIED);
    if (review !== undefined) ctx.orch.extractions.push(review as never);
    ctx.orch.replies.push(BRIEF);
    await ctx.hub.conversations.send(P, ctx.thread, "L'arme est transparente");
    await settle(ctx.hub);
    const task = ctx.hub.tasks.get(P, "T-0001");
    const events = ctx.hub.journal.list({ project: P, subject: "T-0001" }).map((e) => e.type);
    return { ...ctx, task, events };
  };
  const reviewerCalls = (orch: FakeOrchestrator) => orch.calls.filter((c) => c.systemPrompt.includes("directeur technique de jeu vidéo exigeant"));

  it("désactivée par défaut : aucun appel, la consigne part telle quelle", async () => {
    const { orch, task, texts, events } = await launch(undefined, {});
    expect(reviewerCalls(orch)).toHaveLength(0);
    expect(task.goal).toBe("Rendre l'arme semi-transparente en visée.");
    expect(texts().join("\n")).not.toMatch(/le relecteur/);
    expect(events).not.toContain("brief.reviewed");
  });

  it("ok : lancement inchangé, échange visible et journalisé", async () => {
    const { orch, task, texts, events } = await launch({ ok: true, objections: [] });
    const [call] = reviewerCalls(orch);
    expect(call!.prompt).toMatch(/<demande_du_directeur_creatif>\nL'arme est transparente/);
    expect(call!.prompt).toMatch(/Rendre l'arme semi-transparente/);
    expect(task.goal).toBe("Rendre l'arme semi-transparente en visée.");
    expect(events).toContain("brief.reviewed");
    expect(texts().join("\n")).toMatch(/§CONSULTATION§ .*"to":"le relecteur"/);
  });

  it("ko avec consigne corrigée : c'est elle qui part ; les mots du directeur créatif restent", async () => {
    const { orch, task, exec, texts } = await launch({ ok: false, objections: ["La transparence est une rustine."], consigne_corrigee: { title: "Viseur sans transparence", goal: "Viseur sur rail, arme opaque." } });
    expect(reviewerCalls(orch)).toHaveLength(1);
    expect(task).toMatchObject({ title: "Viseur sans transparence", goal: "Viseur sur rail, arme opaque.", request: "L'arme est transparente" });
    expect(exec.requests[0]!.prompt).toMatch(/Viseur sur rail/);
    expect(texts().join("\n")).toMatch(/La transparence est une rustine/);
  });

  it("ko sans consigne corrigée : la consigne d'origine et les points à respecter", async () => {
    const { task } = await launch({ ok: false, objections: ["Pas de transparence."] });
    expect(task.title).toBe("Viseur net");
    expect(task.goal).toMatch(/^Rendre l'arme semi-transparente en visée\.\n\nPoints du relecteur à respecter :\n- Pas de transparence\.$/);
  });

  it("erreur : la consigne part quand même, et un événement le dit", async () => {
    const { task, events, texts } = await launch(new Error("panne"));
    expect(task.goal).toBe("Rendre l'arme semi-transparente en visée.");
    expect(task.status).toBe("merged");
    expect(events).toContain("brief.review_failed");
    expect(texts().join("\n")).not.toMatch(/le relecteur/);
  });

  it("réponse illisible ou délai dépassé : une erreur, jamais une attente sans fin", async () => {
    const stuck = { structured: () => new Promise(() => {}) } as unknown as OrchestratorPort;
    await expect(reviewBrief(stuck, { project: P, brief: { title: "t", goal: "g" }, timeoutMs: 10 })).rejects.toThrow(/pas de réponse/);
    const odd = { structured: async () => ({ data: { ok: "oui" }, costUsd: 0 }) } as unknown as OrchestratorPort;
    await expect(reviewBrief(odd, { project: P, brief: { title: "t", goal: "g" } })).rejects.toThrow();
  });

  it("passe par sa propre file, avec son délai", async () => {
    const seen: Record<string, unknown>[] = [];
    const spy = { structured: async (i: Record<string, unknown>) => (seen.push(i), { data: { ok: true, objections: [] }, costUsd: 0 }) } as unknown as OrchestratorPort;
    await reviewBrief(spy, { project: P, brief: { title: "t", goal: "g" } });
    expect(seen[0]).toMatchObject({ lane: "team", meta: { agent: "relecteur" } });
    expect(seen[0]!.timeoutMs).toBeGreaterThan(0);
  });

  it("une consigne pleine garde sa place : jamais plus de 4000 caractères", () => {
    const after = applyReview({ title: "t", goal: "g".repeat(4000) }, { ok: false, objections: ["o".repeat(3000)] });
    expect(after.goal.length).toBeLessThanOrEqual(4000);
    expect(after.goal).toMatch(/Points du relecteur/);
    expect(applyReview({ title: "t", goal: "g" }, { ok: false, objections: [] })).toEqual({ title: "t", goal: "g" });
    expect(applyReview({ title: "t", goal: "g" }, { ok: true, objections: ["x"], consigne_corrigee: { title: "a", goal: "b" } })).toEqual({ title: "t", goal: "g" });
  });
});

describe("les poses de contrôle (ADR-122)", () => {
  it("l'étape pose de la manette, sa liste, et le relais qui suit", () => {
    expect(PlayStep.parse({ do: "pose", name: "visee_viseur" })).toEqual({ do: "pose", name: "visee_viseur" });
    expect(() => PlayStep.parse({ do: "pose" })).toThrow();
    expect(() => PlayStep.parse({ do: "pose", name: "" })).toThrow();
    expect(PlayRequest.parse({ action: "act", steps: [{ do: "pose", name: "a" }], capture: true }).steps).toHaveLength(1);
    const text = describeSnapshot({ url: "res://main.tscn", title: "", text: "", controls: [], canvases: [], errors: [], failedRequests: [], state: null, bridge: [], poses: [{ nom: "visee_viseur", description: "visée à 100 %" }] });
    expect(text).toMatch(/Poses de contrôle \(do=pose, name\) : visee_viseur \(visée à 100 %\)/);
    const bridge = readFileSync(join(process.cwd(), "apps/hub/src/godot/addons/studio_bridge/bridge.gd"), "utf8");
    expect(bridge).toMatch(/const VERSION := 4/);
    expect(bridge).toMatch(/"pose":[\s\S]*node\.call\("pose", pose_name\)/);
    expect(bridge).toMatch(/"poses": poses/);
    expect(readFileSync(join(process.cwd(), "apps/hub/src/executor/bridge/gate.mjs"), "utf8")).toMatch(/"bridge", "pose"\]/);
  });

  it("nettoie ce que le jeu déclare : huit au plus, sans doublon ni nom vide", () => {
    expect(declaredPoses("rien")).toEqual([]);
    const many = [...Array(12).keys()].map((k) => ({ nom: `p${k}`, description: "d" }));
    expect(declaredPoses(many)).toHaveLength(8);
    expect(declaredPoses([{ nom: "a" }, { nom: "a", description: "x" }, { nom: " " }, {}, null])).toEqual([{ nom: "a", description: "" }]);
  });

  it("montre d'abord les photos que le testeur cite, trois au plus", () => {
    const poses = ["a1", "b1", "c1", "d1"].map((nom) => ({ nom, description: "", file: `${nom}.jpg` }));
    const v = verdict("pass", [{ evidence: "vu sur la pose c1" }]);
    expect(relevantPoses({ poses: [{ nom: "x", description: "", file: null, error: "non" }, ...poses] }, v).map((p) => p.nom)).toEqual(["c1", "a1", "b1"]);
    expect(relevantPoses({}, null)).toEqual([]);
  });

  it("le bloc photos_des_poses, seulement s'il y a des poses", () => {
    const task = { id: "T-0001", title: "t", goal: "g", feedback: [], direct: true } as unknown as Task;
    const plan = { acceptance_criteria: ["c"], commands: [] } as never;
    const prompt = verificationPrompt(task, plan, [], "", {}, { summary: "ok", screenshot: null, poses: [{ nom: "visee", description: "à 100 %", file: "C:/shots/visee.jpg" }, { nom: "cassee", description: "", file: null, error: "boum" }] });
    expect(prompt).toMatch(/<photos_des_poses[\s\S]*visee \(à 100 %\) : C:\/shots\/visee\.jpg[\s\S]*cassee : pas de photo, boum[\s\S]*Tu DOIS lire avec Read/);
    expect(verificationPrompt(task, plan, [], "", {}, { summary: "ok", screenshot: null })).not.toMatch(/photos_des_poses/);
  });

  it("le hub photographie chaque pose, les donne au testeur et au compte rendu ; une pose ratée n'est pas une régression", async () => {
    const checker = new PosingChecker();
    checker.declared = [{ nom: "visee_viseur", description: "visée à 100 %" }, { nom: "cassee", description: "" }];
    checker.failing.add("cassee");
    const { hub, orch, exec, thread, texts, write } = await setup({ checker });
    exec.scripts.execute.push(write("src/a.ts"));
    exec.scripts.verify.push(() => VERIFIED);
    orch.replies.push(BRIEF);
    await hub.conversations.send(P, thread, "go");
    await settle(hub);

    expect(checker.asked).toEqual([["visee_viseur", "cassee"]]);
    const report = hub.checks!.get(P, "T-0001")!;
    expect(report.regression).toBe(false);
    expect(report.poses!.map((p) => !!p.file)).toEqual([true, false]);
    expect(exec.requests[1]!.prompt).toMatch(/<photos_des_poses[\s\S]*visee_viseur[\s\S]*cassee : pas de photo, pose impossible/);
    expect(hub.tasks.get(P, "T-0001").status).toBe("merged");
    expect(texts().at(-1)!).toMatch(/^§POSE§ T-0001 \S+ visee_viseur$/m);
    expect(texts().at(-1)!).not.toMatch(/§POSE§ .* cassee/);
    expect(hub.checks!.poseShot(P, "T-0001", "visee_viseur")).toMatch(/T-0001-pose-0-visee_viseur\.jpg$/);
    expect(hub.checks!.poseShot(P, "T-0001", "../../secret")).toBeNull();
  });

  it("sans poses déclarées, rien ne change", async () => {
    const checker = new PosingChecker();
    const { hub, orch, exec, thread, texts, write } = await setup({ checker });
    exec.scripts.execute.push(write("src/a.ts"));
    exec.scripts.verify.push(() => VERIFIED);
    orch.replies.push(BRIEF);
    await hub.conversations.send(P, thread, "go");
    await settle(hub);
    expect(checker.asked).toEqual([]);
    expect(hub.checks!.get(P, "T-0001")).not.toHaveProperty("poses");
    expect(texts().join("\n")).not.toMatch(/§POSE§/);
  });
});
