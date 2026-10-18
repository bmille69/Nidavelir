import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealModel3D, rigAnimations } from "../src/art/model3d.ts";

/** Un faux Tripo : chaque tâche réussit tout de suite, sauf celles que `fail` désigne. */
function fakeTripo(opts: { rigType: string; fail?: (path: string, body: Record<string, unknown>) => boolean }) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const tasks = new Map<string, Record<string, unknown>>();
  let n = 0;
  const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (url.startsWith("https://cdn/")) return new Response(Buffer.from(path));
    if (path === "/v3/files") return json({ file_token: "tok" });
    if (path.startsWith("/v3/tasks/")) return json(tasks.get(path.slice("/v3/tasks/".length)));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body });
    if (opts.fail?.(path, body)) return new Response(JSON.stringify({ code: 2002, message: "Invalid input parameter" }), { status: 400 });
    const id = `t${++n}`;
    const output = path.endsWith("rig-check") ? { riggable: true, rig_type: opts.rigType } : { model_url: `https://cdn/${id}.glb` };
    tasks.set(id, { task_id: id, status: "success", output, credits_consumed: 10 });
    return json({ task_id: id });
  });
  return { fetch, calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m3d-"));
  mkdirSync(join(dir, "tools", "tripo"), { recursive: true });
  writeFileSync(join(dir, "tools", "tripo", "key.json"), JSON.stringify({ key: "tsk_test_0123456789" }));
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

async function run(m: RealModel3D, animations: string[]) {
  const p = m.tripo({ image: Buffer.from("png"), ext: "png", spec: { size: 0.8, tris: 3000, rig: true, animations }, seed: 1, step: () => {} });
  const done = p.then(
    (r) => ({ r, e: null }),
    (e: Error) => ({ r: null, e }),
  );
  for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(15_000);
  return done;
}

describe("Tripo (atelier 3D)", () => {
  it("quatre pattes : squelette v2.5, une tâche par animation, les suivantes rendues à part", async () => {
    const t = fakeTripo({ rigType: "quadruped" });
    vi.stubGlobal("fetch", t.fetch);
    const { r } = await run(new RealModel3D(dir), ["walk", "run", "slash"]);
    const rig = t.calls.find((c) => c.path === "/v3/animations/rig")!;
    expect(rig.body).toMatchObject({ model: "v2.5-20260210", rig_type: "quadruped" });
    const retargets = t.calls.filter((c) => c.path === "/v3/animations/retarget");
    expect(retargets.map((c) => c.body.animation)).toEqual(["preset:quadruped:walk"]);
    expect(r!.animations).toEqual(["quadruped:walk"]);
    expect(r!.extras).toEqual([]);
  });

  it("bipède : squelette v1.0 et plusieurs animations fusionnables", async () => {
    const t = fakeTripo({ rigType: "biped" });
    vi.stubGlobal("fetch", t.fetch);
    const { r } = await run(new RealModel3D(dir), ["walk", "slash"]);
    expect(t.calls.find((c) => c.path === "/v3/animations/rig")!.body).toMatchObject({ model: "v1.0-20240301", rig_type: "biped" });
    expect(t.calls.filter((c) => c.path === "/v3/animations/retarget").map((c) => c.body.animation)).toEqual(["preset:walk", "preset:slash"]);
    expect(r!.extras).toHaveLength(1);
    expect(r!.credits).toBe(50);
  });

  it("un squelette raté ne fait pas repayer le modèle à la tentative suivante", async () => {
    let failRig = true;
    const t = fakeTripo({ rigType: "quadruped", fail: (p) => failRig && p === "/v3/animations/rig" });
    vi.stubGlobal("fetch", t.fetch);
    const m = new RealModel3D(dir);
    const first = await run(m, ["walk"]);
    expect(first.e?.message).toMatch(/Invalid input parameter/);
    expect(m.state().tripo.credits).toBe(20);
    failRig = false;
    const second = await run(m, ["walk"]);
    expect(second.e).toBeNull();
    expect(t.calls.filter((c) => c.path === "/v3/generation/image-to-model")).toHaveLength(1);
  });

  it("les animations que le squelette sait jouer", () => {
    expect(rigAnimations("quadruped", ["walk", "quadruped:walk", "slash"])).toEqual(["quadruped:walk"]);
    expect(rigAnimations("biped", ["walk", "quadruped:walk", "slash"])).toEqual(["walk", "slash"]);
    expect(rigAnimations("serpentine", ["march"])).toEqual(["serpentine:march"]);
  });
});
