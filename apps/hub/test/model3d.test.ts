import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealModel3D, glbJoints, rigAnimations, rigProblem } from "../src/art/model3d.ts";

/** Un .glb minimal : un squelette fait de ces os. */
function glb(joints: string[]): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, nodes: joints.map((name) => ({ name })), skins: [{ joints: joints.map((_, i) => i) }] }));
  const pad = Buffer.alloc((4 - (json.length % 4)) % 4, 0x20);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + json.length + pad.length, 8);
  head.writeUInt32LE(json.length + pad.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, json, pad]);
}

/** Les os du squelette humanoïde v1.0 de Tripo, relevés sur le Héron de Survivor Destiny. */
const SIDE = ["Clavicle", "Upperarm", "UpperarmTwist01", "UpperarmTwist02", "Forearm", "ForearmTwist01", "ForearmTwist02", "Hand", "Thigh", "ThighTwist01", "ThighTwist02", "Calf", "CalfTwist01", "CalfTwist02", "Foot", "ToeBase"];
const V1 = ["Root", "Hip", "Pelvis", "Waist", "Spine01", "Spine02", "NeckTwist01", "NeckTwist02", "Head", ...SIDE.map((b) => `L_${b}`), ...SIDE.map((b) => `R_${b}`)];

/** Un faux Tripo : chaque tâche réussit tout de suite, sauf celles que `fail` désigne. */
function fakeTripo(opts: { rigType: string; fail?: (path: string, body: Record<string, unknown>) => boolean; rigs?: string[][] }) {
  const skeletons = new Map<string, string[]>();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const tasks = new Map<string, Record<string, unknown>>();
  let n = 0;
  const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (url.startsWith("https://cdn/")) {
      const bones = skeletons.get(path.slice(1, -".glb".length));
      return new Response(bones ? glb(bones) : Buffer.from(path));
    }
    if (path === "/v3/files") return json({ file_token: "tok" });
    if (path.startsWith("/v3/tasks/")) return json(tasks.get(path.slice("/v3/tasks/".length)));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body });
    if (opts.fail?.(path, body)) return new Response(JSON.stringify({ code: 2002, message: "Invalid input parameter" }), { status: 400 });
    const id = `t${++n}`;
    if (path === "/v3/animations/rig" && opts.rigs?.length) skeletons.set(id, opts.rigs.shift()!);
    const output = path.endsWith("rig-check")
      ? { riggable: true, rig_type: opts.rigType }
      : path.endsWith("image-to-multiview")
        ? { generate_multiview_image: Object.fromEntries(["front", "left", "back", "right"].map((v) => [`${v}_view_url`, `https://cdn/${id}-${v}.png`])) }
        : path.endsWith("edit-multiview")
          ? { generate_multiview_image: { back_view_url: `https://cdn/${id}-back.png` } }
          : { model_url: `https://cdn/${id}.glb` };
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

  it("bipède avec une animation de la bibliothèque : squelette v1.0 et plusieurs animations fusionnables", async () => {
    const t = fakeTripo({ rigType: "biped" });
    vi.stubGlobal("fetch", t.fetch);
    const { r } = await run(new RealModel3D(dir), ["walk", "hit_to_body_01"]);
    expect(t.calls.find((c) => c.path === "/v3/animations/rig")!.body).toMatchObject({ model: "v1.0-20240301", rig_type: "biped" });
    // La bibliothèque des bipèdes, faite pour ce squelette ; un modèle à squelette est demandé en qualité détaillée.
    expect(t.calls.filter((c) => c.path === "/v3/animations/retarget").map((c) => c.body.animation)).toEqual(["preset:biped:walk", "preset:biped:hit_to_body_01"]);
    expect(t.calls.find((c) => c.path === "/v3/generation/image-to-model")!.body).toMatchObject({
      model: "v3.1-20260211",
      geometry_quality: "detailed",
      texture_quality: "detailed",
      // ADR-54 : des couleurs sans ombres peintes, le modèle de face comme l'image.
      texture_version: "v3.5-20260815",
      delight: true,
      orientation: "align_image",
    });
    expect(r!.animations).toEqual(["walk", "hit_to_body_01"]);
    expect(r!.rigModel).toBe("v1.0-20240301");
    expect(r!.extras).toHaveLength(1);
    expect(r!.credits).toBe(50);
  });

  it("bipède aux animations toutes de base : squelette v3.0 (octobre 2026) et noms nus", async () => {
    const t = fakeTripo({ rigType: "biped" });
    vi.stubGlobal("fetch", t.fetch);
    const { r } = await run(new RealModel3D(dir), ["walk", "slash", "moonwalk"]);
    expect(t.calls.find((c) => c.path === "/v3/animations/rig")!.body).toMatchObject({ model: "v3.0-20260909", rig_type: "biped" });
    expect(t.calls.filter((c) => c.path === "/v3/animations/retarget").map((c) => c.body.animation)).toEqual(["preset:walk", "preset:slash"]);
    expect(r!.animations).toEqual(["walk", "slash"]);
    expect(r!.rigModel).toBe("v3.0-20260909");
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

  it("un squelette incomplet est refait avant de payer les animations ; trois ratés arrêtent tout", async () => {
    const broken = ["Root", "Spine_0", "Spine_1", "Spine_2", "L_Upperarm", "L_Forearm", "L_Hand", "Neck", "Hip"];
    let t = fakeTripo({ rigType: "biped", rigs: [broken, V1] });
    vi.stubGlobal("fetch", t.fetch);
    const ok = await run(new RealModel3D(dir), ["walk"]);
    expect(ok.e).toBeNull();
    expect(t.calls.map((c) => c.path.split("/").pop())).toEqual(["image-to-model", "rig-check", "rig", "rig", "retarget"]);
    expect(t.calls.find((c) => c.path.endsWith("retarget"))!.body.input).toBe("t4");

    t = fakeTripo({ rigType: "biped", rigs: [broken, broken, broken] });
    vi.stubGlobal("fetch", t.fetch);
    const ko = await run(new RealModel3D(dir), ["walk"]);
    expect(ko.e?.message).toMatch(/pas réussi le squelette en 3 essais \(9 os seulement\)[\s\S]*pose en A ou en T/);
    expect(t.calls.filter((c) => c.path.endsWith("retarget"))).toHaveLength(0);
  });

  it("le contrôle du squelette : deux côtés pareils, assez d'os", () => {
    expect(rigProblem(V1, "biped")).toBeNull();
    expect(glbJoints(glb(V1))).toEqual(V1);
    expect(glbJoints(Buffer.from("pas un glb"))).toBeNull();
    expect(rigProblem(V1.filter((n) => !/^R_(Thigh|Calf|Foot|Toe)/.test(n)), "biped")).toMatch(/côtés inégaux : 16 os à gauche, 8 à droite/);
    // Chaînes de membres du v2.5 (quadrupède) et noms sans côté d'une version inconnue.
    const limbs = [0, 1].flatMap((row) => ["Left", "Right"].flatMap((side) => [0, 1, 2, 3, 4].map((i) => `${row}_${side}_Limb_${i}`)));
    expect(rigProblem(["Root", "Spine", ...limbs], "quadruped")).toBeNull();
    expect(rigProblem(Array.from({ length: 20 }, (_, i) => `bone${i}`), "biped")).toBeNull();
    expect(rigProblem([], "quadruped")).toBe("aucun os dans le fichier");
  });

  it("la planche : quatre vues jugées, une retouchée, puis le modèle tiré des quatre vues (ADR-50)", async () => {
    const t = fakeTripo({ rigType: "biped" });
    vi.stubGlobal("fetch", t.fetch);
    const seen: string[][] = [];
    const p = new RealModel3D(dir).tripo({
      image: Buffer.from("png"),
      ext: "png",
      spec: { size: 1.8, tris: 6000, rig: false, animations: [] },
      seed: 1,
      step: () => {},
      views: async (views, round) => {
        seen.push(views.map((v) => `${v.view}:${v.image.toString()}`));
        return round === 1 ? [{ view: "back", prompt: "Same armor as the front." }] : [];
      },
    });
    for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(15_000);
    const r = await p;
    expect(t.calls.map((c) => c.path)).toEqual(["/v3/generation/image-to-multiview", "/v3/generation/edit-multiview", "/v3/generation/multiview-to-model"]);
    expect(t.calls[1]!.body).toEqual({ input: "t1", prompts: [{ view: "back", prompt: "Same armor as the front." }] });
    // Seule la vue retouchée change ; les autres restent celles de la première planche.
    expect(seen[1]).toEqual(["front:/t1-front.png", "left:/t1-left.png", "back:/t2-back.png", "right:/t1-right.png"]);
    expect(t.calls[2]!.body).toMatchObject({ inputs: [{ front: "https://cdn/t1-front.png" }, { left: "https://cdn/t1-left.png" }, { back: "https://cdn/t2-back.png" }, { right: "https://cdn/t1-right.png" }], face_limit: 6000 });
    expect(r.views!.map((v) => v.view)).toEqual(["front", "left", "back", "right"]);
    expect(r.credits).toBe(30);
  });

  it("une planche impossible ne bloque rien : le modèle vient de l'image seule", async () => {
    const t = fakeTripo({ rigType: "biped", fail: (p) => p === "/v3/generation/image-to-multiview" });
    vi.stubGlobal("fetch", t.fetch);
    const steps: string[] = [];
    const p = new RealModel3D(dir).tripo({ image: Buffer.from("png"), ext: "png", spec: { size: 1, tris: 2000, rig: false, animations: [] }, seed: 1, step: (s) => steps.push(s), views: async () => [] });
    for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(15_000);
    const r = await p;
    expect(t.calls.map((c) => c.path)).toEqual(["/v3/generation/image-to-multiview", "/v3/generation/image-to-model"]);
    expect(r.views).toBeUndefined();
    expect(steps.some((s) => /Planche impossible[\s\S]*image seule/.test(s))).toBe(true);
  });

  it("les animations que le squelette sait jouer", () => {
    expect(rigAnimations("quadruped", ["walk", "quadruped:walk", "slash"])).toEqual(["quadruped:walk"]);
    // Que des animations de base : le squelette v3.0, noms nus ; le squelette v1.0 déjà posé garde la bibliothèque.
    expect(rigAnimations("biped", ["walk", "quadruped:walk", "slash"])).toEqual(["walk", "slash"]);
    expect(rigAnimations("biped", ["walk", "slash"], "v1.0-20240301")).toEqual(["biped:walk", "biped:slash"]);
    expect(rigAnimations("biped", ["walk", "hit_to_body_01"], "v3.0-20260909")).toEqual(["walk"]);
    // Toute la bibliothèque des bipèdes, jusqu'à huit animations ; une animation inconnue est écartée.
    expect(rigAnimations("biped", ["idle", "walk", "run", "hit_to_body_01", "biped:fall", "cast_a_spell", "victory_celebration", "look_around", "sit", "moonwalk"])).toEqual([
      "biped:idle",
      "biped:walk",
      "biped:run",
      "biped:hit_to_body_01",
      "biped:fall",
      "biped:cast_a_spell",
      "biped:victory_celebration",
      "biped:look_around",
    ]);
    expect(rigAnimations("serpentine", ["march"])).toEqual(["serpentine:march"]);
    // Le Grouillot (18/10/2026) : une marche à quatre pattes demandée, un modèle que Tripo voit à huit pattes.
    expect(rigAnimations("octopod", ["quadruped:walk"])).toEqual(["octopod:walk"]);
    expect(rigAnimations("serpentine", ["walk", "run"])).toEqual(["serpentine:march"]);
    expect(rigAnimations("avian", ["walk"])).toEqual([]);
  });
});

describe("Tripo : d'autres animations sur un squelette gardé (ADR-56)", () => {
  it("pose chaque animation sur la tâche du squelette, sans refaire le modèle, et compte les crédits", async () => {
    const t = fakeTripo({ rigType: "biped" });
    vi.stubGlobal("fetch", t.fetch);
    const m = new RealModel3D(dir);
    const first = await run(m, ["walk"]);
    expect(first.r!.rigTask).toMatch(/^t\d+$/);
    const before = t.calls.length;
    const p = m.animate({ rigTask: first.r!.rigTask!, names: ["biped:hit_to_body_01", "biped:slash"], step: () => {} });
    const done = p.then(
      (r) => ({ r, e: null }),
      (e: Error) => ({ r: null, e }),
    );
    for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(15_000);
    const { r, e } = await done;
    expect(e).toBeNull();
    expect(r!.glbs).toHaveLength(2);
    expect(r!.credits).toBe(20);
    const retargets = t.calls.slice(before).filter((c) => c.path === "/v3/animations/retarget");
    expect(retargets.map((c) => c.body)).toEqual([
      { input: first.r!.rigTask, animation: "preset:biped:hit_to_body_01", out_format: "glb", export_with_geometry: true, animate_in_place: true },
      { input: first.r!.rigTask, animation: "preset:biped:slash", out_format: "glb", export_with_geometry: true, animate_in_place: true },
    ]);
    expect(t.calls.slice(before).some((c) => c.path === "/v3/generation/image-to-model")).toBe(false);
    expect(m.state().tripo.credits).toBe(first.r!.credits + 20);
  });
});
