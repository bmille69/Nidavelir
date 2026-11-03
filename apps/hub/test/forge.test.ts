import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Scope } from "../src/executor/foreman.ts";
import { createHub, type Hub } from "../src/hub.ts";
import { forgeSnapshot } from "../src/studio/forge.ts";
import { FakeExecutor, REPORT, VERIFIED } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox, type Sandbox } from "./helpers.ts";

/** La Forge (ADR-106) : la photographie d'un jeu pour la vue en voxels, en lecture seule. */
vi.setConfig({ testTimeout: 40_000 });
afterEach(() => cleanupSandboxes());

const P = "jeu";

class Orchestrator extends FakeOrchestrator {
  readonly scopes = new Map<string, Partial<Scope>>();
  override async structured(input: { systemPrompt: string; prompt: string; jsonSchema: object; skillsDir?: string }) {
    if (!input.systemPrompt.includes("CHEF DE CHANTIER")) return super.structured(input);
    const id = /<chantier id="(T-\d+)">/.exec(input.prompt)![1]!;
    return { data: { files: [], depends_on: [], confident: false, note: "?", ...this.scopes.get(id) }, costUsd: 0.002 };
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

async function until(check: () => boolean) {
  for (let k = 0; k < 400 && !check(); k++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

describe("La Forge", () => {
  it("au repos, puis un établi occupé, un chantier qui attend avec sa raison, et la fusion comptée", async () => {
    const orch = new Orchestrator();
    const exec = new FakeExecutor();
    const sb: Sandbox = sandbox();
    sb.hub.close();
    const hub = createHub({
      databasePath: join(sb.dir, "hub/.data/forge.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      orchestrator: orch,
      executor: exec,
      dataDir: join(sb.dir, "hub/.data"),
      autopilot: { synthesisDelayMs: 0 },
      parallel: 2,
    });
    sb.hub = hub;
    const root = sb.makeGameRepo("games/jeu", { "README.md": "# Jeu\n", "src/main.ts": "export {};\n" });
    await hub.projects.register(sb.human(), { path: root, slug: P, name: "Jeu" });
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    const thread = hub.conversations.createThread(P, "Chantiers").id;

    const idle = forgeSnapshot(hub, P);
    expect(idle).toMatchObject({ project: { slug: P, name: "Jeu", autonomy: "workshop" }, parallel: 2, benches: [], queue: [], merged: [], today: { merged: 0, failed: 0 }, scouting: false });
    expect(idle.pool.max).toBeGreaterThanOrEqual(1);

    const a = hub.tasks.createFromConversation(P, { title: "Grille", goal: "Où : src/grille.ts" }, thread);
    const b = hub.tasks.createFromConversation(P, { title: "Grille plus grande", goal: "Où : src/grille.ts" }, thread);
    orch.scopes.set(a.id, { files: ["src/grille.ts"], confident: true, note: "la grille" });
    orch.scopes.set(b.id, { files: ["src/grille.ts"], confident: true, note: "une grille plus grande" });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    exec.scripts.execute.push(async (t) => {
      await gate;
      await t.write("src/grille.ts", "export const taille = 10;\n");
      return REPORT;
    });
    exec.scripts.execute.push(async (t) => {
      await t.write("src/grille.ts", "export const taille = 12;\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED, () => VERIFIED);

    await hub.tasks.launch(P, a.id);
    await hub.tasks.launch(P, b.id);
    await until(() => forgeSnapshot(hub, P).benches[0]?.phase === "execute" && forgeSnapshot(hub, P).queue[0]?.scoped === true);
    const busy = forgeSnapshot(hub, P);
    expect(busy.benches).toHaveLength(1);
    expect(busy.benches[0]).toMatchObject({ task: { id: a.id, title: "Grille" }, phase: "execute", run: { kind: "execute" }, note: "la grille", files: ["src/grille.ts"] });
    expect(busy.queue).toEqual([{ id: b.id, title: "Grille plus grande", scoped: true, waiting: `attend ${a.id} : ils touchent tous deux src/grille.ts` }]);

    open();
    await settle(hub);
    const after = forgeSnapshot(hub, P);
    expect(after.benches).toEqual([]);
    expect(after.queue).toEqual([]);
    expect(after.merged.map((m) => m.id).sort()).toEqual([a.id, b.id]);
    expect(after.today.merged).toBe(2);
  });
});
