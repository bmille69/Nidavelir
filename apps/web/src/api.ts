import type { ItemFrontmatter, Message, Thread } from "@studio/contracts";

export type { ItemFrontmatter as Item, Message, Thread };

export type Project = { slug: string; name: string; root: string; engine: "godot" | "web" | "unknown"; created_at: string };
export type Analysis = {
  root: string;
  suggestedName: string;
  suggestedSlug: string;
  engine: Project["engine"];
  isGitRepo: boolean;
  hasStudio: boolean;
  documents: string[];
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
  suggestions: () => request<Suggestion[]>("GET", "/import/suggestions"),
  browse: () => request<{ path: string | null }>("POST", "/import/browse", {}),
  analyze: (path: string) => request<Analysis>("POST", "/import/analyze", { path }),
  importProject: (body: { path: string; slug: string; name: string; initGit: boolean; documents: string[] }) =>
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
