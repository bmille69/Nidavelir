import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHub } from "./hub.ts";
import { ClaudeCli } from "./llm/claude-cli.ts";
import { DirectClaudeOrchestrator } from "./orchestrator/direct-claude.ts";
import { WindowsFolderPicker } from "./projects/folder-picker.ts";
import { defaultRegistryOptions } from "./projects/project-registry.ts";
import { buildServer } from "./server/http.ts";

const hubRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const dataDir = process.env.STUDIO_DATA_DIR ? resolve(process.env.STUDIO_DATA_DIR) : join(hubRoot, ".data");
const port = Number(process.env.STUDIO_PORT ?? 4317);
const gamesRoot = process.env.STUDIO_GAMES_ROOT ?? "C:\\Games";

const cli = new ClaudeCli(join(dataDir, "claude-work"));
const orchestrator = new DirectClaudeOrchestrator(cli, {
  chat: process.env.STUDIO_MODEL_CHAT ?? "sonnet",
  structured: process.env.STUDIO_MODEL_STRUCTURED ?? "sonnet",
});

const hub = createHub({
  databasePath: join(dataDir, "hub.db"),
  registry: defaultRegistryOptions(hubRoot, dataDir),
  orchestrator,
});

// Les fichiers studio/ font foi : on réaligne l'index à chaque démarrage (ADR-05).
for (const p of hub.projects.list()) {
  try {
    const { items } = hub.vision.rebuildIndex(p.slug);
    console.log(`  ${p.name} : ${items} éléments de vision`);
  } catch (err) {
    console.error(`  ${p.name} : index non reconstruit (${(err as Error).message})`);
  }
}

const server = await buildServer(hub, {
  port,
  gamesRoot,
  allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
  folderPicker: new WindowsFolderPicker(),
  webDist: join(hubRoot, "apps", "web", "dist"),
});
await server.listen({ host: "127.0.0.1", port });

const link = `http://127.0.0.1:${port}/login?token=${hub.sessions.createLoginToken()}`;
console.log(`\nGame Studio Hub — http://127.0.0.1:${port}`);
console.log(`Orchestrateur : ${orchestrator.name} · jeux : ${gamesRoot}`);
console.log(`Lien de connexion (usage unique) :\n  ${link}\n`);
if (process.env.STUDIO_NO_BROWSER !== "1") {
  execFile("cmd.exe", ["/c", "start", "", link.replace(/&/g, "^&")], { windowsHide: true }, () => {});
}

const shutdown = async () => {
  await server.close();
  await hub.conversations.idle();
  hub.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
