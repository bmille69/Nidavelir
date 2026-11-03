import { execFile } from "node:child_process";
import { constants as osConstants, setPriority } from "node:os";
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
import { defaultHermesSkillsDir } from "./skills/hermes-library.ts";
import { DEFAULT_SOURCES, GithubFetcher } from "./skills/public-catalog.ts";

const hubRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const dataDir = process.env.STUDIO_DATA_DIR ? resolve(process.env.STUDIO_DATA_DIR) : join(hubRoot, ".data");
const port = Number(process.env.STUDIO_PORT ?? 4317);
const gamesRoot = process.env.STUDIO_GAMES_ROOT ?? "C:\\Games";

// Le hub et tout ce qu'il lance passent derrière Windows, la fenêtre et Hermes (ADR-130). Sous Windows, un processus
// de priorité « inférieure à la normale » la transmet à ses enfants : agents, tests, navigateurs cachés, Godot.
// Les chantiers ne ralentissent presque pas (ils prennent ce qui reste), le PC reste fluide. STUDIO_PRIORITY=normal l'éteint.
if (process.env.STUDIO_PRIORITY !== "normal") {
  try {
    setPriority(0, osConstants.priority.PRIORITY_BELOW_NORMAL);
  } catch (err) {
    console.error(`  Priorité basse impossible (${(err as Error).message})`);
  }
}
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
  // Compétences tenues toutes seules (ADR-97) : procédures apprises des chantiers difficiles, import d'Hermes
  // (STUDIO_SKILLS_AUTO=0 éteint les deux ; STUDIO_HERMES_SKILLS choisit ou vide le dossier d'Hermes).
  skills: process.env.STUDIO_SKILLS_AUTO === "0" ? undefined : { learn: true, hermesDir: defaultHermesSkillsDir() },
  // Laboratoire (ADR-102) : catalogue public (liste fixe, STUDIO_SKILL_SOURCES), 3 essais de banc par semaine (STUDIO_SKILL_TRIALS).
  skillLab: {
    fetcher: new GithubFetcher(),
    sources: process.env.STUDIO_SKILL_SOURCES !== undefined ? process.env.STUDIO_SKILL_SOURCES.split(",").map((x) => x.trim()).filter(Boolean) : DEFAULT_SOURCES,
    trialsPerWeek: Number(process.env.STUDIO_SKILL_TRIALS ?? 3),
  },
  // L'équipe (ADR-98) : les agents se consultent, proposent des souvenirs, lisent le jeu. STUDIO_TEAM=0 l'éteint.
  team: process.env.STUDIO_TEAM !== "0",
  // Le chef de chantier (ADR-104) : jusqu'à STUDIO_PARALLEL chantiers en même temps sur un jeu (2 par défaut ; 1 = un seul à la fois).
  parallel: Math.max(1, Number(process.env.STUDIO_PARALLEL ?? 2) || 1),
  // Un seul gros contrôle à la fois pour tout le studio (ADR-130) ; STUDIO_HEAVY en autorise davantage.
  heavyChecks: Math.max(1, Number(process.env.STUDIO_HEAVY ?? 1) || 1),
  // Les plans de production (ADR-107), avec un passage de sécurité toutes les 2 minutes. STUDIO_PRODUCTION=0 les éteint.
  production: process.env.STUDIO_PRODUCTION === "0" ? false : { tickMs: 120_000 },
  // Le relecteur de la consigne du Directeur (ADR-125). STUDIO_RELECTEUR=0 l'éteint.
  review: process.env.STUDIO_RELECTEUR !== "0",
});
// Les outils de l'équipe sont servis par le hub lui-même, sur 127.0.0.1, avec un jeton par appel (ADR-98).
hub.team.baseUrl = () => `http://127.0.0.1:${port}/api/agent/team`;
cli.observer = (e) => hub.usage.record(e);
// Une compétence ouverte par le directeur, le Concepteur ou le DA (Read de son SKILL.md) est comptée.
cli.toolObserver = (e) => {
  if (e.tool === "Read" && typeof e.input.file_path === "string") hub.skills.noteRead(e.input.file_path);
};
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
// Reprise échelonnée (ADR-130) : la fenêtre et le Pilotage s'affichent d'abord, puis les files reprennent un jeu à la fois
// (90 s après le démarrage, puis une minute d'écart). STUDIO_RESUME_DELAY_S=0 : tout de suite. Le Directeur artistique reprend
// tout de suite : sa reprise relance tous les travaux enregistrés, elle doublerait un travail commencé pendant l'attente.
const resumeDelay = Math.max(0, Number(process.env.STUDIO_RESUME_DELAY_S ?? 90) || 0) * 1000;
const resumeGap = resumeDelay ? 60_000 : 0;
const queued = hub.tasks.queuedProjects();
if (queued.length && resumeDelay) console.log(`  Files : reprise dans ${Math.round(resumeDelay / 1000)} s (${queued.length} jeu(x), un par minute)`);
queued.forEach((project, i) => setTimeout(() => hub.tasks.resumeQueues(project), resumeDelay + i * resumeGap).unref());
hub.art.resume();
// Bibliothèque d'Hermes relue 2 min après le démarrage puis toutes les 6 h : seules les skills nouvelles ou modifiées coûtent un appel.
// Le laboratoire des compétences fait une action au plus toutes les 20 min (essai, recherche, mesure, ménage).
if (hub.skills.auto) {
  const labTick = () =>
    void hub.skillLab.tick().then(
      (done) => done && console.log(`  Compétences : ${done}`),
      () => {},
    );
  setTimeout(labTick, 5 * 60_000).unref();
  setInterval(labTick, 20 * 60_000).unref();
}
if (hub.skills.status().hermes.dir) {
  const syncSkills = () =>
    void hub.skills.syncHermes().then(
      (r) => (r.imported || r.updated) && console.log(`  Compétences : ${r.imported} importée(s) et ${r.updated} mise(s) à jour depuis Hermes`),
      (err: Error) => console.error(`  Compétences : import d'Hermes impossible (${err.message})`),
    );
  setTimeout(syncSkills, 120_000).unref();
  setInterval(syncSkills, 6 * 3600_000).unref();
}
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

// Lancé par l'application de bureau (apps/desktop) : elle reçoit le lien de connexion directement
// et demande l'arrêt par le même canal ; si elle disparaît, le hub s'arrête avec elle.
if (process.env.STUDIO_DESKTOP === "1" && process.send) {
  process.send({ type: "ready", link });
  // Notifications Windows : chaque avis destiné au téléphone est aussi remis à l'application.
  hub.notifications.onNotice((n) => process.send?.({ type: "notice", title: n.title, body: n.body, url: n.url, tag: n.tag }));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void shutdown();
  };
  process.on("message", (m) => {
    if ((m as { type?: string } | null)?.type === "shutdown") stop();
  });
  process.on("disconnect", stop);
}
