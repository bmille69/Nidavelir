import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@studio/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeRel } from "../src/art/art-service.ts";
import { fluxWorkflow, type GenRequest, type GenState, type ImageGenPort } from "../src/art/imagegen.ts";
import type { Model3DPort, Model3DSpec, Model3DState } from "../src/art/model3d.ts";
import { parseArtDirectives, parseFormat, parseModel3D } from "../src/art/prompts.ts";
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
  requests: GenRequest[] = [];
  state(): GenState {
    return { installed: this.installed, installing: null, error: null, size: "≈ 19 Go" };
  }
  install(): void {
    this.installed = true;
  }
  async generate(req: GenRequest): Promise<Buffer> {
    this.requests.push(req);
    return PNG;
  }
  close(): void {}
}

/** L'atelier 3D factice : Tripo rend un faux .glb, Blender écrit quatre photos. */
class FakeModel3D implements Model3DPort {
  blender = false;
  key = false;
  tripoCalls: { spec: Model3DSpec; bytes: number }[] = [];
  finishes: { input: string; output: string; prefix: string }[] = [];
  state(): Model3DState {
    return { blender: { installed: this.blender, installing: null, error: null, size: "≈ 400 Mo" }, tripo: { configured: this.key, month: "2026-10", credits: 0, cap: 2000 } };
  }
  installBlender(): void {
    this.blender = true;
  }
  async setTripoKey(key: string): Promise<void> {
    if (!key.startsWith("tsk_")) throw new Error("Une clé Tripo commence par « tsk_ »");
    this.key = true;
  }
  async tripo(req: { image: Buffer; spec: Model3DSpec; step: (s: string) => void }) {
    req.step("Tripo fabrique le modèle");
    this.tripoCalls.push({ spec: req.spec, bytes: req.image.length });
    return { glb: Buffer.from("glTF"), credits: 30 };
  }
  async finish(req: { input: string; output: string; rendersDir: string; prefix: string; spec: Model3DSpec }) {
    this.finishes.push({ input: req.input, output: req.output, prefix: req.prefix });
    writeFileSync(req.output, readFileSync(req.input));
    const renders = ["face", "trois-quarts", "profil", "dos"].map((a) => join(req.rendersDir, `${req.prefix}-${a}.png`));
    for (const r of renders) writeFileSync(r, PNG);
    return { renders, tris: Math.min(req.spec.tris, 7000), dims: [2.1, 12, 3.4], animations: req.spec.animations };
  }
}

const quietChecker: CheckerPort = { tests: async () => ({ status: "none", detail: "" }), launch: async () => ({ status: "none", detail: "" }) };

/** Le même projet, avec un générateur local et un atelier 3D branchés, et les vérifications du hub (captures). */
async function setupLocal() {
  const fake = new Artist();
  const sb = sandbox(fake);
  sb.hub.close();
  const gen = new FakeImageGen();
  const m3d = new FakeModel3D();
  sb.hub = createHub({
    databasePath: join(sb.dir, "hub/.data/art.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    orchestrator: fake,
    dataDir: join(sb.dir, "hub/.data"),
    imagegen: gen,
    model3d: m3d,
    checker: quietChecker,
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

describe("générateur d'images local (ADR-46)", () => {
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
    fake.extractions.push({ best: 3, ok: false, summary: "Trop chargé.", points: ["Silhouette confuse"], prompt: "A gunpowder keg icon, bold flat shapes, plain background." } as never);
    fake.extractions.push({ best: 2, ok: true, summary: "Lisible et dans la palette.", points: [], prompt: null } as never);
    fake.replies.push("Je la fais fabriquer.\n[[GENERER: A-0001 | 1000x1000]] A gunpowder keg icon, plain background. [[/GENERER]]");
    art.send(sb.human(), "bordee", "Vas-y");
    await art.idle();
    expect(fake.calls.find((c) => c.prompt.includes("Vas-y"))!.systemPrompt).toMatch(/générateur d'images local est prêt[\s\S]*GENERER/);

    expect(gen.requests).toHaveLength(6);
    expect(gen.requests[0]).toMatchObject({ prompt: "A gunpowder keg icon, plain background.", width: 1024, height: 1024 });
    expect(gen.requests[3]!.prompt).toBe("A gunpowder keg icon, bold flat shapes, plain background.");
    const a = art.state("bordee").assets[0]!;
    // Validé : il part tout seul dans le jeu.
    expect(a).toMatchObject({ status: "integration", format: "1024x1024", verdict: { ok: true, by: "validator", file: "production/a-0001-t2-e2.png" } });
    expect(a.renders).toHaveLength(6);
    expect(a.renders.at(-1)).toBe("production/a-0001-t2-e2.png");
    expect(existsSync(join(repo, "studio", "art", "production", "a-0001-t1-e1.png"))).toBe(true);
    // Le validateur a vu les trois essais de chaque tour.
    const picks = fake.calls.filter((c) => c.kind === "structured");
    expect(picks).toHaveLength(2);
    expect(picks[0]!.prompt).toMatch(/1\. production\/a-0001-t1-e1.png\n2\. production\/a-0001-t1-e2.png\n3\. production\/a-0001-t1-e3.png/);
    const messages = art.state("bordee").messages.map((m) => m.text);
    expect(messages.some((t) => /pas encore\*\* \(tour 1 sur 3\)[\s\S]*Je relance un tour/.test(t))).toBe(true);
    expect(messages.at(-2)).toMatch(/^§IMAGE§ production\/a-0001-t2-e1.png\n§IMAGE§ production\/a-0001-t2-e2.png[\s\S]*conforme\*\* \(essai 2, tour 2\)[\s\S]*Je le fais intégrer/);
    expect(messages.at(-1)).toMatch(/part dans le jeu/);
    expect(log(repo)).toMatch(/art: A-0001 validé \(validateur, tour 2\)/);
    expect(art.state("bordee").busy.generating).toEqual([]);

    // « Refaire » relance la fabrication ; trois tours refusés : le meilleur reste, vous tranchez.
    for (let i = 0; i < 3; i++) fake.extractions.push({ best: 1, ok: false, summary: "Non.", points: [], prompt: null } as never);
    await art.decide(sb.human(), "bordee", "A-0001", "refaire");
    await art.idle();
    expect(gen.requests).toHaveLength(15);
    expect(art.state("bordee").assets[0]).toMatchObject({ status: "production", verdict: { ok: false, file: "production/a-0001-t3-e1.png" } });
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/Trois tours sans essai conforme/);
    expect((await art.decide(sb.human(), "bordee", "A-0001", "valider")).verdict).toMatchObject({ by: "human", file: "production/a-0001-t3-e1.png" });
    await art.idle();
    expect(art.state("bordee").assets[0]!.status).toBe("integration");
  }, 60_000);

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

  it("3D : l'image validée part chez Tripo puis Blender, le validateur juge les photos, l'asset part au jeu et y est vérifié", async () => {
    const { sb, fake, gen, m3d, repo, art } = await setupLocal();
    gen.installed = true;
    fake.replies.push(
      [
        '[[ASSET]] {"name": "Cuirassé", "type": "modèle 3D", "usage": "navire du joueur sur la mer 3D"} [[/ASSET]]',
        "[[MODELE3D: A-0001 | taille 12 | triangles 6000]]",
        "[[GENERER: A-0001 | 1024x1024]] A 1910s dreadnought, three-quarter view, whole ship, plain grey background. [[/GENERER]]",
      ].join("\n"),
    );
    // L'atelier 3D n'est pas prêt : l'image se fait, la 3D attend (et on le dit).
    fake.extractions.push({ best: 1, ok: true, summary: "Belle silhouette.", points: [], prompt: null } as never);
    art.send(sb.human(), "bordee", "Fais-moi le cuirassé en 3D");
    await art.idle();
    let a = art.state("bordee").assets[0]!;
    expect(a).toMatchObject({ status: "production", model3d: { size: 12, tris: 6000, rig: false, animations: [] }, verdict: { ok: true } });
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/La 3D de A-0001 attend l'atelier 3D : installez blender et ajoutez votre clé tripo/);
    expect(() => art.generateModel(sb.human(), "bordee", "A-0001")).toThrow(/Installez Blender/);

    art.installBlender(sb.human());
    await expect(art.setTripoKey(sb.human(), "pas-une-cle")).rejects.toThrow(/tsk_/);
    await art.setTripoKey(sb.human(), "tsk_0123456789abcdef");
    expect(art.state("bordee").workshop3d).toMatchObject({ blender: { installed: true }, tripo: { configured: true } });

    // Premier tour refusé, deuxième conforme : il part au jeu tout seul.
    fake.extractions.push({ ok: false, summary: "La poupe est fondue.", points: ["Arrière déformé"], prompt: null } as never);
    fake.extractions.push({ ok: true, summary: "Fidèle à l'image, lisible.", points: [], prompt: null } as never);
    art.generateModel(sb.human(), "bordee", "A-0001");
    await art.idle();
    expect(m3d.tripoCalls).toHaveLength(2);
    expect(m3d.tripoCalls[0]!.bytes).toBe(PNG.length);
    expect(m3d.finishes[1]!.output).toBe(join(repo, "studio", "art", "models", "a-0001-t2.glb"));
    expect(existsSync(m3d.finishes[0]!.input)).toBe(false); // le modèle brut ne reste pas dans le dépôt
    a = art.state("bordee").assets[0]!;
    expect(a).toMatchObject({
      status: "integration",
      model: { file: "models/a-0001-t2.glb", source: "production/a-0001-t1-e1.png", tris: 6000, dims: [2.1, 12, 3.4], verdict: { ok: true, by: "validator" } },
    });
    expect(a.model!.renders).toEqual(["face", "trois-quarts", "profil", "dos"].map((x) => `production/a-0001-3d-t2-${x}.png`));
    const judge = fake.calls.filter((c) => c.kind === "structured").at(-1)!;
    expect(judge.systemPrompt).toMatch(/MODÈLE 3D/);
    expect(judge.prompt).toMatch(/production\/a-0001-t1-e1.png[\s\S]*production\/a-0001-3d-t2-face.png[\s\S]*demandé : 12 m/);
    const integration = sb.hub.conversations.listThreads("bordee").find((t) => t.title === "Intégrer A-0001 : Cuirassé")!;
    expect(sb.hub.conversations.messages("bordee", integration.id)[0]!.text).toMatch(/studio\/art\/models\/a-0001-t2.glb[\s\S]*axe Y vers le haut, 1 unité = 1 mètre[\s\S]*2.1 m × 12 m × 3.4 m/);
    expect(log(repo)).toMatch(/art: modèle 3D de A-0001 validé \(validateur, tour 2\)/);

    // Le chantier est fusionné : le validateur regarde la capture du jeu ; à retoucher → une retouche part au directeur, une seule fois.
    const shot = sb.hub.checks!.screenshotPath("bordee", "T-0007");
    mkdirSync(join(shot, ".."), { recursive: true });
    writeFileSync(shot, PNG);
    fake.extractions.push({ visible: true, ok: false, summary: "Le navire est minuscule à l'écran.", points: ["Échelle trop petite"] } as never);
    art.onTaskStatus({ id: "T-0007", project: "bordee", title: "A-0001 : brancher le cuirassé", goal: "…", status: "merged" } as Task);
    await art.idle();
    a = art.state("bordee").assets[0]!;
    expect(a.ingame).toMatchObject({ task: "T-0007", file: "production/a-0001-en-jeu-t-0007.png", visible: true, ok: false, retried: true });
    expect(a.status).toBe("integration");
    expect(art.state("bordee").messages.at(-1)!.text).toMatch(/^§IMAGE§ production\/a-0001-en-jeu-t-0007.png\n\*\*A-0001 dans le jeu : à retoucher\.\*\*[\s\S]*J'ai demandé une retouche/);
    const fix = sb.hub.conversations.listThreads("bordee").find((t) => t.title === "Retoucher A-0001 dans le jeu")!;
    expect(sb.hub.conversations.messages("bordee", fix.id)[0]!.text).toMatch(/minuscule[\s\S]*titre commence par « A-0001 »/);

    // La retouche est fusionnée et rend bien : plus de nouvelle retouche.
    writeFileSync(sb.hub.checks!.screenshotPath("bordee", "T-0008"), PNG);
    fake.extractions.push({ visible: true, ok: true, summary: "Bonne taille, bien éclairé.", points: [] } as never);
    art.onTaskStatus({ id: "T-0008", project: "bordee", title: "A-0001 : agrandir le cuirassé", goal: "…", status: "merged" } as Task);
    await art.idle();
    expect(art.state("bordee").assets[0]).toMatchObject({ status: "integre", ingame: { task: "T-0008", ok: true } });
    expect(sb.hub.conversations.listThreads("bordee").filter((t) => t.title.startsWith("Retoucher"))).toHaveLength(1);
  }, 60_000);

  it("formats, mesures 3D et graphe Flux", () => {
    expect(parseModel3D("taille 1,8 | triangles 9000 | animations walk, slash, preset:run, danse")).toEqual({ size: 1.8, tris: 9000, rig: true, animations: ["walk", "slash", "run"] });
    expect(parseModel3D("taille 40 | triangles 50")).toEqual({ size: 40, tris: 500, rig: false, animations: [] });
    expect(parseModel3D("squelette")).toMatchObject({ rig: true, animations: [] });
    expect(parseFormat("1024x1536")).toBe("1024x1536");
    expect(parseFormat(" 300 × 4000 ")).toBe("512x1536");
    expect(parseFormat("carré")).toBeNull();
    const g = fluxWorkflow({ prompt: "a ship", width: 768, height: 1024, seed: 7 }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(g["2"]!.inputs.text).toBe("a ship");
    expect(g["5"]!.inputs).toMatchObject({ width: 768, height: 1024 });
    expect(g["6"]!.inputs).toMatchObject({ seed: 7, cfg: 1 });
  });
});

describe("balises du Directeur artistique", () => {
  it("ignore les fiches illisibles et les questions à une seule option", () => {
    const { text, directives } = parseArtDirectives("Bonjour [[ASSET]] pas du json [[/ASSET]] [[CHOIX: Seul ?]] oui [[/CHOIX]]");
    expect(text).toBe("Bonjour");
    expect(directives.assets).toEqual([]);
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
