import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conflictBetween, pathsIn, type Scope } from "../src/executor/foreman.ts";
import { createHub, type Hub } from "../src/hub.ts";
import { FakeExecutor, REPORT, VERIFIED } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, git, sandbox, type Sandbox } from "./helpers.ts";

/** Le chef de chantier et plusieurs développeurs sur le même jeu (ADR-104). */
vi.setConfig({ testTimeout: 40_000 });
afterEach(() => cleanupSandboxes());

const P = "jeu";

/** Orchestrateur de test : le chef de chantier rend la fiche préparée pour chaque chantier ; le reste comme d'habitude. */
class Orchestrator extends FakeOrchestrator {
  readonly scopes = new Map<string, Partial<Scope> | Error>();
  readonly scouted: string[] = [];
  override async structured(input: { systemPrompt: string; prompt: string; jsonSchema: object; skillsDir?: string }) {
    if (!input.systemPrompt.includes("CHEF DE CHANTIER")) return super.structured(input);
    const id = /<chantier id="(T-\d+)">/.exec(input.prompt)![1]!;
    this.scouted.push(id);
    const s = this.scopes.get(id);
    if (s instanceof Error) throw s;
    return { data: { files: [], depends_on: [], confident: false, note: "?", ...s }, costUsd: 0.002 };
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

async function setup(parallel = 2) {
  const orch = new Orchestrator();
  const exec = new FakeExecutor();
  const sb: Sandbox = sandbox();
  sb.hub.close();
  const hub = createHub({
    databasePath: join(sb.dir, "hub/.data/paralleles.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    orchestrator: orch,
    executor: exec,
    dataDir: join(sb.dir, "hub/.data"),
    autopilot: { synthesisDelayMs: 0 },
    parallel,
  });
  sb.hub = hub;
  const root = sb.makeGameRepo("games/jeu", { "README.md": "# Jeu\n", "src/main.ts": "export {};\n" });
  await hub.projects.register(sb.human(), { path: root, slug: P, name: "Jeu" });
  hub.projects.setAutonomy(sb.human(), P, "workshop");
  const thread = hub.conversations.createThread(P, "Chantiers").id;
  const chantier = (title: string, goal: string) => hub.tasks.createFromConversation(P, { title, goal }, thread);
  const notes = () => hub.conversations.messages(P, thread).map((m) => m.text);
  return { hub, orch, exec, root, chantier, notes };
}

/** Une porte : le premier développeur attend que le second ait commencé (preuve qu'ils travaillent en même temps). */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

describe("fiche du chef de chantier", () => {
  const scope = (files: string[], extra: Partial<Scope> = {}): Scope => ({ files, depends_on: [], confident: true, note: "", at: "", ...extra });

  it("deux chantiers sont compatibles seulement sans fichier commun, sans dépendance, avec deux fiches sûres", () => {
    expect(conflictBetween({ id: "T-0001", scope: scope(["src/a.ts"]) }, { id: "T-0002", scope: scope(["src/b.ts"]) })).toBeNull();
    expect(conflictBetween({ id: "T-0001", scope: scope(["src/A.ts"]) }, { id: "T-0002", scope: scope(["src\\a.ts"]) })).toMatch(/touchent tous deux src\/a\.ts/);
    expect(conflictBetween({ id: "T-0001", scope: scope(["src/ui/"]) }, { id: "T-0002", scope: scope(["src/ui/hud.ts"]) })).toMatch(/touchent tous deux/);
    expect(conflictBetween({ id: "T-0002", scope: scope(["src/b.ts"], { depends_on: ["T-0001"] }) }, { id: "T-0001", scope: scope(["src/a.ts"]) })).toMatch(/T-0002 s'appuie sur T-0001/);
    expect(conflictBetween({ id: "T-0001", scope: scope(["src/a.ts"], { confident: false }) }, { id: "T-0002", scope: scope(["src/b.ts"]) })).toMatch(/trop incertain/);
    expect(conflictBetween({ id: "T-0001", scope: null }, { id: "T-0002", scope: scope(["src/b.ts"]) })).toMatch(/pas encore prête/);
    // Ce qu'un chantier en cours a réellement touché compte, même hors de sa fiche.
    expect(conflictBetween({ id: "T-0002", scope: scope(["src/b.ts"]) }, { id: "T-0001", scope: scope(["src/a.ts"]), touched: ["src/b.ts"] })).toMatch(/src\/b\.ts/);
  });

  it("les chemins cités dans la consigne entrent dans la fiche", () => {
    expect(pathsIn("Objectif : une grille.\nOù : src/grille.ts et scenes/ui/hud.tscn\nVérification : npm test")).toEqual(["src/grille.ts", "scenes/ui/hud.tscn"]);
  });
});

describe("plusieurs développeurs sur le même jeu", () => {
  it("deux chantiers sans fichier commun avancent en même temps, puis le second est réuni avec le premier avant sa fusion", async () => {
    const { hub, orch, exec, root, chantier, notes } = await setup();
    const a = chantier("Grille", "Une grille de 10 cases.\nOù : src/grille.ts");
    const b = chantier("Sons", "Des sons de pas.\nOù : src/sons.ts");
    orch.scopes.set(a.id, { files: ["src/grille.ts"], confident: true, note: "la grille" });
    orch.scopes.set(b.id, { files: ["src/sons.ts"], confident: true, note: "les sons de pas" });
    const together = gate();
    exec.scripts.execute.push(async (t) => {
      await together.opened;
      await t.write("src/grille.ts", "export const taille = 10;\n");
      return REPORT;
    });
    exec.scripts.execute.push(async (t, req) => {
      together.open();
      expect(req.prompt).toMatch(/<travail_en_parallele>[\s\S]*Périmètre prévu par le chef de chantier : src\/sons\.ts[\s\S]*T-0001 « Grille » est en cours dans une autre copie et a en main : src\/grille\.ts/);
      await t.write("src/sons.ts", "export const pas = 'tap';\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED, () => VERIFIED);

    await hub.tasks.launch(P, a.id);
    const second = await hub.tasks.launch(P, b.id);
    expect(second).toMatchObject({ scouting: true, after: { id: a.id } });
    await settle(hub);

    expect([hub.tasks.get(P, a.id).status, hub.tasks.get(P, b.id).status]).toEqual(["merged", "merged"]);
    expect(git(root, "show", "HEAD:src/grille.ts")).toMatch(/taille = 10/);
    expect(git(root, "show", "HEAD:src/sons.ts")).toMatch(/tap/);
    expect(notes().join("\n")).toMatch(/⇉ Chantier T-0002 « Sons » démarre en même temps que T-0001 : le chef de chantier ne voit aucun fichier en commun \(les sons de pas\)/);
    // Le second à finir a été réuni avec la version du jeu qui contenait le premier, sans conflit.
    const integrated = hub.journal.list({ project: P, limit: 5000 }).filter((e) => e.type === "task.integrated");
    expect(integrated).toHaveLength(1);
    expect(integrated[0]!.payload).toMatchObject({ conflicts: [] });
    expect(orch.scouted.sort()).toEqual([a.id, b.id]);
    expect(hub.tasks.occupying(P)).toEqual([]);
  });

  it("deux chantiers qui touchent le même fichier : le second attend, le dit, puis part de la version qui contient le premier", async () => {
    const { hub, orch, exec, root, chantier, notes } = await setup();
    const a = chantier("Grille", "Où : src/grille.ts");
    const b = chantier("Grille plus grande", "Où : src/grille.ts");
    orch.scopes.set(a.id, { files: ["src/grille.ts"], confident: true });
    orch.scopes.set(b.id, { files: ["src/grille.ts"], confident: true });
    exec.scripts.execute.push(async (t) => {
      await t.write("src/grille.ts", "export const taille = 10;\n");
      return REPORT;
    });
    exec.scripts.execute.push(async (t, req) => {
      expect(existsSync(join(req.cwd, "src/grille.ts"))).toBe(true);
      await t.write("src/grille.ts", "export const taille = 12;\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED, () => VERIFIED);
    await hub.tasks.launch(P, a.id);
    await hub.tasks.launch(P, b.id);
    await settle(hub);
    expect(notes().join("\n")).toMatch(/⏳ Chantier T-0002 « Grille plus grande » attend T-0001 : ils touchent tous deux src\/grille\.ts/);
    expect(hub.journal.list({ project: P, limit: 5000 }).filter((e) => e.type === "task.parallel")).toEqual([]);
    expect(git(root, "show", "HEAD:src/grille.ts")).toBe("export const taille = 12;\n");
  });

  it("le chef de chantier en panne : rien ne part en parallèle, le chantier attend son tour comme avant", async () => {
    const { hub, orch, exec, chantier, notes } = await setup();
    const a = chantier("Un", "Où : src/un.ts");
    const b = chantier("Deux", "Où : src/deux.ts");
    orch.scopes.set(a.id, new Error("quota"));
    orch.scopes.set(b.id, new Error("quota"));
    for (const f of ["src/un.ts", "src/deux.ts"]) {
      exec.scripts.execute.push(async (t) => {
        await t.write(f, "export {};\n");
        return REPORT;
      });
      exec.scripts.verify.push(() => VERIFIED);
    }
    await hub.tasks.launch(P, a.id);
    await hub.tasks.launch(P, b.id);
    await settle(hub);
    expect(notes().join("\n")).toMatch(/attend T-0001 : le périmètre de T-0002 est trop incertain/);
    expect(hub.tasks.get(P, b.id).scope).toMatchObject({ confident: false, note: expect.stringMatching(/Chef de chantier indisponible/) });
    expect([hub.tasks.get(P, a.id).status, hub.tasks.get(P, b.id).status]).toEqual(["merged", "merged"]);
  });

  it("une prévision ratée : les deux ont modifié les mêmes lignes ; le dernier réconcilie les deux versions avant sa fusion", async () => {
    const { hub, orch, exec, root, chantier, notes } = await setup();
    const a = chantier("Vie", "Où : src/vie.ts");
    const b = chantier("Mana", "Où : src/mana.ts");
    orch.scopes.set(a.id, { files: ["src/vie.ts"], confident: true });
    orch.scopes.set(b.id, { files: ["src/mana.ts"], confident: true });
    const together = gate();
    const firstDone = gate();
    exec.scripts.execute.push(async (t) => {
      await together.opened;
      await t.write("src/main.ts", "export const vie = 100;\n");
      return REPORT;
    });
    exec.scripts.execute.push(async (t) => {
      together.open();
      await t.write("src/main.ts", "export const mana = 50;\n");
      firstDone.open();
      return REPORT;
    });
    // La passe de réconciliation : les marqueurs sont là ; elle garde les deux intentions.
    exec.scripts.execute.push(async (t, req) => {
      expect(req.prompt).toMatch(/Réconciliation avec la version actuelle du jeu[\s\S]*- src\/main\.ts/);
      const text = readFileSync(join(req.cwd, "src/main.ts"), "utf8");
      expect(text).toMatch(/^<{7} /m);
      await t.write("src/main.ts", "export const vie = 100;\nexport const mana = 50;\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED, () => VERIFIED, () => VERIFIED);
    await hub.tasks.launch(P, a.id);
    await hub.tasks.launch(P, b.id);
    await settle(hub);
    expect([hub.tasks.get(P, a.id).status, hub.tasks.get(P, b.id).status]).toEqual(["merged", "merged"]);
    expect(git(root, "show", "HEAD:src/main.ts")).toBe("export const vie = 100;\nexport const mana = 50;\n");
    expect(notes().join("\n")).toMatch(/d'autres chantiers ont été fusionnés et touchent les mêmes lignes \(src\/main\.ts\)\. Le développeur réconcilie les deux versions/);
    expect(hub.journal.list({ project: P, limit: 5000 }).filter((e) => e.type === "task.integrated").map((e) => e.payload)).toContainEqual(expect.objectContaining({ conflicts: ["src/main.ts"] }));
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("une réconciliation qui laisse un marqueur n'est jamais enregistrée : le chantier échoue et se relance de zéro", async () => {
    const { hub, orch, exec, root, chantier } = await setup();
    const a = chantier("Vie", "Où : src/vie.ts");
    const b = chantier("Mana", "Où : src/mana.ts");
    orch.scopes.set(a.id, { files: ["src/vie.ts"], confident: true });
    orch.scopes.set(b.id, { files: ["src/mana.ts"], confident: true });
    const together = gate();
    exec.scripts.execute.push(async (t) => {
      await together.opened;
      await t.write("src/main.ts", "export const vie = 100;\n");
      return REPORT;
    });
    exec.scripts.execute.push(async (t) => {
      together.open();
      await t.write("src/main.ts", "export const mana = 50;\n");
      return REPORT;
    });
    exec.scripts.execute.push(async () => REPORT);
    exec.scripts.verify.push(() => VERIFIED, () => VERIFIED);
    await hub.tasks.launch(P, a.id);
    await hub.tasks.launch(P, b.id);
    await settle(hub);
    const statuses = [hub.tasks.get(P, a.id).status, hub.tasks.get(P, b.id).status].sort();
    expect(statuses).toEqual(["failed", "merged"]);
    const failed = [a.id, b.id].find((id) => hub.tasks.get(P, id).status === "failed")!;
    expect(hub.tasks.runs(P, failed).at(-1)!.error).toMatch(/Réconciliation inachevée : marqueurs de conflit encore présents dans src\/main\.ts/);
    // Le jeu n'a jamais reçu de marqueur.
    expect(git(root, "show", "HEAD:src/main.ts")).not.toMatch(/<{7}/);
  });

  it("sans le réglage (un chantier par jeu, comme avant), le chef de chantier n'est jamais appelé", async () => {
    const { hub, orch, exec, chantier } = await setup(1);
    const a = chantier("Un", "Où : src/un.ts");
    const b = chantier("Deux", "Où : src/deux.ts");
    for (const f of ["src/un.ts", "src/deux.ts"]) {
      exec.scripts.execute.push(async (t) => {
        await t.write(f, "export {};\n");
        return REPORT;
      });
      exec.scripts.verify.push(() => VERIFIED);
    }
    await hub.tasks.launch(P, a.id);
    const second = await hub.tasks.launch(P, b.id);
    expect(second.scouting).toBeUndefined();
    await settle(hub);
    expect(orch.scouted).toEqual([]);
    expect(exec.requests.filter((r) => r.kind === "execute").every((r) => !/travail_en_parallele/.test(r.prompt))).toBe(true);
    expect(hub.tasks.integrate).toBeDefined();
    expect(hub.journal.list({ project: P, limit: 5000 }).filter((e) => e.type === "task.integrated")).toEqual([]);
  });
});
