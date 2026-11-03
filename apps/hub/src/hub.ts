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
import { CaptureStore } from "./conversation/captures.ts";
import type { GodotInstall } from "./godot/toolchain.ts";
import { TaskService } from "./executor/task-service.ts";
import { Foreman } from "./executor/foreman.ts";
import { codeContext } from "./projects/code-context.ts";
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
import { RealGoogleImages, RoutedImageGen, type GoogleImagesPort } from "./art/google-images.ts";
import type { WebRefsPort } from "./art/web-refs.ts";
import { readManifest } from "./art/manifest.ts";
import { ExpressService } from "./express/express-service.ts";
import { ModService } from "./mods/mod-service.ts";
import type { SteamGame } from "./mods/steam.ts";
import { RealToolchain, type ToolchainPort } from "./mods/toolchain.ts";
import { RealExpressChecker, type ExpressChecker } from "./express/checker.ts";
import { RealReverseTools, type ReverseToolsPort } from "./reverse/tools.ts";
import type { Exec, Opener } from "./reverse/playable.ts";
import { RealPublicData, type PublicDataPort } from "./reverse/public-data.ts";
import { PreviewService } from "./executor/preview.ts";
import { QualityService } from "./quality/quality-service.ts";
import { CheckService, checksForTester, type CheckerPort } from "./quality/checks.ts";
import { ReplayService } from "./quality/replays.ts";
import { BalanceService } from "./quality/balance.ts";
import { BenchService } from "./quality/bench.ts";
import { FeelService } from "./quality/feel.ts";
import { LogbookService } from "./journal/logbook.ts";
import { ExportService } from "./godot/export-service.ts";
import { ElevenLabs, type SoundGenPort } from "./sound/elevenlabs.ts";
import { SoundService } from "./sound/sound-service.ts";
import { ProductionService } from "./production/production-service.ts";
import { GameStateService } from "./autonomy/game-state.ts";
import { ConceptionService } from "./conception/conception-service.ts";
import { PlaytestService, type PlayDriver } from "./quality/playtest.ts";
import { SkillService, type SkillAgent, type SkillAutomation } from "./skills/skill-service.ts";
import { SkillLab, type LabOptions } from "./skills/lab.ts";
import { StudioMemory } from "./team/studio-memory.ts";
import { TeamService } from "./team/team-service.ts";
import { teamBriefings } from "./team/briefings.ts";
import { IdeaService } from "./ideas/idea-service.ts";
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
  /** Développeurs et testeurs au travail en même temps, tous jeux confondus (réservoir d'agents ; défaut STUDIO_MAX_AGENTS, sinon 3). */
  maxAgents?: number;
  /** Chantiers en même temps sur un même jeu, avec le chef de chantier (ADR-104) ; 1 par défaut (un seul à la fois). */
  parallel?: number;
  /** Contrôles du hub (tests, lancement, bout en bout) en même temps, tous jeux confondus (ADR-130) ; 1 par défaut. */
  heavyChecks?: number;
  /** Pilote automatique (ADR-20). Absent : le directeur ne décide jamais seul. */
  autopilot?: AutopilotOptions;
  /**
   * Plans de production (ADR-107). `false` (STUDIO_PRODUCTION=0) : aucun plan, le directeur n'en propose pas.
   * `tickMs` : passage de sécurité régulier sur les plans en cours (aucun par défaut).
   */
  production?: { tickMs?: number } | false;
  /** Appel minimal à Claude Code pour rafraîchir vos limites d'abonnement (ADR-21). */
  usageProbe?: () => Promise<void>;
  /**
   * Compétences tenues toutes seules (ADR-97) : procédures apprises des chantiers difficiles, import de
   * la bibliothèque d'Hermes. Absent : ni l'un ni l'autre (les tests l'activent au cas par cas).
   */
  skills?: SkillAutomation;
  /** Laboratoire des compétences (ADR-102) : essais, catalogue public, besoins. Actif seulement avec `skills.learn`. */
  skillLab?: Partial<LabOptions>;
  /** Port du hub : nécessaire pour publier le hub dans Tailscale (ADR-30). */
  remotePort?: number;
  tailscaleRunner?: Runner;
  pushSubject?: string;
  pushFetch?: typeof fetch;
  /** Le Concepteur peut chercher sur le web (lecture seule). Défaut : oui (choix du 14/10). */
  conceptWeb?: boolean;
  /** Vérifications du hub avant fusion : tests du jeu et lancement (ADR-32). Absent : aucune. */
  checker?: CheckerPort;
  /** Le Godot du PC (ADR-73) : « ▶ Essayer », le socle des nouveaux projets Godot. */
  godot?: () => GodotInstall | null;
  /** La manette du testeur : il joue au jeu du chantier dans un navigateur invisible (ADR-69). Absente : il ne joue pas. */
  playDriver?: PlayDriver;
  /** Modèle par défaut de chaque agent, tant que vous n'en choisissez pas un dans le studio (ADR-37). */
  models?: Partial<Record<ModelRole, string | undefined>>;
  /** Outils de l'Atelier de démontage (ADR-40). Défaut : les vrais, téléchargés à votre demande. */
  reverseTools?: ReverseToolsPort;
  /** Comment l'Atelier lance Godot et dotnet pour vérifier qu'un projet démonté démarre (ADR-120). Défaut : les vrais. */
  reverseExec?: Exec;
  /** Comment l'Atelier ouvre Godot en fenêtre (« Ouvrir dans Godot », « Jouer », ADR-127). Défaut : le vrai, détaché. */
  reverseOpen?: Opener;
  /** Données publiques de l'Atelier (CommunityDragon, ADR-95). Défaut : la vraie archive en ligne, lue sur votre clic. */
  publicData?: PublicDataPort;
  /** Générateur d'images local du Directeur artistique (ADR-46). Défaut : ComfyUI + Flux, installé à votre demande. */
  imagegen?: ImageGenPort;
  /** Atelier 3D du Directeur artistique : Tripo et Blender (ADR-47). Défaut : les vrais, sur votre clic et votre clé. */
  model3d?: Model3DPort;
  /** Google Gemini, générateur d'images payant devant le générateur local (ADR-110). Défaut : le vrai, sur votre clé. */
  google?: GoogleImagesPort;
  /** Générateur de sons du directeur sonore (ElevenLabs par défaut, ADR-91). */
  soundGen?: SoundGenPort;
  /** Téléchargement des références web du Directeur artistique (ADR-58). Défaut : le vrai, adresses publiques seulement. */
  webRefs?: WebRefsPort;
  /** Test du Jeu express dans un navigateur (ADR-44). Défaut : le vrai si les vérifications sont actives, sinon aucun test. */
  expressChecker?: ExpressChecker;
  /** Studio de modding (ADR-65) : l'outillage (.NET, chargeur de mods) et les jeux Steam ; des faux dans les tests. */
  modToolchain?: ToolchainPort;
  steamGames?: () => SteamGame[];
  /** L'équipe (ADR-98) : les agents se consultent, proposent des souvenirs, lisent le jeu. Défaut : oui (STUDIO_TEAM=0 l'éteint). */
  team?: boolean;
  /** Contre-expertise de la consigne du Directeur avant un chantier (ADR-125). Défaut : non ; main.ts l'active (STUDIO_RELECTEUR=0 l'éteint). */
  review?: boolean;
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
  /** Les captures annotées jointes aux discussions (ADR-72). */
  captures: CaptureStore;
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
  /** Vos parties enregistrées, et celles gardées comme tests (ADR-85). */
  replays: ReplayService;
  /** L'équilibreur : des centaines de parties simulées sans écran (ADR-86). */
  balance: BalanceService;
  /** Le banc d'essai des agents (ADR-87). */
  bench: BenchService;
  /** La passe « game feel » à la demande (ADR-88). */
  feel: FeelService;
  /** Le journal de bord : les fusions en images, semaine par semaine (ADR-89). */
  logbook: LogbookService;
  /** L'export local des jeux Godot (ADR-90). */
  exports: ExportService;
  /** Le directeur sonore (ADR-91). */
  sound: SoundService;
  gameState: GameStateService;
  conceptions: ConceptionService;
  skills: SkillService;
  skillLab: SkillLab;
  /** La mémoire du studio (ADR-99). */
  memory: StudioMemory;
  /** L'équipe : consultations entre agents et outils servis par le hub (ADR-98). */
  team: TeamService;
  /** L'Atelier d'idées (ADR-100). */
  ideas: IdeaService;
  /** Les plans de production (ADR-107) ; null si désactivés. */
  productions: ProductionService | null;
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
      maxAgents: options.maxAgents,
      parallel: options.parallel,
    },
  });
  // Le chef de chantier (ADR-104) : plusieurs chantiers sur un même jeu quand leurs fichiers ne se croisent pas.
  tasks.foreman = new Foreman({ orchestrator, code: async (project) => codeContext(projects.get(project).root) });
  const usage = new UsageService(db, clock, options.usageProbe);
  const models = new ModelService(db, journal, options.models);
  // Compétences (ADR-29) : données aux agents, et leçons apprises de vos avis et corrections.
  const skills = new SkillService({ db, clock, journal, projects, orchestrator, dataDir: options.dataDir ?? dirname(options.databasePath), auto: options.skills });
  skills.attach(tasks);
  tasks.skills = skills;
  // La mémoire du studio (ADR-99) : ce que vous avez appris à l'équipe, en tête des consignes de chaque agent.
  const memory = new StudioMemory({ db, clock, journal });
  const remembered = {
    promptFor: (agent: SkillAgent, project: string | null) => {
      const s = skills.promptFor(agent, project);
      return { text: [memory.block(), s.text].filter(Boolean).join("\n\n"), dir: s.dir };
    },
  };
  tasks.studioMemory = () => memory.block();
  conversations.skills = remembered;
  // L'équipe (ADR-98) : outils servis par le hub, actifs une fois le serveur démarré (team.baseUrl).
  const team = new TeamService({ db, clock, journal, orchestrator, memory });
  team.enabled = options.team ?? true;
  team.gameRoot = (project) => {
    try {
      return projects.get(project).root;
    } catch {
      return null;
    }
  };
  conversations.team = team;
  const previews = new PreviewService({ workDir: options.dataDir ?? dirname(options.databasePath), godot: options.godot });
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
    tasks.onScheduled = (task, event) => pilot.onScheduled(task, event);
    tasks.onQueueEmpty = (project) => pilot.onQueueEmpty(project);
    conversations.workshopState = (project) => pilot.workshopState(project);
    if (options.review) pilot.reviewer = orchestrator;
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
  const checks = options.checker ? new CheckService({ db, clock, journal, projects, checker: options.checker, shotsDir: join(dataDir, "shots"), heavyLimit: options.heavyChecks }) : null;
  if (autopilot) autopilot.checks = checks;
  const replays = new ReplayService({ dataDir, projects, vcs, journal, clock, godot: options.godot ?? (() => null) });
  const balance = new BalanceService({ db, clock, journal, projects, vcs, conversations, godot: options.godot ?? (() => null) });
  const bench = new BenchService({ db, clock, journal, projects, tasks, checker: options.checker ?? null });
  // Laboratoire des compétences (ADR-102) : besoins, catalogue public, quarantaine, essais, mesure, ménage.
  const skillLab = new SkillLab({ db, clock, journal, projects, tasks, skills, orchestrator, options: options.skillLab });
  skillLab.bench = bench;
  skillLab.usage = usage;
  const labHook = tasks.onStatus;
  tasks.onStatus = (task) => {
    labHook?.(task);
    skillLab.onTaskStatus(task);
  };
  const feel = new FeelService({ projects, tasks, conversations, journal });
  const logbook = new LogbookService({ db, clock, journal, projects, tasks, checks, orchestrator, dataDir });
  const exports = new ExportService({ projects, vcs, journal, clock, godot: options.godot ?? (() => null) });
  if (checks) {
    // Entre le développeur et le testeur : tests, lancement et capture du jeu (ADR-32, ADR-33).
    tasks.beforeVerify = async (task) => {
      if (!task.worktree) return null;
      const r = await checks.run(task.project, task.id, task.worktree);
      return { summary: checksForTester(r), screenshot: r.launch.screenshot ?? null, ...(r.poses?.length ? { poses: r.poses } : {}) };
    };
  }
  // Le testeur joue au jeu de la copie avant de donner son avis (ADR-69) ; captures rangées avec celles du hub.
  const playtest = options.playDriver ? new PlaytestService({ driver: options.playDriver, shotsDir: join(dataDir, "shots"), journal }) : null;
  tasks.playtest = playtest;
  const quality = new QualityService({ db, clock, journal, projects, tasks, vcs, checks });
  quality.onRated = (project, task, r) => {
    // Un 👍 sans un mot n'apprend rien ; un 👎 ou un commentaire, si.
    if (r.rating === "down" || r.note) skills.learn(project, task, `Avis du directeur créatif : ${r.rating === "up" ? "👍 réussi" : "👎 pas ce qu'il voulait"}${r.note ? ` — « ${r.note} »` : ""}`);
  };
  const conceptions = new ConceptionService({ db, clock, journal, projects, tasks, conversations, vision, vcs, orchestrator, web: options.conceptWeb ?? true });
  conceptions.skills = remembered;
  conceptions.team = team;
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
    publicData: options.publicData ?? new RealPublicData(),
    orchestrator,
    conversations,
    projects,
    vcs,
    dataDir,
    exec: options.reverseExec,
    open: options.reverseOpen,
  });
  // Le Directeur artistique (ADR-43) : un asset passe « intégré » quand son chantier est fusionné.
  // Google dessine d'abord s'il a une clé (ADR-110) ; sinon, et s'il se dérobe, le générateur local, comme avant.
  const google = options.google ?? new RealGoogleImages(dataDir);
  const imagegen = new RoutedImageGen(options.imagegen ?? new ComfyImageGen(dataDir), google);
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
    google,
    webRefs: options.webRefs,
    // La capture prise par les vérifications avant la fusion sert à juger le visuel dans le jeu (ADR-48).
    screenshot: (project, task) => checks?.screenshotPath(project, task) ?? null,
    // La scène vitrine du jeu, photographiée sur le jeu lui-même après la fusion (ADR-49).
    // Les fichiers qu'il charge alors servent au bilan des visuels (ADR-71).
    vitrine: async (project, id, file) => {
      if (!options.checker) return null;
      const r = await options.checker.launch(`${project}/vitrine-${id}`, projects.get(project).root, file, `?vitrine=${id}`);
      return r.status === "none" ? null : { shot: r.screenshot ?? null, loaded: r.loaded ?? null };
    },
  });
  // Le Concepteur confie les visuels de ses conceptions au Directeur artistique, et sait ce qui existe déjà (ADR-59).
  conceptions.art = art;
  // Le journal de bord montre les visuels intégrés avec leur image (ADR-89).
  logbook.asset = (project, id) => {
    const a = art.state(project).assets.find((x) => x.id === id);
    return a ? { name: a.name, image: a.model?.renders[0] ?? a.renders.at(-1) ?? null } : null;
  };
  // Le Godot du PC guide le Concepteur et sert au socle des nouveaux jeux Godot (ADR-73).
  conceptions.godot = options.godot ?? null;
  // Un visuel validé attend que son chantier ait posé sa place dans le jeu (ADR-60).
  art.tasks = tasks;
  // La file des visuels attend, comme celle des chantiers, quand la jauge d'abonnement est presque pleine (ADR-62).
  art.paused = () => tasks.limitPaused();
  // Un atelier 3D réglé sous un autre modèle que Fable a une passe de plus ; Fable y vient en renfort pour un personnage animé (ADR-62, ADR-67).
  art.workshopModel = () => models.get("art_workshop");
  art.skills = remembered;
  art.team = team;
  conceptions.artState = (project) => {
    const assets = readManifest(projects.get(project).root).assets;
    return assets.length ? assets.slice(-40).map((a) => `- ${a.id} ${a.name} (${a.type}) : ${a.status}`).join("\n") : null;
  };
  const artHook = tasks.onStatus;
  tasks.onStatus = (task) => {
    artHook?.(task);
    art.onTaskStatus(task);
  };
  // Le directeur sonore (ADR-91) : après la fusion du chantier qui branche des sons, le hub vérifie qu'ils sont joués.
  const sound = new SoundService({ projects, tasks, conversations, orchestrator, vcs, journal, clock, gen: options.soundGen ?? new ElevenLabs(dataDir), dataDir });
  sound.memory = () => memory.block();
  // Ce que chaque agent sait quand un collègue le consulte (ADR-98).
  team.briefings = teamBriefings({ projects, vision, conceptions, tasks, sound, gameState, autopilot });
  // L'Atelier d'idées (ADR-100) : avant les projets ; « En faire un projet » ouvre une conception.
  const ideas = new IdeaService({ db, clock, journal, orchestrator, web: options.conceptWeb ?? true });
  ideas.conceptions = conceptions;
  ideas.skills = remembered;
  ideas.team = team;
  memory.onProposed = (m) => notifications.notify({ title: "🧠 Un souvenir proposé pour la mémoire du studio", body: m.text, url: "#/memoire", tag: `memory-${m.id}` });
  const soundHook = tasks.onStatus;
  tasks.onStatus = (task) => {
    soundHook?.(task);
    sound.onTaskStatus(task);
  };
  // Les plans de production (ADR-107) : chantiers, visuels et sons enchaînés par les circuits existants, puis une
  // vérification d'ensemble. Branché après le DA et le son : leurs manifestes sont à jour quand le plan les lit.
  let productions: ProductionService | null = null;
  if (options.production !== false) {
    const prod = new ProductionService({ db, clock, journal, projects, tasks, conversations, orchestrator, vcs });
    prod.art = art;
    prod.sound = sound;
    prod.skills = remembered;
    prod.gameState = (project) => gameState.get(project)?.text ?? null;
    prod.alert = (n) => notifications.notify(n);
    prod.ingameChecks = !!options.checker;
    sound.onChange = (project) => prod.advance(project);
    const prodHook = tasks.onStatus;
    tasks.onStatus = (task) => {
      prodHook?.(task);
      prod.onTaskStatus(task);
    };
    if (autopilot) {
      const pilot = autopilot;
      pilot.productions = prod;
      prod.onLaunched = (project, ids) => pilot.adopt(project, ids);
      // Le directeur, en atelier, connaît la règle et les plans du jeu (pas le Concepteur, qui lit aussi workshopState).
      conversations.workshopState = (project) => [pilot.workshopState(project), prod.directorContext(project)].filter(Boolean).join("\n");
    }
    prod.recover();
    if (options.production?.tickMs) prod.startTicking(options.production.tickMs);
    productions = prod;
  }
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
    captures: new CaptureStore({ projects, vcs, clock }),
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
    replays,
    balance,
    bench,
    feel,
    logbook,
    exports,
    sound,
    quality,
    checks,
    gameState,
    conceptions,
    skills,
    skillLab,
    memory,
    team,
    ideas,
    productions,
    notifications,
    remote,
    extraHosts,
    close: () => {
      if (closed) return;
      closed = true;
      void previews.stopAll();
      void playtest?.stopAll();
      autopilot?.close();
      productions?.close();
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
