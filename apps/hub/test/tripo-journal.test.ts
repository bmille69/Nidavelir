import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealModel3D } from "../src/art/model3d.ts";
import { orderFingerprint, TripoJournal } from "../src/art/tripo-journal.ts";

/**
 * Un faux Tripo réglable : chaque commande devient une tâche, réussie tout de suite sauf si `hold` la garde « en cours »
 * ou si `fail` la fait échouer ; `forget` fait oublier une tâche (réponse 404).
 */
function fakeTripo(opts: { rigType?: string } = {}) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const tasks = new Map<string, Record<string, unknown>>();
  const ctl = { hold: (_p: string, _b: Record<string, unknown>) => false, fail: (_p: string, _b: Record<string, unknown>) => false, uploads: 0 };
  let n = 0;
  const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (url.startsWith("https://cdn/")) return new Response(Buffer.from(path));
    if (path === "/v3/files") {
      ctl.uploads++;
      return json({ file_token: `tok${ctl.uploads}` });
    }
    if (path.startsWith("/v3/tasks/")) {
      const t = tasks.get(path.slice("/v3/tasks/".length));
      return t ? json(t) : new Response(JSON.stringify({ code: 2001, message: "task not found" }), { status: 404 });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posts.push({ path, body });
    const id = `t${++n}`;
    const output = path.endsWith("rig-check") ? { riggable: true, rig_type: opts.rigType ?? "biped" } : { model_url: `https://cdn/${id}.glb` };
    const status = ctl.fail(path, body) ? "failed" : ctl.hold(path, body) ? "running" : "success";
    tasks.set(id, { task_id: id, status, output, credits_consumed: 10, progress: status === "running" ? 40 : 100 });
    return json({ task_id: id });
  });
  return {
    fetch,
    posts,
    ctl,
    finish: (id: string) => tasks.set(id, { ...tasks.get(id)!, status: "success" }),
    forget: (id: string) => tasks.delete(id),
    count: (path: string) => posts.filter((p) => p.path === path).length,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tripo-journal-"));
  mkdirSync(join(dir, "tools", "tripo"), { recursive: true });
  writeFileSync(join(dir, "tools", "tripo", "key.json"), JSON.stringify({ key: "tsk_test_0123456789" }));
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const spec = (animations: string[] = ["walk", "run"]) => ({ size: 1.7, tris: 8000, rig: animations.length > 0, animations });

/** Lance une fabrication et fait avancer le temps ; `minutes` : jusqu'où (une attente coupée simule un arrêt du hub). */
async function make(m: RealModel3D, animations?: string[], seed = 1, minutes = 15) {
  const steps: string[] = [];
  const p = m.tripo({ image: Buffer.from("png-du-heros"), ext: "png", spec: spec(animations), seed, step: (s) => steps.push(s) });
  const done = p.then(
    (r) => ({ r, e: null as Error | null }),
    (e: Error) => ({ r: null, e }),
  );
  for (let i = 0; i < (minutes * 60) / 15; i++) await vi.advanceTimersByTimeAsync(15_000);
  return { done, steps };
}

const credits = () => (JSON.parse(readFileSync(join(dir, "tools", "tripo", "usage.json"), "utf8")) as { credits: number }).credits;

describe("le carnet de commandes Tripo (ADR-70)", () => {
  it("hub coupé pendant que Tripo fabrique : la relance reprend la commande, sans renvoyer l'image ni repayer", async () => {
    const t = fakeTripo();
    vi.stubGlobal("fetch", t.fetch);
    t.ctl.hold = (p) => p === "/v3/generation/image-to-model";
    let alive = true;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (alive ? t.fetch(url, init) : Promise.reject(new Error("hub arrêté"))));
    const first = await make(new RealModel3D(dir), undefined, 1, 3);
    expect(t.count("/v3/generation/image-to-model")).toBe(1);
    // Le hub s'arrête pendant l'attente : la fabrication meurt, seule la commande notée survit.
    alive = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await first.done).e?.message).toBe("hub arrêté");
    alive = true;
    t.finish("t1");
    t.ctl.hold = () => false;

    // Après le redémarrage : un autre objet, une autre graine, la même demande.
    const second = await make(new RealModel3D(dir), undefined, 777);
    const { r, e } = await second.done;
    expect(e).toBeNull();
    expect(t.count("/v3/generation/image-to-model")).toBe(1);
    expect(t.ctl.uploads).toBe(1);
    expect(second.steps).toContain("Tripo fabrique le modèle : commande déjà passée, reprise sans repayer");
    expect(r!.animations).toEqual(["walk", "run"]);
    // Modèle, contrôle, squelette, deux animations : chaque commande comptée une fois.
    expect(r!.credits).toBe(50);
    expect(credits()).toBe(50);
  });

  it("une animation ratée chez Tripo : la tentative suivante ne repaie ni le modèle, ni le squelette, ni la première animation", async () => {
    const t = fakeTripo();
    vi.stubGlobal("fetch", t.fetch);
    let failRun = true;
    t.ctl.fail = (p, b) => failRun && p === "/v3/animations/retarget" && b.animation === "preset:run";
    const m = new RealModel3D(dir);
    const first = await (await make(m)).done;
    expect(first.e?.message).toMatch(/« run » \(2\/2\) a échoué/);
    expect(credits()).toBe(40);
    failRun = false;
    const second = await (await make(m, undefined, 2)).done;
    expect(second.e).toBeNull();
    expect(t.posts.map((p) => p.path.split("/").pop())).toEqual(["image-to-model", "rig-check", "rig", "retarget", "retarget", "retarget"]);
    expect(second.r!.credits).toBe(10);
    expect(credits()).toBe(50);
  });

  it("une fabrication réussie vide le carnet : refaire la 3D achète bien un nouveau modèle", async () => {
    const t = fakeTripo();
    vi.stubGlobal("fetch", t.fetch);
    const m = new RealModel3D(dir);
    expect((await (await make(m, [])).done).e).toBeNull();
    expect(new TripoJournal(join(dir, "tools", "tripo", "journal.json")).list()).toEqual([]);
    expect((await (await make(m, [], 9)).done).e).toBeNull();
    expect(t.count("/v3/generation/image-to-model")).toBe(2);
  });

  it("une commande que Tripo a oubliée est repassée ; une qu'il a fait échouer n'est pas reprise", async () => {
    const t = fakeTripo();
    vi.stubGlobal("fetch", t.fetch);
    t.ctl.hold = (p) => p === "/v3/generation/image-to-model";
    void (await make(new RealModel3D(dir), [], 1, 3)).done;
    t.forget("t1");
    t.ctl.hold = () => false;
    const again = await (await make(new RealModel3D(dir), [], 2)).done;
    expect(again.e).toBeNull();
    expect(t.count("/v3/generation/image-to-model")).toBe(2);

    t.ctl.fail = (p) => p === "/v3/generation/image-to-model";
    expect((await (await make(new RealModel3D(dir), [], 3)).done).e?.message).toMatch(/a échoué \(failed\)/);
    t.ctl.fail = () => false;
    expect((await (await make(new RealModel3D(dir), [], 4)).done).e).toBeNull();
    expect(t.count("/v3/generation/image-to-model")).toBe(4);
  });

  it("d'autres animations sur un squelette gardé : celles déjà posées ne sont pas repayées après un échec", async () => {
    const t = fakeTripo();
    vi.stubGlobal("fetch", t.fetch);
    let failJump = true;
    t.ctl.fail = (_p, b) => failJump && b.animation === "preset:jump";
    const m = new RealModel3D(dir);
    const go = async () => {
      const p = m.animate({ rigTask: "rig-42", names: ["slash", "jump"], step: () => {} }).then(
        (r) => ({ r, e: null as Error | null }),
        (e: Error) => ({ r: null, e }),
      );
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(15_000);
      return p;
    };
    expect((await go()).e?.message).toMatch(/jump/);
    failJump = false;
    const ok = await go();
    expect(ok.r!.glbs).toHaveLength(2);
    expect(t.posts.map((p) => p.body.animation)).toEqual(["preset:slash", "preset:jump", "preset:jump"]);
    expect(credits()).toBe(20);
  });

  it("le carnet : écrit d'un bloc, empreintes stables, commandes de plus de 7 jours oubliées", () => {
    let now = Date.parse("2026-10-23T12:00:00Z");
    const file = join(dir, "carnet.json");
    const j = new TripoJournal(file, () => now);
    const fp = orderFingerprint("/v3/animations/rig", { input: "t1", model: "v3", rig_type: "biped" });
    expect(fp).toBe(orderFingerprint("/v3/animations/rig", { rig_type: "biped", model: "v3", input: "t1" }));
    expect(fp).not.toBe(orderFingerprint("/v3/animations/rig", { input: "t2", model: "v3", rig_type: "biped" }));
    j.add(fp, { task: "t9", label: "squelette" });
    expect(j.get(fp)).toMatchObject({ task: "t9", counted: false });
    j.counted(fp);
    expect(new TripoJournal(file, () => now).get(fp)?.counted).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain("tsk_");
    now += 8 * 24 * 3600_000;
    expect(j.get(fp)).toBeNull();
  });
});
