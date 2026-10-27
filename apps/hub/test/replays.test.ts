import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readReplay, runSavedReplays } from "../src/quality/replays.ts";
import type { ReplayResult } from "../src/godot/run.ts";
import { cleanupSandboxes, git, sandbox } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());

/** Une partie enregistrée par le relais : en-tête, entrées image par image, état du jeu toutes les 30 images. */
const RECORDING = [
  { studio_replay: 1, seed: 42, window: [1280, 720], at: "2026-10-27T15:00:00" },
  { f: 0, s: '{"score":0}' },
  { f: 12, e: { t: "mm", x: 10, y: 10, rx: 1, ry: 1, bm: 0, m: 0 } },
  { f: 13, e: { t: "key", k: 4194321, p: 4194321, u: 0, d: true, r: false, m: 0 } },
  { f: 30, s: '{"score":3}' },
  { f: 54, e: { t: "key", k: 4194321, p: 4194321, u: 0, d: false, r: false, m: 0 } },
  { f: 60, s: '{"score":5}' },
  { f: 63, end: true, s: "", events: 3 },
]
  .map((l) => JSON.stringify(l))
  .join("\n");

const ok: ReplayResult = { ok: true, frames: 64, events: 3, checked: 3, mismatches: [] };
const diverges: ReplayResult = { ok: false, frames: 64, events: 3, checked: 3, mismatches: [{ image: 60, seconde: 1, attendu: '{"score":5}', obtenu: '{"score":4}' }] };

async function setup() {
  const sb = sandbox();
  const root = sb.makeGameRepo("games/neon", { "project.godot": "config_version=5\n\n[autoload]\n\nStudioBridge=\"*res://addons/studio_bridge/bridge.gd\"\n", "addons/studio_bridge/bridge.gd": "extends Node\n" });
  await sb.hub.projects.register(sb.human(), { path: root, slug: "neon", name: "Néon" });
  const calls: string[] = [];
  const answers: ReplayResult[] = [];
  sb.hub.replays.replay = async (cwd, file) => {
    calls.push(`${cwd === root ? "jeu" : "copie"}:${file.split(/[\\/]/).pop()}`);
    return { result: answers.shift() ?? ok, errors: [] };
  };
  return { sb, root, calls, answers, replays: sb.hub.replays };
}

describe("vos parties rejouées comme tests (ADR-85)", () => {
  it("« ▶ Essayer » enregistre la partie d'un jeu Godot qui a le relais, et pas celle d'un jeu web", async () => {
    const { sb, root, replays } = await setup();
    const file = replays.recordPath("neon", null, root)!;
    expect(file).toMatch(/recordings[\\/]neon[\\/]\d{8}-\d{6}-jeu\.jsonl$/);
    expect(replays.recordPath("neon", "T-0004", root)).toMatch(/-t-0004\.jsonl$/);
    const web = sb.makeGameRepo("games/web", { "package.json": "{}" });
    expect(replays.recordPath("neon", null, web)).toBeNull();
  });

  it("une partie se lit : durée, actions (sans les mouvements de souris), points de contrôle", async () => {
    const { root, replays } = await setup();
    const file = replays.recordPath("neon", "T-0004", root)!;
    writeFileSync(file, RECORDING);
    expect(readReplay(file)).toMatchObject({ seconds: 1.1, inputs: 2, checkpoints: 3, finalState: '{"score":5}', header: { seed: 42 } });
    expect(replays.recordings("neon")).toEqual([expect.objectContaining({ task: "T-0004", seconds: 1.1, inputs: 2, checkpoints: 3 })]);
    // Une partie sans aucune action n'est pas montrée.
    writeFileSync(replays.recordPath("neon", null, root)!.replace(".jsonl", "-vide.jsonl"), [RECORDING.split("\n")[0], '{"f":0,"s":"{}"}'].join("\n"));
    expect(replays.recordings("neon")).toHaveLength(1);
  });

  it("garder une partie : rejouée deux fois sur le jeu actuel ; refusée si elle diverge, commitée sinon", async () => {
    const { sb, root, calls, answers, replays } = await setup();
    const file = replays.recordPath("neon", null, root)!;
    writeFileSync(file, RECORDING);
    const id = replays.recordings("neon")[0]!.id;
    await expect(replays.save({ id: "faux" } as never, "neon", id, { name: "x" })).rejects.toThrow();

    // Le jeu tire au hasard sans graine : la 2e fois ne retombe pas pareil.
    answers.push(ok, diverges);
    await expect(replays.save(sb.human(), "neon", id, { name: "Trois points" })).rejects.toThrow(/ne se rejoue pas à l'identique[\s\S]*à 1 s, l'état du jeu était \{"score":5\}[\s\S]*\{"score":4\}/);
    expect(existsSync(join(root, "studio", "replays"))).toBe(false);

    const saved = await replays.save(sb.human(), "neon", id, { name: "Trois points d'affilée", note: "le combo monte à 5" });
    expect(calls.filter((c) => c.startsWith("jeu:"))).toHaveLength(4);
    expect(saved).toMatchObject({ file: "trois-points-d-affilee.jsonl", name: "Trois points d'affilée", note: "le combo monte à 5", seconds: 1.1 });
    const stored = readFileSync(join(root, "studio", "replays", saved.file), "utf8").split("\n");
    expect(JSON.parse(stored[0]!)).toMatchObject({ studio_replay: 1, seed: 42, name: "Trois points d'affilée", from: expect.stringMatching(/-jeu\.jsonl$/) });
    expect(git(root, "log", "-1", "--format=%s")).toMatch(/partie « Trois points d'affilée » gardée comme test/);
    expect(replays.recordings("neon")).toEqual([]);
    expect(replays.saved("neon")).toHaveLength(1);

    await replays.unsave(sb.human(), "neon", saved.file);
    expect(replays.saved("neon")).toEqual([]);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("une partie sans état du jeu à comparer ne peut pas devenir un test", async () => {
    const { sb, root, replays } = await setup();
    const file = replays.recordPath("neon", null, root)!;
    writeFileSync(file, RECORDING.split("\n").filter((l) => !l.includes('"s"')).join("\n"));
    await expect(replays.save(sb.human(), "neon", replays.recordings("neon")[0]!.id, { name: "x" })).rejects.toThrow(/aucun état du jeu/);
  });

  it("vérification du hub : chaque partie gardée rejouée, la divergence dite en clair avec ce que vous vérifiiez", async () => {
    const { root } = await setup();
    mkdirSync(join(root, "studio", "replays"), { recursive: true });
    const header = (name: string, note = "") => JSON.stringify({ ...JSON.parse(RECORDING.split("\n")[0]!), name, note });
    writeFileSync(join(root, "studio", "replays", "a.jsonl"), [header("Combo"), ...RECORDING.split("\n").slice(1)].join("\n"));
    writeFileSync(join(root, "studio", "replays", "b.jsonl"), [header("Vague 2", "la tourelle tire"), ...RECORDING.split("\n").slice(1)].join("\n"));
    const answers = [ok, diverges];
    const out = await runSavedReplays(root, async () => ({ result: answers.shift()!, errors: [] }));
    expect(out.status).toBe("fail");
    expect(out.detail).toMatch(/^1\/2 partie\(s\) rejouée\(s\) à l'identique\n✓ « Combo » : rejouée à l'identique \(3 points de contrôle\)\n✗ « Vague 2 » : à 1 s[\s\S]*\(ce que vous vérifiiez : la tourelle tire\)$/);
    const crash = await runSavedReplays(root, async () => ({ result: ok, errors: ["SCRIPT ERROR: Invalid call (res://scripts/tour.gd:12)"] }));
    expect(crash.detail).toMatch(/le jeu a écrit des erreurs pendant la partie : SCRIPT ERROR/);
    expect((await runSavedReplays(join(root, "studio"), async () => ({ result: ok, errors: [] }))).status).toBe("none");
  });
});
