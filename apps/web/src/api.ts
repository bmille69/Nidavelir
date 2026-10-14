import type { Escalation, ItemFrontmatter, Message, Plan, Run, Task, Thread, VerificationOutput, ExecutionReportOutput } from "@studio/contracts";

export type { ItemFrontmatter as Item, Message, Thread, Task, Plan, Escalation };
export type TaskRow = Task & { pending_escalations: number; cost_usd: number };
export type RunInfo = Run & { result: { report?: ExecutionReportOutput; verification?: VerificationOutput; text?: string } | null };
export type TaskDetail = { task: Task; plan: Plan | null; runs: RunInfo[]; escalations: Escalation[]; decisions: ItemFrontmatter[]; executor: string };
export type RunEvent = { seq: number; at: string; type: "text" | "tool" | "result" | "info" | "error"; text: string };
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
};
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
export type AgentId = "you" | "director" | "archivist" | "developer" | "qa" | "guardian";
export type AgentState = "idle" | "working" | "waiting";
export type Activity = { project: string; text: string; detail?: string; href: string; since?: string };
export type HubEvent = { seq: number; at: string; project: string | null; actor: { kind: string; role?: string }; type: string; subject: string | null; payload: Record<string, unknown> };
export type StudioSnapshot = {
  at: string;
  usage: UsageSnapshot;
  agents: { id: AgentId; state: AgentState; activities: Activity[] }[];
  projects: { slug: string; name: string; engine: Project["engine"]; autonomy: Autonomy; delegated: number; busy: boolean; waiting: number; decisions: number; proposals: number; tasks: number }[];
  events: HubEvent[];
};
export type Preview = { key: string; project: string; task: string | null; url: string; started_at: string };
export type SessionInfo = { csrf: string; orchestrator: string; gamesRoot: string };

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let csrf = "";

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/human${url}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-csrf-token": csrf } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
  refreshUsage: () => request<UsageSnapshot>("POST", "/usage/refresh", {}),
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
  previews: (slug: string) => request<Preview[]>("GET", `/projects/${slug}/previews`),
  startPreview: (slug: string, task?: string) => request<Preview>("POST", task ? `/projects/${slug}/tasks/${task}/preview` : `/projects/${slug}/preview`, {}),
  stopPreview: (slug: string) => request<{ stopped: boolean }>("POST", `/projects/${slug}/preview/stop`, {}),
  pendingEscalations: (slug: string) => request<Escalation[]>("GET", `/projects/${slug}/escalations`),
  decideEscalation: (slug: string, id: string, allowed: boolean) => request<Escalation>("POST", `/projects/${slug}/escalations/${id}/decide`, { allowed }),
  jobs: (slug: string) => request<Job[]>("GET", `/projects/${slug}/jobs`),
  threads: (slug: string) => request<Thread[]>("GET", `/projects/${slug}/threads`),
  createThread: (slug: string, title: string) => request<Thread>("POST", `/projects/${slug}/threads`, { title }),
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
