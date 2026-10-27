import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@studio/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeRel } from "../src/art/art-service.ts";
import { PENDING_VISUALS } from "../src/art/manifest.ts";
import { fluxWorkflow, kontextWorkflow, type GenRequest, type GenState, type ImageGenPort } from "../src/art/imagegen.ts";
import { VIEWS, type Geometry, type Model3DPort, type Model3DSpec, type Model3DState, type ViewEdit, type ViewsReview } from "../src/art/model3d.ts";
import { parseArtDirectives, parseFormat, parseModel3D, parseRef } from "../src/art/prompts.ts";
import { assertPublic, pageImage, privateAddress, type WebRefsPort } from "../src/art/web-refs.ts";
import type { CheckerPort } from "../src/quality/checks.ts";
import { createHub } from "../src/hub.ts";
import { PolicyEngine } from "../src/executor/policy-engine.ts";
import { buildChatArgs } from "../src/llm/claude-cli.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox } from "./helpers.ts";

afterEach(() => cleanupSandboxes());

/** Une vraie petite image PNG (signature correcte) : le hub vérifie le type réel du fichier. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

/** Le Directeur artistique factice : retient ce qu'on lui donne à lire et les outils reçus. */
class Artist extends FakeOrchestrator {
  reads: { readDir?: string; tools?: string[]; role?: string }[] = [];
  override async reply(input: { systemPrompt: string; prompt: string; readDir?: string; tools?: string[]; role?: "art" }) {
    this.reads.push({ readDir: input.readDir, tools: input.tools, role: input.role });
    return super.reply(input);
  }
  override async structured(input: { systemPrompt: string; prompt: string; jsonSchema: object; readDir?: string; role?: "art" }) {
    this.reads.push({ readDir: input.readDir, role: input.role });
    return super.structured(input);
  }
}

async function setup() {
  const fake = new Artist();
  const sb = sandbox(fake);
  const repo = sb.makeGameRepo("games/bordee", { "CLAUDE.md": "# Bordée\nBataille navale 1900-1945 stylisée.\n" });
  await sb.hub.projects.register(sb.human(), { path: repo, slug: "bordee", name: "Bordée" });
  return { sb, fake, repo, art: sb.hub.art };
}

/** Le générateur local factice : il retient les demandes et rend une petite image PNG. */
class FakeImageGen implements ImageGenPort {
  installed = false;
  kontext = false;
  requests: GenRequest[] = [];
  state(): GenState {
    return { installed: this.installed, installing: null, error: null, size: "≈ 19 Go", kontext: { installed: this.kontext, installing: null, error: null, size: "≈ 17 Go" } };
  }
  install(): void {
    this.installed = true;
  }
  installKontext(): void {
    this.kontext = true;
  }
  async generate(req: GenRequest): Promise<Buffer> {
    this.requests.push(req);
    return PNG;
  }
  close(): void {}
}

/** L'atelier 3D factice : Tripo rend un faux .glb ; Blender prépare, exécute le code de l'artisan, photographie, exporte. */
class FakeModel3D implements Model3DPort {
  blender = false;
  key = false;
  rigType: string | undefined = undefined;
  rigModel: string | undefined = undefined;
  tripoCalls: { spec: Model3DSpec; bytes: number }[] = [];
  prepares: { dir: string; input: string | null; palette: string[] }[] = [];
  codes: string[] = [];
  exports: { output: string; prefix: string }[] = [];
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  state(): Model3DState {
    return { blender: { installed: this.blender, installing: null, error: null, size: "≈ 400 Mo" }, tripo: { configured: this.key, month: "2026-10", credits: 0, cap: 2000 } };
  }
  installBlender(): void {
    this.blender = true;
  }
  atelier(key: string): string {
    return join(this.root, key);
  }
  async setTripoKey(key: string): Promise<void> {
    if (!key.startsWith("tsk_")) throw new Error("Une clé Tripo commence par « tsk_ »");
    this.key = true;
  }
  viewEdits: ViewEdit[] = [];
  async tripo(req: { image: Buffer; spec: Model3DSpec; step: (s: string) => void; views?: ViewsReview }) {
    req.step("Tripo fabrique le modèle");
    this.tripoCalls.push({ spec: req.spec, bytes: req.image.length });
    // La planche : jugée, retouchée une fois si le validateur le demande, puis rejugée.
    const sheet = VIEWS.map((view) => ({ view, image: PNG }));
    if (req.views) {
      const edits = await req.views(sheet, 1);
      this.viewEdits.push(...edits);
      if (edits.length) await req.views(sheet, 2);
    }
    return { glb: Buffer.from("glTF"), credits: 30, animations: req.spec.animations.filter((a) => a !== "slash"), rigType: this.rigType, ...(this.rigType ? { rigTask: "rig-1" } : {}), ...(this.rigModel ? { rigModel: this.rigModel } : {}), ...(req.views ? { views: sheet } : {}) };
  }
  /** Les bandes d'animation ne sont rendues que si un test le demande (ADR-56). */
  bandes = false;
  animates: { rigTask: string; names: string[] }[] = [];
  added: { extras: string[]; animations: string[]; keep: string[] }[] = [];
  async animate(req: { rigTask: string; names: string[]; step: (s: string) => void }) {
    req.step("Tripo applique l'animation");
    this.animates.push({ rigTask: req.rigTask, names: req.names });
    return { glbs: req.names.map(() => Buffer.from("glTF-anim")), credits: 10 * req.names.length };
  }
  async addAnimations(req: { dir: string; extras: string[]; animations: string[]; keep: string[] }) {
    this.added.push({ extras: req.extras.map((f) => (existsSync(f) ? readFileSync(f, "utf8") : "?")), animations: req.animations, keep: req.keep });
    return {};
  }
  async prepare(req: { dir: string; input: string | null; palette: string[] }) {
    mkdirSync(req.dir, { recursive: true });
    writeFileSync(join(req.dir, "scene.blend"), "blend");
    this.prepares.push({ dir: req.dir, input: req.input && existsSync(req.input) ? readFileSync(req.input, "utf8") : null, palette: req.palette });
    return {};
  }
  /** Appelé à chaque pas de l'artisan : un test peut y regarder l'avancement affiché. */
  onCode: (() => void) | null = null;
  async runCode(req: { dir: string; code: string }) {
    this.codes.push(req.code);
    this.onCode?.();
    return { ok: true, sortie: "fait", erreur: null };
  }
  async photos(req: { dir: string; prefix: string }) {
    const photos = ["face", "trois-quarts", "profil", "dos", "vue-jeu"].map((a) => join(req.dir, `${req.prefix}-${a}.png`));
    for (const p of photos) writeFileSync(p, PNG);
    return { photos, mesures: { triangles: 1200 } };
  }
  /** Le contrôle géométrique rendu à chaque export (ADR-63), dans l'ordre. */
  geometry: Geometry[] = [];
  async export(req: { dir: string; output: string; rendersDir: string; prefix: string; spec: Model3DSpec }) {
    this.exports.push({ output: req.output, prefix: req.prefix });
    writeFileSync(req.output, "glTF");
    const renders = ["face", "trois-quarts", "profil", "dos", "vue-jeu"].map((a) => join(req.rendersDir, `${req.prefix}-${a}.png`));
    for (const r of renders) writeFileSync(r, PNG);
    const animations = req.spec.animations.filter((a) => a !== "slash");
    const bandes = this.bandes ? animations.map((a) => join(req.rendersDir, `${req.prefix}-anim-${a}.png`)) : [];
    for (const b of bandes) writeFileSync(b, PNG);
    const controle = this.geometry.shift() ?? null;
    return { renders, bandes, tris: Math.min(req.spec.tris, 7000), dims: [2.1, 12, 3.4], animations, durees: animations.map((nom) => ({ nom, duree_s: nom === "hurt" ? 13.8 : 1.2 })), controle };
  }
}

/** Le validateur trouve la planche cohérente. */
const sheetOk = { ok: true, summary: "Planche cohérente.", points: [], edits: [] };

/** Les pas de l'artisan 3D : un pas qui travaille, puis « fini ». */
const artisanSteps = (code = "tourner(-90)\nmatiere()",summary = "Tourné face à -Y, rendu mat.") => [
  { note: "Le modèle regarde de côté et brille : je le tourne et le rends mat.", code, photos: true, fini: false, summary: "" },
  { note: "Propre sous tous les angles.", code: null, photos: false, fini: true, summary },
];

const quietChecker: CheckerPort = { tests: async () => ({ status: "none", detail: "" }), launch: async () => ({ status: "none", detail: "" }) };

/** Le même projet, avec un générateur local et un atelier 3D branchés, et les vérifications du hub (captures). */
async function setupLocal(checker: CheckerPort = quietChecker, webRefs?: WebRefsPort) {
  const fake = new Artist();
  const sb = sandbox(fake);
  sb.hub.close();
  const gen = new FakeImageGen();
  const m3d = new FakeModel3D(join(sb.dir, "hub/.data/tools/blender/atelier"));
  sb.hub = createHub({
    databasePath: join(sb.dir, "hub/.data/art.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    orchestrator: fake,
    dataDir: join(sb.dir, "hub/.data"),
    imagegen: gen,
    model3d: m3d,
    checker,
    webRefs,
  });
  const repo = sb.makeGameRepo("games/bordee", { "CLAUDE.md": "# Bordée\nBataille navale 1900-1945 stylisée.\n" });
  await sb.hub.projects.register(sb.human(), { path: repo, slug: "bordee", name: "Bordée" });
  return { sb, fake, gen, m3d, repo, art: sb.hub.art };
}

const log = (repo: string) => execFileSync("git", ["-C", repo, "log", "--format=%s"], { encoding: "utf8" });

describe("Directeur artistique (ADR-43)", () => {
  it("discute, tient la bible, propose des assets avec prompts Midjourney et questions de goût, et commite dans studio/art", async () => {
    const { sb, fake, repo, art } = await setup();
    fake.replies.push(
      [
        "Je propose une direction « affiche de propagande navale » : aplats, peu de couleurs, silhouettes fortes.",
        "[[CHOIX: Quelle ambiance pour la mer ?]] Grise et dramatique | Bleu profond d'affiche | Turquoise lumineuse [[/CHOIX]]",
        "[[BIBLE]]\n# Bible visuelle de Bordée\n\n## Palette\n- #1B2A3A : mer\n[[/BIBLE]]",
        '[[ASSET]] {"name": "Illustration du cuirassé", "type": "illustration de carte", "usage": "fiche de navire dans la main", "specs": "PNG 512×768"} [[/ASSET]]',
        "[[MIDJOURNEY: A-0001]] dreadnought battleship, 1910s naval propaganda poster, flat colors --ar 2:3\n---\nbattleship silhouette, art deco poster --ar 2:3 [[/MIDJOURNEY]]",
      ].join("\n\n"),
    );
    const human = art.send(sb.human(), "bordee", "Aide-moi à trouver un style pour le jeu");
    expect(human.role).toBe("human");
    await art.idle();

    // Le DA lit studio/art, cherche sur le web, avec son propre modèle ; il connaît le jeu par CLAUDE.md.
    expect(fake.reads[0]).toEqual({ readDir: join(repo, "studio", "art"), tools: ["WebSearch", "WebFetch"], role: "art" });
    expect(fake.calls[0]!.systemPrompt).toMatch(/DIRECTEUR ARTISTIQUE[\s\S]*Bataille navale 1900-1945/);

    const state = art.state("bordee");
    expect(state.bible).toMatch(/# Bible visuelle de Bordée/);
    expect(state.assets).toMatchObject([
      { id: "A-0001", name: "Illustration du cuirassé", status: "production", prompts: ["dreadnought battleship, 1910s naval propaganda poster, flat colors --ar 2:3", "battleship silhouette, art deco poster --ar 2:3"] },
    ]);
    const reply = state.messages[1]!;
    expect(reply.role).toBe("art");
    expect(reply.text).toMatch(/§CHOIX§ Quelle ambiance pour la mer \? \|\| Grise et dramatique \|\| Bleu profond d'affiche \|\| Turquoise lumineuse/);
    expect(reply.text).not.toMatch(/\[\[/);
    expect(reply.text).toMatch(/\n§FAIT§ bible mise à jour · A-0001 proposé · prompts Midjourney pour A-0001$/);
    expect(readFileSync(join(repo, "studio", "art", "assets.json"), "utf8")).toMatch(/"id": "A-0001"/);
    expect(log(repo)).toMatch(/^art: bible mise à jour, A-0001 proposé/m);
    expect(state.busy.replying).toBe(false);
  }, 30_000);

  it("les compétences données au DA arrivent dans ses consignes", async () => {
    const { sb, fake, art } = await setup();
    sb.hub.skills.save(sb.human(), { name: "da-methode", description: "Méthode de production", body: "Valider une cible avant la série.", agents: ["art_director"], enabled: true });
    fake.replies.push("Entendu.");
    art.send(sb.human(), "bordee", "On commence ?");
    await art.idle();
    expect(fake.calls[0]!.systemPrompt).toMatch(/<competence nom="da-methode"[\s\S]*Valider une cible avant la série/);
  }, 30_000);

  it("le moodboard : images vérifiées, rangées et commentées", async () => {
    const { sb, fake, repo, art } = await setup();
    await expect(art.upload(sb.human(), "bordee", "moodboard", Buffer.from("pas une image"), "image/png")).rejects.toThrow(/pas une image valide/);
    await expect(art.upload(sb.human(), "bordee", "moodboard", PNG, "image/gif")).rejects.toThrow(/PNG, JPEG et WebP/);
    await expect(art.upload(sb.human(), "bordee", "moodboard", Buffer.concat([PNG, Buffer.alloc(15 * 1024 * 1024)]), "image/png")).rejects.toThrow(/trop lourde/);

    const { file } = await art.upload(sb.human(), "bordee", "moodboard", PNG, "image/png", "Affiche Navale.PNG");
    expect(file).toBe("moodboard/affiche-navale.png");
    expect((await art.upload(sb.human(), "bordee", "moodboard", PNG, "image/png", "Affiche Navale.PNG")).file).toBe("moodboard/affiche-navale-2.png");
    expect(log(repo)).toMatch(/art: image d'inspiration moodboard\/affiche-navale.png/);

    fake.replies.push("Belle référence.\n[[NOTE: moodboard/affiche-navale.png]] Les aplats et le ciel orangé : à garder. [[/NOTE]]\n[[NOTE: ../../secret.png]] non [[/NOTE]]");
    art.send(sb.human(), "bordee", `Regarde ça\n§IMAGE§ ${file}`);
    await art.idle();
    expect(fake.calls[0]!.prompt).toMatch(/Image : moodboard\/affiche-navale.png/);
    expect(art.state("bordee").moodboard).toEqual([
      { file: "moodboard/affiche-navale-2.png", note: null },
      { file: "moodboard/affiche-navale.png", note: "Les aplats et le ciel orangé : à garder." },
    ]);
    // Seules les images de studio/art sont servies.
    expect(art.file("bordee", "moodboard/affiche-navale.png").mime).toBe("image/png");
    expect(() => art.file("bordee", "../CLAUDE.md")).toThrow(/Chemin refusé/);
    expect(() => art.file("bordee", "assets.json")).toThrow(/Seules les images/);
  }, 30_000);

  it("le validateur juge chaque rendu ; vous pouvez trancher ; l'intégration part au directeur et se termine à la fusion", async () => {
    const { sb, fake, repo, art } = await setup();
    fake.replies.push('[[ASSET]] {"name": "Icône de poudre", "type": "icône", "usage": "pastilles de poudre du HUD", "specs": "PNG 64×64, fond transparent"} [[/ASSET]]');
    art.send(sb.human(), "bordee", "Il me faut une icône de poudre");
    await art.idle();

    // Premier rendu : à retoucher, avec un prompt corrigé.
    fake.extractions.push({ ok: false, summary: "Trop détaillé pour 64 px.", points: ["Silhouette illisible à petite taille"], prompt: "gunpowder barrel icon, flat, bold silhouette --ar 1:1" } as never);
    await art.upload(sb.human(), "bordee", "A-0001", PNG, "image/png", "essai.png");
    await art.idle();
    let asset = art.state("bordee").assets[0]!;
    expect(asset).toMatchObject({ status: "production", renders: ["production/a-0001-essai.png"], verdict: { ok: false, by: "validator", file: "production/a-0001-essai.png" } });
    expect(asset.prompts[0]).toBe("gunpowder barrel icon, flat, bold silhouette --ar 1:1");
    expect(fake.reads.at(-1)).toEqual({ readDir: join(repo, "studio", "art"), role: "art" });
    expect(fake.calls.at(-1)!.prompt).toMatch(/production\/a-0001-essai.png[\s\S]*pastilles de poudre/);
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/§IMAGE§ production\/a-0001-essai.png\n\*\*A-0001 « Icône de poudre » : à retoucher\.\*\*/);

    // Deuxième rendu : conforme.
    fake.extractions.push({ ok: true, summary: "Lisible et dans la palette.", points: [], prompt: null } as never);
    await art.upload(sb.human(), "bordee", "A-0001", PNG, "image/png", "essai.png");
    await art.idle();
    asset = art.state("bordee").assets[0]!;
    expect(asset).toMatchObject({ status: "integration", verdict: { ok: true, file: "production/a-0001-essai-2.png" } });
    expect(log(repo)).toMatch(/art: A-0001 validé \(validateur\)/);
    // Validé : il part tout seul dans le jeu (ADR-48).
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/A-0001 « Icône de poudre » part dans le jeu/);
    expect(sb.hub.conversations.listThreads("bordee").filter((t) => t.title === "Intégrer A-0001 : Icône de poudre")).toHaveLength(1);

    // Vous gardez le dernier mot : « Refaire », puis « Valider » relance l'intégration.
    expect((await art.decide(sb.human(), "bordee", "A-0001", "refaire")).status).toBe("production");
    expect(await art.decide(sb.human(), "bordee", "A-0001", "valider")).toMatchObject({ status: "valide", verdict: { by: "human" } });
    await art.idle();
    expect(art.state("bordee").assets[0]!.status).toBe("integration");

    // « Faire intégrer » à la main reste possible : une demande au directeur, qui lance un chantier « A-0001 … ».
    const { thread } = await art.integrate(sb.human(), "bordee", "A-0001");
    await sb.hub.conversations.idle();
    expect(sb.hub.conversations.getThread("bordee", thread).title).toBe("Intégrer A-0001 : Icône de poudre");
    expect(sb.hub.conversations.messages("bordee", thread)[0]!.text).toMatch(/studio\/art\/production\/a-0001-essai-2.png[\s\S]*titre commence par « A-0001 »/);
    expect(art.state("bordee").assets[0]!.status).toBe("integration");
    // Le directeur voit les visuels prêts à brancher.
    await vi.waitFor(() => expect(sb.hub.conversations.messages("bordee", thread)).toHaveLength(2));
    expect(fake.calls.filter((c) => c.kind === "reply").at(-1)!.systemPrompt).toMatch(/Validés, à brancher dans le jeu[\s\S]*A-0001 Icône de poudre/);

    art.onTaskStatus({ id: "T-0001", project: "bordee", title: "A-0001 : brancher l'icône de poudre", goal: "…", status: "merged" } as Task);
    await art.idle();
    expect(art.state("bordee").assets[0]!.status).toBe("integre");
    expect(log(repo)).toMatch(/art: A-0001 intégré\(s\) par T-0001/);
    // Sans vérifications du hub, pas de capture : on le dit.
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/A-0001 est dans le jeu \(T-0001\)\. Pas de capture/);
    await expect(art.integrate(sb.human(), "bordee", "A-0001")).rejects.toThrow(/Seul un asset validé/);
  }, 30_000);

  it("un visuel validé attend que son chantier ait posé sa place, puis son intégration passe devant la file (ADR-60)", async () => {
    const { sb, fake, repo, art } = await setup();
    sb.hub.projects.setAutonomy(sb.human(), "bordee", "workshop");
    fake.replies.push('[[ASSET]] {"name": "Icône de poudre", "type": "icône", "usage": "pastilles de poudre du HUD", "specs": "PNG 64×64"} [[/ASSET]]');
    art.send(sb.human(), "bordee", "Il me faut une icône de poudre");
    await art.idle();

    // Deux chantiers de la conception posent un provisoire pour A-0001 ; ils attendent leur tour.
    const thread = sb.hub.conversations.createThread("bordee", "Refonte du HUD").id;
    const pending = `${PENDING_VISUALS} :\n- A-0001 « Icône de poudre » (icône) : pastilles de poudre du HUD`;
    const hud = sb.hub.tasks.createFromConversation("bordee", { title: "HUD de poudre", goal: `Objectif : le HUD.\n\n${pending}` }, thread);
    const shop = sb.hub.tasks.createFromConversation("bordee", { title: "Boutique", goal: `Objectif : la boutique.\n\n${pending}` }, thread);
    const set = (id: string, patch: Record<string, string>) => {
      for (const [k, v] of Object.entries(patch)) sb.hub.db.prepare(`UPDATE tasks SET data_json = json_set(data_json, '$.${k}', ?)${k === "status" ? ", status = ?" : ""} WHERE id = ?`).run(...(k === "status" ? [v, v, id] : [v, id]));
      return sb.hub.tasks.get("bordee", id);
    };
    set(hud.id, { queued_at: "2026-10-22T10:00:00.000Z" });
    set(shop.id, { queued_at: "2026-10-22T10:00:01.000Z" });

    // Validé avant que le jeu ait sa place : il attend le premier chantier, sans rien envoyer au directeur.
    fake.extractions.push({ ok: true, summary: "Lisible.", points: [], prompt: null } as never);
    await art.upload(sb.human(), "bordee", "A-0001", PNG, "image/png", "essai.png");
    await art.idle();
    expect(art.state("bordee").assets[0]).toMatchObject({ status: "valide", waitsFor: hud.id });
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(new RegExp(`dès que le chantier ${hud.id} « HUD de poudre » aura posé sa place`));
    expect(sb.hub.conversations.listThreads("bordee").filter((t) => t.title.startsWith("Intégrer A-0001"))).toHaveLength(0);

    // Le chantier fusionné : le provisoire est en place, l'intégration part, sans compter ce chantier comme l'intégration.
    art.onTaskStatus(set(hud.id, { status: "merged" }));
    await art.idle();
    expect(art.state("bordee").assets[0]).toMatchObject({ status: "integration", waitsFor: null });
    const integ = sb.hub.conversations.listThreads("bordee").find((t) => t.title === "Intégrer A-0001 : Icône de poudre")!;
    expect(sb.hub.conversations.messages("bordee", integ.id)[0]!.text).toMatch(new RegExp(`Sa place existe déjà : ${hud.id} « HUD de poudre » y a posé un provisoire`));
    expect(log(repo)).toMatch(new RegExp(`art: A-0001 validé, intégré après ${hud.id}`));

    // Le chantier d'intégration passe devant ceux qui attendaient déjà.
    const branch = sb.hub.tasks.createFromConversation("bordee", { title: "A-0001 : brancher l'icône de poudre", goal: "Objectif : brancher A-0001." }, integ.id);
    set(branch.id, { queued_at: "2026-10-22T11:00:00.000Z" });
    expect(sb.hub.tasks.queued("bordee").map((t) => t.id)).toEqual([branch.id, shop.id]);

    // Un autre chantier qui cite le visuel n'est pas l'intégration ; celui « A-0001 … », si.
    art.onTaskStatus(set(shop.id, { status: "merged" }));
    await art.idle();
    expect(art.state("bordee").assets[0]!.status).toBe("integration");
    art.onTaskStatus(set(branch.id, { status: "merged" }));
    await art.idle();
    expect(art.state("bordee").assets[0]!.status).toBe("integre");
  }, 30_000);

  it("un visuel validé dont les chantiers ont tous été annulés part dans le jeu sans attendre (ADR-60)", async () => {
    const { sb, fake, art } = await setup();
    sb.hub.projects.setAutonomy(sb.human(), "bordee", "workshop");
    fake.replies.push('[[ASSET]] {"name": "Icône de poudre", "type": "icône", "usage": "HUD", "specs": ""} [[/ASSET]]');
    art.send(sb.human(), "bordee", "Il me faut une icône de poudre");
    await art.idle();
    const thread = sb.hub.conversations.createThread("bordee", "Refonte du HUD").id;
    const hud = sb.hub.tasks.createFromConversation("bordee", { title: "HUD de poudre", goal: `Objectif : le HUD.\n\n${PENDING_VISUALS} :\n- A-0001 « Icône de poudre » (icône) : HUD` }, thread);
    fake.extractions.push({ ok: true, summary: "Lisible.", points: [], prompt: null } as never);
    await art.upload(sb.human(), "bordee", "A-0001", PNG, "image/png", "essai.png");
    await art.idle();
    expect(art.state("bordee").assets[0]!.waitsFor).toBe(hud.id);
    sb.hub.db.prepare("UPDATE tasks SET status = 'cancelled', data_json = json_set(data_json, '$.status', 'cancelled') WHERE id = ?").run(hud.id);
    art.onTaskStatus(sb.hub.tasks.get("bordee", hud.id));
    await art.idle();
    expect(art.state("bordee").assets[0]!.status).toBe("integration");
    expect(sb.hub.conversations.messages("bordee", sb.hub.conversations.listThreads("bordee").find((t) => t.title.startsWith("Intégrer A-0001"))!.id)[0]!.text).not.toMatch(/Sa place existe déjà/);
  }, 30_000);

  it("redémarrage du hub en plein travail : la file est gardée, le chantier coupé repart en tête, le DA reprend, la 3D aussi (ADR-61, ADR-70)", async () => {
    const { sb, fake, art } = await setup();
    sb.hub.projects.setAutonomy(sb.human(), "bordee", "workshop");
    fake.replies.push('[[ASSET]] {"name": "Grouillot", "type": "modèle 3D", "usage": "ennemi", "specs": ""} [[/ASSET]]');
    art.send(sb.human(), "bordee", "Il me faut un ennemi");
    await art.idle();

    // L'état laissé par un hub arrêté net : un chantier en cours, deux en file, une 3D en route, un message sans réponse.
    const thread = sb.hub.conversations.createThread("bordee", "Carte").id;
    const make = (title: string) => sb.hub.tasks.createFromConversation("bordee", { title, goal: `Objectif : ${title}.` }, thread);
    const [running, next, last] = [make("Relief"), make("Forêt"), make("Ciel")];
    const set = (id: string, json: string, status?: string) =>
      sb.hub.db.prepare(`UPDATE tasks SET data_json = json_patch(data_json, ?)${status ? ", status = ?" : ""} WHERE id = ?`).run(...(status ? [json, status, id] : [json, id]));
    set(running.id, JSON.stringify({ status: "running", direct: true }), "running");
    set(next.id, JSON.stringify({ queued_at: "2026-10-22T10:00:00.000Z" }));
    set(last.id, JSON.stringify({ queued_at: "2026-10-22T10:00:01.000Z" }));
    sb.hub.db.prepare("INSERT INTO art_jobs (key, project, kind, payload_json, started_at) VALUES ('k', 'bordee', 'model', '{\"id\":\"A-0001\"}', 'x')").run();
    sb.hub.db.prepare("INSERT INTO art_messages (id, project, seq, role, text, at) VALUES ('m', 'bordee', 99, 'human', 'Et ses couleurs ?', 'x')").run();

    const restarted = sb.hub.tasks.recoverInterrupted();
    expect(restarted).toEqual([{ project: "bordee", id: running.id, again: expect.any(String), thread }]);
    expect(sb.hub.tasks.get("bordee", running.id).status).toBe("cancelled");
    const again = sb.hub.tasks.get("bordee", restarted[0]!.again);
    expect(again).toMatchObject({ title: "Relief", goal: "Objectif : Relief.", status: "draft", origin: { thread } });
    expect(sb.hub.tasks.queued("bordee").map((t) => t.id)).toEqual([again.id, next.id, last.id]);

    fake.replies.push("Des teintes de chitine sombre.");
    art.resume();
    await art.idle();
    const texts = art.state("bordee").messages.map((m) => m.text);
    // La 3D repart seule : le carnet de commandes reprend ce que Tripo avait commencé, sans repayer (ADR-70).
    expect(texts.some((t) => t.startsWith("La 3D de A-0001 a été interrompue par le redémarrage du hub : je la reprends. Ce que Tripo avait déjà fabriqué ou commencé est repris, pas repayé."))).toBe(true);
    expect(texts.some((t) => /chitine sombre/.test(t))).toBe(true);
    expect(sb.hub.db.prepare("SELECT COUNT(*) AS n FROM art_jobs").get()).toEqual({ n: 0 });
    await Promise.all([sb.hub.tasks.idle(), sb.hub.conversations.idle()]);
  }, 30_000);

  it("la file des visuels : un à la fois, dans l'ordre des chantiers ; « Lancer » passe devant ; mis de côté, personne n'y touche (ADR-62)", async () => {
    const { sb, fake, repo, art } = await setup();
    sb.hub.projects.setAutonomy(sb.human(), "bordee", "workshop");
    // Trois fiches, avec une question en suspens : la file attend votre réponse.
    fake.replies.push(
      '[[ASSET]] {"name": "Kit village", "type": "décor", "usage": "îlots", "specs": ""} [[/ASSET]]\n[[ASSET]] {"name": "Rochers", "type": "décor", "usage": "carrière", "specs": ""} [[/ASSET]]\n[[ASSET]] {"name": "Gardien chasseur", "type": "personnage", "usage": "classe agile", "specs": ""} [[/ASSET]]\n[[CHOIX: Quelle lumière ?]] Dorée | Nuit [[/CHOIX]]',
    );
    art.send(sb.human(), "bordee", "La carte");
    await art.idle();
    // Deux chantiers en file attendent des visuels : la carrière (A-0002) passe avant le village (A-0001).
    const thread = sb.hub.conversations.createThread("bordee", "Carte").id;
    const needing = (title: string, id: string, name: string, at: string) => {
      const t = sb.hub.tasks.createFromConversation("bordee", { title, goal: `Objectif : ${title}.\n\n${PENDING_VISUALS} :\n- ${id} « ${name} » (décor) : x` }, thread);
      sb.hub.db.prepare("UPDATE tasks SET data_json = json_set(data_json, '$.queued_at', ?) WHERE id = ?").run(at, t.id);
      return t;
    };
    needing("Village", "A-0001", "Kit village", "2026-10-22T10:00:02.000Z");
    const quarry = needing("Carrière", "A-0002", "Rochers", "2026-10-22T10:00:01.000Z");
    expect(art.state("bordee").queue).toEqual([
      { id: "A-0002", need: { id: quarry.id, title: "Carrière" } },
      { id: "A-0001", need: expect.objectContaining({ title: "Village" }) },
      { id: "A-0003", need: null },
    ]);
    expect(art.state("bordee").messages.filter((m) => m.text.startsWith("(File des visuels)"))).toHaveLength(0);

    // A-0003 mis de côté : il sort de la file, la DA le sait, et ses balises ne le relancent pas.
    expect((await art.setAside(sb.human(), "bordee", "A-0003", true)).status).toBe("ecarte");
    expect(log(repo)).toMatch(/art: A-0003 mis de côté/);

    // Votre réponse : la DA répond, puis la file lui confie la fiche attendue en premier, et une seule.
    fake.replies.push("Dorée, noté.", '[[ASSET]] {"id": "A-0003", "status": "production"} [[/ASSET]] Je prépare les rochers.');
    art.send(sb.human(), "bordee", "Quelle lumière ? → Dorée");
    await art.idle();
    let st = art.state("bordee");
    const launched = st.messages.filter((m) => m.text.startsWith("(File des visuels)"));
    expect(launched).toHaveLength(1);
    expect(launched[0]!.text).toMatch(new RegExp(`Occupe-toi maintenant de A-0002 « Rochers »[\\s\\S]*Le chantier ${quarry.id} « Carrière » l'attend`));
    expect(fake.calls.at(-1)!.systemPrompt).toMatch(/<file_des_visuels>[\s\S]*Prochaines dans la file : A-0001[\s\S]*Mis de côté par l'utilisateur[\s\S]*A-0003 « Gardien chasseur »/);
    expect(st.assets.find((a) => a.id === "A-0003")!.status).toBe("ecarte");
    expect(st.queue.map((q) => q.id)).toEqual(["A-0001"]);

    // « Lancer » fait passer A-0001 sans attendre ; remis en file, A-0003 y revient à la fin.
    fake.replies.push("Je m'occupe du village.");
    art.launch(sb.human(), "bordee", "A-0001");
    await art.idle();
    st = art.state("bordee");
    expect(st.messages.some((m) => m.text.startsWith("(Lancement demandé par l'utilisateur) Occupe-toi maintenant de A-0001"))).toBe(true);
    expect(() => art.launch(sb.human(), "bordee", "A-0001")).toThrow(/déjà confié/);
    await art.setAside(sb.human(), "bordee", "A-0003", false);
    expect(art.state("bordee").queue.map((q) => q.id)).toEqual(["A-0003"]);
    // Rien ne part tant que les visuels confiés ne sont pas validés.
    expect(art.state("bordee").messages.filter((m) => /Occupe-toi maintenant de A-0003/.test(m.text))).toHaveLength(0);
  }, 30_000);

  it("la file des visuels attend quand la jauge d'abonnement est presque pleine (ADR-62)", async () => {
    const { sb, fake, art } = await setup();
    art.paused = () => true;
    fake.replies.push('[[ASSET]] {"name": "Rochers", "type": "décor", "usage": "carrière", "specs": ""} [[/ASSET]]');
    art.send(sb.human(), "bordee", "Des rochers");
    await art.idle();
    expect(art.state("bordee").messages.filter((m) => m.text.startsWith("(File des visuels)"))).toHaveLength(0);
    art.paused = () => false;
    fake.replies.push("Je m'en occupe.");
    art.onTaskStatus({ id: "T-0001", project: "bordee", title: "x", goal: "x", status: "merged" } as Task);
    await art.idle();
    expect(art.state("bordee").messages.filter((m) => m.text.startsWith("(File des visuels) Occupe-toi maintenant de A-0001"))).toHaveLength(1);
  }, 30_000);

  it("une réponse en échec reste visible et se relance en renvoyant un message", async () => {
    const { sb, fake, art } = await setup();
    fake.reply = async () => {
      throw new Error("limite atteinte");
    };
    art.send(sb.human(), "bordee", "Bonjour");
    await art.idle();
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/Je n'ai pas pu répondre : limite atteinte/);
  });
});

describe("générateur d'images local (ADR-46, ADR-49)", () => {
  it("s'installe sur votre clic ; la DA fait fabriquer, le validateur choisit, le hub réessaie seul jusqu'à un essai conforme", async () => {
    const { sb, fake, gen, repo, art } = await setupLocal();
    // Pas encore installé : la DA donne des prompts Midjourney, et rien ne se fabrique.
    expect(art.state("bordee").generator.installed).toBe(false);
    fake.replies.push('[[ASSET]] {"name": "Icône de poudre", "type": "icône", "usage": "HUD", "specs": "64×64"} [[/ASSET]]');
    art.send(sb.human(), "bordee", "Il me faut une icône de poudre");
    await art.idle();
    expect(fake.calls.at(-1)!.systemPrompt).toMatch(/pas encore installé[\s\S]*MIDJOURNEY/);
    expect(() => art.generate(sb.human(), "bordee", "A-0001")).toThrow(/Installez d'abord/);

    art.installGenerator(sb.human());
    expect(art.state("bordee").generator.installed).toBe(true);

    // Tour 1 refusé (le validateur corrige le prompt), tour 2 conforme avec le 2e essai.
    fake.extractions.push({ best: 3, ok: false, usable: false, summary: "Trop chargé.", points: ["Silhouette confuse"], prompt: "A gunpowder keg icon, bold flat shapes, plain background." } as never);
    fake.extractions.push({ best: 2, ok: true, usable: true, summary: "Lisible et dans la palette.", points: [], prompt: null } as never);
    fake.replies.push("Je la fais fabriquer.\n[[GENERER: A-0001 | 1000x1000]] A gunpowder keg icon, plain background. [[/GENERER]]");
    art.send(sb.human(), "bordee", "Vas-y");
    await art.idle();
    expect(fake.calls.find((c) => c.prompt.includes("Vas-y"))!.systemPrompt).toMatch(/générateur d'images local est prêt[\s\S]*GENERER/);

    expect(gen.requests).toHaveLength(6);
    expect(gen.requests[0]).toMatchObject({ prompt: "A gunpowder keg icon, plain background.", width: 1024, height: 1024 });
    expect(gen.requests[0]!.init).toBeUndefined();
    expect(gen.requests[3]!.prompt).toBe("A gunpowder keg icon, bold flat shapes, plain background.");
    const a = art.state("bordee").assets[0]!;
    // Validé : il part tout seul dans le jeu.
    expect(a).toMatchObject({ status: "integration", format: "1024x1024", verdict: { ok: true, by: "validator", file: "production/a-0001-t2-e2.png" } });
    expect(a.renders).toHaveLength(6);
    expect(a.renders.at(-1)).toBe("production/a-0001-t2-e2.png");
    expect(existsSync(join(repo, "studio", "art", "production", "a-0001-t1-e1.png"))).toBe(true);
    // Le validateur a vu les trois essais de chaque tour, avec la grille d'une image finale (pas de 3D ici).
    const picks = fake.calls.filter((c) => c.kind === "structured");
    expect(picks).toHaveLength(2);
    expect(picks[0]!.systemPrompt).toMatch(/Tu juges un rendu[\s\S]*code hexadécimal exact/);
    expect(picks[0]!.prompt).toMatch(/1\. production\/a-0001-t1-e1.png\n2\. production\/a-0001-t1-e2.png\n3\. production\/a-0001-t1-e3.png/);
    const messages = art.state("bordee").messages.map((m) => m.text);
    expect(messages.some((t) => /pas encore\*\* \(tour 1 sur 2\)[\s\S]*Je relance un tour/.test(t))).toBe(true);
    expect(messages.at(-2)).toMatch(/^§IMAGE§ production\/a-0001-t2-e1.png\n§IMAGE§ production\/a-0001-t2-e2.png[\s\S]*conforme\*\* \(essai 2, tour 2\)[\s\S]*Je le fais intégrer/);
    expect(messages.at(-1)).toMatch(/part dans le jeu/);
    expect(log(repo)).toMatch(/art: A-0001 validé \(validateur, tour 2\)/);
    expect(art.state("bordee").busy.generating).toEqual([]);

    // « Refaire » relance la fabrication ; deux tours sans essai utilisable : le meilleur reste, vous tranchez.
    for (let i = 0; i < 2; i++) fake.extractions.push({ best: 1, ok: false, usable: false, summary: "Non.", points: [], prompt: null } as never);
    await art.decide(sb.human(), "bordee", "A-0001", "refaire");
    await art.idle();
    expect(gen.requests).toHaveLength(12);
    expect(art.state("bordee").assets[0]).toMatchObject({ status: "production", verdict: { ok: false, file: "production/a-0001-t2-e1-2.png" } });
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/Aucun essai utilisable/);
    expect((await art.decide(sb.human(), "bordee", "A-0001", "valider")).verdict).toMatchObject({ by: "human", file: "production/a-0001-t2-e1-2.png" });
    await art.idle();
    expect(art.state("bordee").assets[0]!.status).toBe("integration");
  }, 60_000);

  it("au dernier tour, un essai utilisable est gardé au lieu de vous faire trancher sur des détails", async () => {
    const { sb, fake, gen, art } = await setupLocal();
    gen.installed = true;
    fake.extractions.push({ best: 1, ok: false, usable: true, summary: "Rivets en trop.", points: ["Rivets"], prompt: "A keg, smooth." } as never);
    fake.extractions.push({ best: 2, ok: false, usable: true, summary: "Un rivet résiste.", points: ["Un rivet"], prompt: null } as never);
    fake.replies.push('[[ASSET]] {"name": "Tonneau", "type": "icône", "usage": "HUD"} [[/ASSET]]\n[[GENERER: A-0001]] A keg. [[/GENERER]]');
    art.send(sb.human(), "bordee", "Un tonneau");
    await art.idle();
    expect(gen.requests).toHaveLength(6);
    expect(art.state("bordee").assets[0]).toMatchObject({ status: "integration", verdict: { ok: true, file: "production/a-0001-t2-e2.png" } });
    expect(art.state("bordee").messages.map((m) => m.text).find((t) => t.includes("tour 2 sur 2"))).toMatch(/essai 2 retenu\*\* \(tour 2 sur 2\), avec des défauts mineurs/);
  }, 30_000);

  it("une panne du générateur s'affiche et la fiche peut relancer", async () => {
    const { sb, fake, gen, art } = await setupLocal();
    gen.installed = true;
    gen.generate = async () => {
      throw new Error("ComfyUI ne démarre pas");
    };
    fake.replies.push('[[ASSET]] {"name": "Drapeau", "type": "icône", "usage": "HUD"} [[/ASSET]]\n[[GENERER: A-0001]] A flag. [[/GENERER]]');
    art.send(sb.human(), "bordee", "Un drapeau");
    await art.idle();
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/Le générateur n'a pas pu fabriquer A-0001 : ComfyUI ne démarre pas/);
    expect(art.state("bordee").assets[0]).toMatchObject({ status: "production", prompts: ["A flag."] });
  }, 30_000);

  it("le cadrage d'abord : une question bloque la fabrication ; puis croquis, votre clic, variantes du croquis, 3D, jeu", async () => {
    const { sb, fake, gen, m3d, art } = await setupLocal();
    gen.installed = true;
    art.installBlender(sb.human());
    await art.setTripoKey(sb.human(), "tsk_0123456789abcdef");
    const croquis = [
      "[[CROQUIS: A-0001 | 832x1216]] # Chevalier massif",
      "A massive armored knight, front view.",
      "---",
      "# Colosse de pierre",
      "A stone-like colossus, front view.",
      "---",
      "# Templier élancé",
      "A slender templar, front view.",
      "[[/CROQUIS]]",
    ].join("\n");
    // Une question et des croquis dans la même réponse : rien ne part.
    fake.replies.push(
      `Deux questions avant de dessiner.\n[[CHOIX: Quelle allure ?]] Lourd | Agile [[/CHOIX]]\n[[ASSET]] {"name": "Titan", "type": "personnage", "usage": "joueur", "specs": "Plaques #6E6A63, combinaison #2A2B2E, visière #F2EBDD"} [[/ASSET]]\n[[MODELE3D: A-0001 | taille 1,8 | triangles 6000 | animations idle, walk]]\n${croquis}`,
    );
    art.send(sb.human(), "bordee", "Le Titan");
    await art.idle();
    expect(gen.requests).toHaveLength(0);
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/§FAIT§[\s\S]*fabrication en attente de vos réponses/);

    // Les réponses arrivent : les trois croquis se font, sans validateur, et vous choisissez d'un clic.
    fake.replies.push(`Va pour le lourd. Voici trois directions.\n${croquis}`);
    art.send(sb.human(), "bordee", "Quelle allure ? → Lourd");
    await art.idle();
    expect(gen.requests.map((r) => r.prompt)).toEqual(["A massive armored knight, front view.", "A stone-like colossus, front view.", "A slender templar, front view."]);
    expect(gen.requests[0]).toMatchObject({ width: 832, height: 1216 });
    let a = art.state("bordee").assets[0]!;
    expect(a.sketches!.map((s) => [s.file, s.label])).toEqual([
      ["production/a-0001-croquis-1.png", "Chevalier massif"],
      ["production/a-0001-croquis-2.png", "Colosse de pierre"],
      ["production/a-0001-croquis-3.png", "Templier élancé"],
    ]);
    const question = art.state("bordee").messages.at(-1)!.text;
    // Chaque croquis est une option illustrée de la question (ADR-58).
    expect(question).toMatch(
      /§CHOIX§ Quel croquis pour A-0001 « Titan » \? \|\| Croquis 1 : Chevalier massif @@ production\/a-0001-croquis-1.png \|\| Croquis 2 : Colosse de pierre @@ production\/a-0001-croquis-2.png \|\| Croquis 3 : Templier élancé @@ production\/a-0001-croquis-3.png \|\| Aucun, on en reparle/,
    );
    expect(fake.calls.filter((c) => c.kind === "structured")).toHaveLength(0);

    // Votre clic : pas de tour du Directeur artistique, la fabrication part du croquis 2.
    const replies = fake.calls.filter((c) => c.kind === "reply").length;
    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Silhouette nette, de face, fond uni.", points: [], prompt: null } as never);
    fake.extractions.push(sheetOk as never);
    fake.extractions.push(...(artisanSteps() as never[]));
    fake.extractions.push({ ok: true, forme_ok: true, summary: "Propre et lisible de loin.", points: [] } as never);
    art.send(sb.human(), "bordee", "Quel croquis pour A-0001 « Titan » ? → Croquis 2 : Colosse de pierre");
    await art.idle();
    expect(fake.calls.filter((c) => c.kind === "reply")).toHaveLength(replies);
    // Le croquis lui-même est le premier candidat ; les deux autres sont ses variantes.
    expect(gen.requests.slice(3).map((r) => [r.prompt, r.init?.denoise])).toEqual([
      ["A stone-like colossus, front view.", 0.5],
      ["A stone-like colossus, front view.", 0.5],
    ]);
    const pick = fake.calls.filter((c) => c.kind === "structured")[0]!;
    expect(pick.systemPrompt).toMatch(/serviront de MODÈLE à une 3D[\s\S]*Ce qui ne bloque PAS/);
    expect(pick.prompt).toMatch(/1\. production\/a-0001-croquis-2.png\n2\. production\/a-0001-t1-e2.png\n3\. production\/a-0001-t1-e3.png[\s\S]*Croquis choisi par le directeur créatif[^\n]*production\/a-0001-croquis-2.png/);
    // L'image retenue part chez Tripo puis à l'atelier Blender, avec la palette de la fiche.
    expect(m3d.tripoCalls).toHaveLength(1);
    expect(m3d.prepares[0]).toMatchObject({ input: "glTF", palette: ["#6E6A63", "#2A2B2E", "#F2EBDD"] });
    a = art.state("bordee").assets[0]!;
    expect(a).toMatchObject({ status: "integration", direction: { file: "production/a-0001-croquis-2.png" }, verdict: { ok: true, file: "production/a-0001-croquis-2.png" }, model: { file: "models/a-0001-3d.glb", source: "production/a-0001-croquis-2.png" } });
    expect(art.state("bordee").messages.some((m) => /Croquis 2 « Colosse de pierre » retenu pour A-0001/.test(m.text))).toBe(true);
  }, 60_000);

  it("3D demandée après coup sur une image déjà validée : l'atelier 3D part tout de suite", async () => {
    const { sb, fake, gen, m3d, art } = await setupLocal();
    gen.installed = true;
    art.installBlender(sb.human());
    await art.setTripoKey(sb.human(), "tsk_0123456789abcdef");
    fake.replies.push('[[ASSET]] {"name": "Titan", "type": "personnage", "usage": "joueur"} [[/ASSET]]\n[[GENERER: A-0001]] A knight. [[/GENERER]]');
    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Bien.", points: [], prompt: null } as never);
    art.send(sb.human(), "bordee", "Le Titan");
    await art.idle();
    expect(art.state("bordee").assets[0]!.status).toBe("integration");
    // Comme pour le Titan : le DA repasse la fiche en production et ajoute la 3D.
    fake.replies.push('[[ASSET]] {"id": "A-0001", "type": "personnage 3D", "status": "production"} [[/ASSET]]\n[[MODELE3D: A-0001 | taille 1,8 | triangles 6000 | animations idle, walk]]');
    fake.extractions.push(sheetOk as never);
    fake.extractions.push(...(artisanSteps() as never[]));
    fake.extractions.push({ ok: true, forme_ok: true, summary: "Fidèle.", points: [] } as never);
    art.send(sb.human(), "bordee", "Fais-le en 3D");
    await art.idle();
    expect(m3d.tripoCalls).toHaveLength(1);
    expect(art.state("bordee").assets[0]).toMatchObject({ status: "integration", model: { file: "models/a-0001-3d.glb" } });
  }, 30_000);

  it("3D : Tripo une seule fois, l'artisan retouche dans Blender pas à pas, une seconde passe sans repayer Tripo, puis le jeu", async () => {
    const { sb, fake, gen, m3d, repo, art } = await setupLocal();
    gen.installed = true;
    m3d.rigType = "octopod";
    fake.replies.push(
      [
        '[[ASSET]] {"name": "Grouillot", "type": "ennemi", "usage": "ennemi de base", "specs": "Carapace #1C1A1E, joints #9BE000"} [[/ASSET]]',
        "[[MODELE3D: A-0001 | taille 0,8 | triangles 3000 | animations quadruped:walk, slash]]",
        "[[GENERER: A-0001 | 1024x1024]] A small chitin insect, front view, plain grey background. [[/GENERER]]",
      ].join("\n"),
    );
    // L'atelier 3D n'est pas prêt : l'image se fait, la 3D attend (et on le dit).
    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Belle silhouette.", points: [], prompt: null } as never);
    art.send(sb.human(), "bordee", "Fais-moi le grouillot en 3D");
    await art.idle();
    let a = art.state("bordee").assets[0]!;
    expect(a).toMatchObject({ status: "production", model3d: { size: 0.8, tris: 3000, rig: true, animations: ["quadruped:walk", "slash"] }, verdict: { ok: true } });
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/La 3D de A-0001 attend l'atelier 3D : installez blender et ajoutez votre clé tripo/);
    expect(() => art.generateModel(sb.human(), "bordee", "A-0001")).toThrow(/Installez Blender/);

    art.installBlender(sb.human());
    await expect(art.setTripoKey(sb.human(), "pas-une-cle")).rejects.toThrow(/tsk_/);
    await art.setTripoKey(sb.human(), "tsk_0123456789abcdef");
    expect(art.state("bordee").workshop3d).toMatchObject({ blender: { installed: true }, tripo: { configured: true } });

    // La planche : le dos montre trop de pattes, Tripo la retouche ; la planche retouchée est cohérente.
    fake.extractions.push({ ok: false, summary: "Le dos montre six pattes.", points: ["Six pattes de dos"], edits: [{ view: "back", prompt: "Only four legs, like the front view." }, { view: "top", prompt: "?" }] } as never);
    fake.extractions.push(sheetOk as never);
    // Passe 1 : l'artisan tourne et repeint ; le validateur refuse la finition (forme bonne).
    fake.extractions.push(...(artisanSteps() as never[]));
    fake.extractions.push({ ok: false, forme_ok: true, summary: "Les joints ne brillent pas.", points: ["Joints éteints"] } as never);
    // Passe 2 : l'artisan reprend avec la remarque ; conforme.
    fake.extractions.push(...(artisanSteps('lueur("#9BE000")', "Joints allumés en vert acide.") as never[]));
    fake.extractions.push({ ok: true, forme_ok: true, summary: "Fidèle, lisible de loin.", points: [] } as never);
    // Pendant l'atelier, l'onglet Visuels voit l'étape, ce que dit l'artisan et sa dernière photo.
    const seen: unknown[] = [];
    m3d.onCode = () => seen.push(structuredClone(art.state("bordee").busy.generating[0]));
    art.generateModel(sb.human(), "bordee", "A-0001");
    await art.idle();
    expect(seen[0]).toMatchObject({
      asset: "A-0001",
      stage: "atelier",
      step: "L'artisan 3D range le modèle dans Blender (pas 1 sur 4)",
      note: "Le modèle regarde de côté et brille : je le tourne et le rends mat.",
      preview: { kind: "atelier", file: "photo-0-trois-quarts.png" },
    });
    expect(art.atelierFile("bordee", "A-0001", "photo-1-trois-quarts.png").path).toBe(join(m3d.atelier("bordee-A-0001"), "photo-1-trois-quarts.png"));
    for (const bad of ["../scene.blend", "scene.blend", "fiche.json", "photo-1-trois-quarts.png/../../x.png"]) expect(() => art.atelierFile("bordee", "A-0001", bad), bad).toThrow(/refusée/);
    expect(() => art.atelierFile("bordee", "../A-0001", "photo-1-face.png")).toThrow(/refusée/);
    expect(m3d.tripoCalls).toHaveLength(1);
    expect(m3d.tripoCalls[0]!.bytes).toBe(PNG.length);
    expect(m3d.prepares).toHaveLength(1);
    expect(m3d.codes).toEqual(["tourner(-90)\nmatiere()",'lueur("#9BE000")']);
    expect(m3d.exports.map((e) => e.output)).toEqual([join(repo, "studio", "art", "models", "a-0001-3d.glb"), join(repo, "studio", "art", "models", "a-0001-3d-2.glb")]);
    // Le modèle brut de Tripo reste hors du dépôt, et disparaît.
    expect(existsSync(`${m3d.atelier("bordee-A-0001")}-brut.glb`)).toBe(false);
    // L'artisan voit la référence, la palette, ses pas précédents et ses photos ; à la seconde passe, la remarque.
    const steps = fake.calls.filter((c) => c.kind === "structured" && /ARTISAN 3D/.test(c.systemPrompt));
    expect(steps).toHaveLength(4);
    expect(steps[0]!.prompt).toMatch(/Palette de la fiche[^\n]*#1C1A1E, #9BE000[\s\S]*Image de référence : reference.png[\s\S]*photo-0-face.png/);
    expect(steps[1]!.prompt).toMatch(/Tes pas précédents :\nPas 1 :[\s\S]*→ réussi\nSortie :\nfait[\s\S]*photo-1-face.png/);
    expect(steps[2]!.prompt).toMatch(/demande ces corrections :\n- Joints éteints/);
    expect(existsSync(join(m3d.atelier("bordee-A-0001"), "fiche.json"))).toBe(true);
    // La planche : une retouche valable (la vue « top » n'existe pas), rejugée, montrée, et transmise à l'artisan et au validateur.
    expect(m3d.viewEdits).toEqual([{ view: "back", prompt: "Only four legs, like the front view." }]);
    const reviews = fake.calls.filter((c) => /PLANCHE/.test(c.systemPrompt));
    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.prompt).toMatch(/Image de référence : production\/a-0001-t1-e1.png\nVue face \(front\) : production\/a-0001-planche-face.png[\s\S]*Vue dos \(back\) : production\/a-0001-planche-dos.png/);
    expect(reviews[1]!.prompt).toMatch(/déjà retouchée/);
    expect(art.state("bordee").messages.map((m) => m.text).find((t) => t.includes("à retoucher.** Le dos"))).toMatch(/Je fais retoucher par Tripo : vue dos\./);
    expect(steps[0]!.prompt).toMatch(/Planche \(ce que le modèle doit montrer sous chaque angle\) : vue-face.png, vue-gauche.png, vue-dos.png, vue-droite.png/);
    expect(existsSync(join(m3d.atelier("bordee-A-0001"), "vue-dos.png"))).toBe(true);
    a = art.state("bordee").assets[0]!;
    expect(a).toMatchObject({
      status: "integration",
      model: { file: "models/a-0001-3d-2.glb", source: "production/a-0001-t1-e1.png", views: ["face", "gauche", "dos", "droite"].map((v) => `production/a-0001-planche-${v}-2.png`), tris: 3000, workshop: "Joints allumés en vert acide.", rigType: "octopod", missingAnimations: ["slash"], verdict: { ok: true, by: "validator" } },
    });
    expect(a.model!.renders).toEqual(["face", "trois-quarts", "profil", "dos", "vue-jeu"].map((x) => `production/a-0001-3d-2-${x}.png`));
    const judge = fake.calls.filter((c) => c.kind === "structured").at(-1)!;
    expect(judge.systemPrompt).toMatch(/MODÈLE 3D[\s\S]*forme_ok/);
    expect(judge.prompt).toMatch(/production\/a-0001-t1-e1.png[\s\S]*Planche dont la 3D est tirée[^\n]*a-0001-planche-face-2.png[\s\S]*production\/a-0001-3d-2-face.png[\s\S]*demandé : 0.8 m/);
    const texts = art.state("bordee").messages.map((m) => m.text);
    expect(texts.find((t) => t.includes("passe 1 sur 2"))).toMatch(/Dans Blender : Tourné face à -Y[\s\S]*Tripo a reconnu ce modèle comme « octopod » : slash[\s\S]*l'artisan reprend la finition/);
    const integration = sb.hub.conversations.listThreads("bordee").find((t) => t.title === "Intégrer A-0001 : Grouillot")!;
    expect(sb.hub.conversations.messages("bordee", integration.id)[0]!.text).toMatch(
      /studio\/art\/models\/a-0001-3d-2.glb[\s\S]*1 unité = 1 mètre[\s\S]*devant tourné vers \+Z[\s\S]*garde ses matériaux[\s\S]*\?vitrine=A-0001/,
    );
    expect(log(repo)).toMatch(/art: modèle 3D de A-0001 validé \(validateur, passe 2\)/);

    // Le chantier est fusionné : sans scène vitrine, la capture de lancement ; à retoucher → une retouche part au directeur, une seule fois.
    const shot = sb.hub.checks!.screenshotPath("bordee", "T-0007");
    mkdirSync(join(shot, ".."), { recursive: true });
    writeFileSync(shot, PNG);
    fake.extractions.push({ visible: true, ok: false, summary: "L'insecte est minuscule à l'écran.", points: ["Échelle trop petite"] } as never);
    art.onTaskStatus({ id: "T-0007", project: "bordee", title: "A-0001 : brancher le grouillot", goal: "…", status: "merged" } as Task);
    await art.idle();
    a = art.state("bordee").assets[0]!;
    expect(a.ingame).toMatchObject({ task: "T-0007", file: "production/a-0001-en-jeu-t-0007.png", visible: true, ok: false, retried: true });
    expect(existsSync(join(repo, "studio", "art", "production", "a-0001-vitrine-t-0007.png"))).toBe(false);
    expect(a.status).toBe("integration");
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/^§IMAGE§ production\/a-0001-en-jeu-t-0007.png\n\*\*A-0001 dans le jeu : à retoucher\.\*\*[\s\S]*J'ai demandé une retouche/);
    const fix = sb.hub.conversations.listThreads("bordee").find((t) => t.title === "Retoucher A-0001 dans le jeu")!;
    expect(sb.hub.conversations.messages("bordee", fix.id)[0]!.text).toMatch(/minuscule[\s\S]*titre commence par « A-0001 »/);

    // La retouche est fusionnée et rend bien : plus de nouvelle retouche.
    writeFileSync(sb.hub.checks!.screenshotPath("bordee", "T-0008"), PNG);
    fake.extractions.push({ visible: true, ok: true, summary: "Bonne taille, bien éclairé.", points: [] } as never);
    art.onTaskStatus({ id: "T-0008", project: "bordee", title: "A-0001 : agrandir le grouillot", goal: "…", status: "merged" } as Task);
    await art.idle();
    expect(art.state("bordee").assets[0]).toMatchObject({ status: "integre", ingame: { task: "T-0008", ok: true } });
    expect(sb.hub.conversations.listThreads("bordee").filter((t) => t.title.startsWith("Retoucher"))).toHaveLength(1);
  }, 60_000);

  it("forme ratée : l'atelier s'arrête sans seconde passe, et vous dit quoi faire", async () => {
    const { sb, fake, gen, m3d, art } = await setupLocal();
    gen.installed = true;
    art.installBlender(sb.human());
    await art.setTripoKey(sb.human(), "tsk_0123456789abcdef");
    fake.replies.push('[[ASSET]] {"name": "Titan", "type": "personnage", "usage": "joueur"} [[/ASSET]]\n[[MODELE3D: A-0001 | taille 1,8 | triangles 6000]]\n[[GENERER: A-0001]] A knight. [[/GENERER]]');
    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Bien.", points: [], prompt: null } as never);
    fake.extractions.push(sheetOk as never);
    fake.extractions.push(...(artisanSteps() as never[]));
    fake.extractions.push({ ok: false, forme_ok: false, summary: "Les jambes sont fondues ensemble.", points: ["Jambes fondues"] } as never);
    art.send(sb.human(), "bordee", "Le Titan en 3D");
    await art.idle();
    expect(m3d.exports).toHaveLength(1);
    expect(art.state("bordee").assets[0]).toMatchObject({ status: "production", model: { verdict: { ok: false } } });
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/La forme elle-même ne va pas[\s\S]*« Refaire la 3D »/);
  }, 30_000);

  it("reprendre la finition : la scène gardée, sans Tripo, les remarques du validateur, et la version retouchée remplace celle du jeu (ADR-55)", async () => {
    const { sb, fake, gen, m3d, art } = await setupLocal();
    gen.installed = true;
    art.installBlender(sb.human());
    await art.setTripoKey(sb.human(), "tsk_0123456789abcdef");
    m3d.rigType = "biped";
    fake.replies.push('[[ASSET]] {"name": "Titan", "type": "personnage", "usage": "joueur", "specs": "Plaques #6E6A63, visière #F2EBDD"} [[/ASSET]]\n[[MODELE3D: A-0001 | taille 1,8 | triangles 20000 | animations idle, run]]\n[[GENERER: A-0001]] A knight. [[/GENERER]]');
    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Bien.", points: [], prompt: null, edit: null } as never);
    fake.extractions.push(sheetOk as never);
    fake.extractions.push(...(artisanSteps() as never[]));
    fake.extractions.push({ ok: true, forme_ok: true, summary: "Fidèle.", points: ["Armure un peu claire", "Visière ambre, sans lueur"] } as never);
    art.send(sb.human(), "bordee", "Le Titan");
    await art.idle();
    expect(art.state("bordee").assets[0]!.status).toBe("integration");
    expect(() => art.retouchModel(sb.human(), "bordee", "A-0002")).toThrow(/introuvable/);

    // Deux passes jugées « mineur » : le modèle, jouable, repart quand même au jeu, en remplacement.
    const step = { note: "Je teinte l'armure et j'allume la visière.", code: 'teinter("#525657", "#6E6A63")\nlueur("#F2EBDD")', photos: true, fini: false, summary: "" };
    const done = { note: "Propre.", code: null, photos: false, fini: true, summary: "Armure gris-pierre, visière allumée." };
    const minor = { ok: false, forme_ok: true, mineur: true, summary: "Jouable ; la visière pourrait être plus large.", points: ["Visière un peu fine"] };
    fake.extractions.push(...([step, done, minor, done, minor] as never[]));
    art.retouchModel(sb.human(), "bordee", "A-0001");
    await art.idle();
    expect(m3d.tripoCalls).toHaveLength(1);
    expect(m3d.prepares).toHaveLength(1);
    const steps = fake.calls.filter((c) => /ARTISAN 3D/.test(c.systemPrompt));
    expect(steps.at(-3)!.prompt).toMatch(/Le validateur demande ces corrections :\n- Armure un peu claire\n- Visière ambre, sans lueur/);
    expect(steps.at(-1)!.prompt).toMatch(/- Visière un peu fine/);
    expect(steps[0]!.systemPrompt).toMatch(/couleurs\(n\)[\s\S]*teinter\(de, vers/);
    const a = art.state("bordee").assets[0]!;
    expect(a).toMatchObject({ status: "integration", model: { workshop: "Armure gris-pierre, visière allumée.", animations: ["idle", "run"], rigType: "biped", verdict: { ok: true } } });
    expect(art.state("bordee").messages.some((m) => /en 3D : jouable\*\* \(passe 2\), quelques retouches mineures restent/.test(m.text))).toBe(true);
    const threads = sb.hub.conversations.listThreads("bordee").filter((t) => t.title === "Intégrer A-0001 : Titan");
    expect(threads).toHaveLength(2);
    const texts = threads.map((t) => sb.hub.conversations.messages("bordee", t.id)[0]!.text);
    expect(texts.filter((t) => /version retouchée d'un modèle déjà branché/.test(t))).toHaveLength(1);
  }, 60_000);

  it("animations : jugées sur leurs bandes, coupées par l'artisan, et une animation remplacée sans refaire le modèle (ADR-56)", async () => {
    const { sb, fake, gen, m3d, art } = await setupLocal();
    gen.installed = true;
    art.installBlender(sb.human());
    await art.setTripoKey(sb.human(), "tsk_0123456789abcdef");
    m3d.rigType = "biped";
    m3d.bandes = true;
    fake.replies.push('[[ASSET]] {"name": "Titan", "type": "personnage", "usage": "joueur", "specs": "Lourd, planté comme un roc"} [[/ASSET]]\n[[MODELE3D: A-0001 | taille 1,8 | triangles 20000 | animations idle, run, hurt]]\n[[GENERER: A-0001]] A knight. [[/GENERER]]');
    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Bien.", points: [], prompt: null, edit: null } as never);
    fake.extractions.push(sheetOk as never);
    fake.extractions.push(...(artisanSteps() as never[]));
    // Passe 1 : le modèle est bon, mais « hurt » est une chute et la course sprinte.
    fake.extractions.push({ ok: true, forme_ok: true, mineur: false, summary: "Fidèle.", points: [] } as never);
    fake.extractions.push({ ok: false, mineur: false, summary: "hurt est une chute au sol ; la course sprinte.", points: ["run : ralentir à 0,8"], remplacements: [{ animation: "hurt", par: "hit_to_body_01", pourquoi: "C'est une chute qui reste au sol 14 s, pas un coup reçu." }] } as never);
    art.send(sb.human(), "bordee", "Le Titan");
    await art.idle();
    const judge = fake.calls.filter((c) => /bandes/.test(c.systemPrompt)).at(-1)!;
    expect(judge.systemPrompt).toMatch(/CATALOGUE DES ANIMATIONS[\s\S]*hurt est une CHUTE/);
    expect(judge.prompt).toMatch(/« hurt » \(13\.8 s\) : bande production\/a-0001-3d(-\d+)?-anim-hurt\.png/);
    let a = art.state("bordee").assets[0]!;
    expect(a).toMatchObject({ status: "production", model: { rigTask: "rig-1", bandes: [expect.stringMatching(/anim-idle\.png$/), expect.stringMatching(/anim-run\.png$/), expect.stringMatching(/anim-hurt\.png$/)], verdict: { ok: false, points: ["Animation : run : ralentir à 0,8"] } } });
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/« remplace hurt par hit_to_body_01 » : 10 crédits Tripo, sans refaire le modèle/);
    expect(fake.calls.filter((c) => /ARTISAN 3D/.test(c.systemPrompt)).at(-1)!.systemPrompt).toMatch(/couper\(nom, debut_s, fin_s\)/);

    // La DA remplace l'animation : Tripo ne pose que la nouvelle sur le squelette gardé, Blender la range, l'artisan coupe.
    fake.replies.push("Je remplace la chute par un vrai coup reçu.\n[[MODELE3D: A-0001 | taille 1,8 | triangles 20000 | animations idle, run, hit_to_body_01]]");
    fake.extractions.push(...(artisanSteps('vitesse("run", 0.8)', "Course ralentie à 0,8.") as never[]));
    fake.extractions.push({ ok: true, forme_ok: true, mineur: false, summary: "Fidèle.", points: [] } as never);
    fake.extractions.push({ ok: true, mineur: false, summary: "Le coup reçu est une réaction courte, la course est lourde.", points: [], remplacements: [] } as never);
    art.send(sb.human(), "bordee", "Remplace hurt par hit_to_body_01");
    await art.idle();
    expect(m3d.tripoCalls).toHaveLength(1);
    expect(m3d.prepares).toHaveLength(1);
    expect(m3d.animates).toEqual([{ rigTask: "rig-1", names: ["biped:hit_to_body_01"] }]);
    expect(m3d.added).toEqual([{ extras: ["glTF-anim"], animations: ["hit_to_body_01"], keep: ["idle", "run", "hit_to_body_01"] }]);
    const steps = fake.calls.filter((c) => /ARTISAN 3D/.test(c.systemPrompt));
    expect(steps.at(-2)!.prompt).toMatch(/Le validateur demande ces corrections :\n- Animation : run : ralentir à 0,8/);
    expect(m3d.codes.at(-1)).toBe('vitesse("run", 0.8)');
    a = art.state("bordee").assets[0]!;
    expect(a).toMatchObject({ status: "integration", model: { animations: ["idle", "run", "hit_to_body_01"], rigTask: "rig-1", verdict: { ok: true } } });
    expect(art.state("bordee").messages.some((m) => /en 3D : conforme\*\* \(passe 1\)[\s\S]*10 crédits Tripo/.test(m.text))).toBe(true);
  }, 60_000);

  it("une animation de la bibliothèque sur un squelette v3.0 refait le modèle avec l'ancien squelette", async () => {
    const { sb, fake, gen, m3d, art } = await setupLocal();
    gen.installed = true;
    art.installBlender(sb.human());
    await art.setTripoKey(sb.human(), "tsk_0123456789abcdef");
    m3d.rigType = "biped";
    m3d.rigModel = "v3.0-20260909";
    m3d.bandes = true;
    fake.replies.push('[[ASSET]] {"name": "Titan", "type": "personnage", "usage": "joueur", "specs": "Lourd"} [[/ASSET]]\n[[MODELE3D: A-0001 | taille 1,8 | triangles 20000 | animations idle, run]]\n[[GENERER: A-0001]] A knight. [[/GENERER]]');
    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Bien.", points: [], prompt: null, edit: null } as never);
    fake.extractions.push(sheetOk as never);
    fake.extractions.push(...(artisanSteps() as never[]));
    fake.extractions.push({ ok: true, forme_ok: true, mineur: false, summary: "Fidèle.", points: [] } as never);
    fake.extractions.push({ ok: false, mineur: false, summary: "Il manque un coup reçu.", points: [], remplacements: [] } as never);
    art.send(sb.human(), "bordee", "Le Titan");
    await art.idle();
    expect(art.state("bordee").assets[0]!.model).toMatchObject({ rigModel: "v3.0-20260909", rigTask: "rig-1" });

    m3d.rigModel = "v1.0-20240301";
    fake.replies.push("Un vrai coup reçu.\n[[MODELE3D: A-0001 | taille 1,8 | triangles 20000 | animations idle, run, hit_to_body_01]]");
    fake.extractions.push(sheetOk as never);
    fake.extractions.push(...(artisanSteps() as never[]));
    fake.extractions.push({ ok: true, forme_ok: true, mineur: false, summary: "Fidèle.", points: [] } as never);
    fake.extractions.push({ ok: true, mineur: false, summary: "Bien.", points: [], remplacements: [] } as never);
    art.send(sb.human(), "bordee", "Remplace par hit_to_body_01");
    await art.idle();
    expect(m3d.animates).toEqual([]);
    expect(m3d.tripoCalls).toHaveLength(2);
    expect(art.state("bordee").assets[0]!.model).toMatchObject({ rigModel: "v1.0-20240301" });
  }, 60_000);

  it("modèle de Tripo : l'artisan le range en quatre pas au plus, sans le repeindre, et un pas trop long est rattrapé (ADR-54)", async () => {
    const { sb, fake, gen, m3d, art } = await setupLocal();
    gen.installed = true;
    art.installBlender(sb.human());
    await art.setTripoKey(sb.human(), "tsk_0123456789abcdef");
    m3d.rigType = "biped";
    // Une ancienne fiche « figurine » (ADR-53, abandonnée) passe par Tripo comme les autres.
    fake.replies.push('[[ASSET]] {"name": "Titan", "type": "personnage", "usage": "joueur", "specs": "Plaques #6E6A63, visière #F2EBDD"} [[/ASSET]]\n[[MODELE3D: A-0001 | taille 1,8 | triangles 20000 | animations idle, run | figurine]]\n[[GENERER: A-0001]] A knight. [[/GENERER]]');
    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Bien.", points: [], prompt: null, edit: null } as never);
    fake.extractions.push(sheetOk as never);
    // Deux pas sans réponse de suite : l'atelier exporte la scène telle quelle, le validateur juge.
    fake.extractions.push(new Error("Claude Code n'a pas répondu en 900 s") as never, new Error("Claude Code n'a pas répondu en 900 s") as never);
    fake.extractions.push({ ok: false, forme_ok: true, summary: "Il regarde de côté.", points: ["Tourner face à -Y"] } as never);
    // Seconde passe : un pas perdu, puis l'artisan reprend, plus court.
    fake.extractions.push(
      new Error("Claude Code n'a pas répondu en 900 s") as never,
      ...([{ note: "Je le tourne face à -Y.", code: "tourner(90)", photos: true, fini: false, summary: "" }, { note: "Propre.", code: null, photos: false, fini: true, summary: "Tourné face à -Y." }] as never[]),
    );
    fake.extractions.push({ ok: true, forme_ok: true, summary: "Fidèle à l'image, lisible.", points: [] } as never);
    art.send(sb.human(), "bordee", "Le Titan");
    await art.idle();
    expect(parseModel3D("taille 1,8 | figurine")).not.toHaveProperty("figurine");
    expect(m3d.tripoCalls).toHaveLength(1);
    expect(m3d.prepares).toHaveLength(1);
    const steps = fake.calls.filter((c) => /ARTISAN 3D/.test(c.systemPrompt));
    expect(steps).toHaveLength(5);
    expect(steps[0]!.systemPrompt).toMatch(/NE LA REPEINS\s+PAS/);
    expect(steps[0]!.systemPrompt).not.toMatch(/FIGURINE/);
    expect(steps[0]!.prompt).toMatch(/modèle de TRIPO : garde sa forme et sa texture[\s\S]*Pas 1 sur 4\./);
    expect(steps[3]!.prompt).toMatch(/n.a pas abouti \(trop long\)[\s\S]*Pas 2 sur 4\./);
    expect(m3d.codes).toEqual(["tourner(90)"]);
    const a = art.state("bordee").assets[0]!;
    expect(a).toMatchObject({ status: "integration", model3d: { tris: 20000, rig: true }, model: { workshop: "Tourné face à -Y.", rigType: "biped" } });
    expect(art.state("bordee").messages.some((m) => /Dans Blender : Interrompu au pas 2/.test(m.text))).toBe(true);
  }, 60_000);

  it("objet simple : ni image ni Tripo, l'artisan le modélise directement dans Blender", async () => {
    const { sb, fake, gen, m3d, art } = await setupLocal();
    gen.installed = true;
    art.installBlender(sb.human());
    expect(art.state("bordee").workshop3d.tripo.configured).toBe(false);
    fake.extractions.push(...(artisanSteps('boite("Caisse", (1, 1, 1), materiau=nouveau_materiau("Bois", "#6B4F3A"))', "Caisse en bois biseautée.") as never[]));
    fake.extractions.push({ ok: true, forme_ok: true, summary: "Lisible.", points: [] } as never);
    fake.replies.push('[[ASSET]] {"name": "Caisse de munitions", "type": "décor", "usage": "sur le pont", "specs": "Bois #6B4F3A"} [[/ASSET]]\n[[MODELE3D: A-0001 | taille 1 | triangles 500 | simple]]');
    art.send(sb.human(), "bordee", "Une caisse de munitions");
    await art.idle();
    expect(gen.requests).toHaveLength(0);
    expect(m3d.tripoCalls).toHaveLength(0);
    expect(m3d.prepares[0]).toMatchObject({ input: null, palette: ["#6B4F3A"] });
    const step = fake.calls.find((c) => /ARTISAN 3D/.test(c.systemPrompt))!;
    expect(step.prompt).toMatch(/objet SIMPLE : la scène est vide[\s\S]*Pas d'image de référence/);
    expect(art.state("bordee").assets[0]).toMatchObject({ status: "integration", model3d: { simple: true }, model: { source: null, workshop: "Caisse en bois biseautée." } });
  }, 30_000);

  it("atelier 3D sous Opus : un décor dont la finition résiste deux passes a une dernière passe sous Opus, sans renfort Fable (ADR-62, ADR-67)", async () => {
    const { sb, fake, m3d, art } = await setupLocal();
    art.installBlender(sb.human());
    art.workshopModel = () => "opus";
    m3d.geometry.push({ faces_retournees: 3, petits_morceaux: 1, faces_nulles: 0, aretes_ouvertes: 12, objets: [{ nom: "Muret" }] });
    m3d.geometry.push({ faces_retournees: 0, petits_morceaux: 0, faces_nulles: 0, aretes_ouvertes: 0, objets: [] }, { faces_retournees: 0, petits_morceaux: 0, faces_nulles: 0, aretes_ouvertes: 0, objets: [] });
    const roles: (string | undefined)[] = [];
    const structured = fake.structured.bind(fake);
    fake.structured = async (input) => {
      if (/ARTISAN 3D/.test(input.systemPrompt)) roles.push((input as { role?: string }).role);
      return structured(input);
    };
    const resists = { ok: false, forme_ok: true, mineur: false, summary: "Béton trop clair.", points: ["Baisser la teinte"] };
    fake.extractions.push(...(artisanSteps() as never[]), resists as never, ...(artisanSteps() as never[]), resists as never, ...(artisanSteps() as never[]), { ok: true, forme_ok: true, summary: "Conforme.", points: [] } as never);
    fake.replies.push('[[ASSET]] {"name": "Muret", "type": "décor", "usage": "bord de rampe", "specs": "1 unité = 1 px, hauteur 48 px"} [[/ASSET]]\n[[MODELE3D: A-0001 | taille 48 | triangles 500 | simple]]');
    art.send(sb.human(), "bordee", "Un muret");
    await art.idle();
    expect([...new Set(roles)]).toEqual(["artisan"]);
    // Le validateur lit le contrôle géométrique : ce que les photos ne montrent pas (ADR-63).
    const judged = fake.calls.filter((c) => /VALIDATEUR ARTISTIQUE/.test(c.systemPrompt) && /MODÈLE 3D/.test(c.systemPrompt));
    expect(judged[0]!.prompt).toMatch(/Contrôle géométrique : 3 face\(s\) à l'envers, 1 petit\(s\) morceau\(x\) détaché\(s\) \(Muret\)/);
    expect(judged.at(-1)!.prompt).toMatch(/Contrôle géométrique : aucune face à l'envers/);
    expect(judged[0]!.systemPrompt).toMatch(/CONTRÔLE GÉOMÉTRIQUE/);
    expect(fake.calls.find((c) => /ARTISAN 3D/.test(c.systemPrompt))!.systemPrompt).toMatch(/Blender 4\.5 LTS[\s\S]*reparer\(\)/);
    const texts = art.state("bordee").messages.map((m) => m.text);
    expect(texts.some((t) => /passe 2 sur 3\)[\s\S]*l'artisan reprend la scène pour une dernière passe/.test(t))).toBe(true);
    expect(texts.some((t) => /conforme\*\* \(passe 3\)[\s\S]*px × /.test(t))).toBe(true);
    expect(art.state("bordee").assets[0]!.status).toBe("integration");
  }, 30_000);

  it("dans le jeu : le hub photographie la scène vitrine de l'asset", async () => {
    const launches: { cwd: string; path?: string }[] = [];
    const checker: CheckerPort = {
      tests: async () => ({ status: "none", detail: "" }),
      launch: async (_key, cwd, screenshot, path) => {
        launches.push({ cwd, path });
        if (screenshot) writeFileSync(screenshot, PNG);
        return { status: "pass", detail: "", screenshot: screenshot ?? null };
      },
    };
    const { sb, fake, gen, repo, art } = await setupLocal(checker);
    gen.installed = true;
    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Bien.", points: [], prompt: null } as never);
    fake.replies.push('[[ASSET]] {"name": "Drapeau", "type": "icône", "usage": "HUD"} [[/ASSET]]\n[[GENERER: A-0001]] A flag. [[/GENERER]]');
    art.send(sb.human(), "bordee", "Un drapeau");
    await art.idle();
    fake.extractions.push({ visible: true, ok: true, summary: "Net et lisible.", points: [] } as never);
    art.onTaskStatus({ id: "T-0003", project: "bordee", title: "A-0001 : brancher le drapeau", goal: "…", status: "merged" } as Task);
    await art.idle();
    expect(launches.at(-1)).toEqual({ cwd: repo, path: "?vitrine=A-0001" });
    expect(art.state("bordee").assets[0]).toMatchObject({ status: "integre", ingame: { file: "production/a-0001-vitrine-t-0003.png", ok: true } });
    expect(fake.calls.filter((c) => c.kind === "structured").at(-1)!.prompt).toMatch(/Capture de la scène vitrine du jeu \(\?vitrine=A-0001\)/);

  }, 30_000);

  it("bilan des visuels (ADR-71) : copie exacte dans le jeu, preuve au lancement, ancienne version, réintégration", async () => {
    let loaded: string[] | undefined;
    const launches: (string | undefined)[] = [];
    const checker: CheckerPort = {
      tests: async () => ({ status: "none", detail: "" }),
      launch: async (_key, _cwd, screenshot, path) => {
        launches.push(path);
        if (screenshot) writeFileSync(screenshot, PNG);
        return { status: "pass", detail: "", screenshot: screenshot ?? null, loaded };
      },
    };
    const { sb, fake, gen, repo, art } = await setupLocal(checker);
    gen.installed = true;
    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Bien.", points: [], prompt: null } as never);
    fake.replies.push('[[ASSET]] {"name": "Drapeau", "type": "icône", "usage": "HUD"} [[/ASSET]]\n[[GENERER: A-0001]] A flag. [[/GENERER]]');
    art.send(sb.human(), "bordee", "Un drapeau");
    await art.idle();
    fake.extractions.push({ visible: true, ok: true, summary: "Net et lisible.", points: [] } as never);
    art.onTaskStatus({ id: "T-0003", project: "bordee", title: "A-0001 : brancher le drapeau", goal: "…", status: "merged" } as Task);
    await art.idle();
    const source = art.state("bordee").assets[0]!.verdict!.file;

    // Donné pour intégré, mais le développeur n'a rien copié : absent du jeu, à réparer.
    expect(art.bilan("bordee").rows[0]).toMatchObject({ id: "A-0001", level: "absent", problem: true });
    expect(() => art.verifyBilan(sb.human(), "bordee")).toThrow(/Aucun visuel copié/);

    // La copie exacte est dans le dossier public du jeu ; rien ne prouve encore qu'il la charge.
    mkdirSync(join(repo, "public"), { recursive: true });
    copyFileSync(join(repo, "studio", "art", source), join(repo, "public", "drapeau.png"));
    expect(art.bilan("bordee").rows[0]).toMatchObject({ level: "non_prouve", problem: false, copies: ["public/drapeau.png"] });

    // Lancé sur sa scène vitrine, le jeu la charge (servie à la racine) : vérifié, le manifeste garde la preuve.
    loaded = ["/drapeau.png", "/autre.glb"];
    const started = art.verifyBilan(sb.human(), "bordee");
    expect(started.checking).toMatchObject({ total: 1 });
    await art.idle();
    expect(launches.at(-1)).toBe("?vitrine=A-0001");
    expect(art.bilan("bordee")).toMatchObject({ checking: null, rows: [{ level: "verifie", problem: false }] });
    expect(art.state("bordee").assets[0]!.proof!.loaded).toEqual(["/drapeau.png", "/autre.glb"]);
    expect(log(repo)).toMatch(/art: bilan des visuels, 1 visuel\(s\) vérifié\(s\)/);
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/Bilan des visuels[\s\S]*1 visuel\(s\) chargé\(s\) par le jeu, 0 problème/);

    // Une ancienne version du visuel est restée dans le jeu : reconnue, et la réintégration part au directeur.
    writeFileSync(join(repo, "studio", "art", "production", "a-0001-ancien.png"), Buffer.concat([PNG, Buffer.from("v1")]));
    copyFileSync(join(repo, "studio", "art", "production", "a-0001-ancien.png"), join(repo, "public", "drapeau.png"));
    expect(art.bilan("bordee").rows[0]).toMatchObject({ level: "ancienne_version", problem: true, stale: ["public/drapeau.png"] });
    const { thread } = await art.reintegrate(sb.human(), "bordee", "A-0001");
    expect(art.state("bordee").assets[0]!.status).toBe("integration");
    expect(sb.hub.conversations.messages("bordee", thread)[0]!.text).toMatch(/Le bilan du hub a vérifié le jeu : Le jeu a encore une ancienne version \(public\/drapeau\.png\)/);
    await expect(art.reintegrate(sb.human(), "bordee", "A-0001")).rejects.toThrow(/pas de problème/);
  }, 30_000);

  it("dans le jeu : une vitrine qui montre l'accueil au lieu de l'asset fait demander la scène vitrine, une fois", async () => {
    const launches: { cwd: string; path?: string }[] = [];
    const checker: CheckerPort = {
      tests: async () => ({ status: "none", detail: "" }),
      launch: async (_key, cwd, screenshot, path) => {
        launches.push({ cwd, path });
        if (screenshot) writeFileSync(screenshot, PNG);
        return { status: "pass", detail: "", screenshot: screenshot ?? null };
      },
    };
    const { sb, fake, gen, repo, art } = await setupLocal(checker);
    gen.installed = true;
    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Bien.", points: [], prompt: null } as never);
    fake.replies.push('[[ASSET]] {"name": "Drapeau", "type": "icône", "usage": "HUD"} [[/ASSET]]\n[[GENERER: A-0001]] A flag. [[/GENERER]]');
    art.send(sb.human(), "bordee", "Un drapeau");
    await art.idle();
    fake.extractions.push({ visible: false, ok: false, summary: "C'est l'écran d'accueil.", points: [] } as never);
    art.onTaskStatus({ id: "T-0003", project: "bordee", title: "A-0001 : brancher le drapeau", goal: "…", status: "merged" } as Task);
    await art.idle();
    expect(launches.at(-1)).toEqual({ cwd: repo, path: "?vitrine=A-0001" });
    const fix = sb.hub.conversations.listThreads("bordee").find((t) => t.title === "Retoucher A-0001 dans le jeu")!;
    expect(sb.hub.conversations.messages("bordee", fix.id)[0]!.text).toMatch(/faire marcher la scène vitrine[\s\S]*sans menu ni écran d'accueil[\s\S]*Vérifie-la/);
    expect(art.state("bordee").assets[0]).toMatchObject({ status: "integration", ingame: { visible: false, retried: true } });
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/faire marcher la scène vitrine/);
  }, 30_000);

  it("Flux Kontext : installé sur votre clic, il retouche le meilleur essai au lieu de tout redessiner (ADR-51)", async () => {
    const { sb, fake, gen, art } = await setupLocal();
    expect(() => art.installKontext(sb.human())).toThrow(/d'abord le générateur/);
    gen.installed = true;
    fake.replies.push('[[ASSET]] {"name": "Titan", "type": "personnage", "usage": "joueur"} [[/ASSET]]\n[[GENERER: A-0001]] A knight. [[/GENERER]]');
    // Sans Kontext, le validateur n'en parle pas ; son « edit » est ignoré.
    fake.extractions.push({ best: 2, ok: false, usable: false, summary: "Épaulière du mauvais côté.", points: [], prompt: "A knight, huge left pauldron.", edit: "Move the pauldron." } as never);
    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Bien.", points: [], prompt: null, edit: null } as never);
    art.send(sb.human(), "bordee", "Le Titan");
    await art.idle();
    expect(fake.calls.filter((c) => c.kind === "structured")[0]!.prompt).not.toMatch(/Kontext/);
    expect(gen.requests.slice(3).every((r) => !r.edit && r.prompt === "A knight, huge left pauldron.")).toBe(true);

    // Avec Kontext : le meilleur essai est retouché par consigne au tour suivant.
    expect(art.installKontext(sb.human()).kontext.installed).toBe(true);
    const edit = "Move the huge pauldron to the character's left shoulder; keep everything else exactly the same.";
    fake.extractions.push({ best: 3, ok: false, usable: false, summary: "Presque : l'épaulière est à droite.", points: ["Épaulière"], prompt: null, edit } as never);
    fake.extractions.push({ best: 2, ok: true, usable: true, summary: "Corrigé.", points: [], prompt: null, edit: null } as never);
    await art.decide(sb.human(), "bordee", "A-0001", "refaire");
    await art.idle();
    const picks = fake.calls.filter((c) => c.kind === "structured");
    expect(picks.at(-2)!.prompt).toMatch(/Flux Kontext est prêt/);
    expect(picks.at(-2)!.systemPrompt).toMatch(/Kontext retouche l'image au lieu de/);
    const retouches = gen.requests.slice(-3);
    expect(retouches.map((r) => [r.prompt, r.edit?.images.length])).toEqual([
      [edit, 1],
      [edit, 1],
      [edit, 1],
    ]);
    expect(art.state("bordee").messages.map((m) => m.text).find((t) => t.includes("Presque"))).toMatch(/Je fais retoucher l'essai 3 par Kontext : « Move the huge pauldron/);
    expect(art.state("bordee").assets[0]).toMatchObject({ status: "integration", verdict: { ok: true, file: "production/a-0001-t2-e2-2.png" } });
  }, 30_000);

  it("Flux Kontext : « ref A-0001 » dessine les croquis d'un nouvel asset dans le style d'un asset validé", async () => {
    const { sb, fake, gen, art } = await setupLocal();
    gen.installed = true;
    gen.kontext = true;
    fake.replies.push('[[ASSET]] {"name": "Titan", "type": "personnage", "usage": "joueur"} [[/ASSET]]\n[[GENERER: A-0001]] A knight. [[/GENERER]]');
    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Bien.", points: [], prompt: null, edit: null } as never);
    art.send(sb.human(), "bordee", "Le Titan");
    await art.idle();
    expect(fake.calls.filter((c) => c.kind === "reply").at(-1)!.systemPrompt).toMatch(/Flux Kontext est prêt : « \| ref A-xxxx »/);
    const before = gen.requests.length;
    fake.replies.push(
      '[[ASSET]] {"name": "Chasseur", "type": "personnage", "usage": "joueur"} [[/ASSET]]\n[[CROQUIS: A-0002 | 1024x1024 | ref A-0001]] # Encapuchonné\nA slender hooded hunter.\n---\n# Cape\nA hunter with a torn cape.\n[[/CROQUIS]]',
    );
    art.send(sb.human(), "bordee", "Le Chasseur, même famille que le Titan");
    await art.idle();
    const sketches = gen.requests.slice(before);
    expect(sketches).toHaveLength(2);
    expect(sketches[0]!.prompt).toMatch(/^Using exactly the same art style[\s\S]*A slender hooded hunter\.$/);
    expect(sketches.every((r) => r.edit?.images.length === 1)).toBe(true);
    expect(art.state("bordee").assets[1]).toMatchObject({ id: "A-0002", styleRef: "production/a-0001-t1-e1.png" });
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/Quel croquis pour A-0002 « Chasseur »/);
  }, 30_000);

  it("formats, mesures 3D, croquis et graphe Flux (avec ou sans image de départ)", () => {
    expect(parseRef("A-0002 | 1024x1024 | ref A-0001")).toBe("A-0001");
    expect(parseRef("A-0002 | ref: moodboard/titan.png")).toBe("moodboard/titan.png");
    expect(parseRef("A-0002 | 1024x1024")).toBeNull();
    const k = kontextWorkflow({ prompt: "Remove the rivets.", width: 0, height: 0, seed: 3, edit: { images: [PNG, PNG] } }, ["a.png", "b.png"]) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(k["1"]).toMatchObject({ class_type: "UNETLoader", inputs: { unet_name: "flux1-dev-kontext_fp8_scaled.safetensors" } });
    expect(k["2"]).toMatchObject({ class_type: "DualCLIPLoader", inputs: { type: "flux" } });
    // Deux références enchaînées ; la première sert de toile.
    expect(k["13"]).toMatchObject({ class_type: "ReferenceLatent", inputs: { conditioning: ["4", 0], latent: ["12", 0] } });
    expect(k["17"]).toMatchObject({ class_type: "ReferenceLatent", inputs: { conditioning: ["13", 0], latent: ["16", 0] } });
    expect(k["5"]).toMatchObject({ class_type: "FluxGuidance", inputs: { guidance: 2.5, conditioning: ["17", 0] } });
    expect(k["7"]!.inputs).toMatchObject({ model: ["1", 0], seed: 3, latent_image: ["12", 0], negative: ["6", 0] });
    expect(parseModel3D("taille 1,8 | triangles 9000 | animations walk, slash, preset:run, danse")).toEqual({ size: 1.8, tris: 9000, rig: true, animations: ["walk", "slash", "run"] });
    expect(parseModel3D("taille 1,8 | animations idle, hit_to_body_01, preset:biped:cast_a_spell, quadruped:walk").animations).toEqual(["idle", "hit_to_body_01", "cast_a_spell", "quadruped:walk"]);
    expect(parseModel3D("taille 40 | triangles 50")).toEqual({ size: 40, tris: 500, rig: false, animations: [] });
    expect(parseModel3D("squelette")).toMatchObject({ rig: true, animations: [] });
    expect(parseModel3D("taille 1 | triangles 800 | simple")).toEqual({ size: 1, tris: 800, rig: false, animations: [], simple: true });
    expect(parseFormat("1024x1536")).toBe("1024x1536");
    expect(parseFormat(" 300 × 4000 ")).toBe("512x1536");
    expect(parseFormat("carré")).toBeNull();
    const { directives } = parseArtDirectives("[[CROQUIS: A-0002]] # Lourd\nA heavy knight.\n---\nA nimble scout.\n---\n# Seul titre\n[[/CROQUIS]] [[CROQUIS: A-0003]] Un seul. [[/CROQUIS]]");
    expect(directives.sketches).toEqual([
      {
        asset: "A-0002",
        format: null,
        options: [
          { label: "Lourd", prompt: "A heavy knight." },
          { label: "Direction 2", prompt: "A nimble scout." },
        ],
        ref: null,
      },
    ]);
    const g = fluxWorkflow({ prompt: "a ship", width: 768, height: 1024, seed: 7 }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(g["2"]!.inputs.text).toBe("a ship");
    expect(g["5"]!.inputs).toMatchObject({ width: 768, height: 1024 });
    expect(g["6"]!.inputs).toMatchObject({ seed: 7, cfg: 1, denoise: 1, latent_image: ["5", 0] });
    const v = fluxWorkflow({ prompt: "a ship", width: 768, height: 1024, seed: 7, init: { image: PNG, denoise: 0.5 } }, "nidavellir-x.png") as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(v["9"]).toEqual({ class_type: "LoadImage", inputs: { image: "nidavellir-x.png" } });
    expect(v["6"]!.inputs).toMatchObject({ denoise: 0.5, latent_image: ["10", 0] });
    expect(v["5"]).toBeUndefined();
  });
});

describe("balises du Directeur artistique", () => {
  it("ignore les fiches illisibles et les questions à une seule option", () => {
    const { text, directives } = parseArtDirectives("Bonjour [[ASSET]] pas du json [[/ASSET]] [[CHOIX: Seul ?]] oui [[/CHOIX]]");
    expect(text).toBe("Bonjour");
    expect(directives.assets).toEqual([]);
  });
  it("une marque égarée dans une option de question n'apparaît pas sur le bouton", () => {
    const { text } = parseArtDirectives("[[CHOIX: Quelle suite ?]] Le Chasseur | Je veux d'abord voir le Titan §CHOIX§ [[/CHOIX]]");
    expect(text).toBe("§CHOIX§ Quelle suite ? || Le Chasseur || Je veux d'abord voir le Titan");
  });
  it("chemins de studio/art : ni absolus ni remontées", () => {
    for (const ok of ["moodboard/a.png", "production/a-0001.png"]) expect(safeRel(ok), ok).toBe(true);
    for (const bad of ["../a.png", "moodboard/../../a.png", "/etc/a.png", "C:/a.png", "", "a//b.png"]) expect(safeRel(bad), bad).toBe(false);
  });
});

describe("outils du Directeur artistique et du développeur", () => {
  it("la DA lit son dossier et cherche sur le web, rien d'autre", () => {
    const args = buildChatArgs({ systemPrompt: "s", prompt: "p", model: "sonnet", readDir: "C:/x", tools: ["WebSearch", "WebFetch"] }, "sys.txt");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,WebSearch,WebFetch");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("WebSearch,WebFetch");
    expect(() => buildChatArgs({ systemPrompt: "s", prompt: "p", model: "sonnet", readDir: "C:/x", tools: ["Bash"] }, "sys.txt")).toThrow(/que la recherche web/);
  });

  it("le développeur peut copier un visuel de studio/art vers le jeu, et seulement ça", () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-art-"));
    try {
      const root = join(dir, "worktree");
      mkdirSync(join(root, "studio", "art", "production"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "studio", "art", "production", "a-0001.png"), "x");
      writeFileSync(join(root, "src", "a.ts"), "");
      const plan = { files_to_create: [], files_to_modify: [], files_to_delete: [], commands: [] };
      const exec = new PolicyEngine({ mode: "execute", root, plan });
      const d = (cmd: string) => exec.evaluate("Bash", { command: cmd }).decision;
      expect(d("mkdir -p public/art")).toBe("allow");
      expect(d("cp studio/art/production/a-0001.png public/art/powder.png")).toBe("allow");
      expect(d("mkdir -p public/art && cp studio/art/production/a-0001.png public/art/powder.png")).toBe("allow");
      // Pas ailleurs que depuis studio/art, ni vers une zone protégée, ni avec options.
      expect(d("cp src/a.ts public/a.ts")).toBe("ask");
      expect(d("cp studio/art/production/a-0001.png studio/x.png")).toBe("ask");
      expect(d("cp -r studio/art public")).toBe("ask");
      expect(d("cp studio/art/production/a-0001.png ../dehors.png")).toBe("deny");
      expect(d("mkdir studio/x")).toBe("ask");
      expect(new PolicyEngine({ mode: "plan", root, plan }).evaluate("Bash", { command: "mkdir public" }).decision).toBe("deny");
      expect(existsSync(join(root, "public"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conception visuelle (ADR-58)", () => {
  it("des intentions au style du jeu : questions illustrées, planche de références, duel de styles, rien ne se perd", async () => {
    const web: WebRefsPort = {
      fetchImage: async (url) => {
        if (url.includes("absente")) throw new Error("le site répond 404");
        return { data: PNG, mime: "image/png", url };
      },
    };
    const { sb, fake, gen, repo, art } = await setupLocal(quietChecker, web);
    gen.installed = true;

    // 1. Intentions : une question illustrée ; les vignettes sont dessinées avant que la question s'affiche.
    fake.replies.push(
      [
        "Commençons par l'ambiance.",
        "[[CHOIX: Quelle mer pour Bordée ?]] Grise et dramatique => a stormy grey sea, naval poster | Bleu d'affiche => the same sea in flat deep poster blue [[/CHOIX]]",
        "[[CHOIX: Quel rythme ?]] Lent | Nerveux [[/CHOIX]]",
      ].join("\n"),
    );
    art.send(sb.human(), "bordee", "Construisons la direction artistique");
    await art.idle();
    expect(gen.requests.map((r) => [r.prompt, r.width, r.height])).toEqual([
      ["a stormy grey sea, naval poster", 512, 512],
      ["the same sea in flat deep poster blue", 512, 512],
    ]);
    const asked = art.state("bordee").messages.at(-1)!.text;
    expect(asked).toMatch(/§CHOIX§ Quelle mer pour Bordée \? \|\| Grise et dramatique @@ choix\/m\d+-1\.png \|\| Bleu d'affiche @@ choix\/m\d+-2\.png/);
    expect(asked).toMatch(/§CHOIX§ Quel rythme \? \|\| Lent \|\| Nerveux/);
    const vignette = /Bleu d'affiche @@ (choix\/\S+\.png)/.exec(asked)![1]!;
    expect(existsSync(join(repo, "studio", "art", vignette))).toBe(true);

    // Vos deux réponses en un envoi : gardées avec l'image, et rappelées au Directeur artistique (il ne les repose pas).
    fake.replies.push(
      [
        "Noté. Voici des références.",
        "[[REFERENCES: Affiches navales des années 1930]]",
        "- https://example.org/affiche-1.jpg | Affiche de la Marine 1931 | les aplats et le ciel en bandes",
        "- https://example.org/page-absente | Page disparue | rien",
        "- pas une adresse | ignorée | ignorée",
        "[[/REFERENCES]]",
      ].join("\n"),
    );
    art.send(sb.human(), "bordee", "Quelle mer pour Bordée ? → Bleu d'affiche\nQuel rythme ? → je te laisse choisir");
    await art.idle();
    let d = art.state("bordee").direction;
    expect(d.choices).toEqual([{ question: "Quelle mer pour Bordée ?", answer: "Bleu d'affiche", image: vignette, at: expect.any(String) }]);
    expect(fake.calls.at(-1)!.systemPrompt).toMatch(/Choix déjà tranchés[\s\S]*- Quelle mer pour Bordée \? → Bleu d'affiche/);

    // 2. Références : l'image arrive dans le moodboard avec sa source ; l'adresse morte est signalée, pas inventée.
    expect(d.boards).toMatchObject([{ id: "P-01", theme: "Affiches navales des années 1930", failed: [{ url: "https://example.org/page-absente", reason: "le site répond 404" }] }]);
    expect(d.references).toMatchObject([
      { file: "moodboard/web-affiche-de-la-marine-1931.png", board: "P-01", source: "https://example.org/affiche-1.jpg", why: "les aplats et le ciel en bandes", verdict: null },
    ]);
    const board = art.state("bordee").messages.at(-1)!.text;
    expect(board).toMatch(/\*\*Planche P-01 « Affiches navales des années 1930 »\*\* : 1 référence/);
    expect(board).toMatch(/§PLANCHE§ P-01/);
    expect(board).toMatch(/1 adresse\(s\) non récupérée\(s\) : le site répond 404/);
    expect(art.state("bordee").moodboard.map((m) => m.file)).toContain("moodboard/web-affiche-de-la-marine-1931.png");

    // Votre avis : gardé, envoyé au Directeur artistique, qui propose un duel de styles.
    fake.replies.push(
      [
        "Les aplats vous plaisent : voici trois styles.",
        "[[STYLES: Un cuirassé en mer, vue de trois quarts | 768x768]]",
        "# Affiche plate",
        "A battleship at sea, flat poster style.",
        "---",
        "# Gravure",
        "A battleship at sea, engraving style.",
        "---",
        "# Aquarelle",
        "A battleship at sea, watercolor style.",
        "[[/STYLES]]",
      ].join("\n"),
    );
    await art.react(sb.human(), "bordee", { verdicts: { "moodboard/web-affiche-de-la-marine-1931.png": "aime", "moodboard/inconnue.png": "evite" }, comment: "Plus de contraste" });
    await art.idle();
    const said = art.state("bordee").messages.filter((m) => m.role === "human").at(-1)!.text;
    expect(said).toBe("Mon avis sur les références :\n- J'aime : « Affiche de la Marine 1931 »\nPlus de contraste");
    expect(fake.calls.at(-1)!.systemPrompt).toMatch(/Références qu'il aime[\s\S]*web-affiche-de-la-marine-1931\.png « Affiche de la Marine 1931 »/);

    // 3. Duel : le même sujet, la même graine, trois styles ; vous choisissez d'un clic.
    const duel = gen.requests.slice(2);
    expect(duel.map((r) => [r.prompt, r.width])).toEqual([
      ["A battleship at sea, flat poster style.", 768],
      ["A battleship at sea, engraving style.", 768],
      ["A battleship at sea, watercolor style.", 768],
    ]);
    expect(new Set(duel.map((r) => r.seed)).size).toBe(1);
    const q = art.state("bordee").messages.at(-1)!.text;
    expect(q).toMatch(/§CHOIX§ Quel style pour le jeu \(duel S-01, « Un cuirassé en mer, vue de trois quarts »\) \? \|\| Style 1 : Affiche plate @@ styles\/s-01-1\.png/);

    fake.replies.push(
      [
        "Va pour l'affiche plate.",
        "[[BIBLE]]\n# Bible\n## Palette\n- #1B2A3A : mer\n## Phrase de style\nflat naval poster\n[[/BIBLE]]",
        '[[ASSET]] {"name": "Cuirassé", "type": "illustration", "usage": "carte", "specs": "512x768"} [[/ASSET]]',
        "[[GENERER: A-0001 | 512x768 | ref style]] A dreadnought, flat poster style. [[/GENERER]]",
      ].join("\n"),
    );
    fake.extractions.push({ best: 1, ok: true, usable: true, summary: "Conforme.", points: [], prompt: null } as never);
    art.send(sb.human(), "bordee", "Quel style pour le jeu (duel S-01, « Un cuirassé en mer, vue de trois quarts ») ? → Style 1 : Affiche plate");
    await art.idle();
    d = art.state("bordee").direction;
    expect(d.style).toMatchObject({ duel: "S-01", label: "Affiche plate", file: "styles/s-01-1.png", prompt: "A battleship at sea, flat poster style." });
    expect(d.duels[0]!.chosen).toBe(1);
    expect(d.choices.map((c) => [c.answer, c.image])).toContainEqual(["Style 1 : Affiche plate", "styles/s-01-1.png"]);
    // Le Directeur artistique a repris la main (bible), et le style retenu sert de référence au premier visuel.
    expect(fake.calls.filter((c) => c.kind === "reply").at(-1)!.systemPrompt).toMatch(/Style retenu \(duel S-01\) : « Affiche plate »/);
    expect(art.state("bordee").bible).toMatch(/flat naval poster/);
    expect(art.state("bordee").assets[0]!.styleRef).toBe("styles/s-01-1.png");

    // Tout est dans le dépôt du jeu : le développeur et les tours suivants le relisent.
    const saved = JSON.parse(readFileSync(join(repo, "studio", "art", "direction.json"), "utf8")) as { references: { verdict: string }[]; style: { file: string } };
    expect(saved.references[0]!.verdict).toBe("aime");
    expect(saved.style.file).toBe("styles/s-01-1.png");
    expect(log(repo)).toMatch(/art: style « Affiche plate » retenu \(duel S-01\)/);
    expect(log(repo)).toMatch(/art: planche P-01/);
  }, 60_000);

  it("sans générateur : les options restent en mots et le duel attend, sans rien perdre", async () => {
    const { sb, fake, gen, art } = await setupLocal();
    fake.replies.push("[[CHOIX: Quelle mer ?]] Grise => a grey sea | Bleue => a blue sea [[/CHOIX]]\n[[STYLES: Un navire]] # A\nship, style A\n---\n# B\nship, style B [[/STYLES]]");
    art.send(sb.human(), "bordee", "On commence ?");
    await art.idle();
    expect(gen.requests).toHaveLength(0);
    const msgs = art.state("bordee").messages;
    expect(msgs.find((m) => m.text.includes("§CHOIX§"))!.text).toMatch(/§CHOIX§ Quelle mer \? \|\| Grise \|\| Bleue$/m);
    expect(msgs.at(-1)!.text).toMatch(/Le duel de styles « Un navire » attend le générateur/);
  });

  it("les choix faits avant la direction visuelle sont retrouvés dans l'historique", async () => {
    const { sb, fake, repo, art } = await setupLocal();
    fake.replies.push("[[CHOIX: Quelle mer ?]] Grise | Bleue [[/CHOIX]]", "Noté.");
    art.send(sb.human(), "bordee", "On commence ?");
    await art.idle();
    art.send(sb.human(), "bordee", "Quelle mer ? → Bleue");
    await art.idle();
    // Un projet d'avant ADR-58 : pas de direction.json, seulement la discussion.
    rmSync(join(repo, "studio", "art", "direction.json"));
    expect(art.state("bordee").direction.choices.map((c) => `${c.question} → ${c.answer}`)).toEqual(["Quelle mer ? → Bleue"]);
  });
});

describe("références web : adresses sûres seulement (ADR-58)", () => {
  it("refuse la machine et le réseau local, accepte une adresse publique", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.20", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) expect(privateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "151.101.1.69", "2606:4700::1111"]) expect(privateAddress(ip), ip).toBe(false);
    await expect(assertPublic("http://localhost:3000/x.png")).rejects.toThrow(/locale|port/);
    await expect(assertPublic("http://127.0.0.1/x.png")).rejects.toThrow(/réseau local/);
    await expect(assertPublic("file:///C:/secret.png")).rejects.toThrow(/http, https/);
    await expect(assertPublic("https://user:pw@example.org/x.png")).rejects.toThrow(/identifiants/);
    expect((await assertPublic("https://93.184.215.14/a.jpg")).hostname).toBe("93.184.215.14");
  });
  it("trouve l'image d'aperçu d'une page", () => {
    expect(pageImage('<head><meta property="og:image" content="/img/cover.jpg?a=1&amp;b=2"></head>', "https://store.example.org/app/1")).toBe("https://store.example.org/img/cover.jpg?a=1&b=2");
    expect(pageImage('<meta content="https://cdn.example.org/x.png" property="og:image" />', "https://example.org")).toBe("https://cdn.example.org/x.png");
    expect(pageImage("<html>rien</html>", "https://example.org")).toBeNull();
  });
});
