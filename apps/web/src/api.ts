import type { Escalation, ItemFrontmatter, Message, Plan, Run, Task, Thread, VerificationOutput, ExecutionReportOutput } from "@studio/contracts";

export type { ItemFrontmatter as Item, Message, Thread, Task, Plan, Escalation };
export type Rating = { rating: "up" | "down"; note: string | null; at: string };
/** queue_rank, restarted_from et visuals : la chaîne de production (ADR-64). */
export type TaskRow = Task & {
  pending_escalations: number;
  cost_usd: number;
  rating: Rating | null;
  queue_rank?: number | null;
  restarted_from?: string | null;
  visuals?: { id: string; name: string; status: AssetStatus; launched: boolean }[];
  /** Avancement estimé par le hub, sans appel à un modèle (pilotage) : absent pour un chantier fini ou en file. */
  progress?: { pct: number; phase: "plan" | "execute" | "checks" | "verify" | "merge"; label: string } | null;
};
/** Le studio de modding (ADR-65). */
export type ModToolchain = {
  dotnet: { installed: boolean; version: string | null };
  loader: { installed: boolean; version: string | null; generated: boolean; installing: boolean; error: string | null };
  typemap: { ready: boolean; types: number | null; building: boolean; error: string | null };
};
export type ModGame = {
  appid: string;
  name: string;
  dir: string;
  buildid: string;
  recipe: { id: string; name: string; warnings: string[]; loader: { name: string; version: string; size: string; firstRun: string } } | null;
  protection: string | null;
  toolchain: ModToolchain | null;
};
export type ModPlan = { title: string; summary: string; kind: "regles" | "confort" | "apparence"; changes: string[]; settings: { name: string; default: string; description: string }[]; questions: string[]; risks: string[]; visuals?: { file: string; description: string; size: number }[] };
export type ModStatus = "planning" | "waiting" | "running" | "ready" | "failed" | "cancelled";
export type Mod = {
  id: string;
  recipe: string;
  appid: string;
  game: string;
  game_dir: string;
  name: string;
  title: string;
  idea: string;
  status: ModStatus;
  phase: string;
  root: string;
  plan: ModPlan | null;
  report: { summary: string; how_to_test: string; settings: string[]; known_issues: string[] } | null;
  game_build: string | null;
  outdated: boolean;
  installed: { files: { path: string; sha256: string }[]; at: string; build: string } | null;
  assets?: string[];
  played: { found: boolean; loaded: boolean; lines: string[]; errors: string[]; gameVersion: string | null; at: string } | null;
  error: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  events: { seq: number; at: string; kind: "phase" | "tool" | "text" | "info" | "error"; text: string }[];
};
/** Le moniteur du studio (ADR-64). */
export type Monitor = {
  at: string;
  queues: { project: string; name: string; running: { id: string; title: string; status: string } | null; alongside: { id: string; title: string; status: string }[]; next: { id: string; title: string } | null; queued: number; paused: { until: string; window: string } | null }[];
  machine: { cpu: number | null; ram: { used: number; total: number }; gpu: { name: string; load: number; memUsed: number; memTotal: number } | null };
  tokens: { buckets: { at: string; tokens: number; costUsd: number }[]; last15: { tokens: number; costUsd: number; calls: number }; hour: { tokens: number; costUsd: number; calls: number } };
};
export type QualityStats = {
  launched: number;
  merged: number;
  first_try: number;
  abandoned: number;
  in_progress: number;
  success_rate: number | null;
  first_try_rate: number | null;
  cost_usd: number;
  cost_per_merged: number | null;
  median_agent_minutes: number | null;
  interventions_per_chantier: number | null;
  qa_fail_rate: number | null;
  up: number;
  down: number;
  held: number;
  reworked: number;
  tests_checked: number;
  tests_ok: number;
  launch_checked: number;
  launch_ok: number;
  tester_judged: number;
  tester_right: number;
  tester_rate: number | null;
};
export type ChantierRow = {
  project: string;
  id: string;
  title: string;
  status: string;
  created_at: string;
  merged_at: string | null;
  first_try: boolean;
  corrections: number;
  interventions: number;
  cost_usd: number;
  agent_minutes: number;
  qa: "pass" | "pass_with_notes" | "fail" | null;
  rating: Rating | null;
  held: boolean;
  reworked_by: string[];
  reverted: boolean;
  checks: { tests: CheckStatus; launch: CheckStatus; regression: boolean } | null;
  tester_missed: boolean;
};
export type CheckStatus = "pass" | "fail" | "none";
export type QualityReport = { overall: QualityStats; weeks: (QualityStats & { week: string; label: string })[]; chantiers: ChantierRow[] };
export type RunInfo = Run & { result: { report?: ExecutionReportOutput; verification?: VerificationOutput; text?: string } | null };
export type TaskDetail = { task: Task; plan: Plan | null; runs: RunInfo[]; escalations: Escalation[]; decisions: ItemFrontmatter[]; executor: string };
export type RunEvent = { seq: number; at: string; type: "text" | "tool" | "result" | "info" | "error"; text: string };

/** La Forge (ADR-106) : établis, file et fusions d'un jeu, pour la vue en voxels (apps/hub/src/studio/forge.ts). */
export type ForgePhase = "starting" | "plan" | "plan_review" | "execute" | "checks" | "verify" | "review" | "changes";
export type ForgeBench = {
  task: { id: string; title: string; status: Task["status"] };
  phase: ForgePhase;
  run: { id: string; kind: "plan" | "execute" | "verify"; started_at: string; last: { at: string; type: string; text: string } | null } | null;
  note: string | null;
  files: string[];
  since: string;
};
export type ForgeSnapshot = {
  at: string;
  project: { slug: string; name: string; autonomy: string };
  parallel: number;
  pool: { busy: number; waiting: number; max: number };
  benches: ForgeBench[];
  queue: { id: string; title: string; scoped: boolean; waiting: string }[];
  scouting: boolean;
  escalations: { id: string; task: string; summary: string }[];
  merged: { id: string; title: string; at: string }[];
  today: { merged: number; failed: number };
  paused: { until: string; window: string } | null;
};
export type Review = {
  task: Task;
  plan: Plan | null;
  head: string | null;
  files: { status: string; path: string; planned: boolean }[];
  patch: string;
  report: ExecutionReportOutput | null;
  verification: VerificationOutput | null;
  escalations: Escalation[];
};

export type Autonomy = "workshop" | "supervised" | "balanced" | "autonomous";
export type Project = { slug: string; name: string; root: string; engine: "godot" | "web" | "unknown"; created_at: string; autonomy: Autonomy };
export type UsageSnapshot = {
  limits: { at: string; status: string; windows: Partial<Record<"five_hour" | "seven_day", { utilization: number; resetsAt: string }>> } | null;
  today: { tokens: number; calls: number; costUsd: number };
  week: { tokens: number; calls: number; costUsd: number };
  byAgent: { agent: string; tokens: number; calls: number }[];
  agents: Record<string, AgentUsage>;
};
export type AgentUsage = { today: { tokens: number; calls: number }; week: { tokens: number; calls: number; costUsd: number }; models: Record<string, number> };
export type ModelRole = "concepteur" | "director" | "art_director" | "archivist" | "developer" | "developer_big" | "qa" | "archeologue" | "art_workshop";
export type ExpressMode = "eclair" | "soigne";
export type ExpressPhase = "idee" | "code" | "test" | "correction" | "finition" | "amelioration" | "pret";
export type ExpressConcept = { title: string; pitch: string; dimension: "2d" | "3d"; genre: string; controls: string[]; loop: string; goal: string; style: string; features: string[]; juice: string[] };
export type ExpressEvent = { seq: number; at: string; kind: "phase" | "tool" | "text" | "info" | "error"; text: string };
export type ExpressGame = {
  id: string;
  slug: string;
  title: string;
  idea: string;
  mode: ExpressMode;
  status: "running" | "ready" | "failed" | "cancelled";
  phase: ExpressPhase;
  root: string;
  concept: ExpressConcept | null;
  summary: string | null;
  how_to_play: string | null;
  error: string | null;
  project: string | null;
  version: number;
  shot: boolean;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  events: ExpressEvent[];
};
export type AssetStatus = "propose" | "production" | "a_valider" | "valide" | "integration" | "integre" | "ecarte";
export type ArtVerdict = { ok: boolean; summary: string; points: string[]; prompt: string | null; file: string; by: "validator" | "human"; at: string };
export type ArtAsset = { id: string; name: string; type: string; usage: string; specs: string; status: AssetStatus; prompts: string[]; refs: string[]; format?: string | null; model3d?: ArtModelSpec | null; model?: ArtModel | null; ingame?: ArtInGame | null; waitsFor?: string | null; launchedAt?: string | null; sketches?: ArtSketch[] | null; direction?: ArtSketch | null; renders: string[]; verdict: ArtVerdict | null; created_at: string; updated_at: string };
export type ArtMessage = { id: string; project: string; seq: number; role: "human" | "art"; text: string; at: string; cost_usd: number | null };
export type ArtModelSpec = { size: number; tris: number; rig: boolean; animations: string[]; simple?: boolean };
export type ArtSketch = { file: string; label: string; prompt: string };
export type ArtModel = { file: string; source: string | null; views?: string[]; renders: string[]; bandes?: string[]; tris: number; dims: number[]; animations: string[]; workshop?: string | null; rigType?: string | null; missingAnimations?: string[]; verdict: ArtVerdict | null };
export type ArtInGame = { task: string; file: string; visible: boolean; ok: boolean; summary: string; points: string[]; retried: boolean; at: string };
export type Art3D = {
  blender: { installed: boolean; installing: { step: string; progress: number } | null; error: string | null; size: string };
  tripo: { configured: boolean; month: string; credits: number; cap: number };
};
/** Google Gemini (ADR-110) : la clé n'est jamais renvoyée, seulement si elle est configurée ; dépense du mois en dollars. */
export type ArtGoogle = { configured: boolean; month: string; usd: number; cap: number };
export type ArtStage = "croquis" | "image" | "planche" | "tripo" | "atelier" | "controle";
export type ArtGenerating = {
  asset: string;
  round: number;
  rounds: number;
  step: string;
  stage?: ArtStage;
  note?: string | null;
  preview?: { kind: "art" | "atelier"; file: string } | null;
};
export type ArtGenerator = {
  installed: boolean;
  installing: { step: string; progress: number } | null;
  error: string | null;
  size: string;
  kontext?: { installed: boolean; installing: { step: string; progress: number } | null; error: string | null; size: string };
};
/** Le bilan des visuels (ADR-71) : chaque visuel donné pour intégré, face aux fichiers du jeu et à ce qu'il charge. */
export type BilanLevel = "verifie" | "a_retoucher" | "charge" | "non_prouve" | "pas_charge" | "ancienne_version" | "absent" | "source_absente" | "en_cours" | "aspect_change";
export type BilanRow = {
  id: string;
  name: string;
  type: string;
  level: BilanLevel;
  problem: boolean;
  text: string;
  source: string | null;
  copies: string[];
  stale: string[];
  thumb: string | null;
  proofAt: string | null;
  /** L'aspect a changé dans le jeu (ADR-84). */
  look?: { ref: string; file: string; changed: number; where: string | null; tasks: string[] } | null;
};
type Progress = { done: number; total: number; current: string | null };
export type Bilan = { rows: BilanRow[]; checking: Progress | null; looking?: Progress | null };

export type ArtState = {
  bible: string | null;
  assets: ArtAsset[];
  moodboard: { file: string; note: string | null }[];
  messages: ArtMessage[];
  direction: ArtDirectionData;
  busy: { replying: boolean; validating: string[]; generating: ArtGenerating[]; exploring?: string[] };
  /** La file des visuels (ADR-62), dans l'ordre où les chantiers les attendent. */
  queue?: { id: string; need: { id: string; title: string } | null }[];
  generator: ArtGenerator;
  workshop3d: Art3D;
  google?: ArtGoogle | null;
  /** Ce que chaque visuel a coûté et son plafond (ADR-82). */
  spend?: Record<string, ArtSpend>;
};
/** Le directeur sonore (ADR-91). */
export type Sound = {
  id: string;
  name: string;
  kind: "effet" | "musique" | "ambiance" | "interface";
  usage: string;
  prompt: string;
  seconds: number | null;
  loop: boolean;
  status: "propose" | "a_choisir" | "choisi" | "en_integration" | "integre" | "non_branche";
  takes: { file: string; at: string; bytes: number; credits: number | null }[];
  chosen: string | null;
  path: string | null;
  task: string | null;
  note: string | null;
};
export type SoundState = {
  configured: boolean;
  credits: { used: number; limit: number; tier: string; resetsAt: string | null } | null;
  sounds: Sound[];
  busy: { proposing: boolean; generating: string[] };
  error: string | null;
};
/** Le plan de production (ADR-107) : un objectif, tous les métiers enchaînés. */
export type ProductionStepState = "todo" | "active" | "you" | "done" | "failed" | "skipped";
export type ProductionStep = {
  key: string;
  kind: "chantier" | "visuel" | "son" | "sons" | "verification";
  label: string;
  ref: string | null;
  state: ProductionStepState;
  detail: string;
  href: string | null;
  skippable: boolean;
};
export type Production = {
  id: string;
  project: string;
  thread: string;
  title: string;
  status: "preparing" | "proposed" | "running" | "paused" | "done" | "cancelled";
  auto: boolean;
  brief: string;
  plan: {
    titre: string;
    objectif: string;
    criteres: string[];
    visuels: { cle: string; nom: string; type: string; usage: string; specs: string }[];
    sons: { nom: string; usage: string }[];
    chantiers: { cle: string; titre: string; consigne: string; visuels: string[]; sons: string[] }[];
    note: string;
  } | null;
  refs: { dossier: string | null; tasks: Record<string, string>; soundTask: string | null; final: string | null; replacedBy: string | null; started_at: string | null; finished_at: string | null };
  note: string | null;
  steps: ProductionStep[];
  waiting: { text: string; href: string; own?: boolean }[];
  spent: number;
  created_at: string;
  updated_at: string;
};
/** L'export local des jeux Godot (ADR-90). */
export type GameBuild = { id: string; exe: string; bytes: number; at: string; commit: string | null; seconds: number; smoke: { ok: boolean; detail: string } };
export type ExportState = {
  available: boolean;
  godot: string | null;
  templates: boolean;
  templatesDir: string | null;
  installing: { step: string; progress: number } | null;
  running: boolean;
  error: string | null;
  builds: GameBuild[];
};
/** Le journal de bord (ADR-89). */
export type LogWeek = {
  week: string;
  from: string;
  to: string;
  previous: string | null;
  next: string | null;
  entries: { task: string; title: string; at: string; summary: string; costUsd: number; checks: string; shot: boolean }[];
  visuals: { id: string; name: string; image: string | null; task: string | null; at: string }[];
  facts: { merged: number; failed: number; costUsd: number; visuals: number; balanceRuns: number; benchRuns: number; replaysSaved: number };
  gif: boolean;
  story: { text: string; at: string } | null;
};
/** Le banc d'essai des agents (ADR-87). */
export type BenchCase = { id: string; source: string; title: string; goal: string; base: string; original: { costUsd: number | null; seconds: number | null; files: number | null }; created_at: string };
export type BenchResult = {
  case: string;
  ok: boolean;
  outcome: string;
  summary: string;
  error: string | null;
  tests: string | null;
  launch: string | null;
  replays: string | null;
  costUsd: number | null;
  tokens: number | null;
  model: string | null;
  seconds: number;
  files: number;
};
export type BenchRun = { id: number; at: string; fingerprint: string; status: "running" | "done"; results: BenchResult[] };
export type BenchState = { cases: BenchCase[]; runs: BenchRun[]; fingerprint: string; executor: string; stale: boolean; running: boolean; candidates: { id: string; title: string }[] };
/** L'équilibreur (ADR-86) : des centaines de parties simulées sans écran. */
export type MetricStats =
  | { kind: "number"; n: number; mean: number; min: number; max: number; p10: number; p50: number; p90: number; histogram: { from: number; to: number; count: number }[] }
  | { kind: "bool"; n: number; rate: number }
  | { kind: "text"; n: number; top: { value: string; count: number }[] };
export type SimSummary = { name: string; runs: number; seconds: number; seed: number; metrics: Record<string, MetricStats>; error?: string };
export type SimRun = { id: number; at: string; commit: string | null; runs: number; status: "running" | "done" | "failed"; sims: SimSummary[]; error: string | null };
export type BalanceState = { available: boolean; hasSims: boolean; running: boolean; latest: SimRun | null; previous: SimRun | null; history: { id: number; at: string; commit: string | null; status: string }[] };
/** Vos parties enregistrées en essayant un jeu Godot, et celles gardées comme tests (ADR-85). */
export type Recording = { id: string; task: string | null; at: string; seconds: number; inputs: number; checkpoints: number; finalState: string | null };
export type SavedReplay = { file: string; name: string; note: string; seconds: number; inputs: number; saved_at: string | null };
/** Mesure par passage et essai Caveman (ADR-92) : chiffres réels de Claude Code, chemin par chemin. */
export type RouteStats = {
  route: "direct" | "caveman";
  chantiers: number;
  tokensMedian: number | null;
  freshMedian: number | null;
  costMedian: number | null;
  executeRunsMean: number | null;
  verifyRunsMean: number | null;
  runs: number;
  failedRuns: number;
};
export type RouteReport = {
  caveman: { mode: "off" | "record" | "compress"; share: number; url: string; installed: boolean; running: boolean; lastError: string | null } | null;
  measuredSince: string | null;
  routes: RouteStats[];
};
export type ArtSpend = { usd: number; credits: number; capUsd: number; capCredits: number; over: boolean };
/** La direction visuelle (ADR-58) : studio/art/direction.json. */
export type ArtTaste = "aime" | "evite";
export type ArtReference = { file: string; board: string; theme: string; source: string; title: string; why: string; verdict: ArtTaste | null; at: string };
export type ArtDirectionData = {
  choices: { question: string; answer: string; image: string | null; at: string }[];
  boards: { id: string; theme: string; at: string; failed: { url: string; reason: string }[] }[];
  references: ArtReference[];
  duels: { id: string; subject: string; options: { label: string; prompt: string; file: string }[]; chosen: number | null; at: string }[];
  style: { duel: string; label: string; prompt: string; file: string; at: string } | null;
};
export type GameScan = {
  path: string;
  name: string;
  engine: string;
  engineLabel: string;
  evidence: string[];
  pck: string | null;
  assembly: string | null;
  protection: string | null;
  recoverable: string;
  moddable: string | null;
  tool: string | null;
  incomplete?: string | null;
  public?: { source: string; patch: string } | null;
  /** Quels outils, dans quel ordre, et pourquoi (ADR-126). Absent des fiches démontées avant cette décision. */
  plan?: { id: string; role: "obligatoire" | "conseillé" | "dernier recours"; why: string }[];
};
export type Dissection = {
  id: string;
  name: string;
  path: string;
  status: "detected" | "blocked" | "running" | "extracted" | "failed";
  scan: GameScan;
  mode: "code" | "complet" | "fonctions" | null;
  out: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  log: string[];
  files: number | null;
  mod_project: string | null;
  updated: boolean;
  previous: boolean;
  needs: string[];
  functions: boolean;
  /** Le projet se recompile-t-il et démarre-t-il ? Mesuré par le hub (ADR-120). */
  launch: LaunchReport | null;
};
export type LaunchReport = {
  verdict: "playable" | "partiel" | "echec" | "outil";
  reason: string;
  need: { version: string | null; mono: boolean } | null;
  editor: { exe: string; version: string; mono: boolean } | null;
  rounds: { imported: boolean; built: boolean; ran: boolean; code: number | null; errors: number; note: string }[];
  repairs: { file: string; kind: string; note: string }[];
  missing: { kind: string; path: string; detail: string }[];
  seconds: number;
  at: string;
};
export type FeaturePack = { donnees: string[]; scenarios: { situation: string; attendu: string; source?: string }[]; dependances: string[]; refuses: string[] };
export type DissectionNote = {
  id: number;
  dissection: string;
  title: string;
  question: string;
  body: string;
  status: "thinking" | "done" | "failed";
  created_at: string;
  kind: "note" | "feature";
  pack: FeaturePack | null;
};
export type DissectionDetail = Dissection & { notes: DissectionNote[] };
export type PublicSource = { id: string; game: string; label: string; description: string; defaultPatch: string; patchHint: string };
export type ReverseTool = { id: string; name: string; repo: string; purpose: string; size: string; installed: boolean; version: string | null };
export type ModelSetting = { role: ModelRole; model: string; recommended: string; why: string };
export type ModelChoice = { id: string; label: string; note: string };
export type Analysis = {
  root: string;
  suggestedName: string;
  suggestedSlug: string;
  engine: Project["engine"];
  isGitRepo: boolean;
  hasStudio: boolean;
  documents: string[];
  document_natures: Record<string, "creative" | "technical">;
  problems: string[];
};
export type Suggestion = { path: string; name: string; registered: string | null; problems: string[] };
export type Job = {
  id: string;
  status: "running" | "done" | "failed";
  documents: { path: string; status: string; created: number; note?: string }[];
  created: number;
  costUsd: number;
};
export type ProposalCard = { proposal: ItemFrontmatter; hash: string; sources: ItemFrontmatter[]; supersedes: ItemFrontmatter[] };
/**
 * La boîte « À vous » d'un projet (ADR-113) : ce qui attend votre décision, trié par urgence (le Gardien d'abord),
 * avec ce qu'il faut pour trancher sur place. `url` : la page de détail ; `deadline` : passé ce moment, le hub décide seul.
 */
type InboxBase = { id: string; title: string; text: string; urgency: number; at: string | null; deadline: string | null; url: string; href: string; line: string };
export type InboxItem = InboxBase &
  (
    | { kind: "escalation"; data: { escalation: string; task: string; taskTitle: string; summary: string; reason: string; tool: string; content: string | null } }
    | { kind: "review"; data: { task: string; summary: string | null; verdict: "pass" | "pass_with_notes" | "fail" | null; tester: string | null; played: string | null; thread: string | null; updated_at: string } }
    | { kind: "task_plan"; data: { task: string; plan: string; hash: string; summary: string; problems: string[] } }
    | { kind: "proposal"; data: ProposalCard }
    | { kind: "art"; data: { what: "question" | "sketch" | "model" | "image" | "render"; asset: string | null; name: string | null; sketches: { file: string; label: string }[]; image: string | null; verdict: { ok: boolean; summary: string; points: string[] } | null } }
    | { kind: "production"; data: { plan: string; status: string; thread: string; objective: string | null; steps: number } }
    | { kind: "sound"; data: { plan: string; sound: string; name: string; usage: string; status: Sound["status"]; takes: string[]; configured: boolean } }
    | { kind: "conception"; data: { conception: string; questions: ConceptQuestion[] } }
    | { kind: "failed"; data: { task: string; error: string | null; updated_at: string } }
  );
/**
 * Le Récap des chantiers (ADR-113, apps/hub/src/studio/recap.ts) : les chiffres d'une période et les chantiers par
 * semaine. `shot` : la capture montrée, la photo « en jeu » du Testeur d'abord.
 */
export type RecapPeriod = "week" | "lastweek" | "30d";
export type RecapGroup = "merged" | "failed" | "running";
export type RecapCard = {
  id: string;
  title: string;
  status: Task["status"];
  group: RecapGroup;
  created_at: string;
  at: string;
  merged_at: string | null;
  summary: string | null;
  tech: string | null;
  how_to_test: string[];
  verdict: "pass" | "pass_with_notes" | "fail" | null;
  tester: string | null;
  played: string | null;
  unverified: string[];
  cost_usd: number;
  minutes: number;
  corrections: number;
  reworks: string[];
  reworked_by: string[];
  first_try: boolean;
  shot: "in_game" | "launch" | "play" | null;
  thread: { id: string; title: string } | null;
  error: string | null;
  queue_rank: number | null;
  queued: boolean;
  pending_escalations: number;
};
export type RecapStats = { total: number; merged: number; failed: number; running: number; cost_usd: number; minutes: number; first_try: number; first_try_pct: number | null; visuals: number };
export type RecapWeek = { week: string; from: string; to: string; merged: number; failed: number; cost_usd: number; minutes: number; tasks: RecapCard[] };
export type Recap = {
  period: RecapPeriod;
  from: string;
  to: string;
  stats: RecapStats;
  counts: Record<"all" | RecapGroup, number>;
  weeks: RecapWeek[];
  story: { week: string; text: string | null; at: string | null; gif: boolean };
};
export type SynthesisJob = {
  id: string;
  status: "running" | "done" | "failed";
  candidates: number;
  chunks: { total: number; done: number };
  proposals: string[];
  left_out: { id: string; reason: string }[];
  corrections: string[];
  error?: string;
  costUsd: number;
};
export type Lineage = { item: ItemFrontmatter; ancestors: ItemFrontmatter[]; decidedBy: ItemFrontmatter[]; supersededBy: ItemFrontmatter | null; hash: string };
export type DecideEdits = { title?: string; statement?: string; chosen_option?: string; exclude?: string[] };
export type AgentId = "you" | "concepteur" | "director" | "art_director" | "archivist" | "developer" | "qa" | "guardian";
export type AgentState = "idle" | "working" | "waiting";
export type Activity = { project: string; text: string; detail?: string; href: string; since?: string };
export type HubEvent = { seq: number; at: string; project: string | null; actor: { kind: string; role?: string }; type: string; subject: string | null; payload: Record<string, unknown> };
export type StudioSnapshot = {
  at: string;
  usage: UsageSnapshot;
  models: { roles: ModelSetting[]; choices: ModelChoice[] };
  agents: { id: AgentId; state: AgentState; activities: Activity[] }[];
  projects: { slug: string; name: string; engine: Project["engine"]; autonomy: Autonomy; delegated: number; busy: boolean; waiting: number; decisions: number; proposals: number; tasks: number }[];
  events: HubEvent[];
};
export type ConceptQuestion = { question: string; why: string; options: { label: string; detail: string }[]; recommended: string };
export type ConceptTurn = {
  reply: string;
  questions: ConceptQuestion[];
  title: string;
  engine: string;
  dossier: string;
  chantiers: { etape?: string; title: string; goal: string; visuels?: string[] }[];
  visuels?: { cle: string; nom: string; type: string; usage: string; specs: string }[];
  ready: boolean;
  claude_md: string;
  sources: { title: string; url: string }[];
};
export type Conception = {
  id: string;
  kind: "project" | "feature";
  project: string | null;
  title: string;
  status: "thinking" | "open" | "done";
  /** `missing` : sections du dossier encore vides (ADR-73) ; `godot` : le socle demandé pour un jeu Godot. */
  data: Omit<ConceptTurn, "reply"> & { error?: string; missing?: string[]; godot?: { rendu: string; dimension: string; largeur: number; hauteur: number; langage: string } | null };
  created_at: string;
  updated_at: string;
};
export type ConceptionMessage = { id: string; seq: number; role: "human" | "concepteur"; text: string; turn: ConceptTurn | null; cost_usd: number | null; at: string };
export type SkillAgent = "director" | "concepteur" | "developer" | "qa" | "art_director";
/** L'équipe (ADR-98) : qui peut consulter qui. */
export type TeamAgent = "directeur" | "concepteur" | "da" | "son" | "testeur";
export type Consultation = { id: string; project: string | null; from: TeamAgent; to: TeamAgent; question: string; answer: string; status: "ok" | "failed"; cost_usd: number | null; at: string };
/** La mémoire du studio (ADR-99). */
export type StudioMemoryEntry = { id: string; text: string; status: "active" | "proposed" | "rejected"; by: string; project: string | null; reason: string | null; created_at: string; decided_at: string | null };
/** L'Atelier d'idées (ADR-100). */
export type IdeaInsight = {
  title: string;
  pitch: string;
  synthese: string;
  pistes: string[];
  questions: string[];
  references: { titre: string; url: string | null; pourquoi: string }[];
  liees: { id: string; pourquoi: string }[];
  at: string;
  team?: string;
};
export type Idea = {
  id: string;
  title: string;
  body: string;
  status: "idee" | "projet" | "archivee";
  inspirations: { id: string; url: string | null; note: string; at: string }[];
  insight: IdeaInsight | null;
  thinking: boolean;
  error: string | null;
  conception: string | null;
  created_at: string;
  updated_at: string;
};
export type Skill = {
  id: string;
  name: string;
  description: string;
  body: string;
  agents: SkillAgent[];
  enabled: boolean;
  /** learned : apprise d'un chantier difficile ; hermes : reprise de la bibliothèque d'Hermes (ADR-97). */
  source: "starter" | "user" | "lessons" | "learned" | "hermes" | "public";
  project: string | null;
  updated_at: string;
  origin: string | null;
  files: { path: string; size: number }[];
  stats: { offered: number; used: number; last_used_at: string | null };
  has_previous: boolean;
  /** quarantine : en attente de son essai automatique ; rejected : écartée par un essai ou la mesure (ADR-102). */
  status: "active" | "quarantine" | "rejected";
  trial: { kind: "bench" | "blind" | "review"; verdict: "pass" | "fail" | "inconclusive"; summary: string; at: string } | null;
};
export type SkillStatus = {
  learn: boolean;
  hermes: { dir: string | null; last_sync: string | null; syncing: boolean; imported: number; ignored: number; failed: number };
  recent: { at: string; project: string | null; type: string; subject: string | null; payload: Record<string, unknown> }[];
  lab: {
    enabled: boolean;
    trials: { bench: number; blind: number; benchMax: number; blindMax: number };
    quarantine: number;
    untested: number;
    needs: { id: number; project: string | null; topic: string; origin: string; status: string; result: string | null; at: string }[];
    catalog: { entries: number; sources: string[]; refreshed: string | null };
    last: string | null;
    busy: boolean;
  };
};
/** `desktop` : un jeu Godot, ouvert dans sa fenêtre sur le PC (ADR-73). */
export type Preview = { key: string; project: string; task: string | null; url: string; started_at: string; desktop?: boolean };
export type SessionInfo = { csrf: string; orchestrator: string; gamesRoot: string; device: boolean };
export type RemoteStatus = { tailscale: "absent" | "stopped" | "ready"; dnsName: string | null; serving: boolean; url: string | null; message?: string; link?: string };
export type Device = { id: string; name: string; created_at: string; last_seen: string; current: boolean };

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let csrf = "";

/**
 * Envoie une modification ; si le jeton CSRF est périmé (hub relancé puis reconnecté
 * dans un autre onglet : le cookie est neuf, le jeton gardé par cette page ne l'est plus),
 * redemande le jeton de la session courante et réessaie une fois.
 */
async function withCsrf(send: () => Promise<Response>): Promise<Response> {
  const res = await send();
  if (res.status !== 403 || !res.headers.get("content-type")?.includes("json")) return res;
  const error = ((await res.clone().json()) as { error?: string } | null)?.error;
  if (error !== "Jeton CSRF invalide") return res;
  const fresh = await fetch("/api/human/session", { credentials: "same-origin" });
  if (!fresh.ok) return res;
  csrf = ((await fresh.json()) as SessionInfo).csrf;
  return send();
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const send = () =>
    fetch(`/api/human${url}`, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(method !== "GET" ? { "x-csrf-token": csrf } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const res = method === "GET" ? await send() : await withCsrf(send);
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Erreur ${res.status}`);
  return data as T;
}

export const api = {
  async session(): Promise<SessionInfo> {
    const s = await request<SessionInfo>("GET", "/session");
    csrf = s.csrf;
    return s;
  },
  projects: () => request<Project[]>("GET", "/projects"),
  studio: () => request<StudioSnapshot>("GET", "/studio"),
  monitor: () => request<Monitor>("GET", "/studio/monitor"),
  forge: (slug: string) => request<ForgeSnapshot>("GET", `/projects/${slug}/forge`),
  modGames: () => request<ModGame[]>("GET", "/mods/games"),
  modLoaderInstall: (appid: string) => request<{ ok: true }>("POST", "/mods/loader/install", { appid }),
  modLoaderRemove: (appid: string) => request<{ ok: true }>("POST", "/mods/loader/remove", { appid }),
  modTypemap: (appid: string) => request<{ ok: true }>("POST", "/mods/typemap", { appid }),
  mods: () => request<{ mods: Mod[]; running: string | null }>("GET", "/mods"),
  modCreate: (appid: string, idea: string) => request<Mod>("POST", "/mods", { appid, idea }),
  modGet: (id: string) => request<Mod>("GET", `/mods/${id}`),
  modReply: (id: string, text: string) => request<Mod>("POST", `/mods/${id}/reply`, { text }),
  modGo: (id: string) => request<Mod>("POST", `/mods/${id}/go`, {}),
  modInstall: (id: string) => request<Mod>("POST", `/mods/${id}/install`, {}),
  modUninstall: (id: string) => request<Mod>("POST", `/mods/${id}/uninstall`, {}),
  modPlayed: (id: string, text: string) => request<Mod>("POST", `/mods/${id}/played`, { text }),
  modImprove: (id: string, text: string) => request<Mod>("POST", `/mods/${id}/improve`, { text }),
  modRebuild: (id: string) => request<Mod>("POST", `/mods/${id}/rebuild`, {}),
  modCancel: (id: string) => request<{ ok: true }>("POST", `/mods/${id}/cancel`, {}),
  modHide: (id: string) => request<{ ok: true }>("POST", `/mods/${id}/hide`, {}),
  modRedraw: (id: string, file: string, text: string) => request<Mod>("POST", `/mods/${id}/assets/${file}/redraw`, { text }),
  modAsset: (id: string, file: string, v: number | string) => `/api/human/mods/${id}/assets/${file}?v=${encodeURIComponent(String(v))}`,
  refreshUsage: () => request<UsageSnapshot>("POST", "/usage/refresh", {}),
  setModel: (role: ModelRole, model: string) => request<ModelSetting[]>("POST", "/studio/models", { role, model }),
  express: () => request<{ games: ExpressGame[]; running: string | null }>("GET", "/express"),
  expressCreate: (idea: string, mode: ExpressMode) => request<ExpressGame>("POST", "/express", { idea, mode }),
  expressGet: (id: string) => request<ExpressGame>("GET", `/express/${id}`),
  expressImprove: (id: string, text: string) => request<ExpressGame>("POST", `/express/${id}/improve`, { request: text }),
  expressCancel: (id: string) => request<{ ok: boolean }>("POST", `/express/${id}/cancel`, {}),
  expressHide: (id: string) => request<{ ok: boolean }>("POST", `/express/${id}/hide`, {}),
  expressPromote: (id: string) => request<{ project: string; thread: string }>("POST", `/express/${id}/promote`, {}),
  expressShot: (g: { id: string; updated_at: string }) => `/api/human/express/${g.id}/shot?v=${encodeURIComponent(g.updated_at)}`,
  expressPlay: (id: string) => `/api/human/express/${id}/play/index.html`,
  art: (slug: string) => request<ArtState>("GET", `/projects/${slug}/art`),
  artSend: (slug: string, text: string) => request<ArtMessage>("POST", `/projects/${slug}/art/messages`, { text }),
  /** Dépose une image (moodboard ou rendu d'un asset « A-0001 ») : corps binaire, pas de JSON. */
  async artUpload(slug: string, target: string, file: File): Promise<{ file: string }> {
    const res = await withCsrf(() =>
      fetch(`/api/human/projects/${slug}/art/images?for=${encodeURIComponent(target)}&name=${encodeURIComponent(file.name.slice(0, 200))}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": file.type || "application/octet-stream", "x-csrf-token": csrf },
        body: file,
      }),
    );
    const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? (res.status === 413 ? "Image trop lourde (15 Mo au plus)" : `Erreur ${res.status}`));
    return data as { file: string };
  },
  /** Une capture annotée pour la discussion (ADR-72) : rend la ligne à ajouter au message. */
  async captureUpload(slug: string, image: Blob): Promise<{ file: string; line: string }> {
    const res = await withCsrf(() =>
      fetch(`/api/human/projects/${slug}/captures`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": image.type || "image/png", "x-csrf-token": csrf },
        body: image,
      }),
    );
    const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Erreur ${res.status}`);
    return data as { file: string; line: string };
  },
  captureUrl: (slug: string, file: string) => `/api/human/projects/${slug}/captures/${encodeURIComponent(file.split("/").pop()!)}`,
  artReact: (slug: string, body: { verdicts: Record<string, ArtTaste | null>; comment?: string; tell?: boolean }) =>
    request<ArtDirectionData>("POST", `/projects/${slug}/art/references`, body),
  artDecide: (slug: string, id: string, decision: "valider" | "refaire") => request<ArtAsset>("POST", `/projects/${slug}/art/assets/${id}/decide`, { decision }),
  artGenerate: (slug: string, id: string) => request<ArtAsset>("POST", `/projects/${slug}/art/assets/${id}/generate`, {}),
  artInstallGenerator: () => request<ArtGenerator>("POST", "/art/generator/install", {}),
  artInstallKontext: () => request<ArtGenerator>("POST", "/art/kontext/install", {}),
  artInstallBlender: () => request<Art3D>("POST", "/art/blender/install", {}),
  artTripoKey: (key: string) => request<Art3D>("POST", "/art/tripo/key", { key }),
  artGoogleKey: (key: string) => request<ArtGoogle>("POST", "/art/google/key", { key }),
  artGoogleCap: (usd: number) => request<ArtGoogle>("POST", "/art/google/cap", { usd }),
  artModel: (slug: string, id: string) => request<ArtAsset>("POST", `/projects/${slug}/art/assets/${id}/model`, {}),
  artLaunch: (slug: string, id: string) => request<ArtAsset>("POST", `/projects/${slug}/art/assets/${id}/launch`, {}),
  artAside: (slug: string, id: string, aside: boolean) => request<ArtAsset>("POST", `/projects/${slug}/art/assets/${id}/aside`, { aside }),
  artRetouch: (slug: string, id: string) => request<ArtAsset>("POST", `/projects/${slug}/art/assets/${id}/retouch`, {}),
  artRaiseBudget: (slug: string, id: string) => request<ArtSpend>("POST", `/projects/${slug}/art/assets/${id}/budget`, {}),
  artIntegrate: (slug: string, id: string) => request<{ thread: string }>("POST", `/projects/${slug}/art/assets/${id}/integrate`, {}),
  artBilan: (slug: string) => request<Bilan>("GET", `/projects/${slug}/art/bilan`),
  artBilanVerify: (slug: string) => request<Bilan>("POST", `/projects/${slug}/art/bilan/verify`, {}),
  artReintegrate: (slug: string, id: string) => request<{ thread: string }>("POST", `/projects/${slug}/art/assets/${id}/reintegrate`, {}),
  artLooksCheck: (slug: string) => request<Bilan>("POST", `/projects/${slug}/art/looks/check`, {}),
  artLookAccept: (slug: string, id: string) => request<ArtAsset>("POST", `/projects/${slug}/art/assets/${id}/look/accept`, {}),
  artAtelierFile: (slug: string, id: string, name: string) => `/api/human/projects/${slug}/art/atelier/${encodeURIComponent(id)}/${encodeURIComponent(name)}`,
  artFile: (slug: string, rel: string) => `/api/human/projects/${slug}/art/files/${rel.split("/").map(encodeURIComponent).join("/")}`,
  reverse: () => request<{ dissections: Dissection[]; tools: ReverseTool[]; sources: PublicSource[] }>("GET", "/reverse"),
  reversePublic: (source: string, patch: string) => request<Dissection>("POST", "/reverse/public", { source, patch }),
  reverseFeature: (id: string, request_: string) => request<DissectionNote>("POST", `/reverse/${id}/feature`, { request: request_ }),
  reverseBrowse: () => request<{ path: string | null }>("POST", "/reverse/browse", {}),
  reverseCreate: (path: string) => request<Dissection>("POST", "/reverse", { path }),
  reverseGet: (id: string) => request<DissectionDetail>("GET", `/reverse/${id}`),
  reverseInstall: (tool: string) => request<ReverseTool>("POST", `/reverse/tools/${tool}/install`, {}),
  reverseRun: (id: string, mode: "code" | "complet" | "fonctions") => request<Dissection>("POST", `/reverse/${id}/run`, { mode }),
  reverseCancel: (id: string) => request<{ ok: boolean }>("POST", `/reverse/${id}/cancel`, {}),
  reverseRelaunch: (id: string) => request<Dissection>("POST", `/reverse/${id}/relaunch`, {}),
  reverseEditor: (id: string) => request<Dissection>("POST", `/reverse/${id}/editor`, {}),
  reverseOpen: (id: string, how: "editor" | "play") => request<{ ok: true; editor: string }>("POST", `/reverse/${id}/open`, { how }),
  reverseAsk: (id: string, question: string) => request<DissectionNote>("POST", `/reverse/${id}/ask`, { question }),
  reverseSend: (id: string, note: number, project: string) => request<{ thread: string }>("POST", `/reverse/${id}/notes/${note}/send`, { project }),
  reverseMod: (id: string) => request<{ project: string; thread: string }>("POST", `/reverse/${id}/mod`, {}),
  setAutonomy: (slug: string, level: Autonomy) => request<Project>("POST", `/projects/${slug}/autonomy`, { level }),
  decidePending: (slug: string) => request<{ decided: string[]; left: number }>("POST", `/projects/${slug}/autonomy/decide-pending`, {}),
  suggestions: () => request<Suggestion[]>("GET", "/import/suggestions"),
  browse: () => request<{ path: string | null }>("POST", "/import/browse", {}),
  analyze: (path: string) => request<Analysis>("POST", "/import/analyze", { path }),
  importProject: (body: { path: string; slug: string; name: string; initGit: boolean; documents: { path: string; nature: "creative" | "technical" }[] }) =>
    request<{ project: Project; job: Job | null }>("POST", "/projects/import", body),
  createProject: (body: { slug: string; name: string }) => request<{ project: Project }>("POST", "/projects/create", body),
  items: (slug: string, view: "inbox" | "canon" | "all", thread?: string) =>
    request<{ vision_rev: number; items: ItemFrontmatter[] }>(
      "GET",
      `/projects/${slug}/items?view=${view}${thread ? `&thread=${encodeURIComponent(thread)}` : ""}`,
    ),
  triage: (slug: string, id: string, action: "keep" | "discard" | "restore") =>
    request<ItemFrontmatter>("POST", `/projects/${slug}/items/${id}/triage`, { action }),
  triageBatch: (slug: string, ids: string[], action: "keep" | "discard") =>
    request<{ done: number; errors: { id: string; error: string }[] }>("POST", `/projects/${slug}/items/triage-batch`, { ids, action }),
  candidates: (slug: string) => request<{ count: number }>("GET", `/projects/${slug}/synthesis/candidates`),
  synthesize: (slug: string, scope: { thread?: string; source?: string } = {}) =>
    request<SynthesisJob>("POST", `/projects/${slug}/synthesis`, scope),
  redoSynthesis: (slug: string) => request<SynthesisJob>("POST", `/projects/${slug}/synthesis/redo`, {}),
  synthesisJobs: (slug: string) => request<SynthesisJob[]>("GET", `/projects/${slug}/synthesis`),
  proposals: (slug: string) => request<ProposalCard[]>("GET", `/projects/${slug}/proposals`),
  decide: (slug: string, id: string, body: { hash: string; verdict: "approved" | "rejected"; edits?: DecideEdits; note?: string }) =>
    request<{ approval: string; decision?: ItemFrontmatter }>("POST", `/projects/${slug}/proposals/${id}/decide`, body),
  decideBatch: (slug: string, proposals: { id: string; hash: string }[]) =>
    request<{ results: { id: string; decision?: string; error?: string }[] }>("POST", `/projects/${slug}/proposals/decide-batch`, { proposals }),
  returnProposal: (slug: string, id: string, note?: string) => request<ItemFrontmatter>("POST", `/projects/${slug}/proposals/${id}/return`, { note }),
  abandon: (slug: string, id: string, hash: string) => request<unknown>("POST", `/projects/${slug}/decisions/${id}/abandon`, { hash }),
  why: (slug: string, id: string) => request<Lineage>("GET", `/projects/${slug}/items/${id}/why`),
  tasks: (slug: string) => request<TaskRow[]>("GET", `/projects/${slug}/tasks`),
  gameState: (slug: string) => request<{ text: string | null; updated_at: string | null; task: string | null }>("GET", `/projects/${slug}/game-state`),
  /** Capture du jeu prise par le hub pour un chantier (ADR-33) ; `v` évite l'ancienne image en cache. */
  screenshotUrl: (slug: string, id: string, v = "") => `/api/human/projects/${slug}/tasks/${id}/screenshot${v ? `?v=${encodeURIComponent(v)}` : ""}`,
  /** Photo d'une pose de contrôle (ADR-122) ; `nom` est déjà encodé dans le message. */
  poseUrl: (slug: string, id: string, nom: string, v = "") => `/api/human/projects/${slug}/tasks/${id}/poses/${nom}${v ? `?v=${encodeURIComponent(v)}` : ""}`,
  createTask: (slug: string, decisions: string[]) => request<Task>("POST", `/projects/${slug}/tasks`, { decisions }),
  task: (slug: string, id: string) => request<TaskDetail>("GET", `/projects/${slug}/tasks/${id}`),
  startPlan: (slug: string, id: string) => request<Task>("POST", `/projects/${slug}/tasks/${id}/plan`, {}),
  approvePlan: (slug: string, id: string, hash: string) => request<Task>("POST", `/projects/${slug}/tasks/${id}/plan/approve`, { hash }),
  rejectPlan: (slug: string, id: string, note?: string) => request<Task>("POST", `/projects/${slug}/tasks/${id}/plan/reject`, { note }),
  execute: (slug: string, id: string) => request<Task>("POST", `/projects/${slug}/tasks/${id}/execute`, {}),
  cancelTask: (slug: string, id: string) => request<Task>("POST", `/projects/${slug}/tasks/${id}/cancel`, {}),
  runEvents: (slug: string, id: string, run: string, after: number) =>
    request<RunEvent[]>("GET", `/projects/${slug}/tasks/${id}/runs/${run}/events?after=${after}`),
  review: (slug: string, id: string) => request<Review>("GET", `/projects/${slug}/tasks/${id}/review`),
  merge: (slug: string, id: string, head: string) => request<{ task: Task; sha: string }>("POST", `/projects/${slug}/tasks/${id}/merge`, { head }),
  requestChanges: (slug: string, id: string, feedback: string) => request<Task>("POST", `/projects/${slug}/tasks/${id}/changes`, { feedback }),
  abandonTask: (slug: string, id: string) => request<Task>("POST", `/projects/${slug}/tasks/${id}/abandon`, {}),
  remoteStatus: () => request<RemoteStatus>("GET", "/remote/status"),
  remoteEnable: () => request<RemoteStatus>("POST", "/remote/enable", {}),
  remoteDisable: () => request<RemoteStatus>("POST", "/remote/disable", {}),
  pairingCode: () => request<{ code: string; expires_at: string }>("POST", "/devices/pairing", {}),
  devices: () => request<Device[]>("GET", "/devices"),
  revokeDevice: (id: string) => request<{ revoked: boolean }>("POST", `/devices/${id}/revoke`, {}),
  pushKey: () => request<{ key: string }>("GET", "/push/key"),
  pushSubscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) => request<{ subscribed: boolean }>("POST", "/push/subscribe", sub),
  pushUnsubscribe: (endpoint: string) => request<{ unsubscribed: boolean }>("POST", "/push/unsubscribe", { endpoint }),
  pushTest: () => request<{ sent: number }>("POST", "/push/test", {}),
  skills: (project?: string) => request<Skill[]>("GET", `/skills${project ? `?project=${encodeURIComponent(project)}` : ""}`),
  saveSkill: (s: { id?: string; name: string; description: string; body: string; agents: SkillAgent[]; enabled: boolean }) => request<Skill>("POST", "/skills", s),
  deleteSkill: (id: string) => request<{ deleted: boolean }>("POST", `/skills/${id}/delete`, {}),
  skillStatus: () => request<SkillStatus>("GET", "/skills/status"),
  skillDetail: (id: string) => request<Skill & { file_contents: { path: string; content: string }[] }>("GET", `/skills/${id}`),
  revertSkill: (id: string) => request<Skill>("POST", `/skills/${id}/revert`, {}),
  syncHermes: () => request<SkillStatus>("POST", "/skills/hermes/sync", {}),
  // L'équipe, la mémoire du studio, l'Atelier d'idées (ADR-98 à ADR-100)
  consultations: (project?: string) => request<Consultation[]>("GET", `/team/consultations${project ? `?project=${encodeURIComponent(project)}` : ""}`),
  memory: () => request<StudioMemoryEntry[]>("GET", "/memory"),
  addMemory: (text: string) => request<StudioMemoryEntry>("POST", "/memory", { text }),
  editMemory: (id: string, text: string) => request<StudioMemoryEntry>("POST", `/memory/${id}`, { text }),
  decideMemory: (id: string, keep: boolean) => request<StudioMemoryEntry>("POST", `/memory/${id}/decide`, { keep }),
  deleteMemory: (id: string) => request<{ ok: true }>("POST", `/memory/${id}/delete`, {}),
  ideas: () => request<Idea[]>("GET", "/ideas"),
  idea: (id: string) => request<Idea>("GET", `/ideas/${id}`),
  createIdea: (body: string, title?: string) => request<Idea>("POST", "/ideas", { body, ...(title ? { title } : {}) }),
  updateIdea: (id: string, patch: { title?: string; body?: string; status?: "idee" | "archivee" }) => request<Idea>("POST", `/ideas/${id}`, patch),
  addInspiration: (id: string, input: { url?: string | null; note?: string }) => request<Idea>("POST", `/ideas/${id}/inspirations`, input),
  removeInspiration: (id: string, inspiration: string) => request<Idea>("POST", `/ideas/${id}/inspirations/${inspiration}/delete`, {}),
  enrichIdea: (id: string) => request<Idea>("POST", `/ideas/${id}/enrich`, {}),
  ideaToProject: (id: string) => request<{ idea: Idea; conception: string }>("POST", `/ideas/${id}/project`, {}),
  deleteIdea: (id: string) => request<{ ok: true }>("POST", `/ideas/${id}/delete`, {}),
  conceptions: () => request<Conception[]>("GET", "/conceptions"),
  startConception: (body: { kind: "project" | "feature"; project?: string; idea: string; thread?: string }) => request<Conception>("POST", "/conceptions", body),
  conception: (id: string) => request<{ conception: Conception; messages: ConceptionMessage[] }>("GET", `/conceptions/${id}`),
  replyConception: (id: string, text: string) => request<Conception>("POST", `/conceptions/${id}/reply`, { text }),
  createFromConception: (id: string) => request<{ project: Project; tasks: string[] }>("POST", `/conceptions/${id}/create-project`, {}),
  addConceptionToProject: (id: string) => request<{ tasks: string[] }>("POST", `/conceptions/${id}/add-to-project`, {}),
  startTask: (slug: string, id: string) => request<Task>("POST", `/projects/${slug}/tasks/${id}/start`, {}),
  quality: (project?: string) => request<QualityReport>("GET", `/quality${project ? `?project=${encodeURIComponent(project)}` : ""}`),
  qualityRoutes: (project?: string) => request<RouteReport>("GET", `/quality/routes${project ? `?project=${encodeURIComponent(project)}` : ""}`),
  rateTask: (slug: string, id: string, rating: "up" | "down", note?: string) => request<Rating>("POST", `/projects/${slug}/tasks/${id}/rating`, { rating, note }),
  previews: (slug: string) => request<Preview[]>("GET", `/projects/${slug}/previews`),
  /** `opened` : le hub a ouvert le jeu lui-même dans Edge sur l'ordinateur. */
  startPreview: (slug: string, task?: string) => request<Preview & { opened: boolean }>("POST", task ? `/projects/${slug}/tasks/${task}/preview` : `/projects/${slug}/preview`, {}),
  sound: (slug: string) => request<SoundState>("GET", `/projects/${slug}/sound`),
  soundKey: (key: string) => request<{ ok: boolean }>("POST", "/sound/key", { key }),
  soundPropose: (slug: string, req: string) => request<SoundState>("POST", `/projects/${slug}/sound/propose`, { request: req }),
  soundEdit: (slug: string, id: string, patch: Partial<Pick<Sound, "prompt" | "seconds" | "loop" | "usage" | "name">>) => request<Sound>("PATCH", `/projects/${slug}/sound/${id}`, patch),
  soundRemove: (slug: string, id: string) => request<{ ok: boolean }>("DELETE", `/projects/${slug}/sound/${id}`),
  soundGenerate: (slug: string, id: string, count: number) => request<SoundState>("POST", `/projects/${slug}/sound/${id}/generate`, { count }),
  soundChoose: (slug: string, id: string, file: string) => request<Sound>("POST", `/projects/${slug}/sound/${id}/choose`, { file }),
  soundIntegrate: (slug: string) => request<{ task: { id: string }; after: string | null }>("POST", `/projects/${slug}/sound/integrate`, {}),
  soundTake: (slug: string, file: string) => `/api/human/projects/${slug}/sound/takes/${file}`,
  productions: (slug: string) => request<Production[]>("GET", `/projects/${slug}/productions`),
  production: (slug: string, id: string) => request<Production>("GET", `/projects/${slug}/productions/${id}`),
  productionStart: (slug: string, id: string) => request<Production>("POST", `/projects/${slug}/productions/${id}/start`, {}),
  productionCancel: (slug: string, id: string) => request<Production>("POST", `/projects/${slug}/productions/${id}/cancel`, {}),
  productionSkip: (slug: string, id: string, ref: string) => request<Production>("POST", `/projects/${slug}/productions/${id}/skip`, { ref }),
  exportState: (slug: string) => request<ExportState>("GET", `/projects/${slug}/export`),
  exportStart: (slug: string) => request<ExportState>("POST", `/projects/${slug}/export`, {}),
  exportTemplates: (slug: string) => request<ExportState>("POST", `/projects/${slug}/export/templates`, {}),
  exportReveal: (slug: string, id: string) => request<{ ok: boolean }>("POST", `/projects/${slug}/export/${id}/reveal`, {}),
  logbook: (slug: string, week?: string) => request<{ weeks: string[]; current: LogWeek }>("GET", `/projects/${slug}/logbook${week ? `?week=${week}` : ""}`),
  logbookGif: (slug: string, week: string, n: number) => `/api/human/projects/${slug}/logbook/${week}/gif?n=${n}`,
  logbookTell: (slug: string, week: string) => request<LogWeek>("POST", `/projects/${slug}/logbook/${week}/tell`, {}),
  feel: (slug: string, moments: string, intensity: "discret" | "marque" | "genereux") =>
    request<{ task: { id: string }; thread: string; after: string | null }>("POST", `/projects/${slug}/feel`, { moments, intensity }),
  bench: (slug: string) => request<BenchState>("GET", `/projects/${slug}/bench`),
  benchAdd: (slug: string, task: string) => request<BenchCase>("POST", `/projects/${slug}/bench/cases`, { task }),
  benchRemove: (slug: string, id: string) => request<{ ok: boolean }>("DELETE", `/projects/${slug}/bench/cases/${id}`),
  benchRun: (slug: string) => request<BenchState>("POST", `/projects/${slug}/bench/run`, {}),
  balance: (slug: string) => request<BalanceState>("GET", `/projects/${slug}/balance`),
  balanceRun: (slug: string, runs: number) => request<BalanceState>("POST", `/projects/${slug}/balance/run`, { runs }),
  balanceSend: (slug: string, id: number, question: string) => request<{ thread: string }>("POST", `/projects/${slug}/balance/${id}/send`, { question }),
  replays: (slug: string) => request<{ recordings: Recording[]; saved: SavedReplay[] }>("GET", `/projects/${slug}/replays`),
  saveRecording: (slug: string, id: string, name: string, note: string) => request<SavedReplay>("POST", `/projects/${slug}/recordings/${id}/save`, { name, note }),
  deleteRecording: (slug: string, id: string) => request<{ ok: true }>("POST", `/projects/${slug}/recordings/${id}/delete`, {}),
  deleteReplay: (slug: string, file: string) => request<{ ok: true }>("POST", `/projects/${slug}/replays/${file}/delete`, {}),
  stopPreview: (slug: string) => request<{ stopped: boolean }>("POST", `/projects/${slug}/preview/stop`, {}),
  inbox: (slug: string) => request<InboxItem[]>("GET", `/projects/${slug}/inbox`),
  recap: (slug: string, period?: RecapPeriod) => request<Recap>("GET", `/projects/${slug}/recap${period ? `?period=${period}` : ""}`),
  pendingEscalations: (slug: string) => request<Escalation[]>("GET", `/projects/${slug}/escalations`),
  decideEscalation: (slug: string, id: string, allowed: boolean) => request<Escalation>("POST", `/projects/${slug}/escalations/${id}/decide`, { allowed }),
  jobs: (slug: string) => request<Job[]>("GET", `/projects/${slug}/jobs`),
  threads: (slug: string) => request<Thread[]>("GET", `/projects/${slug}/threads`),
  createThread: (slug: string, title: string) => request<Thread>("POST", `/projects/${slug}/threads`, { title }),
  renameThread: (slug: string, id: string, title: string) => request<Thread>("POST", `/projects/${slug}/threads/${id}/rename`, { title }),
  messages: (slug: string, thread: string) => request<Message[]>("GET", `/projects/${slug}/threads/${thread}/messages`),
  send: (slug: string, thread: string, text: string) =>
    request<{ human: Message; director: Message }>("POST", `/projects/${slug}/threads/${thread}/messages`, { text }),
};

export function slugify(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "projet"
  );
}
