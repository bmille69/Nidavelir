import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewService } from "../src/executor/preview.ts";

const dirs: string[] = [];
const previews = new PreviewService({ startTimeoutMs: 20_000 });
afterEach(async () => {
  await previews.stopAll();
  await new Promise((r) => setTimeout(r, 300));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function game(scripts: Record<string, string>, withModules = true): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-preview-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "jeu", scripts }));
  if (withModules) mkdirSync(join(dir, "node_modules"));
  // Petit serveur de jeu : écoute sur PORT et annonce son adresse comme Vite.
  writeFileSync(
    join(dir, "server.mjs"),
    "import http from 'node:http';const p=process.env.PORT;http.createServer((q,r)=>r.end('jeu')).listen(p,'127.0.0.1',()=>console.log(`  Local:   http://127.0.0.1:${p}/`));",
  );
  return dir;
}

describe("▶ Essayer", () => {
  it("lance le jeu, renvoie son adresse, puis l'arrête", async () => {
    const p = await previews.start("destiny", "T-0001", game({ dev: "node server.mjs" }));
    expect(p.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(await (await fetch(p.url)).text()).toBe("jeu");
    expect(previews.list("destiny")).toHaveLength(1);
    await previews.stop(p.key);
    expect(previews.list("destiny")).toHaveLength(0);
  }, 30_000);

  it("explique clairement quand le jeu ne peut pas être lancé", async () => {
    await expect(previews.start("destiny", null, game({ build: "vite build" }))).rejects.toThrow(/script « dev »/);
    await expect(previews.start("destiny", null, game({ dev: "vite" }, false))).rejects.toThrow(/npm install/);
  });
});
