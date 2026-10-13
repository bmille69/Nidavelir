import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalError } from "../src/approvals/approval-service.ts";
import { createHub } from "../src/hub.ts";
import { VisionService } from "../src/vision/vision-service.ts";
import { cleanupSandboxes, DIRECTOR, fakeClock, git, HUMAN, msg, sandbox, type Sandbox } from "./helpers.ts";

const P = "ombres";
let sb: Sandbox;
let root: string;

beforeEach(async () => {
  sb = sandbox();
  root = sb.makeGameRepo("ombres");
  await sb.hub.projects.register(sb.human(), { path: root, slug: P, name: "Ombres du Nord" });
});
afterEach(cleanupSandboxes);

const v = () => sb.hub.vision;

function captureSaveIdea() {
  return v().capture(P, DIRECTOR, {
    type: "mechanic",
    title: "Sauvegarde aux feux de camp",
    statement: "Le jeu ne sauvegarde qu'aux feux de camp.",
    source: msg("conv-1/msg-3", "j'aimerais que la sauvegarde soit rare, genre aux feux"),
    domain: ["gameplay"],
    confidence: 0.8,
  });
}

function propose(basedOn: string[], extra: Partial<Parameters<VisionService["submitProposal"]>[2]["details"]> = {}) {
  return v().submitProposal(P, DIRECTOR, {
    title: "Sauvegarde uniquement aux feux de camp",
    statement: "La sauvegarde manuelle n'existe pas ; le jeu sauvegarde quand le joueur se repose à un feu.",
    domain: ["gameplay"],
    source: { kind: "message", ref: "conv-1/msg-9" },
    details: { rationale: "Renforcer la tension.", based_on: basedOn, ...extra },
  });
}

function approve(subjectId: string, hash: string, extra: { verdict?: "approved" | "rejected"; edits?: object; kind?: "proposal" | "abandon" } = {}) {
  return sb.hub.approvals.record(sb.human(), {
    project: P,
    subject: { kind: extra.kind ?? "proposal", id: subjectId, hash },
    verdict: extra.verdict ?? "approved",
    edits: extra.edits as never,
  });
}

describe("mode exploration : capter sans toucher au canon", () => {
  it("les items captés citent la source et restent hors canon", () => {
    const idea = captureSaveIdea();
    expect(idea).toMatchObject({ id: "M-0001", status: "captured", tier: "working" });
    expect(idea.source.quote).toContain("aux feux");
    expect(v().list(P, { tier: "canon" })).toEqual([]);
    expect(v().visionRev(P)).toBe(0);
    expect(existsSync(join(root, "studio/items/M-0001.md"))).toBe(true);
  });

  it("une question ou une hypothèse s'ouvre au statut open", () => {
    const q = v().capture(P, DIRECTOR, { type: "question", title: "Combien de feux ?", statement: "?", source: msg("m", "q") });
    expect(q).toMatchObject({ id: "Q-0001", status: "open" });
  });

  it("on ne peut pas capter directement une décision ou une proposition", () => {
    for (const type of ["decision", "proposal", "conflict"] as const) {
      expect(() => v().capture(P, DIRECTOR, { type, title: "x", statement: "x", source: msg("m", "x") })).toThrow(/capté/);
    }
  });

  it("tri : retenir, écarter, restaurer", () => {
    const idea = captureSaveIdea();
    expect(v().triage(P, DIRECTOR, idea.id, "keep").status).toBe("triaged");
    expect(v().triage(P, HUMAN, idea.id, "discard").status).toBe("discarded");
    expect(v().triage(P, HUMAN, idea.id, "restore").status).toBe("triaged");
    expect(() => v().triage(P, DIRECTOR, idea.id, "restore")).toThrow();
  });
});

describe("mode décision : seule votre approbation fait entrer au canon", () => {
  it("parcours complet : proposition → approbation → décision, fichiers, commit, révision", async () => {
    const idea = captureSaveIdea();
    const { proposal, hash } = propose([idea.id]);
    expect(proposal).toMatchObject({ id: "P-0001", status: "submitted" });
    expect(v().get(P, idea.id).status).toBe("proposed");

    const approval = approve(proposal.id, hash);
    const { decision, commit } = await v().decideProposal(P, approval.id);

    expect(decision).toMatchObject({ id: "D-0001", status: "validated", tier: "canon", vision_rev: 1 });
    expect(decision!.validated_by).toMatchObject({ kind: "human", approval: "A-0001" });
    expect(v().get(P, idea.id)).toMatchObject({ status: "validated", tier: "canon" });
    expect(v().get(P, proposal.id).status).toBe("validated");
    expect(v().visionRev(P)).toBe(1);

    const file = readFileSync(join(root, "studio/items/D-0001.md"), "utf8");
    expect(file).toMatch(/approval: A-0001/);
    expect(readFileSync(join(root, "studio/BRIEF.md"), "utf8")).toMatch(/D-0001 — Sauvegarde uniquement aux feux/);

    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(root, "log", "-1", "--format=%s")).toMatch(/D-0001 validée .*\(A-0001\)/);
    expect(sb.hub.journal.list({ project: P }).map((e) => e.type)).toContain("decision.validated");
  });

  it("une approbation déjà utilisée ne peut pas resservir", async () => {
    const { proposal, hash } = propose([captureSaveIdea().id]);
    const a = approve(proposal.id, hash);
    await v().decideProposal(P, a.id);
    await expect(v().decideProposal(P, a.id)).rejects.toThrow();
  });

  it("une approbation portant sur un autre contenu (hash) est refusée, sans effet", async () => {
    const { proposal } = propose([captureSaveIdea().id]);
    const a = approve(proposal.id, "0".repeat(64));
    await expect(v().decideProposal(P, a.id)).rejects.toThrow(ApprovalError);
    expect(v().list(P, { tier: "canon" })).toEqual([]);
    expect(sb.hub.approvals.get(P, a.id)!.consumed_at).toBeUndefined();
  });

  it("une approbation ne peut pas être modifiée après coup, même en SQL direct", () => {
    const { proposal, hash } = propose([captureSaveIdea().id]);
    const a = approve(proposal.id, hash);
    expect(() => sb.hub.db.exec(`UPDATE approvals SET subject_id = 'P-0099' WHERE id = '${a.id}'`)).toThrow(/immutable/);
    expect(() => sb.hub.db.exec("DELETE FROM approvals")).toThrow(/immutable/);
  });

  it("refus : la proposition est rejetée et ses sources reviennent au tri", async () => {
    const idea = captureSaveIdea();
    const { proposal, hash } = propose([idea.id]);
    await v().decideProposal(P, approve(proposal.id, hash, { verdict: "rejected" }).id);
    expect(v().get(P, proposal.id).status).toBe("rejected");
    expect(v().get(P, idea.id).status).toBe("triaged");
    expect(v().list(P, { tier: "canon" })).toEqual([]);
    expect(v().visionRev(P)).toBe(0);
  });

  it("vos modifications au moment de valider sont appliquées et tracées", async () => {
    const { proposal, hash } = propose([captureSaveIdea().id]);
    const a = approve(proposal.id, hash, { edits: { statement: "Sauvegarde aux feux, plus une sauvegarde de secours en quittant." } });
    const { decision } = await v().decideProposal(P, a.id);
    expect(decision!.statement).toMatch(/secours/);
    expect(decision!.decision!.human_edits).toBe(true);
  });

  it("une proposition à options exige un choix ; le choix fixe l'énoncé", async () => {
    const options = [
      { key: "a", label: "Feux seulement", statement: "Sauvegarde aux feux uniquement.", tradeoffs: "tension forte" },
      { key: "b", label: "Feux + auto", statement: "Feux et sauvegarde auto entre les zones.", tradeoffs: "plus accessible" },
    ];
    const { proposal, hash } = propose([], { options });
    await expect(v().decideProposal(P, approve(proposal.id, hash).id)).rejects.toThrow(/options/);

    const { decision } = await v().decideProposal(P, approve(proposal.id, hash, { edits: { chosen_option: "b" } }).id);
    expect(decision).toMatchObject({ statement: "Feux et sauvegarde auto entre les zones." });
    expect(decision!.decision!.chosen_option).toBe("b");
  });

  it("la validation peut créer de nouveaux items au canon", async () => {
    const { proposal, hash } = propose([], {
      creates: [{ type: "constraint", title: "60 fps sur Steam Deck", statement: "Le jeu tient 60 fps sur Steam Deck.", domain: ["tech"] }],
    });
    await v().decideProposal(P, approve(proposal.id, hash).id);
    const [c] = v().list(P, { type: "constraint" });
    expect(c).toMatchObject({ id: "C-0001", status: "validated", tier: "canon" });
    expect(c!.links).toContainEqual({ rel: "derived_from", to: "D-0001" });
  });
});

describe("remplacement et abandon : on ne réécrit jamais l'histoire", () => {
  async function validated() {
    const { proposal, hash } = propose([captureSaveIdea().id]);
    return (await v().decideProposal(P, approve(proposal.id, hash).id)).decision!;
  }

  it("remplacer une décision la passe en superseded sans modifier son énoncé", async () => {
    const d1 = await validated();
    const { proposal, hash } = v().submitProposal(P, DIRECTOR, {
      title: "Sauvegarde aux feux et aux portails",
      statement: "On sauvegarde aux feux et aux portails de zone.",
      source: { kind: "message", ref: "conv-2/msg-1" },
      details: { supersedes: [d1.id] },
    });
    const { decision: d2 } = await v().decideProposal(P, approve(proposal.id, hash).id);

    const old = v().get(P, d1.id);
    expect(old.status).toBe("superseded");
    expect(old.statement).toBe(d1.statement);
    expect(old.validated_by).toEqual(d1.validated_by);
    expect(old.decision!.superseded_by).toBe(d2!.id);
    expect(d2!.links).toContainEqual({ rel: "supersedes", to: d1.id });
    expect(v().visionRev(P)).toBe(2);
  });

  it("une proposition devenue obsolète est bloquée", async () => {
    const d1 = await validated();
    const base = { source: { kind: "message" as const, ref: "m" }, details: { supersedes: [d1.id] } };
    const first = v().submitProposal(P, DIRECTOR, { title: "Variante A", statement: "A", ...base });
    const second = v().submitProposal(P, DIRECTOR, { title: "Variante B", statement: "B", ...base });
    await v().decideProposal(P, approve(first.proposal.id, first.hash).id);
    await expect(v().decideProposal(P, approve(second.proposal.id, second.hash).id)).rejects.toThrow(/remise à jour/);
  });

  it("on ne peut pas fonder une proposition sur un item déjà au canon", async () => {
    await validated();
    expect(() => propose(["M-0001"])).toThrow(/canon/);
  });

  it("abandon d'une décision avec votre approbation", async () => {
    const d1 = await validated();
    const a = approve(d1.id, v().itemHash(P, d1.id), { kind: "abandon" });
    await v().abandonDecision(P, a.id);
    expect(v().get(P, d1.id).status).toBe("abandoned");
    expect(git(root, "log", "-1", "--format=%s")).toMatch(/D-0001 abandonnée/);
  });
});

describe("aucun chemin d'agent vers le canon", () => {
  it("le VisionService n'expose aucune méthode de validation sans approbation", () => {
    const methods = Object.getOwnPropertyNames(VisionService.prototype).filter((m) => m !== "constructor");
    expect(methods.sort()).toEqual(
      [
        "abandonDecision",
        "capture",
        "decideProposal",
        "get",
        "itemHash",
        "list",
        "proposalHash",
        "rebuildIndex",
        "search",
        "submitProposal",
        "triage",
        "visionRev",
      ].sort(),
    );
  });
});

describe("index reconstructible et recherche", () => {
  it("après suppression de hub.db, l'index est reconstruit à l'identique depuis studio/", async () => {
    const { proposal, hash } = propose([captureSaveIdea().id]);
    await v().decideProposal(P, approve(proposal.id, hash).id);
    v().capture(P, DIRECTOR, { type: "idea", title: "Météo dynamique", statement: "Tempêtes", source: msg("m", "météo") });
    const before = v().list(P);
    const dbPath = join(sb.dir, "hub/.data/hub.db");
    sb.hub.close();
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });

    const fresh = createHub({ databasePath: dbPath, registry: { forbiddenTrees: [], forbiddenExact: [] }, clock: fakeClock() });
    fresh.db.prepare("INSERT INTO projects (slug, name, root, engine, created_at) VALUES (?, ?, ?, ?, ?)").run(P, "Ombres", root, "unknown", "x");
    expect(fresh.vision.rebuildIndex(P).items).toBe(before.length);
    expect(fresh.vision.list(P)).toEqual(before);
    expect(fresh.vision.visionRev(P)).toBe(1);
    // Les compteurs repartent après les identifiants existants.
    expect(fresh.vision.capture(P, DIRECTOR, { type: "idea", title: "x", statement: "x", source: msg("m", "x") }).id).toBe("I-0002");
    fresh.close();
  });

  it("recherche plein texte insensible aux accents", () => {
    v().capture(P, DIRECTOR, { type: "idea", title: "Météo dynamique", statement: "Tempêtes de neige", source: msg("m", "x") });
    captureSaveIdea();
    expect(v().search(P, "meteo").map((i) => i.id)).toEqual(["I-0001"]);
    expect(v().search(P, "sauvegarde").map((i) => i.id)).toEqual(["M-0001"]);
  });
});
