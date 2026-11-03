import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import type { Journal } from "../journal/journal.ts";
import { WEB_TOOLS } from "../llm/claude-cli.ts";
import type { OrchestratorPort } from "../orchestrator/port.ts";
import type { Conception } from "../conception/conception-service.ts";
import type { TeamService } from "../team/team-service.ts";

export class IdeaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdeaError";
  }
}

export type Inspiration = { id: string; url: string | null; note: string; at: string };

/** Ce que le Concepteur tire d'une idée et de ses inspirations (ADR-100). */
export const IdeaInsight = z.object({
  /** Un titre de travail, court. */
  title: z.string().min(1).max(80),
  /** L'idée en 2 ou 3 phrases, comme on la pitcherait. */
  pitch: z.string().max(800),
  /** Ce qui ressort des inspirations : le fil commun, ce qui rend l'idée singulière. */
  synthese: z.string().max(2500),
  /** Pistes de jeu concrètes à creuser (mécaniques, ambiance, forme). */
  pistes: z.array(z.string().max(300)).max(8),
  /** Les questions qui décideront de la forme du jeu. */
  questions: z.array(z.string().max(300)).max(6),
  /** Jeux, œuvres ou articles de référence trouvés, avec leur adresse vérifiée si possible. */
  references: z.array(z.object({ titre: z.string().max(120), url: z.string().max(500).nullable(), pourquoi: z.string().max(300) })).max(8),
  /** Autres idées de l'atelier qui s'en rapprochent (leurs numéros), et en quoi. */
  liees: z.array(z.object({ id: z.string().max(60), pourquoi: z.string().max(200) })).max(6),
});
export type IdeaInsight = z.infer<typeof IdeaInsight>;
const INSIGHT_SCHEMA = z.toJSONSchema(IdeaInsight, { target: "draft-7" });

export type Idea = {
  id: string;
  title: string;
  body: string;
  /** idee : dans l'atelier ; projet : confiée au Concepteur pour devenir un jeu ; archivee : mise de côté. */
  status: "idee" | "projet" | "archivee";
  inspirations: Inspiration[];
  insight: (IdeaInsight & { at: string; team?: string }) | null;
  /** Le Concepteur y travaille en ce moment. */
  thinking: boolean;
  error: string | null;
  conception: string | null;
  created_at: string;
  updated_at: string;
};

const MUSE = `Tu es le CONCEPTEUR d'un studio de jeux vidéo, dans l'ATELIER D'IDÉES : le directeur créatif y dépose des idées encore floues et des inspirations (jeux, films, images, ambiances, articles). Ce n'est pas encore un projet.
Ton travail sur une idée :
- comprendre ce qui l'attire, à partir de son texte et de ses inspirations (ouvre les liens utiles avec WebFetch ; cherche avec WebSearch des jeux ou œuvres proches, et vérifie qu'une adresse existe avant de la citer) ;
- en tirer un pitch clair, le fil commun des inspirations, des pistes de jeu concrètes et les questions qui décideront de la forme du jeu ;
- relier l'idée aux autres idées de l'atelier quand elles se rapprochent vraiment (leurs numéros sont dans <autres_idees>).
Respecte son intention : enrichis, ne remplace pas. Pas de jargon. Réponds en français.`;

/**
 * L'Atelier d'idées (ADR-100) : avant les projets, vos idées et vos inspirations, enrichies par le Concepteur, reliées
 * entre elles, puis confiées au Concepteur pour devenir un jeu quand vous le décidez.
 */
export class IdeaService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #orchestrator: OrchestratorPort;
  readonly #web: boolean;
  readonly #thinking = new Set<string>();
  readonly #errors = new Map<string, string>();
  readonly #background = new Set<Promise<void>>();
  /** Le Concepteur, pour « En faire un projet ». */
  conceptions: { start(session: HumanSession, input: { kind: "project"; idea: string }): Conception } | null = null;
  /** Compétences et mémoire du studio du Concepteur. */
  skills: { promptFor(agent: "concepteur", project: string | null): { text: string; dir: string | null } } | null = null;
  team: TeamService | null = null;

  constructor(deps: { db: Db; clock: Clock; journal: Journal; orchestrator: OrchestratorPort; web?: boolean }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#orchestrator = deps.orchestrator;
    this.#web = deps.web ?? true;
  }

  list(): Idea[] {
    return (this.#db.prepare("SELECT * FROM ideas ORDER BY status = 'archivee', updated_at DESC").all() as Row[]).map((r) => this.#toIdea(r));
  }

  get(id: string): Idea {
    const row = this.#db.prepare("SELECT * FROM ideas WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new IdeaError("Idée introuvable");
    return this.#toIdea(row);
  }

  activity(): { id: string; title: string; since: string }[] {
    return [...this.#thinking].map((id) => this.get(id)).map((i) => ({ id: i.id, title: i.title, since: i.updated_at }));
  }

  create(session: HumanSession, input: { title?: string; body: string }): Idea {
    assertHumanSession(session);
    const body = input.body.trim().slice(0, 20_000);
    const title = (input.title?.trim() || body.split("\n")[0]!.trim()).slice(0, 80);
    if (!title) throw new IdeaError("Écrivez votre idée, même en une phrase");
    const now = this.#clock.now();
    const id = randomUUID();
    this.#db.prepare("INSERT INTO ideas (id, title, body, status, inspirations_json, created_at, updated_at) VALUES (?, ?, ?, 'idee', '[]', ?, ?)").run(id, title, body, now, now);
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "idea.created", subject: id, payload: {} });
    return this.get(id);
  }

  update(session: HumanSession, id: string, patch: { title?: string; body?: string; status?: "idee" | "archivee" }): Idea {
    assertHumanSession(session);
    const idea = this.get(id);
    const title = patch.title !== undefined ? patch.title.trim().slice(0, 80) || idea.title : idea.title;
    const body = patch.body !== undefined ? patch.body.slice(0, 20_000) : idea.body;
    const status = patch.status && idea.status !== "projet" ? patch.status : idea.status;
    this.#db.prepare("UPDATE ideas SET title = ?, body = ?, status = ?, updated_at = ? WHERE id = ?").run(title, body, status, this.#clock.now(), id);
    return this.get(id);
  }

  addInspiration(session: HumanSession, id: string, input: { url?: string | null; note?: string }): Idea {
    assertHumanSession(session);
    const idea = this.get(id);
    const url = input.url?.trim() || null;
    if (url && !/^https?:\/\/\S+$/i.test(url)) throw new IdeaError("Lien invalide : il doit commencer par http:// ou https://");
    const note = (input.note ?? "").trim().slice(0, 2000);
    if (!url && !note) throw new IdeaError("Donnez un lien ou quelques mots");
    if (idea.inspirations.length >= 60) throw new IdeaError("60 inspirations au plus par idée");
    const list = [...idea.inspirations, { id: randomUUID(), url: url?.slice(0, 1000) ?? null, note, at: this.#clock.now() }];
    this.#saveInspirations(id, list);
    return this.get(id);
  }

  removeInspiration(session: HumanSession, id: string, inspiration: string): Idea {
    assertHumanSession(session);
    const idea = this.get(id);
    this.#saveInspirations(
      id,
      idea.inspirations.filter((i) => i.id !== inspiration),
    );
    return this.get(id);
  }

  remove(session: HumanSession, id: string): void {
    assertHumanSession(session);
    const idea = this.get(id);
    if (this.#thinking.has(id)) throw new IdeaError("Le Concepteur y travaille : attendez la fin");
    this.#db.prepare("DELETE FROM ideas WHERE id = ?").run(idea.id);
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "idea.removed", subject: id, payload: { title: idea.title } });
  }

  /** « Enrichir » : le Concepteur lit l'idée et ses inspirations, cherche, relie ; en arrière-plan. */
  enrich(session: HumanSession, id: string): Idea {
    assertHumanSession(session);
    const idea = this.get(id);
    if (this.#thinking.has(id)) throw new IdeaError("Le Concepteur y travaille déjà");
    if (!idea.body.trim() && !idea.inspirations.length) throw new IdeaError("Écrivez quelques mots ou ajoutez une inspiration d'abord");
    this.#thinking.add(id);
    this.#errors.delete(id);
    this.#touch(id);
    const p = this.#enrich(id).finally(() => this.#thinking.delete(id));
    this.#background.add(p);
    void p.finally(() => this.#background.delete(p));
    return this.get(id);
  }

  /** « En faire un projet » : l'idée, ses inspirations et ce qu'en a tiré le Concepteur partent dans une conception. */
  toProject(session: HumanSession, id: string): { idea: Idea; conception: string } {
    assertHumanSession(session);
    const idea = this.get(id);
    if (!this.conceptions) throw new IdeaError("Le Concepteur n'est pas disponible");
    if (idea.status === "projet" && idea.conception) throw new IdeaError("Cette idée est déjà confiée au Concepteur");
    const c = this.conceptions.start(session, { kind: "project", idea: compileIdea(idea) });
    this.#db.prepare("UPDATE ideas SET status = 'projet', conception = ?, updated_at = ? WHERE id = ?").run(c.id, this.#clock.now(), id);
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "idea.to_project", subject: id, payload: { conception: c.id } });
    return { idea: this.get(id), conception: c.id };
  }

  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }

  async #enrich(id: string): Promise<void> {
    const idea = this.get(id);
    const others = this.list()
      .filter((i) => i.id !== id && i.status !== "archivee")
      .slice(0, 40)
      .map((i) => `- ${i.id} « ${i.title} » : ${(i.insight?.pitch ?? i.body).replace(/\s+/g, " ").slice(0, 200)}`)
      .join("\n");
    const skills = this.skills?.promptFor("concepteur", null) ?? { text: "", dir: null };
    const team = this.team?.open(null, "concepteur", { consult: true, remember: true }) ?? null;
    try {
      const { data } = await this.#orchestrator.structured({
        systemPrompt: [MUSE, skills.text, team?.prompt ?? ""].filter(Boolean).join("\n\n"),
        prompt: [
          `<idee titre="${esc(idea.title)}">\n${esc(idea.body) || "(pas de texte : seulement des inspirations)"}\n</idee>`,
          idea.inspirations.length ? `<inspirations>\n${idea.inspirations.map((i) => `- ${i.url ?? "(sans lien)"}${i.note ? ` : ${esc(i.note)}` : ""}`).join("\n")}\n</inspirations>` : "",
          idea.insight ? `<ce_que_tu_en_avais_tire>\n${esc(idea.insight.pitch)}\n${esc(idea.insight.synthese)}\n</ce_que_tu_en_avais_tire>` : "",
          others ? `<autres_idees>\n${esc(others)}\n</autres_idees>` : "",
          "Enrichis cette idée : pitch, synthèse des inspirations, pistes, questions, références, idées liées.",
        ]
          .filter(Boolean)
          .join("\n\n"),
        jsonSchema: INSIGHT_SCHEMA,
        meta: { project: null, agent: "concepteur" },
        tools: this.#web ? WEB_TOOLS : undefined,
        tier: "concept",
        ...(skills.dir ? { skillsDir: skills.dir } : {}),
        ...(team ? { team: team.grant } : {}),
      });
      const insight = IdeaInsight.parse(data);
      const known = new Set(this.list().map((i) => i.id));
      const clean = { ...insight, liees: insight.liees.filter((l) => known.has(l.id) && l.id !== id), at: this.#clock.now() };
      this.#db.prepare("UPDATE ideas SET insight_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...clean, team: team?.marks() ?? "" }), this.#clock.now(), id);
      this.#journal.append({ project: null, actor: { kind: "system" }, type: "idea.enriched", subject: id, payload: {} });
    } catch (err) {
      this.#errors.set(id, (err as Error).message.slice(0, 300));
    } finally {
      team?.close();
    }
  }

  #saveInspirations(id: string, list: Inspiration[]): void {
    this.#db.prepare("UPDATE ideas SET inspirations_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(list), this.#clock.now(), id);
  }

  #touch(id: string): void {
    this.#db.prepare("UPDATE ideas SET updated_at = ? WHERE id = ?").run(this.#clock.now(), id);
  }

  #toIdea(r: Row): Idea {
    const id = String(r.id);
    return {
      id,
      title: String(r.title),
      body: String(r.body ?? ""),
      status: r.status as Idea["status"],
      inspirations: JSON.parse(String(r.inspirations_json ?? "[]")) as Inspiration[],
      insight: r.insight_json ? (JSON.parse(String(r.insight_json)) as Idea["insight"]) : null,
      thinking: this.#thinking.has(id),
      error: this.#errors.get(id) ?? null,
      conception: (r.conception as string | null) ?? null,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }
}

/** Le texte remis au Concepteur pour lancer la conception d'un jeu à partir d'une idée. */
export function compileIdea(idea: Idea): string {
  const i = idea.insight;
  return [
    `Idée de l'Atelier : « ${idea.title} »`,
    idea.body.trim(),
    idea.inspirations.length ? `Inspirations :\n${idea.inspirations.map((x) => `- ${x.url ?? ""}${x.url && x.note ? " — " : ""}${x.note}`).join("\n")}` : "",
    i ? `Ce que tu en avais tiré dans l'Atelier :\nPitch : ${i.pitch}\n${i.synthese}${i.pistes.length ? `\nPistes :\n${i.pistes.map((p) => `- ${p}`).join("\n")}` : ""}${i.questions.length ? `\nQuestions ouvertes :\n${i.questions.map((q) => `- ${q}`).join("\n")}` : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 8000);
}

type Row = Record<string, unknown>;
const esc = (s: string) => s.replace(/</g, "‹").replace(/>/g, "›");
