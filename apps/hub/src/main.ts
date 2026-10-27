import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHub } from "./hub.ts";
import { ClaudeCli } from "./llm/claude-cli.ts";
import { DirectClaudeOrchestrator } from "./orchestrator/direct-claude.ts";
import { ClaudeCodeExecutor } from "./executor/claude-code.ts";
import { CavemanExecutor, CavemanRouter, cavemanSettings } from "./executor/caveman.ts";
import { WindowsFolderPicker } from "./projects/folder-picker.ts";
import { defaultRegistryOptions } from "./projects/project-registry.ts";
import { buildServer } from "./server/http.ts";
import { RealChecker } from "./quality/checks.ts";
import { RealPlayDriver } from "./quality/playtest.ts";
import { godotLocator } from "./godot/toolchain.ts";

const hubRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const dataDir = process.env.STUDIO_DATA_DIR ? resolve(process.env.STUDIO_DATA_DIR) : join(hubRoot, ".data");
const port = Number(process.env.STUDIO_PORT ?? 4317);
const gamesRoot = process.env.STUDIO_GAMES_ROOT ?? "C:\\Games";

const cli = new ClaudeCli(join(dataDir, "claude-work"));
// Le Godot du PC (ADR-73) : trouvé sur le bureau ou ailleurs, donné aux agents sous le nom « godot ».
const godot = godotLocator(dataDir);
const found = godot();
console.log(found ? `  Godot ${found.version} : ${found.exe}` : "  Godot : introuvable (jeux Godot sans tests ni essais)");
// Modèles choisis dans « Le studio en direct », lus à chaque appel (ADR-37) ; défauts recommandés (ADR-36).
const orchestrator = new DirectClaudeOrchestrator(cli, () => ({ chat: hub.models.get("director"), structured: hub.models.get("archivist"), concept: hub.models.get("concepteur"), archeologue: hub.models.get("archeologue"), art: hub.models.get("art_director"), artisan: hub.models.get("art_workshop") }));

// Essai Caveman (ADR-92) : éteint sans STUDIO_CAVEMAN ; allumé, le Développeur d'une part des chantiers passe par le relais.
const caveman = new CavemanRouter(cavemanSettings(), { home: join(dataDir, "caveman") });
const developerExecutor = new ClaudeCodeExecutor(() => ({ default: hub.models.get("developer"), big: hub.models.get("developer_big"), verify: hub.models.get("qa") }));

const hub = createHub({
  databasePath: join(dataDir, "hub.db"),
  registry: defaultRegistryOptions(hubRoot, dataDir),
  orchestrator,
  executor: caveman.enabled ? new CavemanExecutor(developerExecutor, caveman) : developerExecutor,
  models: {
    director: process.env.STUDIO_MODEL_CHAT,
    archivist: process.env.STUDIO_MODEL_STRUCTURED,
    concepteur: process.env.STUDIO_MODEL_CONCEPT,
    developer: process.env.STUDIO_MODEL_DEV,
    developer_big: process.env.STUDIO_MODEL_DEV_BIG,
    qa: process.env.STUDIO_MODEL_QA,
    archeologue: process.env.STUDIO_MODEL_ARCHEOLOGUE,
    art_director: process.env.STUDIO_MODEL_ART,
  },
  dataDir,
  agentBaseUrl: () => `http://127.0.0.1:${port}/api/agent/runs`,
  autopilot: { synthesisDelayMs: Number(process.env.STUDIO_AUTOPILOT_DELAY_MS ?? 45_000) },
  // Téléphone (ADR-30) : publication du hub dans votre réseau Tailscale, à la demande.
  remotePort: port,
  // Avant chaque fusion automatique : tests du jeu et lancement dans un navigateur invisible (ADR-32).
  checker: new RealChecker({ workDir: dataDir, godot }),
  godot,
  // Le testeur joue au jeu du chantier avant de donner son avis (ADR-69).
  playDriver: new RealPlayDriver({ workDir: dataDir, godot }),
  usageProbe: async () => {
    await cli.call({ systemPrompt: "Réponds uniquement : ok", prompt: "ok", model: "haiku", tag: { agent: "compteur" } });
  },
});
cli.observer = (e) => hub.usage.record(e);
// Un run ne survit pas à un arrêt du hub : le chantier coupé repart de zéro en tête de file, la file est gardée (ADR-61).
const restarted = hub.tasks.recoverInterrupted();
hub.conceptions.recoverInterrupted();

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
  caveman,
});
await server.listen({ host: "127.0.0.1", port });
// Le hub prêt, le travail interrompu reprend : chantiers en file, travaux du Directeur artistique (ADR-61).
for (const r of restarted) {
  if (r.thread) hub.conversations.notify(r.project, r.thread, `↻ Le hub a redémarré pendant le chantier ${r.id} : il repart de zéro sous ${r.again}, avant le reste de la file.`);
}
if (caveman.enabled) {
  const s = caveman.settings;
  void caveman.ensure().then((ok) =>
    console.log(
      ok
        ? `  Caveman (essai, mode ${s.mode}) : relais prêt sur ${s.url}, ${Math.round(s.share * 100)} % des chantiers`
        : `  Caveman (essai) : ${caveman.status().lastError} — les chantiers restent en direct`,
    ),
  );
}
hub.tasks.resumeQueues();
hub.art.resume();
// Si le hub est déjà publié dans Tailscale, son adresse est acceptée dès le démarrage.
void hub.remote?.status().then((s) => s.url && console.log(`Depuis le téléphone : ${s.url}`), () => {});

const link = `http://127.0.0.1:${port}/login?token=${hub.sessions.createLoginToken()}`;
console.log(`\nGame Studio Hub — http://127.0.0.1:${port}`);
console.log(`Orchestrateur : ${orchestrator.name} · jeux : ${gamesRoot}`);
console.log(`Lien de connexion (usage unique) :\n  ${link}\n`);
if (process.env.STUDIO_NO_BROWSER !== "1") {
  execFile("cmd.exe", ["/c", "start", "", link.replace(/&/g, "^&")], { windowsHide: true }, () => {});
}

const shutdown = async () => {
  caveman.stop();
  await server.close();
  await hub.conversations.idle();
  hub.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
