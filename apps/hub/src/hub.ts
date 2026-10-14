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
  let closed = false;
  return {
    db,
    clock,
    journal,
    sessions: new HumanSessions(),
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
    quality: new QualityService({ db, clock, journal, projects, tasks }),
    conceptions: new ConceptionService({ db, clock, journal, projects, tasks, conversations, vision, vcs, orchestrator, web: options.conceptWeb ?? true }),
    close: () => {
      if (closed) return;
      closed = true;
      void previews.stopAll();
      autopilot?.close();
      db.close();
    },
  };
}
