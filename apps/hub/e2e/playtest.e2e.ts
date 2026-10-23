/**
 * La manette du testeur dans un vrai navigateur (Edge), sur un vrai petit jeu lancé par « npm run dev » (ADR-69) :
 * cliquer « Jouer », se déplacer en maintenant une touche, marquer des points, lire l'état exposé par le jeu,
 * voir une erreur, photographier, jouer au téléphone ; tout s'arrête à la fin.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaytestService, RealPlayDriver } from "../src/quality/playtest.ts";

/** Un jeu web minimal : un menu, un canvas, un carré qu'on déplace, un score, et le pont de test sous « ?studioTest=1 ». */
const GAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Carré</title>
<style>body{margin:0;background:#111;color:#eee;font-family:sans-serif} #menu{position:absolute;top:40%;left:0;right:0;text-align:center} button{font-size:24px;padding:12px 24px}</style></head>
<body><canvas id="c" width="360" height="240"></canvas><div id="hud">Score 0</div><div id="menu"><button id="play">Jouer</button></div>
<script>
const c = document.getElementById("c"), g = c.getContext("2d"), hud = document.getElementById("hud");
let started = false, x = 20, score = 0; const keys = new Set();
document.getElementById("play").addEventListener("click", () => { started = true; document.getElementById("menu").remove(); });
addEventListener("keydown", (e) => { keys.add(e.key); if (e.key === " " && started) { score++; hud.textContent = "Score " + score; } if (e.key === "e") console.error("boom : le boss n'a pas de sprite"); });
addEventListener("keyup", (e) => keys.delete(e.key));
(function frame() { if (started && keys.has("ArrowRight")) x = Math.min(340, x + 4); g.fillStyle = "#123"; g.fillRect(0, 0, 360, 240); g.fillStyle = "#7df"; g.fillRect(x, 110, 20, 20); requestAnimationFrame(frame); })();
if (new URLSearchParams(location.search).get("studioTest") === "1") {
  window.__STUDIO_TEST__ = { snapshot: () => ({ started, x, score }), reset: () => { x = 20; score = 0; hud.textContent = "Score 0"; } };
}
</script></body></html>`;

/** Le serveur du jeu, lancé par « npm run dev » ; il affiche son adresse comme Vite. */
const SERVER = `import { createServer } from "node:http"; import { readFileSync, writeFileSync } from "node:fs";
const s = createServer((req, res) => { const p = req.url.split("?")[0];
  if (p === "/" || p === "/index.html") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync("index.html"));
  res.writeHead(404).end(); });
s.listen(Number(process.env.PORT || 0), "127.0.0.1", () => { writeFileSync("port.txt", String(s.address().port)); console.log("  Local:   http://127.0.0.1:" + s.address().port + "/"); });`;

let dir = "";
let game = "";
let service: PlaytestService;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "playtest-e2e-"));
  game = join(dir, "game");
  mkdirSync(join(game, "node_modules"), { recursive: true });
  writeFileSync(join(game, "package.json"), JSON.stringify({ name: "carre", private: true, type: "module", scripts: { dev: "node server.mjs" } }));
  writeFileSync(join(game, "server.mjs"), SERVER);
  writeFileSync(join(game, "index.html"), GAME_HTML);
  service = new PlaytestService({ driver: new RealPlayDriver({ workDir: join(dir, "hub") }), shotsDir: join(dir, "shots") });
});

afterAll(async () => {
  await service?.stopAll();
  rmSync(dir, { recursive: true, force: true });
});

const run = { id: "RUN-0001", project: "carre", task: "T-0001", cwd: "" };
const state = (text: string) => JSON.parse(/État du jeu \(__STUDIO_TEST__\.snapshot\) : (\{.*\})/.exec(text)![1]!) as { started: boolean; x: number; score: number };

describe("le testeur joue pour de vrai (ADR-69)", () => {
  it("ouvre le jeu, clique « Jouer », se déplace, marque, voit une erreur, photographie, puis tout s'arrête", async () => {
    run.cwd = game;
    const opened = await service.handle(run, { action: "open" });
    expect(opened.text).toMatch(/^Jeu ouvert \(écran PC 1280×720\)\./);
    expect(opened.text).toMatch(/Page : « Carré » \/\?studioTest=1/);
    expect(opened.text).toMatch(/button « Jouer » \(\d+, \d+\)/);
    expect(opened.text).toContain("Zones de jeu (canvas) : 360×240 à (0, 0)");
    expect(opened.text).toContain("Pont de test disponible : snapshot, reset");
    expect(state(opened.text)).toEqual({ started: false, x: 20, score: 0 });
    // Une vraie photo JPEG, rendue en image au testeur.
    expect(readFileSync(opened.image!.file).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    const played = await service.handle(run, {
      action: "act",
      steps: [
        { do: "click", text: "Jouer" },
        { do: "press", key: "ArrowRight", hold_ms: 600 },
        { do: "press", key: "Space" },
        { do: "press", key: " " },
        { do: "press", key: "e" },
      ],
      capture: true,
    });
    expect(played.text).toMatch(/^5 action\(s\) jouée\(s\)\./);
    expect(played.text).not.toContain("⚠");
    const s = state(played.text);
    expect(s.started).toBe(true);
    expect(s.x).toBeGreaterThan(40);
    expect(s.score).toBe(2);
    expect(played.text).toContain("Score 2");
    expect(played.text).toContain("Erreurs dans la page : boom : le boss n'a pas de sprite");
    expect(played.image).toBeDefined();

    // Les erreurs déjà rendues ne reviennent pas ; le pont de test remet la partie à zéro.
    const reset = await service.handle(run, { action: "act", steps: [{ do: "bridge", method: "reset" }, { do: "click", text: "Introuvable" }] });
    expect(reset.text).toContain("Aucune nouvelle erreur dans la page.");
    expect(reset.text).toMatch(/⚠ étape 2 \(click\) impossible/);
    expect(state(reset.text)).toMatchObject({ x: 20, score: 0 });

    await service.closeRun(run.id);
    // Le serveur du jeu est arrêté avec la partie.
    const port = readFileSync(join(game, "port.txt"), "utf8");
    await expect(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
    expect((await service.handle(run, { action: "close" })).text).toBe("Aucune partie ouverte.");
  }, 90_000);

  it("au téléphone : écran étroit et tactile, on touche « Jouer »", async () => {
    run.cwd = game;
    const opened = await service.handle({ ...run, id: "RUN-0002" }, { action: "open", screen: "phone" });
    expect(opened.text).toMatch(/^Jeu ouvert \(écran téléphone 390×844, tactile\)\./);
    const tapped = await service.handle({ ...run, id: "RUN-0002" }, { action: "act", steps: [{ do: "click", text: "Jouer" }], capture: true });
    expect(tapped.text).not.toContain("⚠");
    expect(state(tapped.text).started).toBe(true);
    await service.closeRun("RUN-0002");
  }, 90_000);
});
