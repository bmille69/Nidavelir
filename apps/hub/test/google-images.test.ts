import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GEMINI_DRAFT, GEMINI_FINAL, googleSheet, noteLines, RealGoogleImages, RoutedImageGen, type GenNote, type GoogleImagesPort, type GoogleRequest } from "../src/art/google-images.ts";
import type { GenRequest, GenState, ImageGenPort } from "../src/art/imagegen.ts";
import { RealModel3D, type Model3DState, type ViewsReview } from "../src/art/model3d.ts";
import { createHub } from "../src/hub.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox } from "./helpers.ts";

/** Une clé factice, longue comme une vraie : elle ne doit apparaître nulle part ailleurs que dans key.json. */
const KEY = "AIzaFAKE-0123456789abcdefghijklmnopqrstu";
/** Une petite image PNG (signature et en-tête IHDR 1024 × 1024) ; `n` la rend reconnaissable. */
const png = (n: number) => {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0, 0, 0, 4, 0]);
  return Buffer.concat([head, Buffer.alloc(16, n)]);
};

/** Le faux Gemini : retient chaque requête et rend une image (ou l'erreur que `fail` choisit). */
function fakeGemini(opts: { fail?: (body: Record<string, unknown>) => Response | null } = {}) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> | null }[] = [];
  let n = 0;
  const handle = async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body });
    if (url.includes("/models?")) return new Response(JSON.stringify({ models: [{ name: "models/x" }] }), { status: 200 });
    const failed = body && opts.fail?.(body);
    if (failed) return failed;
    const image = png(100 + ++n).toString("base64");
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }, { inlineData: { mimeType: "image/png", data: image } }] }, finishReason: "STOP" }] }), { status: 200 });
  };
  return { calls, handle };
}

/** Le générateur local factice. */
class LocalGen implements ImageGenPort {
  requests: GenRequest[] = [];
  state(): GenState {
    return { installed: true, installing: null, error: null, size: "≈ 19 Go", kontext: { installed: true, installing: null, error: null, size: "≈ 17 Go" } };
  }
  install(): void {}
  installKontext(): void {}
  async generate(req: GenRequest): Promise<Buffer> {
    this.requests.push(req);
    return png(1);
  }
  close(): void {}
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "google-"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  cleanupSandboxes();
});

const withKey = () => {
  mkdirSync(join(dir, "tools", "google"), { recursive: true });
  writeFileSync(join(dir, "tools", "google", "key.json"), JSON.stringify({ key: KEY }));
};
const gemini = <T extends { url: string }>(calls: T[]) => calls.filter((c) => c.url.includes(":generateContent"));

describe("Google Gemini, générateur d'images (ADR-110)", () => {
  it("requête generateContent : le bon modèle, les images de référence jointes, la clé seulement dans l'en-tête", async () => {
    withKey();
    const g = fakeGemini();
    vi.stubGlobal("fetch", vi.fn(g.handle));
    const local = new LocalGen();
    const notes: GenNote[] = [];
    const out = await new RoutedImageGen(local, new RealGoogleImages(dir)).generate({
      prompt: "A powder keg icon, plain background.",
      width: 1024,
      height: 1536,
      seed: 1,
      tier: "draft",
      refs: [png(7), png(8)],
      report: (n) => notes.push(n),
    });
    expect(out.equals(png(101))).toBe(true);
    expect(local.requests).toHaveLength(0);
    const [call] = gemini(g.calls);
    expect(call!.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_DRAFT.id}:generateContent`);
    expect(GEMINI_DRAFT.id).toBe("gemini-nano-banana-2.1");
    expect(call!.headers["x-goog-api-key"]).toBe(KEY);
    expect(call!.url).not.toContain(KEY);
    const parts = (call!.body as { contents: { parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] }[] }).contents[0]!.parts;
    expect(parts[0]!.text).toMatch(/^A powder keg icon[\s\S]*style references from the same game/);
    expect(parts.slice(1).map((p) => p.inlineData)).toEqual([
      { mimeType: "image/png", data: png(7).toString("base64") },
      { mimeType: "image/png", data: png(8).toString("base64") },
    ]);
    expect(call!.body!.generationConfig).toEqual({ responseModalities: ["IMAGE"], imageConfig: { imageSize: "1K", aspectRatio: "2:3" } });
    // Le coût estimé, compté dans le mois et dit au fil ; jamais la clé.
    expect(notes).toEqual([{ kind: "google", label: "Nano Banana 2.1", usd: 0.0336 }]);
    expect(noteLines(notes)).toEqual(["Images Google : 1 × Nano Banana 2.1 · ≈ 0,03 $."]);
    expect(JSON.parse(readFileSync(join(dir, "tools", "google", "usage.json"), "utf8"))).toMatchObject({ usd: 0.0336 });
    expect(new RealGoogleImages(dir).state()).toMatchObject({ configured: true, usd: 0.0336, cap: 10 });
  });

  it("Nano Banana Pro pour une retouche vers l'image finale, Nano Banana 2.1 pour le reste ; variante d'un croquis jointe", async () => {
    withKey();
    const g = fakeGemini();
    vi.stubGlobal("fetch", vi.fn(g.handle));
    const gen = new RoutedImageGen(new LocalGen(), new RealGoogleImages(dir));
    await gen.generate({ prompt: "move the pauldron to the left shoulder", width: 1024, height: 1024, seed: 1, edit: { images: [png(3)] }, tier: "final" });
    await gen.generate({ prompt: "A knight.", width: 1024, height: 1024, seed: 1, init: { image: png(4), denoise: 0.5 }, tier: "draft" });
    const [edit, variant] = gemini(g.calls);
    expect(edit!.url).toContain(`/models/${GEMINI_FINAL.id}:generateContent`);
    expect(GEMINI_FINAL.id).toBe("gemini-3-pro-image");
    expect(JSON.stringify(edit!.body)).toContain(png(3).toString("base64"));
    expect(variant!.url).toContain(`/models/${GEMINI_DRAFT.id}:`);
    expect(JSON.stringify(variant!.body)).toMatch(/variation of the attached sketch/);
    expect(new RealGoogleImages(dir).state().usd).toBeCloseTo(0.134 + 0.0336, 4);
  });

  it("sans clé : le générateur local, exactement comme avant, sans un mot dans le fil", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const local = new LocalGen();
    const notes: GenNote[] = [];
    const req: GenRequest = { prompt: "A flag.", width: 1024, height: 1024, seed: 3, tier: "draft", refs: [png(9)], report: (n) => notes.push(n) };
    await new RoutedImageGen(local, new RealGoogleImages(dir)).generate(req);
    expect(local.requests).toEqual([req]);
    expect(fetch).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
  });

  it("une erreur de Google : le générateur local prend le relais, la raison est dite, sans la clé", async () => {
    withKey();
    const g = fakeGemini({ fail: () => new Response(JSON.stringify({ error: { message: `Internal error for key ${KEY}` } }), { status: 500 }) });
    vi.stubGlobal("fetch", vi.fn(g.handle));
    const local = new LocalGen();
    const notes: GenNote[] = [];
    await new RoutedImageGen(local, new RealGoogleImages(dir)).generate({ prompt: "A flag.", width: 1024, height: 1024, seed: 3, tier: "draft", report: (n) => notes.push(n) });
    expect(local.requests).toHaveLength(1);
    const lines = noteLines(notes);
    expect(lines).toEqual([expect.stringMatching(/^Google indisponible : Google répond 500 : Internal error for key … → générateur local\.$/)]);
    expect(JSON.stringify(notes)).not.toContain(KEY);
    // Rien de facturé, rien de compté.
    expect(new RealGoogleImages(dir).state().usd).toBe(0);
  });

  it("une réponse sans image (bloquée) : repli local, avec la raison de Google", async () => {
    withKey();
    const g = fakeGemini({ fail: () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 }) });
    vi.stubGlobal("fetch", vi.fn(g.handle));
    const notes: GenNote[] = [];
    await new RoutedImageGen(new LocalGen(), new RealGoogleImages(dir)).generate({ prompt: "x", width: 512, height: 512, seed: 1, tier: "draft", report: (n) => notes.push(n) });
    expect(noteLines(notes)).toEqual(["Google indisponible : Nano Banana 2.1 n'a pas rendu d'image (SAFETY) → générateur local."]);
  });

  it("le filtre de Google bloque au hasard : la même demande est refaite, une seule image comptée", async () => {
    withKey();
    let n = 0;
    const g = fakeGemini({ fail: () => (n++ < 2 ? new Response(JSON.stringify({ candidates: [{ finishReason: "PROHIBITED_CONTENT" }] }), { status: 200 }) : null) });
    const fetchMock = vi.fn(g.handle);
    vi.stubGlobal("fetch", fetchMock);
    const google = new RealGoogleImages(dir);
    const r = await google.generate({ prompt: "x", images: [], tier: "draft", size: "1K" });
    expect(r.image.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes(":generateContent"))).toHaveLength(3);
    expect(google.state().usd).toBeCloseTo(0.0336);
  });

  it("plafond mensuel atteint : aucun appel à Google, le générateur local, et le plafond se règle", async () => {
    withKey();
    const month = new Date().toISOString().slice(0, 7);
    writeFileSync(join(dir, "tools", "google", "usage.json"), JSON.stringify({ month, usd: 9.99 }));
    const g = fakeGemini();
    vi.stubGlobal("fetch", vi.fn(g.handle));
    const google = new RealGoogleImages(dir);
    const local = new LocalGen();
    const notes: GenNote[] = [];
    const gen = new RoutedImageGen(local, google);
    await gen.generate({ prompt: "x", width: 512, height: 512, seed: 1, tier: "draft", report: (n) => notes.push(n) });
    expect(gemini(g.calls)).toHaveLength(0);
    expect(local.requests).toHaveLength(1);
    expect(noteLines(notes)).toEqual(["Google indisponible : plafond mensuel Google atteint (9,99 $ sur 10,00 $), il repart le mois prochain → générateur local."]);
    // Plafond relevé : Google reprend.
    google.setCap(20);
    expect(google.state().cap).toBe(20);
    await gen.generate({ prompt: "x", width: 512, height: 512, seed: 1, tier: "draft" });
    expect(gemini(g.calls)).toHaveLength(1);
    expect(() => google.setCap(-1)).toThrow(/de 0 à 1000/);
  });

  it("les demandes sans `tier` (sprites du studio de modding) restent au générateur local", async () => {
    withKey();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const local = new LocalGen();
    await new RoutedImageGen(local, new RealGoogleImages(dir)).generate({ prompt: "sprite", width: 1024, height: 1024, seed: 1, scale: { width: 32, height: 32 } });
    expect(local.requests).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("la clé : vérifiée chez Google (gratuit), gardée hors du dépôt ; refusée sans répéter la clé", async () => {
    const g = fakeGemini();
    vi.stubGlobal("fetch", vi.fn(g.handle));
    const google = new RealGoogleImages(dir);
    await expect(google.setKey("trop-courte")).rejects.toThrow(/AIza/);
    await google.setKey(`  ${KEY} `);
    expect(g.calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1");
    expect(JSON.parse(readFileSync(join(dir, "tools", "google", "key.json"), "utf8"))).toEqual({ key: KEY });
    expect(JSON.stringify(google.state())).not.toContain(KEY);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }), { status: 400 })));
    const err = await new RealGoogleImages(join(dir, "autre")).setKey(KEY).catch((e: Error) => e);
    expect((err as Error).message).toBe("Google refuse la clé");
  });
});

/** Un faux Tripo réduit : téléversements, planche, modèle ; chaque tâche réussit tout de suite. */
function fakeTripo(opts: { failMultiview?: boolean } = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const tasks = new Map<string, Record<string, unknown>>();
  let n = 0;
  let uploads = 0;
  const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
  const handle = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (url.startsWith("https://cdn/")) return new Response(Buffer.from(path));
    if (path === "/v3/files") return json({ file_token: `tok${++uploads}` });
    if (path.startsWith("/v3/tasks/")) return json(tasks.get(path.slice("/v3/tasks/".length)));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body });
    const id = `t${++n}`;
    const output = path.endsWith("image-to-multiview")
      ? { generate_multiview_image: Object.fromEntries(["front", "left", "back", "right"].map((v) => [`${v}_view_url`, `https://cdn/${id}-${v}.png`])) }
      : { model_url: `https://cdn/${id}.glb` };
    tasks.set(id, { task_id: id, status: "success", output, credits_consumed: 10 });
    return json({ task_id: id });
  };
  return { calls, handle, uploads: () => uploads, opts };
}

describe("La planche dessinée par Google (ADR-110)", () => {
  beforeEach(() => {
    withKey();
    mkdirSync(join(dir, "tools", "tripo"), { recursive: true });
    writeFileSync(join(dir, "tools", "tripo", "key.json"), JSON.stringify({ key: "tsk_test_0123456789" }));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
  });

  async function build(views: ViewsReview, failGoogle = false) {
    const t = fakeTripo();
    const g = fakeGemini({ fail: () => (failGoogle ? new Response("{}", { status: 503 }) : null) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => (url.startsWith("https://generativelanguage") ? g.handle(url, init) : t.handle(url, init))),
    );
    const notes: GenNote[] = [];
    const front = png(50);
    const p = new RealModel3D(dir).tripo({
      image: front,
      ext: "png",
      spec: { size: 1.8, tris: 6000, rig: false, animations: [] },
      seed: 1,
      step: () => {},
      views,
      sheet: googleSheet(new RealGoogleImages(dir), front, (n) => notes.push(n)),
    });
    for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(15_000);
    return { r: await p, t, g, notes, front };
  }

  it("face = image de référence, trois vues par Nano Banana Pro en 1K, une seule retouchée, puis multiview-to-model", async () => {
    const seen: { round: number; by?: string; views: string[] }[] = [];
    const { r, t, g, notes, front } = await build(async (views, round, by) => {
      seen.push({ round, by, views: views.map((v) => `${v.view}:${v.image[24]}`) });
      return round === 1 ? [{ view: "back", prompt: "Same pauldron as the front." }] : [];
    });
    const calls = gemini(g.calls);
    expect(calls.map((c) => c.url.split("/models/")[1])).toEqual([
      `${GEMINI_FINAL.id}:generateContent`,
      `${GEMINI_FINAL.id}:generateContent`,
      `${GEMINI_FINAL.id}:generateContent`,
      `${GEMINI_FINAL.id}:generateContent`,
    ]);
    // Chaque vue de côté voit la face (et les vues déjà faites) ; consignes strictes, 1K sans format imposé (le filtre de Google bloquait le 2K).
    const first = calls[0]!.body as { contents: { parts: { text?: string; inlineData?: { data: string } }[] }[]; generationConfig: unknown };
    expect(first.contents[0]!.parts[0]!.text).toMatch(/turntable[\s\S]*LEFT side view[\s\S]*same design, same colors, same pose[\s\S]*plain light background/);
    expect(first.contents[0]!.parts[1]!.inlineData!.data).toBe(front.toString("base64"));
    expect(first.generationConfig).toEqual({ responseModalities: ["IMAGE"], imageConfig: { imageSize: "1K" } });
    expect((calls[2]!.body as { contents: { parts: unknown[] }[] }).contents[0]!.parts).toHaveLength(4);
    // La retouche Pro ne touche que la vue de dos, avec la face en référence.
    expect(JSON.stringify(calls[3]!.body)).toMatch(/BACK view[\s\S]*Same pauldron as the front/);
    expect(seen).toEqual([
      { round: 1, by: "google", views: ["front:50", "left:101", "back:102", "right:103"] },
      { round: 2, by: "google", views: ["front:50", "left:101", "back:104", "right:103"] },
    ]);
    // Tripo ne dessine rien : il reçoit les quatre vues téléversées.
    expect(t.calls.map((c) => c.path)).toEqual(["/v3/generation/multiview-to-model"]);
    expect(t.uploads()).toBe(4);
    expect(t.calls[0]!.body).toMatchObject({ inputs: [{ front: "tok1" }, { left: "tok2" }, { back: "tok3" }, { right: "tok4" }], texture_alignment: "original_image" });
    expect(r.views!.map((v) => v.image[24])).toEqual([50, 101, 104, 103]);
    expect(r.credits).toBe(10);
    expect(noteLines(notes)).toEqual(["Images Google : 4 × Nano Banana Pro · ≈ 0,54 $."]);
  });

  it("Google en panne : la planche de Tripo, inchangée, et la raison pour le fil", async () => {
    const bys: (string | undefined)[] = [];
    const { r, t, notes } = await build(async (_views, _round, by) => {
      bys.push(by);
      return [];
    }, true);
    expect(t.calls.map((c) => c.path)).toEqual(["/v3/generation/image-to-multiview", "/v3/generation/multiview-to-model"]);
    expect(bys).toEqual(["tripo"]);
    expect(r.views).toHaveLength(4);
    expect(noteLines(notes)).toEqual(["Google indisponible : Google répond 503 → planche dessinée par Tripo."]);
  });

  it("une planche de Google jugée infidèle est écartée : le modèle vient de l'image seule (ADR-109)", async () => {
    const { r, t } = await build(async () => {
      throw new Error("planche infidèle à l'image de référence");
    });
    expect(t.calls.map((c) => c.path)).toEqual(["/v3/generation/image-to-model"]);
    expect(r.views).toBeUndefined();
  });
});

/** Le faux Google des tests du Directeur artistique : il retient les images jointes. */
class FakeGoogle implements GoogleImagesPort {
  requests: GoogleRequest[] = [];
  n = 0;
  state() {
    return { configured: true, month: "2026-10", usd: 0, cap: 10 };
  }
  async setKey(): Promise<void> {}
  setCap(): void {}
  unavailable() {
    return null;
  }
  async generate(req: GoogleRequest) {
    this.requests.push(req);
    return { image: png(200 + ++this.n), mime: "image/png", model: GEMINI_DRAFT.id, label: GEMINI_DRAFT.label, usd: 0.05 };
  }
}

describe("Le style du jeu suit Google (ADR-110)", () => {
  it("aucune référence tant que rien n'est validé ; ensuite, les images de la bible et l'asset validé sont joints", async () => {
    const fake = new FakeOrchestrator();
    const sb = sandbox(fake);
    sb.hub.close();
    const google = new FakeGoogle();
    const model3d = {
      state: (): Model3DState => ({ blender: { installed: false, installing: null, error: null, size: "" }, tripo: { configured: false, month: "2026-10", credits: 0, cap: 2000 } }),
    } as never;
    sb.hub = createHub({
      databasePath: join(sb.dir, "hub/.data/g.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      orchestrator: fake,
      dataDir: join(sb.dir, "hub/.data"),
      imagegen: new LocalGen(),
      model3d,
      google,
    });
    const repo = sb.makeGameRepo("games/bordee", { "CLAUDE.md": "# Bordée\n", "studio/art/bible.md": "# Bible\n![palette](moodboard/palette.png)\n" });
    mkdirSync(join(repo, "studio", "art", "moodboard"), { recursive: true });
    writeFileSync(join(repo, "studio", "art", "moodboard", "palette.png"), png(77));
    await sb.hub.projects.register(sb.human(), { path: repo, slug: "bordee", name: "Bordée" });
    const art = sb.hub.art;

    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Bien.", points: [], prompt: null } as never);
    fake.replies.push('[[ASSET]] {"name": "Tonneau", "type": "icône", "usage": "HUD"} [[/ASSET]]\n[[GENERER: A-0001]] A keg. [[/GENERER]]');
    art.send(sb.human(), "bordee", "Un tonneau");
    await art.idle();
    expect(google.requests).toHaveLength(3);
    expect(google.requests.every((r) => r.images.length === 0 && r.tier === "draft")).toBe(true);
    const first = art.state("bordee");
    expect(first.assets[0]).toMatchObject({ verdict: { ok: true, file: "production/a-0001-t1-e1.png" } });
    // Le coût est dit au fil et compté sur le visuel ; l'état ne montre que « configurée ».
    expect(first.messages.map((m) => m.text).join("\n")).toMatch(/Images Google : 3 × Nano Banana 2\.1 · ≈ 0,15 \$\./);
    expect(first.spend["A-0001"]!.usd).toBeGreaterThanOrEqual(0.15);
    expect(first.google).toEqual({ configured: true, month: "2026-10", usd: 0, cap: 10 });

    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Bien.", points: [], prompt: null } as never);
    fake.replies.push('[[ASSET]] {"name": "Drapeau", "type": "icône", "usage": "HUD"} [[/ASSET]]\n[[GENERER: A-0002]] A flag. [[/GENERER]]');
    art.send(sb.human(), "bordee", "Un drapeau");
    await art.idle();
    const second = google.requests.slice(3);
    expect(second).toHaveLength(3);
    // La bible d'abord, puis l'asset validé (le premier essai de A-0001, dessiné par Google).
    expect(second[0]!.images.map((b) => b[24])).toEqual([77, 201]);
    expect(second[0]!.prompt).toMatch(/style references from the same game/);
  }, 30_000);
});
