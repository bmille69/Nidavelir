import { z } from "zod";
import { ItemId } from "./items.ts";

/** Cycle de vie d'une tâche (docs/SECURITY.md §5). */
export const TASK_STATUSES = [
  "draft",
  "planning",
  "plan_review",
  "approved",
  "running",
  "review",
  "merged",
  "changes_requested",
  "rejected",
  "cancelled",
  "abandoned",
  "failed",
] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskId = z.string().regex(/^T-\d{4,}$/);

export const Task = z.object({
  id: TaskId,
  project: z.string(),
  title: z.string().min(1).max(160),
  goal: z.string().min(1).max(4000),
  /** Décisions de la bible qui fondent la tâche ; vide pour un chantier lancé depuis une discussion (mode atelier). */
  authorized_by: z.array(ItemId).default([]),
  /** Discussion d'où vient le chantier (mode atelier, ADR-24) : le hub y donne les nouvelles. */
  origin: z.object({ thread: z.string() }).nullable().default(null),
  status: TaskStatus,
  /** Commentaires de votre part transmis au prochain plan (demande de corrections). */
  feedback: z.array(z.string()).default([]),
  base_commit: z.string().nullable(),
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  plan: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Task = z.infer<typeof Task>;

/** Plan produit par le développeur, en lecture seule (docs/AGENT_CONTRACTS.md §4.6). */
export const PlanOutput = z.object({
  summary: z.string().min(1).max(2000),
  /** Résumé pour le directeur créatif, sans jargon. */
  summary_simple: z.string().min(1).max(800),
  acceptance_criteria: z.array(z.string().max(300)).min(1).max(12),
  steps: z.array(z.object({ description: z.string().max(500), files: z.array(z.string()).max(30) })).min(1).max(20),
  files_to_create: z.array(z.string()).max(40),
  files_to_modify: z.array(z.string()).max(60),
  files_to_delete: z.array(z.string()).max(20),
  commands: z.array(z.object({ cmd: z.string().max(200), purpose: z.string().max(200) })).max(10),
  new_dependencies: z.array(z.object({ name: z.string(), version: z.string(), why: z.string().max(300) })).max(10),
  risks: z.array(z.string().max(300)).max(10),
  assumptions: z.array(z.string().max(300)).max(10),
  questions: z.array(z.string().max(300)).max(5),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

export const Plan = PlanOutput.extend({
  id: z.string().regex(/^PL-\d{4,}$/),
  project: z.string(),
  task: TaskId,
  status: z.enum(["submitted", "approved", "rejected", "superseded"]),
  /** Problèmes relevés par le hub (chemins interdits, commandes refusées…). Bloquants. */
  problems: z.array(z.string()),
  vision_rev: z.number().int(),
  hash: z.string().length(64),
  created_at: z.string(),
});
export type Plan = z.infer<typeof Plan>;

export const RunKind = z.enum(["plan", "execute", "verify"]);
export const Run = z.object({
  id: z.string().regex(/^RUN-\d{4,}$/),
  project: z.string(),
  task: TaskId,
  kind: RunKind,
  status: z.enum(["running", "done", "failed", "cancelled"]),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  cost_usd: z.number().nullable(),
  error: z.string().nullable(),
});
export type Run = z.infer<typeof Run>;

/** Demande d'autorisation pour une action hors plan (niveau N3). */
export const Escalation = z.object({
  id: z.string().regex(/^E-\d{4,}$/),
  project: z.string(),
  task: TaskId,
  run: z.string(),
  tool: z.string(),
  /** Résumé lisible de l'action demandée. */
  summary: z.string(),
  input: z.record(z.string(), z.unknown()),
  reason: z.string(),
  status: z.enum(["pending", "allowed", "denied", "expired"]),
  created_at: z.string(),
  decided_at: z.string().nullable(),
});
export type Escalation = z.infer<typeof Escalation>;

export const ExecutionReportOutput = z.object({
  outcome: z.enum(["completed", "partial", "failed"]),
  summary: z.string().max(2000),
  summary_simple: z.string().max(800),
  deviations: z.array(z.object({ what: z.string().max(300), why: z.string().max(300) })).max(10),
  open_issues: z.array(z.string().max(300)).max(10),
  /** Pas à pas pour essayer le changement en jouant, écrit pour quelqu'un qui ne lit pas le code. */
  how_to_test: z.array(z.string().max(300)).max(8).default([]),
});
export type ExecutionReportOutput = z.infer<typeof ExecutionReportOutput>;

export const VerificationOutput = z.object({
  verdict: z.enum(["pass", "pass_with_notes", "fail"]),
  summary_simple: z.string().max(800),
  checks: z
    .array(z.object({ criterion: z.string().max(300), result: z.enum(["pass", "fail", "not_verifiable"]), evidence: z.string().max(600) }))
    .max(20),
  decision_compliance: z.array(z.object({ decision: ItemId, respected: z.boolean(), note: z.string().max(400) })).max(20),
  hidden_assumptions: z.array(z.string().max(300)).max(10),
  regressions: z.array(z.string().max(300)).max(10),
  recommendation: z.enum(["merge", "request_changes", "abandon"]),
});
export type VerificationOutput = z.infer<typeof VerificationOutput>;
