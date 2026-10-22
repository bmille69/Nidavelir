/**
 * La conception visuelle dans un vrai navigateur (Edge), ADR-58 : questions illustrées choisies ensemble, planche de
 * références jugée image par image, duel de styles, puis la direction en images. Générateur et web factices.
 */
import type { FastifyInstance } from "fastify";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GenRequest, GenState, ImageGenPort } from "../src/art/imagegen.ts";
import { createHub, type Hub } from "../src/hub.ts";
import { buildServer } from "../src/server/http.ts";
import { FakeOrchestrator } from "../test/fake-orchestrator.ts";
import { cleanupSandboxes, sandbox, type Sandbox } from "../test/helpers.ts";

const PORT = 4396;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = process.env.STUDIO_WEB_DIST ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");

/** Une image PNG unie de 96×96, pour que les vignettes se distinguent sur les captures. */
function solid(r: number, g: number, b: number): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const x of buf) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const size = 96;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const COLORS: [number, number, number][] = [
  [70, 82, 96],
  [27, 64, 122],
  [196, 160, 92],
  [120, 40, 40],
  [60, 120, 90],
];

class Gen implements ImageGenPort {
  n = 0;
  state(): GenState {
    return { installed: true, installing: null, error: null, size: "", kontext: { installed: false, installing: null, error: null, size: "" } };
  }
  install(): void {}
  installKontext(): void {}
  async generate(_req: GenRequest): Promise<Buffer> {
    return solid(...COLORS[this.n++ % COLORS.length]!);
  }
  close(): void {}
}

class Artist extends FakeOrchestrator {
  override async reply(input: { systemPrompt: string; prompt: string; readDir?: string }) {
    if (!input.readDir) return super.reply(input);
    const last = input.prompt.slice(input.prompt.lastIndexOf('<message de="directeur créatif">'));
    if (/Construisons ensemble/.test(last))
      return {
        text: [
          "Deux questions pour sentir l'ambiance, avec des images.",
          "[[CHOIX: Quelle mer pour Bordée ?]] Grise et dramatique => a stormy grey sea | Bleu d'affiche => a flat deep blue sea | Doré du soir => a golden evening sea [[/CHOIX]]",
          "[[CHOIX: Quel rythme visuel ?]] Calme, de grands aplats | Nerveux, des contrastes forts [[/CHOIX]]",
        ].join("\n"),
        costUsd: 0,
      };
    if (/Quelle mer pour Bordée/.test(last))
      return {
        text: [
          "Noté : bleu d'affiche. Voici des références trouvées sur le web.",
          "[[REFERENCES: Affiches navales des années 1930]]",
          "- https://example.org/a.jpg | Affiche de la Marine 1931 | les aplats et le ciel en bandes",
          "- https://example.org/b.jpg | Croiseur en gravure | les hachures des vagues",
          "- https://example.org/c.jpg | Carte postale de port | le papier jauni",
          "[[/REFERENCES]]",
        ].join("\n"),
        costUsd: 0,
      };
    if (/Mon avis sur les références/.test(last))
      return {
        text: "Les aplats vous plaisent : trois styles pour le même cuirassé.\n[[STYLES: Un cuirassé en mer]] # Affiche plate\nflat poster battleship\n---\n# Gravure\nengraved battleship\n---\n# Aquarelle\nwatercolor battleship [[/STYLES]]",
        costUsd: 0,
      };
    return { text: "Va pour l'affiche plate.\n[[BIBLE]]\n# Bible\n## Palette\n- #1B2A3A : mer de nuit\n- #E8D9B5 : papier\n- #B5332E : rouge des coques\n[[/BIBLE]]", costUsd: 0 };
  }
}

let sb: Sandbox;
let hub: Hub;
let app: FastifyInstance;
let browser: Browser;
let page: Page;
const errors: string[] = [];

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  const fake = new Artist();
  sb = sandbox(fake);
  sb.hub.close();
  let k = 2;
  hub = createHub({
    databasePath: join(sb.dir, "hub/.data/vision.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    orchestrator: fake,
    dataDir: join(sb.dir, "hub/.data"),
    imagegen: new Gen(),
    webRefs: { fetchImage: async (url) => ({ data: solid(...COLORS[k++ % COLORS.length]!), mime: "image/png", url }) },
  });
  sb.hub = hub;
  const repo = sb.makeGameRepo("games/bordee", { "CLAUDE.md": "# Bordée\nBataille navale 1900-1945.\n" });
  await hub.projects.register(sb.human(), { path: repo, slug: "bordee", name: "Bordée" });
  app = await buildServer(hub, { port: PORT, gamesRoot: join(sb.dir, "games"), allowedHosts: [`127.0.0.1:${PORT}`], folderPicker: { pick: async () => null }, webDist });
  await app.listen({ host: "127.0.0.1", port: PORT });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 950 }, locale: "fr-FR" });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await hub?.art.idle();
  cleanupSandboxes();
});

describe("conception visuelle", () => {
  it("questions illustrées, planche, duel, direction en images", async () => {
    try {
      await steps();
    } catch (e) {
      await page.screenshot({ path: join(shots, "vision-echec.png"), fullPage: true });
      throw e;
    }
  }, 90_000);

  async function steps() {
    await page.goto(`${BASE}/#/p/bordee/art`);
    // Rien de posé : on ouvre sur la direction.
    await page.locator(".art-panel .tab.active", { hasText: "Direction" }).waitFor();
    await page.getByRole("button", { name: /Construire la direction artistique/ }).click();

    // Deux questions, la première en vignettes : on choisit les deux, puis un seul envoi.
    const sea = page.locator(".art-vignette", { hasText: "Bleu d'affiche" });
    await sea.waitFor({ timeout: 20_000 });
    await expect(page.locator(".art-vignette img").count()).resolves.toBe(3);
    await sea.click();
    await page.getByRole("button", { name: "Calme, de grands aplats" }).click();
    await page.screenshot({ path: join(shots, "vision-1-questions.png") });
    await page.getByRole("button", { name: /Envoyer mes choix \(2\/2\)/ }).click();

    // La planche : j'aime, à éviter, et un mot.
    const board = page.locator(".art-board");
    await board.waitFor({ timeout: 20_000 });
    await expect(board.locator(".art-ref").count()).resolves.toBe(3);
    await board.locator(".art-ref", { hasText: "Affiche de la Marine 1931" }).getByRole("button", { name: "J'aime" }).click();
    await board.locator(".art-ref", { hasText: "Carte postale de port" }).getByRole("button", { name: "À éviter" }).click();
    await board.locator("textarea").fill("Plus de contraste dans le ciel");
    await page.screenshot({ path: join(shots, "vision-2-planche.png") });
    await board.getByRole("button", { name: /Envoyer mon avis \(2\/3\)/ }).click();

    // Le duel : trois styles en vignettes, un clic.
    const duel = page.locator(".art-vignette", { hasText: "Style 1 : Affiche plate" });
    await duel.waitFor({ timeout: 20_000 });
    await page.screenshot({ path: join(shots, "vision-3-duel.png") });
    await duel.click();

    // La direction en images : style, palette, choix, références aimées et évitées.
    await page.locator(".msg.art", { hasText: "Va pour l'affiche plate" }).waitFor({ timeout: 20_000 });
    await page.locator(".art-panel .tab", { hasText: "Direction" }).click();
    await page.locator(".art-vision-style", { hasText: "Affiche plate" }).waitFor();
    await page.locator(".art-swatch", { hasText: "#B5332E" }).waitFor();
    await page.locator(".art-vision-choices figure", { hasText: "Bleu d'affiche" }).locator("img").waitFor();
    await page.locator(".art-vision-refs", { hasText: "Affiche de la Marine 1931" }).waitFor();
    await page.locator(".art-vision-refs", { hasText: "Carte postale de port" }).waitFor();
    await page.screenshot({ path: join(shots, "vision-4-direction.png"), fullPage: true });

    const d = hub.art.state("bordee").direction;
    expect(d.style?.label).toBe("Affiche plate");
    expect(d.references.map((r) => r.verdict)).toEqual(["aime", null, "evite"]);
    expect(d.choices.map((c) => c.answer)).toEqual(["Bleu d'affiche", "Calme, de grands aplats", "Style 1 : Affiche plate"]);

    // Le moodboard : vos images et celles du web, avec leur source.
    await page.locator(".art-panel .tab", { hasText: "Moodboard" }).click();
    await page.locator(".art-mood-grid .art-ref", { hasText: "Source : example.org" }).first().waitFor();
    expect(errors).toEqual([]);
  }

  it("sur téléphone : les vignettes et la direction tiennent dans l'écran", async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "fr-FR", isMobile: true, hasTouch: true });
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
    await phone.goto(`${BASE}/#/p/bordee/art`);
    await phone.locator(".art-vignette").first().waitFor();
    expect(await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
    await phone.screenshot({ path: join(shots, "vision-5-telephone.png") });
    await phone.locator(".pane-switch button", { hasText: "Visuels" }).click();
    await phone.locator(".art-panel .tab", { hasText: "Direction" }).click();
    await phone.locator(".art-vision-style").waitFor();
    expect(await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
    await phone.screenshot({ path: join(shots, "vision-6-telephone-direction.png"), fullPage: true });
    await phone.close();
    expect(errors).toEqual([]);
  });
});
