import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildChatArgs, type TeamGrant } from "../src/llm/claude-cli.ts";
import type { OrchestratorPort } from "../src/orchestrator/port.ts";
import { buildServer, SESSION_COOKIE } from "../src/server/http.ts";
import { GameReader } from "../src/team/game-reader.ts";
import { CONSULT_MARK, compactMarks, MEMORY_MARK, normalizeAgent } from "../src/team/team-service.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, sandbox, type Sandbox } from "./helpers.ts";

/**
 * Orchestrateur scripté qui joue un agent avec ses outils d'équipe : quand un appel reçoit un accès (team), il appelle
 * les outils comme le ferait Claude Code par MCP, puis répond. Les appels sans accès (collègue consulté) répondent seuls.
 */
class TeamFake extends FakeOrchestrator {
  hub: Sandbox["hub"] | null = null;
  /** Ce que l'agent fait avec ses outils, dans l'ordre : [outil, arguments]. */
  script: [string, Record<string, unknown>][] = [];
  results: string[] = [];
  grants: TeamGrant[] = [];
  consulted: { systemPrompt: string; prompt: string; lane?: string }[] = [];

  async #play(team?: TeamGrant) {
    if (!team || !this.hub) return;
    this.grants.push(team);
    const rpc = (method: string, params: object = {}) => this.hub!.team.handle(team.token, { jsonrpc: "2.0", id: Math.random(), method, params });
    await rpc("initialize", { protocolVersion: "2025-06-18" });
    for (const [name, args] of this.script.splice(0)) {
      const out = (await rpc("tools/call", { name, arguments: args })) as { result: { content: { text: string }[]; isError?: boolean } };
      this.results.push(`${out.result.isError ? "ERREUR " : ""}${out.result.content[0]!.text}`);
    }
  }

  override async reply(input: Parameters<OrchestratorPort["reply"]>[0]) {
    if (input.lane === "team") {
      this.consulted.push({ systemPrompt: input.systemPrompt, prompt: input.prompt, lane: input.lane });
      return { text: "Magenta et cyan sur fond nuit, contours épais.", costUsd: 0.001 };
    }
    await this.#play(input.team);
    return super.reply(input);
  }

  override async structured(input: Parameters<OrchestratorPort["structured"]>[0]) {
    await this.#play(input.team);
    return super.structured(input);
  }
}

const P = "neon";
let sb: Sandbox;
let fake: TeamFake;
let root: string;

beforeEach(async () => {
  fake = new TeamFake();
  sb = sandbox(fake);
  fake.hub = sb.hub;
  root = sb.makeGameRepo("neon", { "README.md": "# Neon\n", "scripts/player.gd": "extends Node\nconst SPEED = 7.5\n", ".env": "SECRET=1\n" });
  await sb.hub.projects.register(sb.human(), { path: root, slug: P, name: "Néon Saloon" });
  sb.hub.team.baseUrl = () => "http://127.0.0.1:4317/api/agent/team";
});
afterEach(cleanupSandboxes);

describe("outils de l'équipe dans Claude Code (ADR-98)", () => {
  it("avec un accès : serveur MCP du hub seul, outils nommés, sans --safe-mode (qui coupe les serveurs MCP)", () => {
    const args = buildChatArgs({ systemPrompt: "", prompt: "", model: "m", team: { url: "http://127.0.0.1:4317/api/agent/team", token: "t0k", tools: ["consulter", "retenir"] } }, "sys.txt");
    expect(args).not.toContain("--safe-mode");
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    const cfg = JSON.parse(args[args.indexOf("--mcp-config") + 1]!);
    expect(cfg).toEqual({ mcpServers: { studio: { type: "http", url: "http://127.0.0.1:4317/api/agent/team", headers: { Authorization: "Bearer t0k" } } } });
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__studio__consulter,mcp__studio__retenir");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("40");
  });

  it("sans accès : rien ne change (--safe-mode, aucun serveur MCP)", () => {
    const args = buildChatArgs({ systemPrompt: "", prompt: "", model: "m", tools: ["WebSearch"] }, "sys.txt");
    expect(args).toContain("--safe-mode");
    expect(args).not.toContain("--mcp-config");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("WebSearch");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("16");
  });

  it("avec un dossier à lire et la recherche web, les outils de l'équipe s'ajoutent aux autorisations", () => {
    const args = buildChatArgs({ systemPrompt: "", prompt: "", model: "m", readDir: "C:/x", tools: ["WebSearch", "WebFetch"], team: { url: "u", token: "t", tools: ["lire_fichier"] } }, "s");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("WebSearch,WebFetch,mcp__studio__lire_fichier");
    expect(args.filter((a) => a === "--setting-sources")).toHaveLength(1);
  });
});

describe("le serveur MCP de l'équipe", () => {
  it("refuse un jeton inconnu ; liste seulement les outils du tour ; oublie le jeton à la fin du tour", async () => {
    await expect(sb.hub.team.handle("faux", { jsonrpc: "2.0", id: 1, method: "tools/list" })).rejects.toThrow(/inconnu/);
    const turn = sb.hub.team.open(P, "da", { consult: true })!;
    const init = (await sb.hub.team.handle(turn.grant.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe("2025-11-25");
    expect(await sb.hub.team.handle(turn.grant.token, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = (await sb.hub.team.handle(turn.grant.token, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["consulter"]);
    const refused = (await sb.hub.team.handle(turn.grant.token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lire_fichier", arguments: { chemin: "README.md" } } })) as { result: { isError: boolean } };
    expect(refused.result.isError).toBe(true);
    turn.close();
    await expect(sb.hub.team.handle(turn.grant.token, { jsonrpc: "2.0", id: 4, method: "tools/list" })).rejects.toThrow(/inconnu/);
  });

  it("sans adresse de serveur ou éteinte, aucun outil : les agents travaillent comme avant", () => {
    sb.hub.team.baseUrl = null;
    expect(sb.hub.team.open(P, "directeur", { consult: true })).toBeNull();
    sb.hub.team.baseUrl = () => "u";
    sb.hub.team.enabled = false;
    expect(sb.hub.team.open(P, "directeur", { consult: true })).toBeNull();
  });

  it("reconnaît les collègues sous leurs noms courants", () => {
    expect(normalizeAgent("DA")).toBe("da");
    expect(normalizeAgent("le Directeur artistique")).toBe("da");
    expect(normalizeAgent("directeur sonore")).toBe("son");
    expect(normalizeAgent("Concepteur")).toBe("concepteur");
    expect(normalizeAgent("QA")).toBe("testeur");
    expect(normalizeAgent("le Directeur")).toBe("directeur");
    expect(normalizeAgent("comptable")).toBeNull();
  });
});

describe("le directeur consulte un collègue, lit le jeu et propose un souvenir", () => {
  it("la réponse du DA revient pendant le tour, l'échange est gardé et montré sous le message", async () => {
    mkdirSync(join(root, "studio", "art"), { recursive: true });
    writeFileSync(join(root, "studio", "art", "bible.md"), "# Bible\nWestern néon, magenta et cyan.\n");
    fake.script = [
      ["consulter", { agent: "da", question: "Quelle palette pour les enseignes du saloon ?", contexte: "Le directeur créatif veut des enseignes lumineuses." }],
      ["lire_fichier", { chemin: "scripts/player.gd" }],
      ["lire_fichier", { chemin: ".env" }],
      ["lire_fichier", { chemin: "../hub/.data/hub.db" }],
      ["chercher", { motif: "SPEED" }],
      ["retenir", { souvenir: "Il déteste les rendus photoréalistes, dans tous ses jeux.", pourquoi: "Il l'a dit en parlant du saloon." }],
    ];
    fake.replies.push("Le DA conseille magenta et cyan ; le joueur va à 7,5.");
    const t = sb.hub.conversations.createThread(P, "Saloon");
    const { director } = await sb.hub.conversations.send(P, t.id, "Je veux des enseignes lumineuses. Et je déteste le photoréalisme, dans tous mes jeux.");

    // Le tour du directeur avait ses outils et ses consignes d'équipe.
    expect(fake.grants[0]!.tools).toEqual(["consulter", "retenir", "lire_fichier", "lister", "chercher"]);
    const directorCall = fake.calls.find((c) => c.kind === "reply" && c.systemPrompt.includes("<outils_de_l_equipe>"));
    expect(directorCall).toBeTruthy();
    // Le DA consulté a répondu avec son propre contexte (sa bible), dans sa propre file.
    expect(fake.consulted).toHaveLength(1);
    expect(fake.consulted[0]!.systemPrompt).toMatch(/DIRECTEUR ARTISTIQUE/);
    expect(fake.consulted[0]!.systemPrompt).toMatch(/Western néon, magenta et cyan/);
    expect(fake.consulted[0]!.prompt).toMatch(/enseignes lumineuses/);
    expect(fake.results[0]).toMatch(/^Le Directeur artistique répond :\nMagenta et cyan/);
    // Lecture du jeu : le fichier oui, les secrets et l'extérieur non.
    expect(fake.results[1]).toMatch(/SPEED = 7\.5/);
    expect(fake.results[2]).toMatch(/^ERREUR Fichier sensible/);
    expect(fake.results[3]).toMatch(/^ERREUR Chemin hors du jeu/);
    expect(fake.results[4]).toMatch(/scripts\/player\.gd:2/);
    expect(fake.results[5]).toMatch(/Proposé/);

    // Le message montre l'encart de consultation et le souvenir proposé ; le texte affiché reste celui du directeur.
    expect(director.text.startsWith("Le DA conseille magenta et cyan")).toBe(true);
    const consult = director.text.split("\n").find((l) => l.startsWith(CONSULT_MARK))!;
    expect(JSON.parse(consult.slice(CONSULT_MARK.length))).toMatchObject({ from: "directeur", to: "da", ok: true, answer: "Magenta et cyan sur fond nuit, contours épais." });
    expect(director.text).toContain(MEMORY_MARK);
    expect(sb.hub.team.list(P)).toHaveLength(1);
    const pending = sb.hub.memory.list().filter((m) => m.status === "proposed");
    expect(pending.map((m) => [m.text, m.by, m.project])).toEqual([["Il déteste les rendus photoréalistes, dans tous ses jeux.", "directeur", P]]);
    // Le jeton du tour ne sert plus.
    await expect(sb.hub.team.handle(fake.grants[0]!.token, { jsonrpc: "2.0", id: 9, method: "tools/list" })).rejects.toThrow();

    // Au tour suivant, le directeur relit l'échange en une ligne lisible, pas le JSON.
    fake.replies.push("D'accord.");
    await sb.hub.conversations.send(P, t.id, "Ok");
    const next = fake.calls.filter((c) => c.kind === "reply" && c.systemPrompt.includes("<outils_de_l_equipe>")).at(-1)!;
    expect(next.prompt).toMatch(/\[Consultation — le Directeur artistique a été consulté/);
    expect(next.prompt).not.toContain(CONSULT_MARK);
  });

  it("trois consultations au plus par réponse, et jamais soi-même", async () => {
    fake.script = [
      ["consulter", { agent: "directeur", question: "Je me demande moi-même ?" }],
      ["consulter", { agent: "da", question: "Question une ?" }],
      ["consulter", { agent: "son", question: "Question deux ?" }],
      ["consulter", { agent: "testeur", question: "Question trois ?" }],
      ["consulter", { agent: "concepteur", question: "Question quatre ?" }],
    ];
    const t = sb.hub.conversations.createThread(P, "x");
    await sb.hub.conversations.send(P, t.id, "Fais le point.");
    expect(fake.results[0]).toMatch(/^ERREUR Tu ne peux pas te consulter/);
    expect(fake.results.slice(1, 4).every((r) => / répond :\n/.test(r))).toBe(true);
    expect(fake.results[4]).toMatch(/^ERREUR Déjà 3 consultations/);
  });
});

describe("le Concepteur et le DA ont aussi leurs outils d'équipe", () => {
  it("le Concepteur d'un nouveau jeu consulte le DA (sans projet) ; l'encart suit sa réponse", async () => {
    fake.script = [["consulter", { agent: "da", question: "Un style néon western tient-il en 2D ?" }]];
    fake.extractions.push({
      reply: "J'ai demandé au DA : c'est faisable en 2D.",
      questions: [],
      title: "Néon Saloon",
      engine: "web",
      dossier: "# Néon Saloon",
      chantiers: [],
      ready: false,
      claude_md: "",
      sources: [],
    } as never);
    const c = sb.hub.conceptions.start(sb.human(), { kind: "project", idea: "Un saloon néon" });
    await sb.hub.conceptions.idle();
    expect(fake.grants.at(-1)!.tools).toEqual(["consulter", "retenir"]);
    expect(fake.consulted[0]!.systemPrompt).toMatch(/Aucun projet n'est encore créé/);
    const msg = sb.hub.conceptions.messages(c.id).at(-1)!;
    expect(msg.text.startsWith("J'ai demandé au DA")).toBe(true);
    expect(msg.text).toContain(CONSULT_MARK);
    expect(sb.hub.team.list(null)[0]).toMatchObject({ from: "concepteur", to: "da", project: null });
  });

  it("le DA consulte le Concepteur, avec la lecture du jeu", async () => {
    fake.script = [["consulter", { agent: "concepteur", question: "Combien d'ennemis différents prévois-tu ?" }]];
    fake.replies.push("Le Concepteur prévoit trois ennemis : je propose trois silhouettes.");
    sb.hub.art.send(sb.human(), P, "Propose les ennemis");
    await sb.hub.art.idle();
    expect(fake.grants.at(-1)!.tools).toEqual(["consulter", "retenir", "lire_fichier", "lister", "chercher"]);
    const last = sb.hub.art.messages(P).at(-1)!;
    expect(last.text).toContain(CONSULT_MARK);
    expect(sb.hub.team.list(P)[0]).toMatchObject({ from: "da", to: "concepteur" });
  });
});

describe("la mémoire du studio (ADR-99)", () => {
  it("rien n'entre sans vous ; gardé, il est lu par tous les agents ; refusé, il n'est plus reproposé", async () => {
    const s = sb.hub.memory.propose({ text: "Jamais de rendu simpliste pour ce qui se voit de près.", by: "da", project: P });
    expect(s.memory!.status).toBe("proposed");
    expect(sb.hub.memory.block()).toBe("");
    expect(sb.hub.memory.propose({ text: "jamais de rendu SIMPLISTE pour ce qui se voit de près", by: "directeur", project: P }).memory).toBeNull();

    sb.hub.memory.decide(sb.human(), s.memory!.id, true);
    expect(sb.hub.memory.block()).toMatch(/Jamais de rendu simpliste/);

    const t = sb.hub.conversations.createThread(P, "x");
    await sb.hub.conversations.send(P, t.id, "Bonjour");
    const call = fake.calls.find((c) => c.kind === "reply" && c.systemPrompt.includes("<outils_de_l_equipe>"))!;
    expect(call.systemPrompt).toMatch(/<memoire_du_studio[^>]*>\n- Jamais de rendu simpliste/);

    const r = sb.hub.memory.propose({ text: "Toujours des menus en anglais.", by: "concepteur", project: null });
    sb.hub.memory.decide(sb.human(), r.memory!.id, false);
    expect(sb.hub.memory.propose({ text: "Toujours des menus en anglais.", by: "concepteur", project: null }).note).toMatch(/déjà refusé/);
    expect(() => sb.hub.memory.decide(sb.human(), r.memory!.id, true)).toThrow(/n'attend pas/);
  });

  it("la mémoire entre aussi dans les consignes du développeur et du testeur", () => {
    sb.hub.memory.add(sb.human(), "Toujours tester sur manette.");
    expect(sb.hub.tasks.studioMemory?.()).toMatch(/Toujours tester sur manette/);
  });
});

describe("la lecture du jeu", () => {
  it("lit, liste et cherche dans le jeu, jamais .git, les secrets ni l'extérieur", () => {
    const r = new GameReader(root);
    expect(r.read("scripts/player.gd")).toMatch(/2\tconst SPEED = 7\.5/);
    expect(r.list(".")).toMatch(/scripts\//);
    expect(r.list(".")).not.toMatch(/\.env|\.git\//);
    expect(() => r.read(".env")).toThrow(/sensible/);
    expect(() => r.read(".git/config")).toThrow(/non lisible/);
    expect(() => r.read("../")).toThrow(/hors du jeu/);
    expect(r.search("speed")).toMatch(/scripts\/player\.gd:2/);
    expect(r.search("SECRET")).toMatch(/Aucun résultat/);
  });
});

describe("compactMarks", () => {
  it("résume les encarts en une ligne et laisse le reste intact", () => {
    const text = `Bonjour\n\n${CONSULT_MARK}${JSON.stringify({ from: "directeur", to: "testeur", question: "Ça casse ?", answer: "Non.", ok: true })}`;
    expect(compactMarks(text)).toBe("Bonjour\n\n[Consultation — le Testeur a été consulté. Question : Ça casse ? — Réponse : Non.]");
    expect(compactMarks("rien")).toBe("rien");
  });
});

describe("l'Atelier d'idées et l'API (ADR-100)", () => {
  const HOST = "127.0.0.1:4317";
  let app: FastifyInstance;
  beforeEach(async () => {
    const games = join(sb.dir, "games");
    mkdirSync(games, { recursive: true });
    app = await buildServer(sb.hub, { port: 4317, gamesRoot: games, allowedHosts: [HOST], folderPicker: { pick: async () => null } });
  });
  afterEach(async () => {
    await app.close();
  });
  async function login() {
    const res = await app.inject({ method: "GET", url: `/login?token=${sb.hub.sessions.createLoginToken()}`, headers: { host: HOST } });
    const cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
    const { csrf } = (await app.inject({ method: "GET", url: "/api/human/session", headers: { host: HOST, cookie } })).json() as { csrf: string };
    return {
      get: (url: string) => app.inject({ method: "GET", url, headers: { host: HOST, cookie } }),
      post: (url: string, body: unknown = {}) => app.inject({ method: "POST", url, payload: body as object, headers: { host: HOST, cookie, origin: `http://${HOST}`, "x-csrf-token": csrf } }),
    };
  }

  it("le serveur MCP refuse un appel sans jeton valide, répond 202 aux notifications", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/agent/team", headers: { host: HOST, authorization: "Bearer nope" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(bad.statusCode).toBe(401);
    const turn = sb.hub.team.open(P, "directeur", { consult: true })!;
    const note = await app.inject({ method: "POST", url: "/api/agent/team", headers: { host: HOST, authorization: `Bearer ${turn.grant.token}` }, payload: { jsonrpc: "2.0", method: "notifications/initialized" } });
    expect(note.statusCode).toBe(202);
    const list = await app.inject({ method: "POST", url: "/api/agent/team", headers: { host: HOST, authorization: `Bearer ${turn.grant.token}` }, payload: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    expect(list.json().result.tools[0].name).toBe("consulter");
    expect((await app.inject({ method: "GET", url: "/api/agent/team", headers: { host: HOST } })).statusCode).toBe(405);
    turn.close();
  });

  it("noter une idée, l'enrichir, puis en faire un projet (une conception démarre)", async () => {
    const { get, post } = await login();
    const created = (await post("/api/human/ideas", { body: "Un western néon où l'on tient un saloon la nuit" })).json();
    expect(created.title).toBe("Un western néon où l'on tient un saloon la nuit");
    const withLink = (await post(`/api/human/ideas/${created.id}/inspirations`, { url: "https://example.com/neon", note: "les enseignes" })).json();
    expect(withLink.inspirations).toHaveLength(1);
    expect((await post(`/api/human/ideas/${created.id}/inspirations`, { url: "javascript:alert(1)" })).statusCode).toBe(400);

    fake.extractions.push({ title: "Néon Saloon", pitch: "Tenir un saloon la nuit.", synthese: "Néon et western.", pistes: ["Clients à servir"], questions: ["Combien de temps dure une nuit ?"], references: [{ titre: "Red Dead", url: null, pourquoi: "western" }], liees: [{ id: "inconnue", pourquoi: "x" }] } as never);
    const enriching = (await post(`/api/human/ideas/${created.id}/enrich`)).json();
    expect(enriching.thinking).toBe(true);
    await sb.hub.ideas.idle();
    const enriched = (await get(`/api/human/ideas/${created.id}`)).json();
    expect(enriched.insight).toMatchObject({ pitch: "Tenir un saloon la nuit.", pistes: ["Clients à servir"], liees: [] });
    expect(enriched.thinking).toBe(false);
    const prompt = fake.calls.find((c) => c.kind === "structured" && c.systemPrompt.includes("ATELIER D'IDÉES"))!;
    expect(prompt.prompt).toMatch(/https:\/\/example\.com\/neon : les enseignes/);

    const project = (await post(`/api/human/ideas/${created.id}/project`)).json();
    expect(project.idea.status).toBe("projet");
    const conception = sb.hub.conceptions.get(project.conception);
    expect(conception.kind).toBe("project");
    expect(sb.hub.conceptions.messages(project.conception)[0]!.text).toMatch(/Idée de l'Atelier : « Un western néon[\s\S]*Pitch : Tenir un saloon la nuit\./);
    expect((await post(`/api/human/ideas/${created.id}/project`)).statusCode).toBe(400);
    await sb.hub.conceptions.idle();
  });

  it("mémoire : ajouter, modifier, oublier ; consultations lisibles", async () => {
    const { get, post } = await login();
    const m = (await post("/api/human/memory", { text: "Des menus lisibles au pad." })).json();
    expect(m.status).toBe("active");
    expect((await post(`/api/human/memory/${m.id}`, { text: "Des menus lisibles à la manette." })).json().text).toBe("Des menus lisibles à la manette.");
    expect((await get("/api/human/memory")).json()).toHaveLength(1);
    expect((await post(`/api/human/memory/${m.id}/delete`)).statusCode).toBe(200);
    expect((await get("/api/human/memory")).json()).toHaveLength(0);
    expect((await get("/api/human/team/consultations?project=*")).json()).toEqual([]);
  });
});
