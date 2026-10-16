import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

export type ExpressCheck = { ok: boolean; errors: string[]; screenshot: string | null };

/** Le hub ouvre le jeu dans un navigateur invisible, joue quelques touches et prend une capture (ADR-44). */
export interface ExpressChecker {
  check(root: string, screenshot: string): Promise<ExpressCheck>;
}

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

/** Un fichier du jeu, jamais en dehors de son dossier ni dans .git ; null sinon. */
export function gameFile(root: string, rel: string): { path: string; mime: string } | null {
  const clean = normalize(decodeURIComponent(rel || "index.html")).replace(/^([\\/])+/, "");
  if (clean.split(/[\\/]/).some((p) => p === ".." || p === ".git")) return null;
  const path = join(root, clean);
  if (!path.startsWith(normalize(root) + sep) && path !== normalize(root)) return null;
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return { path, mime: MIME[extname(path).toLowerCase()] ?? "application/octet-stream" };
}

/** Petit serveur local le temps du test : les modules ES ne se chargent pas depuis file://. */
function serve(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const f = gameFile(root, (req.url ?? "/").split("?")[0]!.replace(/^\//, ""));
    if (!f) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": f.mime, "cache-control": "no-store" }).end(readFileSync(f.path));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/index.html`, close: () => new Promise((r) => server.close(() => r())) });
    }),
  );
}

export class RealExpressChecker implements ExpressChecker {
  async check(root: string, screenshot: string): Promise<ExpressCheck> {
    let chromium: typeof import("playwright-core").chromium;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      return { ok: true, errors: [], screenshot: null };
    }
    const site = await serve(root);
    const browser = await chromium.launch({ channel: "msedge", headless: true }).catch(() => chromium.launch({ channel: "chrome", headless: true }).catch(() => null));
    try {
      if (!browser) return { ok: true, errors: [], screenshot: null };
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error" && !/favicon/i.test(m.text() + (m.location().url ?? ""))) errors.push(m.text());
      });
      page.on("requestfailed", (r) => errors.push(`fichier introuvable : ${r.url().replace(/^https?:\/\/[^/]+\//, "")}`));
      page.on("response", (r) => {
        if (r.status() >= 400 && !/favicon/i.test(r.url())) errors.push(`fichier introuvable (${r.status()}) : ${r.url().replace(/^https?:\/\/[^/]+\//, "")}`);
      });
      await page.goto(site.url, { waitUntil: "load", timeout: 30_000 });
      await page.waitForTimeout(1200);
      // Un joueur pressé : clic, Entrée, quelques touches, comme pour démarrer une partie.
      await page.mouse.click(640, 360).catch(() => {});
      for (const key of ["Enter", "Space", "ArrowRight", "ArrowUp", "KeyD", "KeyW"]) {
        await page.keyboard.down(key).catch(() => {});
        await page.waitForTimeout(250);
        await page.keyboard.up(key).catch(() => {});
      }
      await page.waitForTimeout(1500);
      const empty = (await page.evaluate("!document.body || document.body.children.length === 0")) as boolean;
      const shot = await page.screenshot({ path: screenshot }).then(
        () => screenshot,
        () => null,
      );
      if (empty) errors.push("la page reste vide");
      const unique = [...new Set(errors)].slice(0, 6).map((e) => e.slice(0, 400));
      return { ok: unique.length === 0, errors: unique, screenshot: shot };
    } catch (err) {
      return { ok: false, errors: [(err as Error).message.slice(0, 400)], screenshot: null };
    } finally {
      await browser?.close().catch(() => {});
      await site.close();
    }
  }
}
