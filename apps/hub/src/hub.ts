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
import { dirname } from "node:path";
import { ExtractionService } from "./vision/extraction.ts";
import { SynthesisService } from "./vision/synthesis.ts";
import { VisionService } from "./vision/vision-service.ts";
import { Autopilot, type AutopilotOptions } from "./autonomy/autopilot.ts";
import { UsageService } from "./usage/usage-service.ts";
import { PreviewService } from "./executor/preview.ts";
import { QualityService } from "./quality/quality-service.ts";
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
  autopilot: Autopilot | null;
  previews: PreviewService;
  quality: QualityService;
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
    autopilot = pilot;
  }
  const statusHook = tasks.onStatus;
  tasks.onStatus = (task) => {
    statusHook?.(task);
    skills.onTaskStatus(task);
  };
  const quality = new QualityService({ db, clock, journal, projects, tasks });
  quality.onRated = (project, task, r) => {
    // Un 👍 sans un mot n'apprend rien ; un 👎 ou un commentaire, si.
    if (r.rating === "down" || r.note) skills.learn(project, task, `Avis du directeur créatif : ${r.rating === "up" ? "👍 réussi" : "👎 pas ce qu'il voulait"}${r.note ? ` — « ${r.note} »` : ""}`);
  };
  const conceptions = new ConceptionService({ db, clock, journal, projects, tasks, conversations, vision, vcs, orchestrator, web: options.conceptWeb ?? true });
  conceptions.skills = skills;
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
    if (task.status === "review") notifications.notify({ title: "✓ Chantier prêt à essayer", body: `${task.title} — ${projectName(task.project)}`, url: at, tag: task.id });
    if (task.status === "failed") notifications.notify({ title: "✗ Chantier en échec", body: `${task.title} — ${projectName(task.project)}`, url: at, tag: task.id });
    if (task.status === "plan_review") notifications.notify({ title: "Un plan attend votre accord", body: `${task.title} — ${projectName(task.project)}`, url: at, tag: task.id });
  };
  tasks.onEscalation = (esc) =>
    notifications.notify({ title: "✋ Autorisation demandée", body: `${esc.summary} — ${projectName(esc.project)}`, url: `#/p/${esc.project}/tasks/${esc.task}`, tag: esc.id });
  conceptions.onTurn = (c) => {
    if (c.data.questions.length) notifications.notify({ title: "✦ Le Concepteur attend vos réponses", body: c.title, url: `#/c/${c.id}`, tag: c.id });
    else if (c.data.ready) notifications.notify({ title: "✦ Conception prête", body: `${c.title} : vous pouvez créer le projet`, url: `#/c/${c.id}`, tag: c.id });
  };
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
    autopilot,
    previews,
    quality,
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
