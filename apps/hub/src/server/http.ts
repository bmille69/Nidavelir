import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ApprovalEdits, ItemType, ProjectSlug } from "@studio/contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ApprovalError } from "../approvals/approval-service.ts";
import { HumanSessionRequiredError, type HumanSession } from "../auth/human-session.ts";
import { ConversationError } from "../conversation/conversation-service.ts";
import type { Hub } from "../hub.ts";
import { OrchestratorError } from "../orchestrator/port.ts";
import type { FolderPicker } from "../projects/folder-picker.ts";
import { ProjectError } from "../projects/project-registry.ts";
import { suggestFolders } from "../projects/suggestions.ts";
import { VisionError } from "../vision/vision-service.ts";
import { TaskError } from "../executor/task-service.ts";

export const SESSION_COOKIE = "studio_session";

export type ServerOptions = {
  port: number;
  gamesRoot: string;
  /** Hôtes acceptés dans l'en-tête Host (protection contre le DNS rebinding). */
  allowedHosts: string[];
  folderPicker: FolderPicker;
  webDist?: string;
};

declare module "fastify" {
  interface FastifyRequest {
    human?: HumanSession;
  }
}

const Body = {
  analyze: z.object({ path: z.string().min(1) }),
  importProject: z.object({
    path: z.string().min(1),
    slug: ProjectSlug,
    name: z.string().min(1).max(120),
    initGit: z.boolean().default(false),
    documents: z.array(z.string()).max(50).default([]),
  }),
  createProject: z.object({ slug: ProjectSlug, name: z.string().min(1).max(120) }),
  thread: z.object({ title: z.string().max(120).default("") }),
  message: z.object({ text: z.string().min(1) }),
  triage: z.object({ action: z.enum(["keep", "discard", "restore"]) }),
  synthesis: z.object({ thread: z.string().optional(), source: z.string().optional() }),
  createTask: z.object({ decisions: z.array(z.string()).min(1).max(10), title: z.string().max(160).optional(), goal: z.string().max(4000).optional() }),
  hash: z.object({ hash: z.string().length(64) }),
  head: z.object({ head: z.string().regex(/^[0-9a-f]{40}$/) }),
  feedback: z.object({ feedback: z.string().min(1).max(4000) }),
  escalation: z.object({ allowed: z.boolean() }),
  agentTool: z.object({ tool_name: z.string().min(1).max(200), tool_input: z.record(z.string(), z.unknown()).default({}) }),
  decide: z.object({
    hash: z.string().length(64),
    verdict: z.enum(["approved", "rejected"]),
    note: z.string().max(2000).optional(),
    edits: ApprovalEdits.optional(),
  }),
  decideBatch: z.object({ proposals: z.array(z.object({ id: z.string(), hash: z.string().length(64) })).min(1).max(50) }),
  note: z.object({ note: z.string().max(2000).optional() }),
  abandon: z.object({ hash: z.string().length(64), note: z.string().max(2000).optional() }),
  triageBatch: z.object({ ids: z.array(z.string()).min(1).max(500), action: z.enum(["keep", "discard"]) }),
};

/**
 * Serveur HTTP local (127.0.0.1 uniquement). Toutes les routes /api/human/*
 * exigent le cookie de session ; les modifications exigent en plus le jeton CSRF
 * et une origine locale (docs/SECURITY.md §4).
 */
export async function buildServer(hub: Hub, options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  await app.register(cookie);
  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()));

  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowed.has(host)) return reply.code(403).send({ error: "Hôte non autorisé" });
  });

  app.get("/login", async (req, reply) => {
    const token = String((req.query as Record<string, unknown>).token ?? "");
    try {
      const { sessionId, cookie: secret } = hub.sessions.login(token);
      reply.setCookie(SESSION_COOKIE, `${sessionId}.${secret}`, { httpOnly: true, sameSite: "strict", path: "/" });
      hub.journal.append({ project: null, actor: { kind: "human" }, type: "session.opened", payload: { session: sessionId } });
      return reply.redirect("/");
    } catch {
      return reply
        .code(401)
        .type("text/html; charset=utf-8")
        .send("<p>Lien de connexion invalide ou déjà utilisé. Relancez le hub pour obtenir un nouveau lien.</p>");
    }
  });

  app.register(async (api) => {
    api.addHook("preHandler", async (req, reply) => authenticate(hub, allowed, req, reply));

    api.get("/session", async (req) => {
      const [sid, secret] = readSessionCookie(req);
      return { csrf: hub.sessions.csrfFor(sid, secret), orchestrator: hub.orchestrator.name, gamesRoot: options.gamesRoot };
    });

    // ── Projets et import ──
    api.get("/projects", async () => hub.projects.list());
    api.get("/import/suggestions", async () => suggestFolders(options.gamesRoot, hub.projects));
    api.post("/import/browse", async () => ({ path: await options.folderPicker.pick(options.gamesRoot) }));
    api.post("/import/analyze", async (req) => hub.projects.analyze(Body.analyze.parse(req.body).path));
    api.post("/projects/import", async (req) => {
      const body = Body.importProject.parse(req.body);
      const project = await hub.projects.register(req.human!, body);
      const job = body.documents.length ? hub.bootstrap.start(project.slug, body.documents) : null;
      return { project, job };
    });
    api.post("/projects/create", async (req) => {
      const body = Body.createProject.parse(req.body);
      const root = join(options.gamesRoot, body.slug);
      if (existsSync(root) && readdirSync(root).length) throw new ProjectError(`Le dossier ${root} existe déjà et n'est pas vide`);
      mkdirSync(root, { recursive: true });
      return { project: await hub.projects.register(req.human!, { path: root, slug: body.slug, name: body.name, initGit: true }) };
    });

    // ── Vision ──
    api.get("/projects/:slug/items", async (req) => {
      const { slug } = req.params as { slug: string };
      const q = z
        .object({ view: z.enum(["inbox", "canon", "all"]).default("all"), thread: z.string().optional(), type: ItemType.optional() })
        .parse(req.query);
      hub.projects.get(slug);
      let items = hub.vision.list(slug, q.type ? { type: q.type } : {});
      if (q.view === "inbox") {
        items = items.filter((i) => i.tier === "working" && ["captured", "triaged", "open"].includes(i.status) && i.type !== "proposal");
      } else if (q.view === "canon") {
        items = items.filter((i) => i.tier === "canon" && i.status === "validated");
      }
      if (q.thread) items = items.filter((i) => i.source.kind === "message" && i.source.ref.startsWith(`${q.thread}/`));
      return { vision_rev: hub.vision.visionRev(slug), items };
    });
    api.get("/projects/:slug/items/:id", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return { item: hub.vision.get(slug, id), history: hub.journal.list({ project: slug, subject: id }) };
    });
    api.post("/projects/:slug/items/:id/triage", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.vision.triage(slug, { kind: "human" }, id, Body.triage.parse(req.body).action);
    });
    api.post("/projects/:slug/items/triage-batch", async (req) => {
      const { slug } = req.params as { slug: string };
      const body = Body.triageBatch.parse(req.body);
      const errors: { id: string; error: string }[] = [];
      let done = 0;
      for (const id of body.ids) {
        try {
          hub.vision.triage(slug, { kind: "human" }, id, body.action);
          done++;
        } catch (err) {
          errors.push({ id, error: (err as Error).message });
        }
      }
      return { done, errors };
    });
    // ── Mode décision : regroupement, propositions, validations humaines ──
    api.post("/projects/:slug/synthesis", async (req) => {
      const { slug } = req.params as { slug: string };
      hub.projects.get(slug);
      return hub.synthesis.start(slug, Body.synthesis.parse(req.body ?? {}));
    });
    api.get("/projects/:slug/synthesis", async (req) => hub.synthesis.list((req.params as { slug: string }).slug));
    api.get("/projects/:slug/synthesis/candidates", async (req) => {
      const { slug } = req.params as { slug: string };
      return { count: hub.synthesis.candidates(slug, Body.synthesis.parse(req.query ?? {})).length };
    });
    api.get("/projects/:slug/proposals", async (req) => {
      const { slug } = req.params as { slug: string };
      return hub.vision.list(slug, { type: "proposal", status: "submitted" }).map((p) => ({
        proposal: p,
        hash: hub.vision.proposalHash(slug, p.id),
        sources: p.proposal!.based_on.map((id) => hub.vision.get(slug, id)),
        supersedes: p.proposal!.supersedes.map((id) => hub.vision.get(slug, id)),
      }));
    });
    api.post("/projects/:slug/proposals/:id/decide", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const body = Body.decide.parse(req.body);
      const approval = hub.approvals.record(req.human!, {
        project: slug,
        subject: { kind: "proposal", id, hash: body.hash },
        verdict: body.verdict,
        note: body.note,
        edits: body.edits,
      });
      return { approval: approval.id, ...(await hub.vision.decideProposal(slug, approval.id)) };
    });
    api.post("/projects/:slug/proposals/decide-batch", async (req) => {
      const { slug } = req.params as { slug: string };
      const body = Body.decideBatch.parse(req.body);
      const results: { id: string; decision?: string; error?: string }[] = [];
      for (const p of body.proposals) {
        try {
          const approval = hub.approvals.record(req.human!, {
            project: slug,
            subject: { kind: "proposal", id: p.id, hash: p.hash },
            verdict: "approved",
            note: "validation groupée",
          });
          const { decision } = await hub.vision.decideProposal(slug, approval.id);
          results.push({ id: p.id, decision: decision?.id });
        } catch (err) {
          results.push({ id: p.id, error: (err as Error).message });
        }
      }
      return { results };
    });
    api.post("/projects/:slug/proposals/:id/return", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.vision.returnProposal(slug, { kind: "human" }, id, Body.note.parse(req.body ?? {}).note);
    });
    api.post("/projects/:slug/decisions/:id/abandon", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const body = Body.abandon.parse(req.body);
      const approval = hub.approvals.record(req.human!, {
        project: slug,
        subject: { kind: "abandon", id, hash: body.hash },
        verdict: "approved",
        note: body.note,
      });
      return hub.vision.abandonDecision(slug, approval.id);
    });
    api.get("/projects/:slug/items/:id/why", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return { ...hub.vision.lineage(slug, id), hash: hub.vision.itemHash(slug, id) };
    });

    // ── Phase 2 : tâches, plans, exécution contrôlée ──
    type TaskParams = { slug: string; id: string };
    api.get("/projects/:slug/tasks", async (req) => {
      const { slug } = req.params as { slug: string };
      const pending = hub.tasks.escalations(slug, { status: "pending" });
      return hub.tasks.list(slug).map((t) => ({ ...t, pending_escalations: pending.filter((e) => e.task === t.id).length }));
    });
    api.post("/projects/:slug/tasks", async (req) => {
      const { slug } = req.params as { slug: string };
      return hub.tasks.create(req.human!, slug, Body.createTask.parse(req.body));
    });
    api.get("/projects/:slug/tasks/:id", async (req) => {
      const { slug, id } = req.params as TaskParams;
      const task = hub.tasks.get(slug, id);
      return {
        task,
        plan: task.plan ? hub.tasks.plan(slug, task.plan) : null,
        runs: hub.tasks.runs(slug, id),
        escalations: hub.tasks.escalations(slug, { task: id }),
        decisions: task.authorized_by.map((d) => hub.vision.get(slug, d)),
        executor: hub.tasks.executorName,
      };
    });
    api.post("/projects/:slug/tasks/:id/plan", async (req) => {
      const { slug, id } = req.params as TaskParams;
      return hub.tasks.startPlanning(slug, id);
    });
    api.post("/projects/:slug/tasks/:id/plan/approve", async (req) => {
      const { slug, id } = req.params as TaskParams;
      return hub.tasks.approvePlan(req.human!, slug, id, Body.hash.parse(req.body).hash);
    });
    api.post("/projects/:slug/tasks/:id/plan/reject", async (req) => {
      const { slug, id } = req.params as TaskParams;
      return hub.tasks.rejectPlan(req.human!, slug, id, Body.note.parse(req.body ?? {}).note);
    });
    api.post("/projects/:slug/tasks/:id/execute", async (req) => {
      const { slug, id } = req.params as TaskParams;
      return hub.tasks.startExecution(req.human!, slug, id);
    });
    api.post("/projects/:slug/tasks/:id/cancel", async (req) => {
      const { slug, id } = req.params as TaskParams;
      return hub.tasks.cancel(req.human!, slug, id);
    });
    api.get("/projects/:slug/tasks/:id/runs/:run/events", async (req) => {
      const { run } = req.params as TaskParams & { run: string };
      const after = Number((req.query as { after?: string }).after ?? 0);
      return hub.tasks.events(run, Number.isFinite(after) ? after : 0);
    });
    api.get("/projects/:slug/tasks/:id/review", async (req) => {
      const { slug, id } = req.params as TaskParams;
      return hub.tasks.review(slug, id);
    });
    api.post("/projects/:slug/tasks/:id/merge", async (req) => {
      const { slug, id } = req.params as TaskParams;
      return hub.tasks.merge(req.human!, slug, id, Body.head.parse(req.body).head);
    });
    api.post("/projects/:slug/tasks/:id/changes", async (req) => {
      const { slug, id } = req.params as TaskParams;
      return hub.tasks.requestChanges(req.human!, slug, id, Body.feedback.parse(req.body).feedback);
    });
    api.post("/projects/:slug/tasks/:id/abandon", async (req) => {
      const { slug, id } = req.params as TaskParams;
      return hub.tasks.abandon(req.human!, slug, id);
    });
    api.get("/projects/:slug/escalations", async (req) => {
      const { slug } = req.params as { slug: string };
      return hub.tasks.escalations(slug, { status: "pending" });
    });
    api.post("/projects/:slug/escalations/:id/decide", async (req) => {
      const { slug, id } = req.params as TaskParams;
      return hub.tasks.decideEscalation(req.human!, slug, id, Body.escalation.parse(req.body).allowed);
    });

    api.get("/projects/:slug/jobs", async (req) => hub.bootstrap.list((req.params as { slug: string }).slug));

    // ── Conversations ──
    api.get("/projects/:slug/threads", async (req) => hub.conversations.listThreads((req.params as { slug: string }).slug));
    api.post("/projects/:slug/threads", async (req) =>
      hub.conversations.createThread((req.params as { slug: string }).slug, Body.thread.parse(req.body ?? {}).title),
    );
    api.get("/projects/:slug/threads/:id/messages", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.conversations.messages(slug, id);
    });
    api.post("/projects/:slug/threads/:id/messages", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.conversations.send(slug, id, Body.message.parse(req.body).text);
    });
    api.get("/projects/:slug/journal", async (req) => hub.journal.list({ project: (req.params as { slug: string }).slug, limit: 200, latest: true }));
  }, { prefix: "/api/human" });

  // Routes des relais d'agent (hook et gardien) : jeton du run, aucun cookie, aucune décision humaine possible.
  app.register(
    async (agent) => {
      const token = (req: FastifyRequest) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      agent.post("/runs/:run/pretool", async (req, reply) => {
        const { run } = req.params as { run: string };
        const body = Body.agentTool.parse(req.body);
        try {
          return hub.tasks.agentPreTool(run, token(req), body.tool_name, body.tool_input);
        } catch (err) {
          return reply.code(403).send({ decision: "deny", reason: (err as Error).message });
        }
      });
      agent.post("/runs/:run/permission", async (req, reply) => {
        const { run } = req.params as { run: string };
        const body = Body.agentTool.parse(req.body);
        try {
          return await hub.tasks.agentPermission(run, token(req), body.tool_name, body.tool_input);
        } catch (err) {
          return reply.code(403).send({ behavior: "deny", message: (err as Error).message });
        }
      });
    },
    { prefix: "/api/agent" },
  );

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HumanSessionRequiredError) return reply.code(401).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Requête invalide", details: err.issues });
    if (err instanceof VisionError || err instanceof ProjectError || err instanceof ApprovalError || err instanceof ConversationError || err instanceof TaskError) {
      return reply.code(400).send({ error: err.message });
    }
    if (err instanceof OrchestratorError) return reply.code(502).send({ error: err.message });
    if (err instanceof Error && err.message.startsWith("Un regroupement est déjà en cours")) {
      return reply.code(409).send({ error: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    hub.journal.append({ project: null, actor: { kind: "system" }, type: "server.error", payload: { error: (err as Error).message } });
    return reply.code(500).send({ error: (err as Error).message });
  });

  if (options.webDist && existsSync(join(options.webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: options.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Introuvable" });
    });
  }
  return app;
}

function readSessionCookie(req: FastifyRequest): [string, string] {
  const raw = req.cookies[SESSION_COOKIE] ?? "";
  const dot = raw.indexOf(".");
  if (dot <= 0) throw new HumanSessionRequiredError();
  return [raw.slice(0, dot), raw.slice(dot + 1)];
}

async function authenticate(hub: Hub, allowed: Set<string>, req: FastifyRequest, reply: FastifyReply) {
  let sid: string;
  let secret: string;
  try {
    [sid, secret] = readSessionCookie(req);
  } catch {
    return reply.code(401).send({ error: "Session requise : ouvrez le lien de connexion affiché par le hub" });
  }
  if (!hub.sessions.check(sid, secret)) return reply.code(401).send({ error: "Session expirée : relancez le hub" });
  if (req.method === "GET" || req.method === "HEAD") return;

  const origin = String(req.headers.origin ?? "");
  const originHost = origin.replace(/^https?:\/\//, "").toLowerCase();
  if (!origin || !allowed.has(originHost)) return reply.code(403).send({ error: "Origine non autorisée" });
  const csrf = String(req.headers["x-csrf-token"] ?? "");
  try {
    req.human = hub.sessions.verify(sid, secret, csrf);
  } catch {
    return reply.code(403).send({ error: "Jeton CSRF invalide" });
  }
}
