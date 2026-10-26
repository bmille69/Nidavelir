/**
 * Les captures annotées (ADR-72), dans un vrai navigateur (Edge) : joindre une capture à la discussion, y dessiner à la
 * souris puis au doigt sur téléphone, l'envoyer ; le directeur la reçoit avec l'accès en lecture à studio/captures.
 */
import type { FastifyInstance } from "fastify";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHub, type Hub } from "../src/hub.ts";
import { buildServer } from "../src/server/http.ts";
import { FakeOrchestrator } from "../test/fake-orchestrator.ts";
import { FakeExecutor } from "../test/fake-executor.ts";
import { cleanupSandboxes, sandbox, type Sandbox } from "../test/helpers.ts";

const PORT = 4404;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = process.env.STUDIO_WEB_DIST ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");
const P = "destiny";

/** Une « capture du jeu » : un ciel bleu et un sol vert, en vrai PNG. */
function gameShot(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(y < h * 0.6 ? [70, 120, 190] : [60, 130, 70], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

let sb: Sandbox;
let hub: Hub;
let app: FastifyInstance;
let browser: Browser;
let repo: string;
const errors: string[] = [];
const fake = new FakeOrchestrator();

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  sb = sandbox();
  sb.hub.close();
  hub = createHub({
    databasePath: join(sb.dir, "hub/.data/annotate.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    orchestrator: fake,
    executor: new FakeExecutor(),
    dataDir: join(sb.dir, "hub/.data"),
  });
  sb.hub = hub;
  repo = sb.makeGameRepo("games/destiny", { "README.md": "# Destiny Survivor\n" });
  await hub.projects.register(sb.human(), { path: repo, slug: P, name: "Destiny Survivor" });
  writeFileSync(join(sb.dir, "capture.png"), gameShot(1280, 720));
  app = await buildServer(hub, { port: PORT, gamesRoot: join(sb.dir, "games"), allowedHosts: [`127.0.0.1:${PORT}`], folderPicker: { pick: async () => null }, webDist });
  await app.listen({ host: "127.0.0.1", port: PORT });
  browser = await chromium.launch({ channel: "msedge", headless: true });
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await hub?.conversations.idle();
  cleanupSandboxes();
});

/** Joint la capture, trace un trait (souris ou doigt), écrit un mot et envoie. */
async function annotateAndSend(page: Page, words: string, touch: boolean, shot: string) {
  await page.locator(".composer input[type=file]").setInputFiles(join(sb.dir, "capture.png"));
  const canvas = page.locator(".annotator-frame canvas");
  await canvas.waitFor();
  await page.waitForFunction('document.querySelector(".annotator-frame img")?.complete');
  const box = (await canvas.boundingBox())!;
  const pts = Array.from({ length: 13 }, (_, k) => ({ x: box.x + box.width * (0.5 + 0.18 * Math.cos((k / 12) * 2 * Math.PI)), y: box.y + box.height * (0.4 + 0.2 * Math.sin((k / 12) * 2 * Math.PI)) }));
  if (touch) {
    // Un trait au doigt : les pointeurs tactiles passent par les mêmes événements que la souris.
    await canvas.dispatchEvent("pointerdown", { pointerId: 2, pointerType: "touch", clientX: pts[0]!.x, clientY: pts[0]!.y, isPrimary: true });
    for (const p of pts.slice(1)) await canvas.dispatchEvent("pointermove", { pointerId: 2, pointerType: "touch", clientX: p.x, clientY: p.y, isPrimary: true });
    await canvas.dispatchEvent("pointerup", { pointerId: 2, pointerType: "touch", clientX: pts.at(-1)!.x, clientY: pts.at(-1)!.y, isPrimary: true });
  } else {
    await page.mouse.move(pts[0]!.x, pts[0]!.y);
    await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 3 });
    await page.mouse.up();
  }
  // Le trait est bien dessiné sur le calque (des pixels rouges).
  expect(await page.evaluate('(() => { const c = document.querySelector(".annotator-frame canvas"); return c.getContext("2d").getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 0 && v > 200); })()')).toBe(true);
  await page.locator(".annotator-send textarea").fill(words);
  await page.screenshot({ path: join(shots, shot) });
  await page.locator(".annotator-send button").click();
  await page.locator(".annotator").waitFor({ state: "detached" });
  const sent = page.locator(".msg.human .msg-image img").last();
  await sent.waitFor();
  await expect.poll(() => page.evaluate('[...document.querySelectorAll(".msg.human .msg-image img")].at(-1).naturalWidth')).toBeGreaterThan(0);
}

describe("captures annotées", () => {
  it("joindre, entourer, envoyer : l'image est dans la discussion et le directeur la regarde", async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: "fr-FR" });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
    await page.goto(`${BASE}/#/p/${P}`);
    await page.locator(".composer textarea").waitFor();
    fake.replies.push("Je vois : le score déborde à droite, je le recadre.");
    await annotateAndSend(page, "Le score déborde ici.", false, "annot-1-dessin.png");
    await page.locator(".msg.director", { hasText: "le score déborde à droite" }).waitFor();
    await page.screenshot({ path: join(shots, "annot-2-discussion.png") });

    const turn = fake.calls.filter((c) => c.kind === "reply").at(-1) as unknown as { prompt: string; readDir?: string };
    expect(turn.readDir).toBe(join(repo, "studio", "captures"));
    expect(turn.prompt).toMatch(/Le score déborde ici\.[\s\S]*Capture jointe par le directeur créatif : studio\/captures\/\d{14}-[0-9a-f]{6}\.jpg/);
    // L'image commitée est le JPEG annoté, à la taille de la capture.
    const saved = readdirSync(join(repo, "studio", "captures"));
    expect(saved).toHaveLength(1);
    const dims = await page.evaluate(`(async () => { const i = new Image(); i.src = "/api/human/projects/${P}/captures/${saved[0]}"; await i.decode(); return [i.naturalWidth, i.naturalHeight]; })()`);
    expect(dims).toEqual([1280, 720]);

    // Téléphone : le même geste au doigt.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "fr-FR", isMobile: true, hasTouch: true });
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
    await phone.goto(page.url());
    await phone.locator(".composer textarea").waitFor();
    fake.replies.push("Vu aussi sur téléphone.");
    await annotateAndSend(phone, "Et là sur téléphone.", true, "annot-3-telephone-dessin.png");
    expect(await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
    await phone.screenshot({ path: join(shots, "annot-4-telephone-discussion.png") });
    expect(readdirSync(join(repo, "studio", "captures"))).toHaveLength(2);
    expect(errors).toEqual([]);
  }, 90_000);
});
