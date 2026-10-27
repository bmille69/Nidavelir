import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ApprovalEdits, Autonomy, ItemType, ProjectSlug } from "@studio/contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ApprovalError } from "../approvals/approval-service.ts";
import { HumanSessionRequiredError, PairingError, type HumanSession } from "../auth/human-session.ts";
import { PAIRING_PAGE } from "./pairing-page.ts";
import { ConversationError } from "../conversation/conversation-service.ts";
import { CaptureError } from "../conversation/captures.ts";
import type { Hub } from "../hub.ts";
import { OrchestratorError } from "../orchestrator/port.ts";
import type { FolderPicker } from "../projects/folder-picker.ts";
import { ProjectError } from "../projects/project-registry.ts";
import { suggestFolders } from "../projects/suggestions.ts";
import { defaultDocNature } from "../projects/bootstrap.ts";
import { VisionError } from "../vision/vision-service.ts";
import { TaskError } from "../executor/task-service.ts";
import { studioSnapshot } from "../studio/activity.ts";
import { PENDING_VISUALS, readManifest, type Asset } from "../art/manifest.ts";
import { studioMonitor } from "../studio/monitor.ts";
import { MODEL_CHOICES, MODEL_ROLES, type ModelId } from "../usage/model-service.ts";
import { openInEdge, PreviewError, type Preview } from "../executor/preview.ts";
import { QualityError } from "../quality/quality-service.ts";
import { ConceptionError } from "../conception/conception-service.ts";
import { SkillError } from "../skills/skill-service.ts";
import { ArtError } from "../art/art-service.ts";
import { ReplayError } from "../quality/replays.ts";
import { BalanceError } from "../quality/balance.ts";
import { BenchError } from "../quality/bench.ts";
import { FeelError } from "../quality/feel.ts";
import { ExpressError } from "../express/express-service.ts";
import { ModError } from "../mods/mod-service.ts";
import { gameFile } from "../express/checker.ts";
import { median, taskProgress, touchedFiles } from "../executor/progress.ts";
import { PlayRequest } from "../quality/playtest.ts";

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
  reversePath: z.object({ path: z.string().min(3).max(1000) }),
  reverseRun: z.object({ mode: z.enum(["code", "complet"]) }),
  reverseAsk: z.object({ question: z.string().min(3).max(4000) }),
  reverseSend: z.object({ project: z.string().min(1).max(100) }),
  artMessage: z.object({ text: z.string().min(1).max(20_000) }),
  artUpload: z.object({ for: z.string().regex(/^(moodboard|A-\d{4,})$/), name: z.string().max(200).optional() }),
  artDecide: z.object({ decision: z.enum(["valider", "refaire"]) }),
  artAside: z.object({ aside: z.boolean() }),
  feel: z.object({ moments: z.string().max(400).optional(), intensity: z.enum(["discret", "marque", "genereux"]).optional() }),
  benchCase: z.object({ task: z.string().regex(/^T-\d{4,}$/) }),
  balanceRun: z.object({ runs: z.number().int().min(10).max(2000).optional() }),
  balanceSend: z.object({ question: z.string().max(2000).optional() }),
  replaySave: z.object({ name: z.string().min(1).max(80), note: z.string().max(500).optional() }),
  tripoKey: z.object({ key: z.string().min(8).max(200) }),
  artReact: z.object({
    verdicts: z.record(z.string().max(300), z.enum(["aime", "evite"]).nullable()).refine((v) => Object.keys(v).length <= 100),
    comment: z.string().max(4000).optional(),
    tell: z.boolean().optional(),
  }),
  expressCreate: z.object({ idea: z.string().min(3).max(4000), mode: z.enum(["eclair", "soigne"]) }),
  expressImprove: z.object({ request: z.string().min(3).max(2000) }),
  modCreate: z.object({ appid: z.string().regex(/^\d{1,10}$/), idea: z.string().min(3).max(4000) }),
  modText: z.object({ text: z.string().max(4000).default("") }),
  modApp: z.object({ appid: z.string().regex(/^\d{1,10}$/) }),
  model: z.object({ role: z.enum(MODEL_ROLES), model: z.enum(MODEL_CHOICES.map((c) => c.id) as [ModelId, ...ModelId[]]) }),
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
  agentTool: z.object({ tool_name: z.string().min(1).max(200), tool_input: z.record(z.string(), z.unknown()).default({}), cwd: z.string().max(1000).optional() }),
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
  conception: z.object({ kind: z.enum(["project", "feature"]), project: z.string().optional(), idea: z.string().min(1).max(8000), thread: z.string().optional() }),
  skill: z.object({
    id: z.string().optional(),
    name: z.string().min(1).max(60),
    description: z.string().max(400),
    body: z.string().max(12000),
    agents: z.array(z.enum(["director", "concepteur", "developer", "qa"])).max(4),
    enabled: z.boolean(),
  }),
  push: z.object({ endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string().min(40).max(200), auth: z.string().min(8).max(100) }) }),
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
  // « Transmets » au Concepteur peut créer un nouveau jeu dans la racine des jeux (ADR-34).
  hub.conceptions.gamesRoot = options.gamesRoot;
  hub.express.gamesRoot = options.gamesRoot;
  hub.mods.gamesRoot = options.gamesRoot;
  const fixedHosts = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  // Les hôtes Tailscale (« mon-pc.tail1234.ts.net ») s'ajoutent quand le hub y est publié (ADR-30).
  const allowed = { has: (h: string) => fixedHosts.has(h) || hub.extraHosts.has(h) };

  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowed.has(host)) return reply.code(403).send({ error: "Hôte non autorisé" });
  });

  app.get("/login", async (req, reply) => {
    const token = String((req.query as Record<string, unknown>).token ?? "");
    // Sans jeton : page de connexion d'un téléphone, avec le code affiché sur le PC (ADR-30).
    if (!token) return reply.type("text/html; charset=utf-8").send(PAIRING_PAGE);
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

  app.post("/login/code", async (req, reply) => {
    const originHost = String(req.headers.origin ?? "").replace(/^https?:\/\//, "").toLowerCase();
    if (!allowed.has(originHost)) return reply.code(403).send({ error: "Origine non autorisée" });
    const body = z.object({ code: z.string().regex(/^\d{6}$/, "Le code a 6 chiffres"), name: z.string().max(60).default("Téléphone") }).parse(req.body);
    try {
      const { sessionId, cookie: secret } = hub.sessions.loginWithCode(body.code, body.name);
      // Session durable (90 jours) : le téléphone reste connecté, révocable depuis le PC.
      const https = req.headers["x-forwarded-proto"] === "https" || req.protocol === "https";
      reply.setCookie(SESSION_COOKIE, `${sessionId}.${secret}`, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 90 * 86400, secure: https });
      hub.journal.append({ project: null, actor: { kind: "human" }, type: "device.paired", payload: { device: sessionId, name: body.name } });
      return { ok: true };
    } catch (err) {
      if (err instanceof PairingError) return reply.code(401).send({ error: err.message });
      throw err;
    }
  });

  // Images déposées pour le Directeur artistique (ADR-43) : corps binaire, 15 Mo au plus (au lieu de 256 Ko).
  app.addContentTypeParser(["image/png", "image/jpeg", "image/webp"], { parseAs: "buffer", bodyLimit: 15 * 1024 * 1024 + 1 }, (_req, body, done) => done(null, body));

  app.register(async (api) => {
    api.addHook("preHandler", async (req, reply) => authenticate(hub, allowed, req, reply));

    api.get("/session", async (req) => {
      const [sid, secret] = readSessionCookie(req);
      return { csrf: hub.sessions.csrfFor(sid, secret), orchestrator: hub.orchestrator.name, gamesRoot: options.gamesRoot, device: hub.sessions.isDevice(sid) };
    });

    // ── Projets et import ──
    api.get("/projects", async () => hub.projects.list());
    api.get("/studio", async () => studioSnapshot(hub));
    // Le moniteur (ADR-64) : files, machine, consommation de la dernière heure.
    api.get("/studio/monitor", async () => studioMonitor(hub));
    api.get("/usage", async () => hub.usage.snapshot());
    api.post("/usage/refresh", async () => hub.usage.refresh());
    // ── Studio de modding (ADR-65) ──
    api.get("/mods/games", async () => hub.mods.games());
    api.post("/mods/loader/install", async (req) => (hub.mods.installLoader(req.human!, Body.modApp.parse(req.body).appid), { ok: true }));
    api.post("/mods/loader/remove", async (req) => (await hub.mods.removeLoader(req.human!, Body.modApp.parse(req.body).appid), { ok: true }));
    api.post("/mods/typemap", async (req) => (hub.mods.buildTypemap(req.human!, Body.modApp.parse(req.body).appid), { ok: true }));
    api.get("/mods", async () => ({ mods: hub.mods.list().map((m) => ({ ...m, events: [] })), running: hub.mods.running()?.id ?? null }));
    api.post("/mods", async (req) => {
      const body = Body.modCreate.parse(req.body);
      return hub.mods.create(req.human!, body.appid, body.idea);
    });
    api.get("/mods/:id", async (req) => hub.mods.get((req.params as { id: string }).id));
    api.post("/mods/:id/reply", async (req) => hub.mods.reply(req.human!, (req.params as { id: string }).id, Body.modText.parse(req.body).text));
    api.post("/mods/:id/go", async (req) => hub.mods.go(req.human!, (req.params as { id: string }).id));
    api.post("/mods/:id/install", async (req) => hub.mods.installMod(req.human!, (req.params as { id: string }).id));
    api.post("/mods/:id/uninstall", async (req) => hub.mods.uninstallMod(req.human!, (req.params as { id: string }).id));
    api.post("/mods/:id/played", async (req) => hub.mods.played(req.human!, (req.params as { id: string }).id, Body.modText.parse(req.body).text));
    api.post("/mods/:id/improve", async (req) => hub.mods.improve(req.human!, (req.params as { id: string }).id, Body.modText.parse(req.body).text));
    api.post("/mods/:id/rebuild", async (req) => hub.mods.rebuild(req.human!, (req.params as { id: string }).id));
    api.post("/mods/:id/assets/:file/redraw", async (req) => {
      const { id, file } = req.params as { id: string; file: string };
      return hub.mods.redraw(req.human!, id, file, Body.modText.parse(req.body).text);
    });
    api.get("/mods/:id/assets/:file", async (req, reply) => {
      const { id, file } = req.params as { id: string; file: string };
      return reply.header("cache-control", "no-store").type("image/png").send(readFileSync(hub.mods.assetPath(id, file)));
    });
    api.post("/mods/:id/cancel", async (req) => {
      hub.mods.cancel((req.params as { id: string }).id);
      return { ok: true };
    });
    api.post("/mods/:id/hide", async (req) => {
      hub.mods.hide(req.human!, (req.params as { id: string }).id);
      return { ok: true };
    });

    // ── Jeu express (ADR-44) ──
    api.get("/express", async () => ({ games: hub.express.list().map((g) => ({ ...g, events: [] })), running: hub.express.running()?.id ?? null }));
    api.post("/express", async (req) => {
      const body = Body.expressCreate.parse(req.body);
      return hub.express.create(req.human!, body.idea, body.mode);
    });
    api.get("/express/:id", async (req) => hub.express.get((req.params as { id: string }).id));
    api.post("/express/:id/improve", async (req) => hub.express.improve(req.human!, (req.params as { id: string }).id, Body.expressImprove.parse(req.body).request));
    api.post("/express/:id/cancel", async (req) => {
      hub.express.cancel((req.params as { id: string }).id);
      return { ok: true };
    });
    api.post("/express/:id/hide", async (req) => {
      hub.express.hide(req.human!, (req.params as { id: string }).id);
      return { ok: true };
    });
    api.post("/express/:id/promote", async (req) => hub.express.promote(req.human!, (req.params as { id: string }).id));
    api.get("/express/:id/shot", async (req, reply) => {
      const file = hub.express.shotPath((req.params as { id: string }).id);
      if (!existsSync(file)) return reply.code(404).send({ error: "Pas encore de capture" });
      return reply.type("image/png").header("cache-control", "private, max-age=30").send(readFileSync(file));
    });
    // Le jeu lui-même, servi par le hub : jouable aussitôt, sur le PC comme sur le téléphone.
    api.get("/express/:id/play/*", async (req, reply) => {
      const { id, "*": rel } = req.params as { id: string; "*": string };
      const g = hub.express.get(id);
      const f = g.root ? gameFile(g.root, rel) : null;
      if (!f) return reply.code(404).send({ error: "Fichier introuvable" });
      return reply.type(f.mime).header("cache-control", "no-store").send(readFileSync(f.path));
    });
    // ── Directeur artistique (ADR-43) ──
    api.get("/projects/:slug/art", async (req) => hub.art.state((req.params as { slug: string }).slug));
    api.post("/projects/:slug/art/messages", async (req) => hub.art.send(req.human!, (req.params as { slug: string }).slug, Body.artMessage.parse(req.body).text));
    api.post("/projects/:slug/art/images", async (req) => {
      const { slug } = req.params as { slug: string };
      const q = Body.artUpload.parse(req.query);
      if (!Buffer.isBuffer(req.body)) throw new ArtError("Envoyez une image (PNG, JPEG ou WebP)");
      return hub.art.upload(req.human!, slug, q.for, req.body, String(req.headers["content-type"] ?? "").split(";")[0]!.trim(), q.name);
    });
    api.post("/projects/:slug/art/assets/:id/decide", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.art.decide(req.human!, slug, id, Body.artDecide.parse(req.body).decision);
    });
    api.post("/projects/:slug/art/assets/:id/generate", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.art.generate(req.human!, slug, id);
    });
    api.post("/art/generator/install", async (req) => hub.art.installGenerator(req.human!));
    api.post("/art/kontext/install", async (req) => hub.art.installKontext(req.human!));
    api.post("/art/blender/install", async (req) => hub.art.installBlender(req.human!));
    api.post("/art/tripo/key", async (req) => hub.art.setTripoKey(req.human!, Body.tripoKey.parse(req.body).key));
    // Votre avis sur les références d'une planche (ADR-58).
    api.post("/projects/:slug/art/references", async (req) => hub.art.react(req.human!, (req.params as { slug: string }).slug, Body.artReact.parse(req.body)));
    api.post("/projects/:slug/art/assets/:id/model", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.art.generateModel(req.human!, slug, id);
    });
    api.post("/projects/:slug/art/assets/:id/retouch", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.art.retouchModel(req.human!, slug, id);
    });
    // La file des visuels (ADR-62) : lancer un visuel avant son tour, le mettre de côté ou l'y remettre.
    api.post("/projects/:slug/art/assets/:id/launch", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.art.launch(req.human!, slug, id);
    });
    api.post("/projects/:slug/art/assets/:id/aside", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.art.setAside(req.human!, slug, id, Body.artAside.parse(req.body).aside);
    });
    api.post("/projects/:slug/art/assets/:id/integrate", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.art.integrate(req.human!, slug, id);
    });
    // Plafond par visuel (ADR-82) : seul votre clic le relève.
    api.post("/projects/:slug/art/assets/:id/budget", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.art.raiseBudget(req.human!, slug, id);
    });
    // Le bilan des visuels (ADR-71) : la liste face aux fichiers du jeu et à ce qu'il charge.
    api.get("/projects/:slug/art/bilan", async (req) => hub.art.bilan((req.params as { slug: string }).slug));
    api.post("/projects/:slug/art/bilan/verify", async (req) => hub.art.verifyBilan(req.human!, (req.params as { slug: string }).slug));
    // Contrôle des vitrines (ADR-84) : comparer tout de suite, ou accepter un nouvel aspect.
    api.post("/projects/:slug/art/looks/check", async (req) => hub.art.checkLooks(req.human!, (req.params as { slug: string }).slug));
    api.post("/projects/:slug/art/assets/:id/look/accept", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.art.acceptLook(req.human!, slug, id);
    });
    api.post("/projects/:slug/art/assets/:id/reintegrate", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.art.reintegrate(req.human!, slug, id);
    });
    api.get("/projects/:slug/art/atelier/:id/:name", async (req, reply) => {
      const { slug, id, name } = req.params as { slug: string; id: string; name: string };
      const f = hub.art.atelierFile(slug, id, name);
      return reply.type(f.mime).header("cache-control", "private, max-age=60").send(readFileSync(f.path));
    });
    api.get("/projects/:slug/art/files/*", async (req, reply) => {
      const { slug, "*": rel } = req.params as { slug: string; "*": string };
      const f = hub.art.file(slug, decodeURIComponent(rel));
      return reply.type(f.mime).header("cache-control", "private, max-age=60").send(readFileSync(f.path));
    });
    // ── Atelier de démontage (ADR-40) ──
    api.get("/reverse", async () => ({ dissections: hub.reverse.list(), tools: hub.reverse.tools() }));
    api.post("/reverse/browse", async () => ({ path: await options.folderPicker.pick(options.gamesRoot) }));
    api.post("/reverse/scan", async (req) => hub.reverse.scan(Body.reversePath.parse(req.body).path));
    api.post("/reverse", async (req) => hub.reverse.create(req.human!, Body.reversePath.parse(req.body).path));
    api.post("/reverse/tools/:tool/install", async (req) => hub.reverse.installTool(req.human!, (req.params as { tool: string }).tool));
    api.get("/reverse/:id", async (req) => hub.reverse.get((req.params as { id: string }).id));
    api.post("/reverse/:id/run", async (req) => hub.reverse.run(req.human!, (req.params as { id: string }).id, Body.reverseRun.parse(req.body).mode));
    api.post("/reverse/:id/cancel", async (req) => {
      hub.reverse.cancel((req.params as { id: string }).id);
      return { ok: true };
    });
    api.post("/reverse/:id/ask", async (req) => hub.reverse.ask(req.human!, (req.params as { id: string }).id, Body.reverseAsk.parse(req.body).question));
    api.post("/reverse/:id/notes/:note/send", async (req) => {
      const { id, note } = req.params as { id: string; note: string };
      return hub.reverse.send(req.human!, id, Number(note), Body.reverseSend.parse(req.body).project);
    });
    api.post("/reverse/:id/mod", async (req) => hub.reverse.createMod(req.human!, (req.params as { id: string }).id, options.gamesRoot));
    api.post("/studio/models", async (req) => {
      const { role, model } = Body.model.parse(req.body);
      return hub.models.set(role, model);
    });
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
      // La chaîne de production (ADR-64) : rang réel dans la file, chantier repris après un redémarrage, visuels attendus.
      const queue = hub.tasks.queued(slug).map((t) => t.id);
      const restarted = new Map(
        hub.journal
          .list({ project: slug, limit: 2000, latest: true })
          .filter((e) => e.type === "task.restarted" && e.subject)
          .map((e) => [e.subject!, String((e.payload as { interrupted?: string }).interrupted ?? "")]),
      );
      let assets: Asset[] = [];
      try {
        assets = readManifest(hub.projects.get(slug).root).assets;
      } catch {
        /* pas de manifeste */
      }
      const visual = (id: string) => {
        const a = assets.find((x) => x.id === id);
        return a ? { id, name: a.name, status: a.status, launched: !!a.launchedAt } : null;
      };
      const visualsOf = (t: { title: string; goal: string }) => {
        const own = /^A-\d{4,}/.exec(t.title)?.[0];
        const ids = own ? [own] : t.goal.includes(PENDING_VISUALS) ? [...t.goal.matchAll(/\n- (A-\d{4,}) «/g)].map((m) => m[1]!) : [];
        return ids.map(visual).filter((v) => v !== null);
      };
      const list = hub.tasks.list(slug);
      const runsOf = new Map(list.map((t) => [t.id, hub.tasks.runs(slug, t.id)]));
      // La barre de progression (refonte du pilotage) : estimée par le hub, sans appel à un modèle.
      const typicalMs = median(
        [...runsOf.values()].flat().filter((r) => r.kind === "execute" && r.status === "done" && r.finished_at).map((r) => Date.parse(r.finished_at!) - Date.parse(r.started_at)),
      );
      const progressOf = (t: (typeof list)[number]) => {
        if (!["planning", "plan_review", "approved", "running", "review"].includes(t.status)) return null;
        const runs = runsOf.get(t.id) ?? [];
        const exec = runs.filter((r) => r.kind === "execute").at(-1);
        let steps: { files: string[] }[] | null = null;
        try {
          steps = t.plan ? hub.tasks.plan(slug, t.plan).steps : null;
        } catch {
          /* plan illisible */
        }
        const touched = exec?.status === "running" ? touchedFiles(hub.tasks.events(exec.id)) : [];
        return taskProgress({ status: t.status, runs, steps, touched, now: Date.now(), typicalMs });
      };
      return list.map((t) => ({
        ...t,
        progress: progressOf(t),
        queue_rank: queue.indexOf(t.id) >= 0 ? queue.indexOf(t.id) + 1 : null,
        restarted_from: restarted.get(t.id) || null,
        visuals: visualsOf(t),
        rating: hub.quality.rating(slug, t.id),
        pending_escalations: pending.filter((e) => e.task === t.id).length,
        cost_usd: (runsOf.get(t.id) ?? []).reduce((n, r) => n + (r.cost_usd ?? 0), 0),
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
    // ── Téléphone (ADR-30) ──
    api.get("/remote/status", async () => (hub.remote ? hub.remote.status() : { tailscale: "absent", dnsName: null, serving: false, url: null, message: "Indisponible dans ce mode" }));
    api.post("/remote/enable", async (req) => {
      if (!hub.remote) throw new ProjectError("Accès à distance indisponible");
      return hub.remote.enable(req.human!);
    });
    api.post("/remote/disable", async (req) => {
      if (!hub.remote) throw new ProjectError("Accès à distance indisponible");
      return hub.remote.disable(req.human!);
    });
    api.post("/devices/pairing", async (req) => hub.sessions.createPairingCode(req.human!));
    api.get("/devices", async (req) => {
      const [sid] = readSessionCookie(req);
      const rows = hub.db.prepare("SELECT id, name, created_at, last_seen FROM devices ORDER BY created_at").all() as { id: string; name: string; created_at: string; last_seen: string }[];
      return rows.map((d) => ({ ...d, current: d.id === sid }));
    });
    api.post("/devices/:id/revoke", async (req) => {
      const { id } = req.params as { id: string };
      hub.sessions.revoke(req.human!, id);
      hub.notifications.forgetDevice(id);
      hub.journal.append({ project: null, actor: { kind: "human" }, type: "device.revoked", payload: { device: id } });
      return { revoked: true };
    });
    api.get("/push/key", async () => ({ key: hub.notifications.publicKey() }));
    api.post("/push/subscribe", async (req) => {
      const [sid] = readSessionCookie(req);
      hub.notifications.subscribe(req.human!, Body.push.parse(req.body), hub.sessions.isDevice(sid) ? sid : null);
      return { subscribed: true };
    });
    api.post("/push/unsubscribe", async (req) => {
      hub.notifications.unsubscribe(req.human!, z.object({ endpoint: z.string().url() }).parse(req.body).endpoint);
      return { unsubscribed: true };
    });
    api.post("/push/test", async () => {
      hub.notifications.notify({ title: "Nidavellir", body: "Les notifications fonctionnent sur cet appareil.", url: "#/", tag: "test" });
      return { sent: hub.notifications.list().length };
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
    // Depuis l'ordinateur, le hub ouvre lui-même le jeu dans Edge ; depuis un téléphone, rien ne s'ouvre sur le PC.
    const openPreview = (req: FastifyRequest, p: Preview) => {
      const [sid] = readSessionCookie(req);
      // Un jeu Godot s'ouvre dans sa fenêtre, sur le PC, d'où que vienne la demande (ADR-73).
      return { ...p, opened: p.desktop ? true : !hub.sessions.isDevice(sid) && openInEdge(p.url) };
    };
    api.post("/projects/:slug/preview", async (req) => {
      const { slug } = req.params as { slug: string };
      const root = hub.projects.get(slug).root;
      // Un jeu Godot reçoit d'abord les outils du studio à jour : le relais enregistre votre partie (ADR-85).
      await hub.tasks.refreshGodotTools(root).catch(() => {});
      return openPreview(req, await hub.previews.start(slug, null, root, hub.replays.recordPath(slug, null, root)));
    });
    api.post("/projects/:slug/tasks/:id/preview", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const task = hub.tasks.get(slug, id);
      if (!task.worktree || !existsSync(task.worktree)) throw new TaskError("Cette version n'existe plus (déjà fusionnée ou abandonnée) : essayez le jeu lui-même.");
      return openPreview(req, await hub.previews.start(slug, id, task.worktree, hub.replays.recordPath(slug, id, task.worktree)));
    });
    // La passe « game feel » (ADR-88).
    api.post("/projects/:slug/feel", async (req) => {
      const { slug } = req.params as { slug: string };
      return hub.feel.start(req.human!, slug, Body.feel.parse(req.body));
    });
    // Le banc d'essai des agents (ADR-87).
    api.get("/projects/:slug/bench", async (req) => hub.bench.state((req.params as { slug: string }).slug));
    api.post("/projects/:slug/bench/cases", async (req) => {
      const { slug } = req.params as { slug: string };
      return hub.bench.addCase(req.human!, slug, Body.benchCase.parse(req.body).task);
    });
    api.delete("/projects/:slug/bench/cases/:id", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      hub.bench.removeCase(req.human!, slug, id);
      return { ok: true };
    });
    api.post("/projects/:slug/bench/run", async (req) => hub.bench.start(req.human!, (req.params as { slug: string }).slug));
    // L'équilibreur (ADR-86) : des centaines de parties simulées sans écran, puis le directeur sur votre demande.
    api.get("/projects/:slug/balance", async (req) => hub.balance.state((req.params as { slug: string }).slug));
    api.post("/projects/:slug/balance/run", async (req) => {
      const { slug } = req.params as { slug: string };
      return hub.balance.start(req.human!, slug, Body.balanceRun.parse(req.body).runs);
    });
    api.post("/projects/:slug/balance/:id/send", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.balance.send(req.human!, slug, Number(id), Body.balanceSend.parse(req.body).question ?? "");
    });
    // Vos parties enregistrées, et celles gardées comme tests (ADR-85).
    api.get("/projects/:slug/replays", async (req) => {
      const { slug } = req.params as { slug: string };
      return { recordings: hub.replays.recordings(slug), saved: hub.replays.saved(slug) };
    });
    api.post("/projects/:slug/recordings/:id/save", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const body = Body.replaySave.parse(req.body);
      return hub.replays.save(req.human!, slug, id, body);
    });
    api.post("/projects/:slug/recordings/:id/delete", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      hub.replays.remove(req.human!, slug, id);
      return { ok: true };
    });
    api.post("/projects/:slug/replays/:file/delete", async (req) => {
      const { slug, file } = req.params as { slug: string; file: string };
      await hub.replays.unsave(req.human!, slug, file);
      return { ok: true };
    });
    // Carnet « État du jeu » (ADR-33).
    api.get("/projects/:slug/game-state", async (req) => {
      const { slug } = req.params as { slug: string };
      hub.projects.get(slug);
      return hub.gameState.get(slug) ?? { project: slug, text: null, updated_at: null, task: null };
    });
    // Capture du jeu prise par le hub avant le testeur (ADR-33).
    api.get("/projects/:slug/tasks/:id/screenshot", async (req, reply) => {
      const { slug, id } = req.params as { slug: string; id: string };
      hub.tasks.get(slug, id);
      const file = hub.checks?.screenshotPath(slug, id);
      if (!file || !existsSync(file)) return reply.code(404).send({ error: "Pas de capture pour ce chantier" });
      return reply.type("image/png").header("cache-control", "private, max-age=300").send(readFileSync(file));
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
    api.post("/projects/:slug/threads/:id/rename", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.conversations.renameThread(slug, id, Body.thread.parse(req.body ?? {}).title);
    });
    api.get("/projects/:slug/threads/:id/messages", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.conversations.messages(slug, id);
    });
    api.post("/projects/:slug/threads/:id/messages", async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      return hub.conversations.send(slug, id, Body.message.parse(req.body).text);
    });
    // Les captures annotées jointes à un message (ADR-72) : enregistrées et commitées dans studio/captures du jeu.
    api.post("/projects/:slug/captures", async (req) => {
      if (!Buffer.isBuffer(req.body)) throw new CaptureError("Envoyez une image (PNG, JPEG ou WebP)");
      return hub.captures.save((req.params as { slug: string }).slug, req.body, String(req.headers["content-type"] ?? "").split(";")[0]!.trim());
    });
    api.get("/projects/:slug/captures/:name", async (req, reply) => {
      const { slug, name } = req.params as { slug: string; name: string };
      const f = hub.captures.file(slug, name);
      return reply.type(f.mime).header("cache-control", "private, max-age=3600").send(readFileSync(f.path));
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
          if (hub.express.owns(run)) return hub.express.agentPreTool(run, token(req), body.tool_name, body.tool_input, body.cwd);
          if (hub.mods.owns(run)) return hub.mods.agentPreTool(run, token(req), body.tool_name, body.tool_input, body.cwd);
          return hub.tasks.agentPreTool(run, token(req), body.tool_name, body.tool_input, body.cwd);
        } catch (err) {
          return reply.code(403).send({ decision: "deny", reason: (err as Error).message });
        }
      });
      // La manette du testeur (ADR-69) : seulement pour un run de vérification de chantier.
      agent.post("/runs/:run/play", async (req, reply) => {
        const { run } = req.params as { run: string };
        const parsed = PlayRequest.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(" ; ") });
        try {
          return await hub.tasks.agentPlay(run, token(req), parsed.data);
        } catch (err) {
          return reply.code(403).send({ error: (err as Error).message });
        }
      });
      agent.post("/runs/:run/permission", async (req, reply) => {
        const { run } = req.params as { run: string };
        const body = Body.agentTool.parse(req.body);
        try {
          if (hub.express.owns(run)) return await hub.express.agentPermission(run, token(req), body.tool_name, body.tool_input);
          if (hub.mods.owns(run)) return await hub.mods.agentPermission(run, token(req), body.tool_name, body.tool_input);
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
    if (err instanceof VisionError || err instanceof ProjectError || err instanceof ApprovalError || err instanceof ConversationError || err instanceof CaptureError || err instanceof TaskError || err instanceof PreviewError || err instanceof QualityError || err instanceof ConceptionError || err instanceof SkillError || err instanceof ArtError || err instanceof ExpressError || err instanceof ModError || err instanceof ReplayError || err instanceof BalanceError || err instanceof BenchError || err instanceof FeelError) {
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

async function authenticate(hub: Hub, allowed: { has(h: string): boolean }, req: FastifyRequest, reply: FastifyReply) {
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
