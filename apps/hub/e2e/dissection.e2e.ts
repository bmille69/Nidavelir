/**
 * Atelier de démontage dans un vrai navigateur (Edge), avec un faux jeu et des outils factices :
 * examiner, installer l'outil, démonter, lire la fiche de l'Archéologue, poser une question (ADR-40).
 */
import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHub, type Hub } from "../src/hub.ts";
import type { RecoverInput, ReverseToolsPort, ToolInfo } from "../src/reverse/tools.ts";
import { buildServer } from "../src/server/http.ts";
import { FakeOrchestrator } from "../test/fake-orchestrator.ts";
import { cleanupSandboxes, sandbox, type Sandbox } from "../test/helpers.ts";

const PORT = 4394;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = process.env.STUDIO_WEB_DIST ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");

class FakeTools implements ReverseToolsPort {
  installed = false;
  list(): ToolInfo[] {
    return [{ id: "gdre", name: "GDRE Tools", repo: "GDRETools/gdsdecomp", purpose: "Démonte les jeux Godot.", size: "≈ 100 Mo", installed: this.installed, version: this.installed ? "v2.7.4" : null }];
  }
  async install(): Promise<ToolInfo> {
    this.installed = true;
    return this.list()[0]!;
  }
  async recover(input: RecoverInput): Promise<void> {
    input.log("Recovering…");
    mkdirSync(join(input.out, "src"), { recursive: true });
    writeFileSync(join(input.out, "src", "Strike.cs"), "class Strike {}");
  }
}

class Archeologue extends FakeOrchestrator {
  override async reply(input: { systemPrompt: string; prompt: string; readDir?: string }) {
    if (!input.readDir) return super.reply(input);
    return /Fais la fiche « Vue d'ensemble »/.test(input.prompt)
      ? { text: "# Vue d'ensemble\n\nUn jeu de cartes **roguelike**. Les mods passent par Harmony.", costUsd: 0 }
      : { text: "# Les dégâts\n\nUne attaque inflige ses dégâts de base, plus la Force.", costUsd: 0 };
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
  sb = sandbox();
  sb.hub.close();
  hub = createHub({
    databasePath: join(sb.dir, "hub/.data/atelier.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    orchestrator: new Archeologue(),
    dataDir: join(sb.dir, "hub/.data"),
    reverseTools: new FakeTools(),
  });
  sb.hub = hub;
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
  await hub?.reverse.idle();
  cleanupSandboxes();
});

describe("atelier de démontage", () => {
  it("examiner, installer, démonter, lire et questionner l'Archéologue", async () => {
    const game = join(sb.dir, "steam", "Slay the Spire 2");
    for (const f of ["SlayTheSpire2.pck", "data_sts2_windows_x86_64/sts2.dll", "data_sts2_windows_x86_64/0Harmony.dll"]) {
      mkdirSync(join(game, f, ".."), { recursive: true });
      writeFileSync(join(game, f), "x");
    }
    await page.locator(".side-nav a", { hasText: "Démonter un jeu" }).click();
    await page.getByRole("heading", { name: "Démonter un jeu" }).waitFor();
    await page.getByLabel("Dossier du jeu").fill(game);
    await page.getByRole("button", { name: "Examiner" }).click();

    await page.getByRole("heading", { name: "Slay the Spire 2" }).waitFor();
    await page.getByText("Godot (C#)").first().waitFor();
    await page.getByText(/Harmony \(outil de mods intégré\)/).first().waitFor();
    await page.screenshot({ path: join(shots, "demontage-1-examen.png") });
    await page.getByRole("button", { name: "Installer GDRE Tools" }).click();
    await page.getByRole("button", { name: /Code seulement/ }).click();

    await page.locator(".dissect-note h2", { hasText: "Vue d'ensemble" }).waitFor({ timeout: 15_000 });
    await page.getByText(/1 fichiers récupérés/).waitFor();
    await page.getByPlaceholder(/Posez une question/).fill("Comment sont calculés les dégâts ?");
    await page.getByRole("button", { name: "Demander" }).click();
    await page.locator(".dissect-note h2", { hasText: "Les dégâts" }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Créer un projet de mod" }).waitFor();
    await page.screenshot({ path: join(shots, "demontage-2-archeologue.png"), fullPage: true });

    // Le jeu est mis à jour : un bandeau invite à le redémonter pour voir ce qui a changé (ADR-42).
    writeFileSync(join(game, "SlayTheSpire2.pck"), "version 2");
    await page.reload();
    await page.getByText(/Le jeu a été mis à jour depuis le démontage/).waitFor();
    await page.getByText(/garde la version actuelle de côté/).waitFor();
    expect(errors).toEqual([]);
  });
});
