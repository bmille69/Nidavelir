import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ApprovalEdits, Autonomy, ItemType, ProjectSlug } from "@studio/contracts";
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
import { defaultDocNature } from "../projects/bootstrap.ts";
import { VisionError } from "../vision/vision-service.ts";
import { TaskError } from "../executor/task-service.ts";
import { studioSnapshot } from "../studio/activity.ts";
import { PreviewError } from "../executor/preview.ts";
import { QualityError } from "../quality/quality-service.ts";
import { ConceptionError } from "../conception/conception-service.ts";
import { SkillError } from "../skills/skill-service.ts";

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
    documents: z
      .array(z.union([z.string(), z.object({ path: z.string(), nature: z.enum(["creative", "technical"]) })]))
      .max(50)
      .default([]),
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
  autonomy: z.object({ level: Autonomy }),
  conception: z.object({ kind: z.enum(["project", "feature"]), project: z.string().optional(), idea: z.string().min(1).max(8000) }),
  skill: z.object({
    id: z.string().optional(),
    name: z.string().min(1).max(60),
    description: z.string().max(400),
    body: z.string().max(12000),
    agents: z.array(z.enum(["director", "concepteur", "developer", "qa"])).max(4),
    enabled: z.boolean(),
  }),
  rating: z.object({ rating: z.enum(["up", "down"]), note: z.string().max(500).optional() }),
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
    api.get("/studio", async () => studioSnapshot(hub));
    api.get("/usage", async () => hub.usage.snapshot());
    api.post("/usage/refresh", async () => hub.usage.refresh());
    api.post("/projects/:slug/autonomy", async (req) => {
      const { slug } = req.params as { slug: string };
      return hub.projects.setAutonomy(req.human!, slug, Body.autonomy.parse(req.body).level);
    });
    api.post("/projects/:slug/autonomy/decide-pending", async (req) => {
      const { slug } = req.params as { slug: string };
      if (!hub.autopilot) throw new ProjectError("Le pilote automatique n'est pas activé sur ce hub");
      return hub.autopilot.decidePending(req.human!, slug);
    });
    api.get("/import/suggestions", async () => suggestFolders(options.gamesRoot, hub.projects));
    api.post("/import/browse", async () => ({ path: await options.folderPicker.pick(options.gamesRoot) }));
    api.post("/import/analyze", async (req) => {
      const a = await hub.projects.analyze(Body.analyze.parse(req.body).path);
      // Nature proposée par défaut pour chaque document (modifiable à l'écran avant import).
      return { ...a, document_natures: Object.fromEntries(a.documents.map((d) => [d, defaultDocNature(d)])) };
    });
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
    api.post("/projects/:slug/synthesis/redo", async (req) => {
      const { slug } = req.params as { slug: string };
      hub.projects.get(slug);
      return hub.synthesis.redo(slug, { kind: "human" });
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
      return hub.tasks.list(slug).map((t) => ({
        ...t,
        rating: hub.quality.rating(slug, t.id),
        pending_escalations: pending.filter((e) => e.task === t.id).length,
        cost_usd: hub.tasks.runs(slug, t.id).reduce((n, r) => n + (r.cost_usd ?? 0), 0),
      }));
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
    // ── Compétences (ADR-29) ──
    api.get("/skills", async (req) => {
      const { project } = z.object({ project: z.string().optional() }).parse(req.query);
      if (project) hub.skills.lessons(project);
      return hub.skills.list(project);
    });
    api.post("/skills", async (req) => hub.skills.save(req.human!, Body.skill.parse(req.body)));
    api.post("/skills/:id/delete", async (req) => {
      hub.skills.remove(req.human!, (req.params as { id: string }).id);
      return { deleted: true };
    });
    // ── Conception (ADR-28) ──
    api.get("/conceptions", async () => hub.conceptions.list());
    api.post("/conceptions", async (req) => hub.conceptions.start(req.human!, Body.conception.parse(req.body)));
    api.get("/conceptions/:id", async (req) => {
      const { id } = req.params as { id: string };
      return { conception: hub.conceptions.get(id), messages: hub.conceptions.messages(id) };
    });
    api.post("/conceptions/:id/reply", async (req) => {
      const { id } = req.params as { id: string };
      return hub.conceptions.reply(req.human!, id, Body.message.parse(req.body).text);
    });
    api.post("/conceptions/:id/create-project", async (req) => {
      const { id } = req.params as { id: string };
      return hub.conceptions.createProject(req.human!, id, options.gamesRoot);
    });
    api.post("/conceptions/:id/add-to-project", async (req) => {
      const { id } = req.params as { id: string };
      return hub.conceptions.addToProject(req.human!, id);
    });
    api.post("/projects/:slug/tasks/:id/start", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.tasks.startDirectByHuman(req.human!, slug, id);
    });
    // ── Qualité du workflow (ADR-27) ──
    api.get("/quality", async (req) => hub.quality.report(z.object({ project: z.string().optional() }).parse(req.query).project));
    api.post("/projects/:slug/tasks/:id/rating", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const body = Body.rating.parse(req.body);
      return hub.quality.rate(req.human!, slug, id, body.rating, body.note);
    });
    // ── Essayer le jeu (ADR-25) ──
    api.get("/projects/:slug/previews", async (req) => hub.previews.list((req.params as { slug: string }).slug));
    api.post("/projects/:slug/preview", async (req) => {
      const { slug } = req.params as { slug: string };
      return hub.previews.start(slug, null, hub.projects.get(slug).root);
    });
    api.post("/projects/:slug/tasks/:id/preview", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const task = hub.tasks.get(slug, id);
      if (!task.worktree || !existsSync(task.worktree)) throw new TaskError("Cette version n'existe plus (déjà fusionnée ou abandonnée) : essayez le jeu lui-même.");
      return hub.previews.start(slug, id, task.worktree);
    });
    api.post("/projects/:slug/preview/stop", async (req) => {
      const { slug } = req.params as { slug: string };
      for (const p of hub.previews.list(slug)) await hub.previews.stop(p.key);
      return { stopped: true };
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
    if (err instanceof VisionError || err instanceof ProjectError || err instanceof ApprovalError || err instanceof ConversationError || err instanceof TaskError || err instanceof PreviewError || err instanceof QualityError || err instanceof ConceptionError || err instanceof SkillError) {
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
