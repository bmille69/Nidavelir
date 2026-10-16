import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@studio/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeRel } from "../src/art/art-service.ts";
import { parseArtDirectives } from "../src/art/prompts.ts";
import { PolicyEngine } from "../src/executor/policy-engine.ts";
import { buildChatArgs } from "../src/llm/claude-cli.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, sandbox } from "./helpers.ts";

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
    expect(asset).toMatchObject({ status: "valide", verdict: { ok: true, file: "production/a-0001-essai-2.png" } });
    expect(log(repo)).toMatch(/art: A-0001 validé \(validateur\)/);

    // Vous gardez le dernier mot.
    expect((await art.decide(sb.human(), "bordee", "A-0001", "refaire")).status).toBe("production");
    expect(await art.decide(sb.human(), "bordee", "A-0001", "valider")).toMatchObject({ status: "valide", verdict: { by: "human" } });

    // Faire intégrer : une demande au directeur, qui lance un chantier « A-0001 … ».
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
