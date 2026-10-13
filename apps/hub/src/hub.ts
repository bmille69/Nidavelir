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
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
