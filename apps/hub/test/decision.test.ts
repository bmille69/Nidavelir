import type { SynthesizedProposal } from "@studio/contracts";
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer, SESSION_COOKIE } from "../src/server/http.ts";
import { chunkByDomain } from "../src/vision/synthesis.ts";
import { extracted, FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, DIRECTOR, git, msg, sandbox, type Sandbox } from "./helpers.ts";

const P = "survivor";
const HOST = "127.0.0.1:4317";
let sb: Sandbox;
let fake: FakeOrchestrator;
let root: string;
let app: FastifyInstance;

beforeEach(async () => {
  fake = new FakeOrchestrator();
  sb = sandbox(fake);
  root = sb.makeGameRepo("survivor");
  await sb.hub.projects.register(sb.human(), { path: root, slug: P, name: "Destiny Survivor" });
  app = await buildServer(sb.hub, { port: 4317, gamesRoot: sb.dir, allowedHosts: [HOST], folderPicker: { pick: async () => null } });
});
afterEach(async () => {
  await app.close();
  cleanupSandboxes();
});

function note(title: string, domain = "boss", type: "mechanic" | "idea" | "constraint" = "mechanic") {
  return sb.hub.vision.capture(P, DIRECTOR, { type, title, statement: title, source: msg("m", title), domain: [domain] });
}

function group(partial: Partial<SynthesizedProposal> & Pick<SynthesizedProposal, "title" | "based_on">): SynthesizedProposal {
  return { nature: "creative", summary: `En bref : ${partial.title}`, statement: `Règle : ${partial.title}`, rationale: "Cohérent.", supersedes: [], conflict_notes: [], questions: [], domain: ["boss"], ...partial };
}

/** File une réponse de regroupement dans l'orchestrateur factice. */
function scriptSynthesis(proposals: SynthesizedProposal[], left_out: { id: string; reason: string }[] = []) {
  fake.extractions.push(() => ({ proposals, left_out }) as never);
}

async function login() {
  const res = await app.inject({ method: "GET", url: `/login?token=${sb.hub.sessions.createLoginToken()}`, headers: { host: HOST } });
  const cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
  const { csrf } = (await app.inject({ method: "GET", url: "/api/human/session", headers: { host: HOST, cookie } })).json();
  const headers = { host: HOST, cookie, origin: `http://${HOST}`, "x-csrf-token": csrf };
  return {
    get: (url: string) => app.inject({ method: "GET", url, headers: { host: HOST, cookie } }),
    post: (url: string, payload: object = {}) => app.inject({ method: "POST", url, payload, headers }),
  };
}

describe("regroupement en propositions de synthèse", () => {
  it("transforme beaucoup de fiches en quelques propositions, sans rien valider", async () => {
    for (let k = 1; k <= 6; k++) note(`Boss règle ${k}`);
    note("Vague de 30 s", "rythme");
    note("Truc vague", "divers", "idea");
    scriptSynthesis(
      [
        group({ title: "Apparition des boss", based_on: ["M-0001", "M-0002", "M-0003", "M-0004", "M-0005", "M-0006"] }),
        group({ title: "Rythme des vagues", based_on: ["M-0007"], domain: ["rythme"] }),
      ],
      [{ id: "I-0001", reason: "trop vague" }],
    );

    const job = sb.hub.synthesis.start(P);
    await sb.hub.synthesis.idle();

    expect(job).toMatchObject({ status: "done", candidates: 8, proposals: ["P-0001", "P-0002"] });
    expect(job.left_out).toEqual([{ id: "I-0001", reason: "trop vague" }]);
    expect(sb.hub.vision.get(P, "M-0001").status).toBe("proposed");
    expect(sb.hub.vision.get(P, "I-0001").status).toBe("captured");
    expect(sb.hub.vision.list(P, { tier: "canon" })).toEqual([]);
    expect(sb.hub.synthesis.candidates(P).map((i) => i.id)).toEqual(["I-0001"]);
  });

  it("corrige les identifiants inventés, les doublons entre groupes et les faux remplacements", async () => {
    note("A");
    note("B");
    scriptSynthesis([
      group({ title: "G1", based_on: ["M-0001", "M-0999"], supersedes: ["D-0042"], conflict_notes: ["faux conflit"] }),
      group({ title: "G2", based_on: ["M-0001", "M-0002"] }),
      group({ title: "G3", based_on: ["M-0777"] }),
    ]);
    const job = sb.hub.synthesis.start(P);
    await sb.hub.synthesis.idle();

    expect(job.proposals).toEqual(["P-0001", "P-0002"]);
    expect(sb.hub.vision.get(P, "P-0001").proposal).toMatchObject({ based_on: ["M-0001"], supersedes: [], conflict_notes: [] });
    expect(sb.hub.vision.get(P, "P-0002").proposal!.based_on).toEqual(["M-0002"]);
    expect(job.corrections.join("\n")).toMatch(/M-0999 inconnu[\s\S]*D-0042 n'est pas une décision validée[\s\S]*M-0001 déjà dans un autre groupe[\s\S]*G3.*abandonnée/);
  });

  it("le périmètre peut se limiter à une discussion ou à un document", () => {
    sb.hub.vision.capture(P, DIRECTOR, { type: "idea", title: "x", statement: "x", source: { kind: "message", ref: "T1/m1", quote: "x" } });
    sb.hub.vision.capture(P, DIRECTOR, { type: "idea", title: "y", statement: "y", source: { kind: "file", ref: "docs/a.md#L3", quote: "y" } });
    expect(sb.hub.synthesis.candidates(P, { thread: "T1" }).map((i) => i.title)).toEqual(["x"]);
    expect(sb.hub.synthesis.candidates(P, { source: "docs/a.md" }).map((i) => i.title)).toEqual(["y"]);
  });

  it("découpe les gros volumes en lots en gardant les domaines ensemble", () => {
    const fake = (d: string, n: number) => Array.from({ length: n }, () => ({ domain: [d] }) as never);
    const chunks = chunkByDomain([...fake("boss", 70), ...fake("armes", 60), ...fake("ui", 10)], 120);
    expect(chunks.map((c) => c.length)).toEqual([70, 70]);
  });
});

describe("séparation créatif / technique", () => {
  it("chaque proposition porte sa nature, que la décision conserve", async () => {
    note("Boss à l'arène");
    sb.hub.vision.capture(P, DIRECTOR, { type: "constraint", title: "Simulation sans DOM", statement: "x", source: { kind: "file", ref: "CLAUDE.md#L9", quote: "x" } });
    scriptSynthesis([
      group({ title: "Apparition des boss", based_on: ["M-0001"], nature: "creative" }),
      group({ title: "Architecture de la simulation", based_on: ["C-0001"], nature: "technical" }),
    ]);
    sb.hub.synthesis.start(P);
    await sb.hub.synthesis.idle();
    expect(sb.hub.vision.get(P, "P-0001").nature).toBe("creative");
    expect(sb.hub.vision.get(P, "P-0002").nature).toBe("technical");
    // Les éléments d'un document de code importé avant l'étiquetage sont signalés comme techniques au regroupeur.
    expect(fake.calls.at(-1)!.prompt).toMatch(/\[C-0001\] \([^)]*document technique/);
    const { post, get } = await login();
    const cards = (await get(`/api/human/projects/${P}/proposals`)).json() as { proposal: { id: string }; hash: string }[];
    await post(`/api/human/projects/${P}/proposals/decide-batch`, { proposals: cards.map((c) => ({ id: c.proposal.id, hash: c.hash })) });
    expect(sb.hub.vision.list(P, { type: "decision" }).map((d) => d.nature)).toEqual(["creative", "technical"]);
  });

  it("refaire le regroupement : les propositions en attente reviennent au tri, rien de validé ne bouge", async () => {
    note("A");
    note("B");
    scriptSynthesis([group({ title: "G1", based_on: ["M-0001", "M-0002"] })]);
    sb.hub.synthesis.start(P);
    await sb.hub.synthesis.idle();
    scriptSynthesis([group({ title: "A seul", based_on: ["M-0001"] }), group({ title: "B seul", based_on: ["M-0002"], nature: "technical" })]);
    const { post } = await login();
    expect((await post(`/api/human/projects/${P}/synthesis/redo`)).statusCode).toBe(200);
    await sb.hub.synthesis.idle();
    expect(sb.hub.vision.get(P, "P-0001").status).toBe("returned");
    expect(sb.hub.vision.list(P, { type: "proposal", status: "submitted" }).map((p) => [p.title, p.nature])).toEqual([
      ["A seul", "creative"],
      ["B seul", "technical"],
    ]);
    expect(sb.hub.vision.list(P, { tier: "canon" })).toEqual([]);
  });

  it("à l'import, CLAUDE.md et l'architecture sont « code » par défaut, modifiable par document", async () => {
    const { post } = await login();
    const game = sb.makeGameRepo("autre-jeu", { "README.md": "# Jeu\nUn jeu de pirates.", "CLAUDE.md": "# Code\nTypeScript strict.", "docs/architecture.md": "# Archi" });
    const analysis = (await post("/api/human/import/analyze", { path: game })).json();
    expect(analysis.document_natures).toEqual({ "README.md": "creative", "CLAUDE.md": "technical", "docs/architecture.md": "technical" });
    fake.extractions.push(() => [extracted({ title: "Pirates", quote: "Un jeu de pirates." })], () => [extracted({ title: "TS strict", quote: "TypeScript strict." })]);
    await post("/api/human/projects/import", {
      path: game,
      slug: "pirates",
      name: "Pirates",
      documents: [
        { path: "README.md", nature: "creative" },
        { path: "CLAUDE.md", nature: "technical" },
      ],
    });
    await sb.hub.bootstrap.idle();
    expect(sb.hub.vision.list("pirates").map((i) => [i.title, i.nature])).toEqual([
      ["Pirates", "creative"],
      ["TS strict", "technical"],
    ]);
  });
});

describe("décider depuis l'interface", () => {
  async function prepared() {
    for (const t of ["Boss à l'arène", "Pas de minuteur", "Ogre en fin de zone"]) note(t);
    scriptSynthesis([group({ title: "Apparition des boss", based_on: ["M-0001", "M-0002", "M-0003"] })]);
    sb.hub.synthesis.start(P);
    await sb.hub.synthesis.idle();
  }

  it("valider une proposition en retirant une fiche du groupe", async () => {
    await prepared();
    const { get, post } = await login();
    const [card] = (await get(`/api/human/projects/${P}/proposals`)).json();
    expect(card.sources).toHaveLength(3);

    const res = await post(`/api/human/projects/${P}/proposals/P-0001/decide`, {
      hash: card.hash,
      verdict: "approved",
      edits: { statement: "Le boss surgit quand le joueur entre dans son arène.", exclude: ["M-0003"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ approval: "A-0001", decision: { id: "D-0001", status: "validated" } });
    expect(sb.hub.vision.get(P, "M-0001")).toMatchObject({ status: "validated", tier: "canon" });
    expect(sb.hub.vision.get(P, "M-0003")).toMatchObject({ status: "triaged", tier: "working" });
    expect(sb.hub.vision.get(P, "D-0001").statement).toMatch(/arène/);
    expect(git(root, "log", "-1", "--format=%s")).toMatch(/D-0001 validée/);

    const why = (await get(`/api/human/projects/${P}/items/M-0001/why`)).json();
    expect(why.decidedBy.map((d: { id: string }) => d.id)).toEqual(["D-0001"]);
    const whyD = (await get(`/api/human/projects/${P}/items/D-0001/why`)).json();
    // La décision remonte à la proposition puis aux fiches ; la fiche retirée garde son vrai statut.
    expect(whyD.ancestors.map((a: { id: string; status: string }) => [a.id, a.status])).toEqual([
      ["P-0001", "validated"],
      ["M-0001", "validated"],
      ["M-0002", "validated"],
      ["M-0003", "triaged"],
    ]);
  });

  it("une proposition modifiée depuis l'affichage ne peut pas être validée avec l'ancien contenu", async () => {
    await prepared();
    const { post } = await login();
    const res = await post(`/api/human/projects/${P}/proposals/P-0001/decide`, { hash: "f".repeat(64), verdict: "approved" });
    expect(res.statusCode).toBe(400);
    expect(sb.hub.vision.list(P, { tier: "canon" })).toEqual([]);
  });

  it("refuser, ou renvoyer en discussion : les fiches reviennent au tri", async () => {
    await prepared();
    const { get, post } = await login();
    const [card] = (await get(`/api/human/projects/${P}/proposals`)).json();
    expect((await post(`/api/human/projects/${P}/proposals/P-0001/return`, { note: "à revoir" })).json().status).toBe("returned");
    expect(sb.hub.vision.get(P, "M-0001").status).toBe("triaged");
    // Le hash affiché ne correspond plus : la proposition n'est plus en attente.
    expect((await post(`/api/human/projects/${P}/proposals/P-0001/decide`, { hash: card.hash, verdict: "rejected" })).statusCode).toBe(400);
  });

  it("validation groupée : chaque proposition reçoit sa propre approbation", async () => {
    note("A");
    note("B");
    scriptSynthesis([group({ title: "G1", based_on: ["M-0001"] }), group({ title: "G2", based_on: ["M-0002"] })]);
    sb.hub.synthesis.start(P);
    await sb.hub.synthesis.idle();
    const { get, post } = await login();
    const cards = (await get(`/api/human/projects/${P}/proposals`)).json() as { proposal: { id: string }; hash: string }[];
    const res = (await post(`/api/human/projects/${P}/proposals/decide-batch`, { proposals: cards.map((c) => ({ id: c.proposal.id, hash: c.hash })) })).json();
    expect(res.results).toEqual([
      { id: "P-0001", decision: "D-0001" },
      { id: "P-0002", decision: "D-0002" },
    ]);
    expect(sb.hub.approvals.get(P, "A-0002")!.subject.id).toBe("P-0002");
    expect(sb.hub.vision.visionRev(P)).toBe(2);
    expect(readFileSync(join(root, "studio/BRIEF.md"), "utf8")).toMatch(/D-0002/);
  });

  it("une contradiction avec le canon est présentée comme un remplacement explicite", async () => {
    note("Boss au minuteur");
    scriptSynthesis([group({ title: "Boss au minuteur", based_on: ["M-0001"] })]);
    sb.hub.synthesis.start(P);
    await sb.hub.synthesis.idle();
    const { get, post } = await login();
    let [card] = (await get(`/api/human/projects/${P}/proposals`)).json();
    await post(`/api/human/projects/${P}/proposals/P-0001/decide`, { hash: card.hash, verdict: "approved" });

    note("Boss à l'arène");
    scriptSynthesis([
      group({ title: "Boss à l'arène", based_on: ["M-0002"], supersedes: ["D-0001"], conflict_notes: ["Avant : minuteur. Maintenant : arène."] }),
    ]);
    sb.hub.synthesis.start(P);
    await sb.hub.synthesis.idle();
    [card] = (await get(`/api/human/projects/${P}/proposals`)).json();
    expect(card.supersedes.map((d: { id: string }) => d.id)).toEqual(["D-0001"]);
    expect(card.proposal.proposal.conflict_notes).toEqual(["Avant : minuteur. Maintenant : arène."]);

    await post(`/api/human/projects/${P}/proposals/P-0002/decide`, { hash: card.hash, verdict: "approved" });
    expect(sb.hub.vision.get(P, "D-0001")).toMatchObject({ status: "superseded", decision: { superseded_by: "D-0002" } });
  });

  it("abandonner une décision validée", async () => {
    note("A");
    scriptSynthesis([group({ title: "G1", based_on: ["M-0001"] })]);
    sb.hub.synthesis.start(P);
    await sb.hub.synthesis.idle();
    const { get, post } = await login();
    const [card] = (await get(`/api/human/projects/${P}/proposals`)).json();
    await post(`/api/human/projects/${P}/proposals/P-0001/decide`, { hash: card.hash, verdict: "approved" });
    const why = (await get(`/api/human/projects/${P}/items/D-0001/why`)).json();
    const res = await post(`/api/human/projects/${P}/decisions/D-0001/abandon`, { hash: why.hash });
    expect(res.statusCode).toBe(200);
    expect(sb.hub.vision.get(P, "D-0001").status).toBe("abandoned");
  });

  it("un seul regroupement à la fois par projet", async () => {
    note("A");
    let release!: () => void;
    fake.extractions.push(() => ({ proposals: [], left_out: [] }) as never);
    const original = fake.structured.bind(fake);
    fake.structured = async (input) => {
      await new Promise<void>((r) => (release = r));
      return original(input);
    };
    const { post } = await login();
    expect((await post(`/api/human/projects/${P}/synthesis`)).statusCode).toBe(200);
    expect((await post(`/api/human/projects/${P}/synthesis`)).statusCode).toBe(409);
    release();
    await sb.hub.synthesis.idle();
  });
});
