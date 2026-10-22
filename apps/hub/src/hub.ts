import { ApprovalService } from "./approvals/approval-service.ts";
import { HumanSessions } from "./auth/human-session.ts";
import { systemClock, type Clock } from "./clock.ts";
import { ConversationService } from "./conversation/conversation-service.ts";
import { openDatabase, type Db } from "./db/database.ts";
import { Journal } from "./journal/journal.ts";
import { OrchestratorError, type OrchestratorPort } from "./orchestrator/port.ts";
import { BootstrapService } from "./projects/bootstrap.ts";
import { ProjectRegistry, type RegistryOptions } from "./projects/project-registry.ts";
import { GitCli, type VcsPort } from "./vcs/git.ts";
import { TaskService } from "./executor/task-service.ts";
import { ExecutorError, type ExecutorPort } from "./executor/port.ts";
import { dirname, join } from "node:path";
import { ExtractionService } from "./vision/extraction.ts";
import { SynthesisService } from "./vision/synthesis.ts";
import { VisionService } from "./vision/vision-service.ts";
import { Autopilot, type AutopilotOptions } from "./autonomy/autopilot.ts";
import { UsageService } from "./usage/usage-service.ts";
import { ModelService, type ModelRole } from "./usage/model-service.ts";
import { ReverseService } from "./reverse/reverse-service.ts";
import { ArtService } from "./art/art-service.ts";
import { ComfyImageGen, type ImageGenPort } from "./art/imagegen.ts";
import { RealModel3D, type Model3DPort } from "./art/model3d.ts";
import type { WebRefsPort } from "./art/web-refs.ts";
import { readManifest } from "./art/manifest.ts";
import { ExpressService } from "./express/express-service.ts";
import { ModService } from "./mods/mod-service.ts";
import type { SteamGame } from "./mods/steam.ts";
import { RealToolchain, type ToolchainPort } from "./mods/toolchain.ts";
import { RealExpressChecker, type ExpressChecker } from "./express/checker.ts";
import { RealReverseTools, type ReverseToolsPort } from "./reverse/tools.ts";
import { PreviewService } from "./executor/preview.ts";
import { QualityService } from "./quality/quality-service.ts";
import { CheckService, checksForTester, type CheckerPort } from "./quality/checks.ts";
import { GameStateService } from "./autonomy/game-state.ts";
import { ConceptionService } from "./conception/conception-service.ts";
import { SkillService } from "./skills/skill-service.ts";
import { NotificationService } from "./remote/notifications.ts";
import { RemoteService, type Runner } from "./remote/tailscale.ts";
import type { DeviceRecord, DeviceStore } from "./auth/human-session.ts";

export type HubOptions = {
  databasePath: string;
  registry: RegistryOptions;
  clock?: Clock;
  vcs?: VcsPort;
  orchestrator?: OrchestratorPort;
  executor?: ExecutorPort;
  /** Dossier des données du hub (worktrees, runs). Défaut : dossier de la base. */
  dataDir?: string;
  /** URL de base des routes agents, connue une fois le serveur démarré. */
  agentBaseUrl?: () => string;
  escalationTimeoutMs?: number;
  /** Pilote automatique (ADR-20). Absent : le directeur ne décide jamais seul. */
  autopilot?: AutopilotOptions;
  /** Appel minimal à Claude Code pour rafraîchir vos limites d'abonnement (ADR-21). */
  usageProbe?: () => Promise<void>;
  /** Port du hub : nécessaire pour publier le hub dans Tailscale (ADR-30). */
  remotePort?: number;
  tailscaleRunner?: Runner;
  pushSubject?: string;
  pushFetch?: typeof fetch;
  /** Le Concepteur peut chercher sur le web (lecture seule). Défaut : oui (choix du 14/10). */
  conceptWeb?: boolean;
  /** Vérifications du hub avant fusion : tests du jeu et lancement (ADR-32). Absent : aucune. */
  checker?: CheckerPort;
  /** Modèle par défaut de chaque agent, tant que vous n'en choisissez pas un dans le studio (ADR-37). */
  models?: Partial<Record<ModelRole, string | undefined>>;
  /** Outils de l'Atelier de démontage (ADR-40). Défaut : les vrais, téléchargés à votre demande. */
  reverseTools?: ReverseToolsPort;
  /** Générateur d'images local du Directeur artistique (ADR-46). Défaut : ComfyUI + Flux, installé à votre demande. */
  imagegen?: ImageGenPort;
  /** Atelier 3D du Directeur artistique : Tripo et Blender (ADR-47). Défaut : les vrais, sur votre clic et votre clé. */
  model3d?: Model3DPort;
  /** Téléchargement des références web du Directeur artistique (ADR-58). Défaut : le vrai, adresses publiques seulement. */
  webRefs?: WebRefsPort;
  /** Test du Jeu express dans un navigateur (ADR-44). Défaut : le vrai si les vérifications sont actives, sinon aucun test. */
  expressChecker?: ExpressChecker;
  /** Studio de modding (ADR-65) : l'outillage (.NET, chargeur de mods) et les jeux Steam ; des faux dans les tests. */
  modToolchain?: ToolchainPort;
  steamGames?: () => SteamGame[];
};

export type Hub = {
  db: Db;
  clock: Clock;
  journal: Journal;
  sessions: HumanSessions;
  approvals: ApprovalService;
  projects: ProjectRegistry;
  vision: VisionService;
  orchestrator: OrchestratorPort;
  extraction: ExtractionService;
  conversations: ConversationService;
  bootstrap: BootstrapService;
  synthesis: SynthesisService;
  tasks: TaskService;
  usage: UsageService;
  models: ModelService;
  reverse: ReverseService;
  art: ArtService;
  express: ExpressService;
  mods: ModService;
  autopilot: Autopilot | null;
  previews: PreviewService;
  quality: QualityService;
  checks: CheckService | null;
  gameState: GameStateService;
  conceptions: ConceptionService;
  skills: SkillService;
  notifications: NotificationService;
  /** Accès depuis le téléphone via Tailscale (null si le port du hub n'est pas connu, ex. tests). */
  remote: RemoteService | null;
  /** Noms d'hôte acceptés en plus de ceux du serveur (ex. « mon-pc.tail1234.ts.net »). */
  extraHosts: Set<string>;
  close(): void;
};

const noExecutor: ExecutorPort = {
  name: "none",
  run: () => Promise.reject(new ExecutorError("Aucun exécuteur configuré")),
};

const noOrchestrator: OrchestratorPort = {
  name: "none",
  reply: () => Promise.reject(new OrchestratorError("Aucun orchestrateur configuré")),
  structured: () => Promise.reject(new OrchestratorError("Aucun orchestrateur configuré")),
};

/** Assemble les services du hub (composition racine, sans état global). */
export function createHub(options: HubOptions): Hub {
  const clock = options.clock ?? systemClock;
  const vcs = options.vcs ?? new GitCli();
  const orchestrator = options.orchestrator ?? noOrchestrator;
  const db = openDatabase(options.databasePath);
  const sessions = new HumanSessions(deviceStore(db));
  const journal = new Journal(db, clock);
  const approvals = new ApprovalService(db, journal, clock);
  const projects = new ProjectRegistry(db, journal, clock, vcs, options.registry);
  const vision = new VisionService({ db, journal, clock, vcs, projects, approvals });
  const extraction = new ExtractionService(vision, orchestrator, journal);
  const conversations = new ConversationService({ db, clock, journal, projects, vision, extraction, orchestrator });
  const bootstrap = new BootstrapService({ db, clock, projects, extraction });
  const synthesis = new SynthesisService({ db, clock, journal, vision, orchestrator });
  const tasks = new TaskService({
    db,
    clock,
    journal,
    projects,
    vision,
    approvals,
    vcs,
    executor: options.executor ?? noExecutor,
    options: {
      dataDir: options.dataDir ?? dirname(options.databasePath),
      agentBaseUrl: options.agentBaseUrl ?? (() => "http://127.0.0.1:0/api/agent/runs"),
      escalationTimeoutMs: options.escalationTimeoutMs,
    },
  });
  const usage = new UsageService(db, clock, options.usageProbe);
  const models = new ModelService(db, journal, options.models);
  // Compétences (ADR-29) : données aux agents, et leçons apprises de vos avis et corrections.
  const skills = new SkillService({ db, clock, journal, projects, orchestrator });
  skills.attach(tasks);
  tasks.skills = skills;
  conversations.skills = skills;
  const previews = new PreviewService({ workDir: options.dataDir ?? dirname(options.databasePath) });
  tasks.usage = usage;
  let autopilot: Autopilot | null = null;
  if (options.autopilot) {
    const pilot = new Autopilot({ projects, vision, approvals, synthesis, tasks, journal, clock, options: options.autopilot });
    conversations.autopilot = pilot;
    pilot.conversations = conversations;
    synthesis.onCompleted = (job) => pilot.onSynthesis(job);
    tasks.onPlanSubmitted = (project, id) => pilot.onPlanSubmitted(project, id);
    tasks.onStatus = (task) => pilot.onTaskStatus(task);
    tasks.onRunFinished = (task, kind) => pilot.onRunFinished(task, kind);
    tasks.onQueueEmpty = (project) => pilot.onQueueEmpty(project);
    conversations.workshopState = (project) => pilot.workshopState(project);
    autopilot = pilot;
  }
  const statusHook = tasks.onStatus;
  tasks.onStatus = (task) => {
    statusHook?.(task);
    skills.onTaskStatus(task);
  };
  // Carnet « État du jeu » (ADR-33) : réécrit après chaque fusion en atelier, lu par le directeur et le développeur.
  const gameState = new GameStateService({ db, clock, journal, tasks, orchestrator });
  tasks.gameState = (project) => gameState.get(project)?.text ?? null;
  if (autopilot) autopilot.gameState = gameState;
  const stateHook = tasks.onStatus;
  tasks.onStatus = (task) => {
    stateHook?.(task);
    if (task.status === "merged" && projects.get(task.project).autonomy === "workshop") gameState.afterMerge(task);
  };
  const dataDir = options.dataDir ?? dirname(options.databasePath);
  const checks = options.checker ? new CheckService({ db, clock, journal, projects, checker: options.checker, shotsDir: join(dataDir, "shots") }) : null;
  if (autopilot) autopilot.checks = checks;
  if (checks) {
    // Entre le développeur et le testeur : tests, lancement et capture du jeu (ADR-32, ADR-33).
    tasks.beforeVerify = async (task) => {
      if (!task.worktree) return null;
      const r = await checks.run(task.project, task.id, task.worktree);
      return { summary: checksForTester(r), screenshot: r.launch.screenshot ?? null };
    };
  }
  const quality = new QualityService({ db, clock, journal, projects, tasks, vcs, checks });
  quality.onRated = (project, task, r) => {
    // Un 👍 sans un mot n'apprend rien ; un 👎 ou un commentaire, si.
    if (r.rating === "down" || r.note) skills.learn(project, task, `Avis du directeur créatif : ${r.rating === "up" ? "👍 réussi" : "👎 pas ce qu'il voulait"}${r.note ? ` — « ${r.note} »` : ""}`);
  };
  const conceptions = new ConceptionService({ db, clock, journal, projects, tasks, conversations, vision, vcs, orchestrator, web: options.conceptWeb ?? true });
  conceptions.skills = skills;
  // Le directeur et le Concepteur se passent la main (ADR-34) : conception demandée depuis une discussion,
  // état du jeu et chantiers montrés au Concepteur.
  if (autopilot) {
    autopilot.conceptions = conceptions;
    const pilot = autopilot;
    conceptions.projectState = (project) => pilot.workshopState(project);
  }
  // Téléphone (ADR-30) : notifications sur vos appareils pour ce qui vous attend.
  const notifications = new NotificationService({ db, clock, journal, subject: options.pushSubject, fetch: options.pushFetch });
  const projectName = (slug: string) => {
    try {
      return projects.get(slug).name;
    } catch {
      return slug;
    }
  };
  const notifyHook = tasks.onStatus;
  tasks.onStatus = (task) => {
    notifyHook?.(task);
    const at = `#/p/${task.project}/tasks/${task.id}`;
    // En atelier ou en autonomie, un chantier à relire est fusionné tout seul ou corrigé ; le pilote prévient s'il a besoin de vous (ADR-31).
    const delegated = autopilot !== null && task.origin !== null && ["workshop", "autonomous"].includes(projects.get(task.project).autonomy);
    if (task.status === "review" && !delegated) notifications.notify({ title: "✓ Chantier prêt à essayer", body: `${task.title} — ${projectName(task.project)}`, url: at, tag: task.id });
    if (task.status === "failed") notifications.notify({ title: "✗ Chantier en échec", body: `${task.title} — ${projectName(task.project)}`, url: at, tag: task.id });
    if (task.status === "plan_review") notifications.notify({ title: "Un plan attend votre accord", body: `${task.title} — ${projectName(task.project)}`, url: at, tag: task.id });
  };
  if (autopilot) autopilot.alert = (n) => notifications.notify(n);
  tasks.onEscalation = (esc) =>
    notifications.notify({ title: "✋ Autorisation demandée", body: `${esc.summary} — ${projectName(esc.project)}`, url: `#/p/${esc.project}/tasks/${esc.task}`, tag: esc.id });
  conceptions.onTurn = (c) => {
    if (c.data.questions.length) notifications.notify({ title: "✦ Le Concepteur attend vos réponses", body: c.title, url: `#/c/${c.id}`, tag: c.id });
    else if (c.data.ready) notifications.notify({ title: "✦ Conception prête", body: `${c.title} : vous pouvez créer le projet`, url: `#/c/${c.id}`, tag: c.id });
  };
  const reverse = new ReverseService({
    db,
    clock,
    journal,
    tools: options.reverseTools ?? new RealReverseTools(dataDir),
    orchestrator,
    conversations,
    projects,
    vcs,
    dataDir,
  });
  // Le Directeur artistique (ADR-43) : un asset passe « intégré » quand son chantier est fusionné.
  const imagegen = options.imagegen ?? new ComfyImageGen(dataDir);
  const art = new ArtService({
    db,
    clock,
    journal,
    projects,
    orchestrator,
    vcs,
    conversations,
    imagegen,
    model3d: options.model3d ?? new RealModel3D(dataDir),
    webRefs: options.webRefs,
    // La capture prise par les vérifications avant la fusion sert à juger le visuel dans le jeu (ADR-48).
    screenshot: (project, task) => checks?.screenshotPath(project, task) ?? null,
    // La scène vitrine du jeu, photographiée sur le jeu lui-même après la fusion (ADR-49).
    vitrine: async (project, id, file) => {
      if (!options.checker) return null;
      const r = await options.checker.launch(`${project}/vitrine-${id}`, projects.get(project).root, file, `?vitrine=${id}`);
      return r.screenshot ?? null;
    },
  });
  // Le Concepteur confie les visuels de ses conceptions au Directeur artistique, et sait ce qui existe déjà (ADR-59).
  conceptions.art = art;
  // Un visuel validé attend que son chantier ait posé sa place dans le jeu (ADR-60).
  art.tasks = tasks;
  // La file des visuels attend, comme celle des chantiers, quand la jauge d'abonnement est presque pleine (ADR-62).
  art.paused = () => tasks.limitPaused();
  // Un atelier 3D réglé sous Fable reçoit Fable en renfort pour une dernière passe (ADR-62).
  art.workshopModel = () => models.get("art_workshop");
  conceptions.artState = (project) => {
    const assets = readManifest(projects.get(project).root).assets;
    return assets.length ? assets.slice(-40).map((a) => `- ${a.id} ${a.name} (${a.type}) : ${a.status}`).join("\n") : null;
  };
  const artHook = tasks.onStatus;
  tasks.onStatus = (task) => {
    artHook?.(task);
    art.onTaskStatus(task);
  };
  // Le Jeu express (ADR-44) : de l'idée à un jeu jouable en quelques minutes.
  const express = new ExpressService({
    db,
    clock,
    journal,
    orchestrator,
    executor: options.executor ?? noExecutor,
    vcs,
    projects,
    conversations,
    checker: options.expressChecker ?? (options.checker ? new RealExpressChecker() : { check: async () => ({ ok: true, errors: [], screenshot: null }) }),
    dataDir,
    agentBaseUrl: options.agentBaseUrl ?? (() => "http://127.0.0.1:0/api/agent/runs"),
  });
  express.usage = usage;
  express.onFinished = (g) =>
    notifications.notify(
      g.status === "ready"
        ? { title: "⚡ Jeu express prêt", body: `${g.title} : à vous de jouer`, url: `#/express/${g.id}`, tag: `express-${g.id}` }
        : { title: "Jeu express interrompu", body: g.error ?? g.title, url: `#/express/${g.id}`, tag: `express-${g.id}` },
    );
  // Le studio de modding (ADR-65) : des mods pour vos jeux du commerce, une recette par jeu.
  const mods = new ModService({
    db,
    clock,
    journal,
    orchestrator,
    executor: options.executor ?? noExecutor,
    vcs,
    toolchain: options.modToolchain ?? new RealToolchain(dataDir),
    imagegen,
    dataDir,
    agentBaseUrl: options.agentBaseUrl ?? (() => "http://127.0.0.1:0/api/agent/runs"),
    steam: options.steamGames,
  });
  mods.usage = usage;
  mods.onFinished = (m) =>
    notifications.notify(
      m.status === "ready"
        ? { title: "🧩 Mod prêt", body: `${m.title} (${m.game}) : à installer et essayer`, url: `#/mods/${m.id}`, tag: `mod-${m.id}` }
        : { title: "Mod interrompu", body: m.error ?? m.title, url: `#/mods/${m.id}`, tag: `mod-${m.id}` },
    );
  const extraHosts = new Set<string>();
  const remote = options.remotePort ? new RemoteService({ port: options.remotePort, run: options.tailscaleRunner, onHost: (h) => extraHosts.add(h.toLowerCase()) }) : null;
  let closed = false;
  return {
    db,
    clock,
    journal,
    sessions,
    approvals,
    projects,
    vision,
    orchestrator,
    extraction,
    conversations,
    bootstrap,
    synthesis,
    tasks,
    usage,
    models,
    reverse,
    art,
    express,
    mods,
    autopilot,
    previews,
    quality,
    checks,
    gameState,
    conceptions,
    skills,
    notifications,
    remote,
    extraHosts,
    close: () => {
      if (closed) return;
      closed = true;
      void previews.stopAll();
      autopilot?.close();
      imagegen.close();
      db.close();
    },
  };
}

/** Les téléphones connectés survivent à un redémarrage du hub (ADR-30). */
function deviceStore(db: Db): DeviceStore {
  return {
    load: () => db.prepare("SELECT * FROM devices").all() as DeviceRecord[],
    save: (r) =>
      db
        .prepare("INSERT INTO devices (id, name, cookie_hash, csrf, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
        .run(r.id, r.name, r.cookie_hash, r.csrf, r.created_at, r.last_seen),
    remove: (id) => db.prepare("DELETE FROM devices WHERE id = ?").run(id),
    touch: (id, at) => db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(at, id),
  };
}
