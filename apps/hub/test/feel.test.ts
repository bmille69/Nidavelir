import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHub } from "../src/hub.ts";
import { DEFAULT_MOMENTS, feelGoal } from "../src/quality/feel.ts";
import { FakeExecutor, REPORT, VERIFIED } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());
const P = "neon";

describe("la passe « game feel » (ADR-88)", () => {
  it("la consigne : les moments, l'intensité, un fichier de réglages, aucune règle touchée, et la preuve", () => {
    const godot = feelGoal({ moments: "la mort d'un ennemi", intensity: "genereux", godot: true, sims: true, replays: true });
    expect(godot).toMatch(/^Passe « game feel » sur : la mort d'un ennemi\. Intensité généreuse/);
    expect(godot).toContain("res://scripts/feel.gd");
    expect(godot).toMatch(/Interdit : changer une règle/);
    expect(godot).toMatch(/pas de Engine\.time_scale/);
    expect(godot).toMatch(/parties gardées \(studio\/replays\)[\s\S]*simulations d'équilibrage \(tests\/sims\)/);
    expect(godot).toMatch(/mouvements réduits/);
    const web = feelGoal({ moments: DEFAULT_MOMENTS, intensity: "discret", godot: false, sims: false, replays: false });
    expect(web).toContain("src/feel.ts");
    expect(web).not.toMatch(/studio\/replays|tests\/sims/);
    expect(web.length).toBeLessThan(4000);
  });

  it("un clic lance le chantier, suivi dans sa discussion ; il attend son tour si le projet est occupé ; refusé en « Je valide tout »", async () => {
    const sb = sandbox();
    const exec = new FakeExecutor();
    sb.hub.close();
    const hub = createHub({
      databasePath: join(sb.dir, "hub/.data/feel.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      orchestrator: new FakeOrchestrator(),
      executor: exec,
      dataDir: join(sb.dir, "hub/.data"),
    });
    sb.hub = hub;
    const root = sb.makeGameRepo("games/neon", { "project.godot": "config_version=5\n", "README.md": "# Néon\n" });
    mkdirSync(join(root, "tests", "sims"), { recursive: true });
    writeFileSync(join(root, "tests", "sims", ".keep"), "");
    await hub.projects.register(sb.human(), { path: root, slug: P, name: "Néon" });

    hub.projects.setAutonomy(sb.human(), P, "supervised");
    await expect(hub.feel.start(sb.human(), P, {})).rejects.toThrow(/Je valide tout/);
    await expect(hub.feel.start({ id: "x" } as never, P, {})).rejects.toThrow();
    hub.projects.setAutonomy(sb.human(), P, "workshop");

    let release!: () => void;
    exec.scripts.execute.push(async (t) => {
      await new Promise<void>((r) => (release = r));
      await t.write("scripts/feel.gd", "extends Node\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    const first = await hub.feel.start(sb.human(), P, { moments: "les tirs des tourelles", intensity: "discret" });
    expect(first.after).toBeNull();
    expect(first.task).toMatchObject({ title: "Game feel : les tirs des tourelles", origin: { thread: first.thread }, direct: true });
    expect(first.task.goal).toMatch(/Intensité discrète[\s\S]*tests\/sims/);
    expect(hub.conversations.messages(P, first.thread).at(-1)!.text).toMatch(/^✦ Passe « game feel » demandée par vous : les tirs des tourelles \(intensité discrète\)\.\n→ Chantier T-0001 lancé\./);

    // Le projet est occupé : la seconde passe attend son tour.
    const second = await hub.feel.start(sb.human(), P, {});
    expect(second.after).toBe("T-0001");
    expect(second.task.title).toBe(`Game feel : ${DEFAULT_MOMENTS.slice(0, 67)}…`);
    expect(hub.tasks.queued(P).map((t) => t.id)).toEqual([second.task.id]);
    expect(exec.requests[0]!.prompt).toContain("les tirs des tourelles");
    release();
    await hub.tasks.idle();
    expect(hub.tasks.get(P, "T-0001").status).toBe("review");
    expect(hub.journal.list({ project: P }).filter((e) => e.type === "feel.requested")).toHaveLength(2);
    hub.tasks.unqueue(P, second.task.id);
  });
});
