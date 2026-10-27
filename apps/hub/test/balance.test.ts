import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareSims, describeSim, summarize, type SimSummary } from "../src/godot/sim.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, sandbox } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());

/** 100 parties : la vague atteinte va de 5 à 9, une victoire sur 4, la cause de défaite. */
const parties = (shift = 0) =>
  Array.from({ length: 100 }, (_, i) => ({ vague: 5 + ((i + shift) % 5), victoire: i % 4 === 0, cause: i % 4 === 0 ? "aucune" : i % 3 ? "fuite" : "boss", or: 200 + i }));

describe("l'équilibreur (ADR-86)", () => {
  it("les parties deviennent des distributions : moyenne, centiles, histogramme, taux, causes", () => {
    const m = summarize(parties());
    expect(m.vague).toMatchObject({ kind: "number", n: 100, mean: 7, min: 5, max: 9, p10: 5, p50: 7, p90: 9 });
    expect(m.vague!.kind === "number" && m.vague!.histogram.reduce((a, h) => a + h.count, 0)).toBe(100);
    expect(m.victoire).toEqual({ kind: "bool", n: 100, rate: 0.25 });
    expect(m.cause).toMatchObject({ kind: "text", top: [{ value: "fuite", count: 50 }, { value: "aucune", count: 25 }, { value: "boss", count: 25 }] });
  });

  it("ce qui a bougé depuis le passage précédent, en clair", () => {
    const sim = (runs: ReturnType<typeof parties>): SimSummary => ({ name: "res://tests/sims/sim_vagues.gd", runs: runs.length, seconds: 0.4, seed: 1, metrics: summarize(runs) });
    const before = sim(parties());
    const after = sim(parties().map((p) => ({ ...p, vague: p.vague + 2, victoire: p.vague > 6 })));
    expect(compareSims(after, before)).toEqual(["vague : 7 → 9 en moyenne (+29 %)", "victoire : 25 % → 60 % des parties"]);
    expect(describeSim(after, before)).toMatch(/^sim_vagues\.gd — 100 parties en 0,40 s\n- cause : « fuite » 50 %[\s\S]*- vague : moyenne 9, de 7 à 11 \(9 parties sur 10 entre 7 et 11\)[\s\S]*Depuis le passage précédent : vague : 7 → 9/);
  });

  it("jouer les parties en arrière-plan, garder les passages, et les confier au directeur", async () => {
    const fake = new FakeOrchestrator();
    const sb = sandbox(fake);
    const root = sb.makeGameRepo("games/neon", { "project.godot": "config_version=5\n" });
    await sb.hub.projects.register(sb.human(), { path: root, slug: "neon", name: "Néon" });
    const balance = sb.hub.balance;
    expect(balance.state("neon")).toMatchObject({ available: true, hasSims: false, latest: null });
    const asked: number[] = [];
    let shift = 0;
    balance.runner = async (_cwd, runs) => {
      asked.push(runs);
      return { sims: [{ name: "res://tests/sims/sim_vagues.gd", runs, seconds: 0.4, seed: 1, metrics: summarize(parties(shift)) }], errors: [] };
    };
    expect(() => balance.start({ id: "faux" } as never, "neon")).toThrow();
    mkdirSync(join(root, "tests", "sims"), { recursive: true });
    balance.start(sb.human(), "neon", 200);
    await balance.idle();
    shift = 2;
    balance.start(sb.human(), "neon", 5000);
    await balance.idle();
    expect(asked).toEqual([200, 2000]);
    const st = balance.state("neon");
    expect(st).toMatchObject({ hasSims: true, running: false, latest: { status: "done", runs: 2000 }, previous: { runs: 200 } });
    expect(st.latest!.commit).toMatch(/^[0-9a-f]{40}$/);

    fake.replies.push("Je propose : vague 7, 18 ennemis au lieu de 19.");
    const { thread } = await balance.send(sb.human(), "neon", st.latest!.id, "La vague 7 est un mur.");
    await sb.hub.conversations.idle();
    const sent = sb.hub.conversations.messages("neon", thread)[0]!.text;
    expect(sent).toMatch(/^Le hub a joué 2000 parties de chaque simulation[\s\S]*sim_vagues\.gd — 2000 parties[\s\S]*La vague 7 est un mur\.$/);
    expect(sb.hub.journal.list({ project: "neon" }).some((e) => e.type === "balance.ran")).toBe(true);

    // Un jeu web n'a pas d'équilibreur.
    const web = sb.makeGameRepo("games/web", { "package.json": "{}" });
    await sb.hub.projects.register(sb.human(), { path: web, slug: "web", name: "Web" });
    expect(() => balance.start(sb.human(), "web")).toThrow(/jeux Godot/);
  });

  it("une simulation qui écrit des erreurs ou l'absence de simulation sont dites", async () => {
    const sb = sandbox();
    const root = sb.makeGameRepo("games/neon", { "project.godot": "config_version=5\n" });
    await sb.hub.projects.register(sb.human(), { path: root, slug: "neon", name: "Néon" });
    sb.hub.balance.runner = async () => ({ sims: [], errors: [] });
    sb.hub.balance.start(sb.human(), "neon");
    await sb.hub.balance.idle();
    expect(sb.hub.balance.state("neon").latest).toMatchObject({ status: "failed", error: expect.stringMatching(/Aucune simulation/) });
  });
});
