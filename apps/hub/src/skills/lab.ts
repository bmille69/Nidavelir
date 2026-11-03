import type { Task } from "@studio/contracts";
import type { z } from "zod";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import type { TaskService } from "../executor/task-service.ts";
import type { Journal } from "../journal/journal.ts";
import type { OrchestratorPort } from "../orchestrator/port.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import type { BenchResult, BenchService } from "../quality/bench.ts";
import type { UsageService } from "../usage/usage-service.ts";
import {
  BLIND_JUDGE_PROMPT,
  BLIND_SCENARIO_PROMPT,
  BLIND_SCENARIO_SCHEMA,
  BLIND_VERDICT_SCHEMA,
  BlindScenario,
  BlindVerdict,
  CONSOLIDATE_PROMPT,
  CONSOLIDATE_SCHEMA,
  ConsolidateOutput,
  HERMES_ADAPT_SCHEMA,
  HermesAdapted,
  NEEDS_PROMPT,
  NEEDS_SCHEMA,
  NeedsOutput,
  PATTERNS_PROMPT,
  PATTERNS_SCHEMA,
  PatternsOutput,
  PROCEDURE_PROMPT,
  PROCEDURE_SCHEMA,
  ProcedureOutput,
  PUBLIC_ADAPT_PROMPT,
  PUBLIC_PICK_PROMPT,
  PUBLIC_PICKS_SCHEMA,
  PublicPicks,
  REVIEW_PROMPT,
  REVIEW_SCHEMA,
  ReviewOutput,
} from "./curator.ts";
import { fetchSkill, licenseAllowed, readSource, suspicious, type CatalogFetcher } from "./public-catalog.ts";
import { verdictBlocks } from "../quality/verdict.ts";
import { EXTERNAL_AGENTS, NEED_MARK, type Skill, type SkillAgent, type SkillService, type SkillTrial } from "./skill-service.ts";

/**
 * Le laboratoire des compétences (ADR-102) : la bibliothèque se nourrit et se vérifie seule.
 * - Besoins : signalés par les agents (« Compétence manquante : … ») ou repérés chaque semaine par jeu.
 * - Éclaireur : cherche dans un catalogue public fixe (licences libres, texte seulement), relit pour la sécurité,
 *   adapte, met en QUARANTAINE ; s'il ne trouve rien, écrit lui-même une compétence, en quarantaine aussi.
 * - Essais : sur le banc (le même chantier refait avec et sans la compétence) pour le Développeur et le Testeur,
 *   en aveugle (deux réponses jugées sans savoir laquelle a la compétence) pour les autres. Au plus N essais de banc
 *   par semaine, seulement quand l'abonnement est peu utilisé et qu'aucun chantier ne tourne.
 * - Motifs : tous les 5 chantiers réussis, ce qui revient devient procédure ou liste de vérification.
 * - Mesure continue et ménage : une compétence qui nuit est retirée ; les doublons sont fusionnés.
 * Une seule action par tour (toutes les 20 min) : jamais de rafale.
 */

export type LabOptions = { trialsPerWeek: number; blindPerWeek: number; sources: string[]; fetcher: CatalogFetcher | null };

export type LabStatus = {
  enabled: boolean;
  trials: { bench: number; blind: number; benchMax: number; blindMax: number };
  quarantine: number;
  untested: number;
  needs: { id: number; project: string | null; topic: string; origin: string; status: string; result: string | null; at: string }[];
  catalog: { entries: number; sources: string[]; refreshed: string | null };
  last: string | null;
  busy: boolean;
};

const WEEK = 7 * 24 * 3600_000;
const PATTERN_EVERY = 5;
const ROLE: Record<SkillAgent, string> = {
  director: "directeur (chef de projet) qui découpe le travail en chantiers",
  concepteur: "Concepteur (game designer) qui écrit les dossiers de conception",
  developer: "Développeur du jeu",
  qa: "Testeur qui vérifie et joue au jeu",
  art_director: "Directeur artistique",
};

export class SkillLab {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #projects: ProjectRegistry;
  readonly #tasks: TaskService;
  readonly #skills: SkillService;
  readonly #orchestrator: OrchestratorPort;
  readonly #opts: LabOptions;
  bench: BenchService | null = null;
  usage: UsageService | null = null;
  #busy = false;
  readonly #background = new Set<Promise<unknown>>();

  constructor(deps: { db: Db; clock: Clock; journal: Journal; projects: ProjectRegistry; tasks: TaskService; skills: SkillService; orchestrator: OrchestratorPort; options?: Partial<LabOptions> }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#projects = deps.projects;
    this.#tasks = deps.tasks;
    this.#skills = deps.skills;
    this.#orchestrator = deps.orchestrator;
    this.#opts = { trialsPerWeek: 3, blindPerWeek: 10, sources: [], fetcher: null, ...deps.options };
  }

  // ── Événements ───────────────────────────────────────────────────────────

  /** Besoins signalés dans les rapports ; motifs tous les 5 chantiers fusionnés. */
  onTaskStatus(task: Task): void {
    if (!this.#skills.auto) return;
    if (task.status === "review" || task.status === "merged") {
      for (const r of this.#tasks.runs(task.project, task.id)) {
        for (const line of r.result?.report?.open_issues ?? []) {
          const at = line.indexOf(NEED_MARK);
          if (at >= 0) this.addNeed(task.project, line.slice(at + NEED_MARK.length).trim(), `agent (${task.id})`);
        }
      }
    }
    if (task.status === "merged") {
      const key = `merged:${task.project}`;
      const n = Number(this.#get(key) ?? "0") + 1;
      this.#set(key, String(n));
      if (n % PATTERN_EVERY === 0) this.#track(this.#patterns(task.project));
    }
  }

  /** Un besoin de compétence (doublons ignorés). */
  addNeed(project: string | null, topic: string, origin: string): void {
    const clean = topic.replace(/\s+/g, " ").trim().slice(0, 120);
    if (clean.length < 3) return;
    const dup = this.#db.prepare("SELECT 1 FROM skill_needs WHERE lower(topic) = lower(?) AND (project IS ? OR project = ?) AND status IN ('open', 'searched', 'done')").get(clean, project, project);
    if (dup) return;
    this.#db.prepare("INSERT INTO skill_needs (project, topic, origin, status, created_at) VALUES (?, ?, ?, 'open', ?)").run(project, clean, origin, this.#clock.now());
    this.#journal.append({ project, actor: { kind: "system" }, type: "skill.need", subject: clean, payload: { origin } });
  }

  // ── Le tour du laboratoire ───────────────────────────────────────────────

  /** Une action au plus, par ordre d'importance. Renvoie ce qui a été fait (ou null). */
  async tick(): Promise<string | null> {
    if (!this.#skills.auto || this.#busy) return null;
    this.#busy = true;
    try {
      const done = await this.#step();
      if (done) this.#set("last", `${this.#clock.now()} ${done}`);
      return done;
    } catch (err) {
      this.#journal.append({ project: null, actor: { kind: "system" }, type: "skill.lab_failed", payload: { error: (err as Error).message.slice(0, 300) } });
      return null;
    } finally {
      this.#busy = false;
    }
  }

  async #step(): Promise<string | null> {
    const now = Date.parse(this.#clock.now());
    // 1. Ce qui attend en quarantaine passe en premier.
    for (const s of this.#skills.list().filter((x) => x.status === "quarantine")) {
      const r = await this.#trial(s);
      if (r) return `essai de ${s.name}`;
    }
    // 2. Les besoins ouverts : chercher (catalogue) ou écrire.
    const open = this.#needs("open");
    if (open.length && this.#since("scout") > 3600_000) {
      this.#set("scout", this.#clock.now());
      await this.#scout(open.slice(0, 5));
      return "recherche de compétences";
    }
    // 3. Chaque semaine : catalogue public relu, besoins repérés par jeu, mesure, ménage.
    // Une source ajoutée à la liste est lue au tour suivant, sans attendre la semaine (ADR-108).
    const sources = this.#opts.sources.join(",");
    if (this.#opts.fetcher && this.#opts.sources.length && (this.#since("catalog") > WEEK || this.#get("catalog_sources") !== sources)) {
      this.#set("catalog", this.#clock.now());
      this.#set("catalog_sources", sources);
      await this.refreshCatalog();
      return "catalogue public relu";
    }
    for (const p of this.#projects.list()) {
      const recent = this.#tasks.list(p.slug).some((t) => now - Date.parse(t.updated_at) < 2 * WEEK);
      if (recent && this.#since(`needs:${p.slug}`) > WEEK) {
        this.#set(`needs:${p.slug}`, this.#clock.now());
        await this.#detectNeeds(p.slug);
        return `besoins de ${p.name}`;
      }
    }
    // 4. Les compétences apprises ou importées jamais essayées (actives en attendant).
    for (const s of this.#untested()) {
      const r = await this.#trial(s);
      if (r) return `essai de ${s.name}`;
    }
    if (this.#since("measure") > WEEK) {
      this.#set("measure", this.#clock.now());
      this.measure();
      return "mesure des compétences";
    }
    if (this.#since("consolidate") > WEEK) {
      this.#set("consolidate", this.#clock.now());
      await this.#consolidate();
      return "ménage de la bibliothèque";
    }
    return null;
  }

  status(): LabStatus {
    const since = new Date(Date.parse(this.#clock.now()) - WEEK).toISOString();
    const count = (kind: string) => Number((this.#db.prepare("SELECT COUNT(*) AS n FROM skill_trials WHERE kind = ? AND created_at >= ?").get(kind, since) as { n: number }).n);
    return {
      enabled: this.#skills.auto,
      trials: { bench: count("bench"), blind: count("blind"), benchMax: this.#opts.trialsPerWeek, blindMax: this.#opts.blindPerWeek },
      quarantine: this.#skills.list().filter((s) => s.status === "quarantine").length,
      untested: this.#untested().length,
      needs: (this.#db.prepare("SELECT * FROM skill_needs ORDER BY id DESC LIMIT 12").all() as Record<string, unknown>[]).map((r) => ({
        id: Number(r.id),
        project: (r.project as string | null) ?? null,
        topic: String(r.topic),
        origin: String(r.origin),
        status: String(r.status),
        result: (r.result as string | null) ?? null,
        at: String(r.created_at),
      })),
      catalog: { entries: Number((this.#db.prepare("SELECT COUNT(*) AS n FROM skill_catalog").get() as { n: number }).n), sources: this.#opts.sources, refreshed: this.#get("catalog") },
      last: this.#get("last"),
      busy: this.#busy,
    };
  }

  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }

  // ── Essais ───────────────────────────────────────────────────────────────

  #untested(): Skill[] {
    return this.#skills.list().filter((s) => s.status === "active" && s.enabled && !s.trial && (s.source === "learned" || s.source === "hermes"));
  }

  /** Essaie une compétence si le budget et le moment le permettent. Renvoie null s'il faut attendre. */
  async #trial(s: Skill): Promise<SkillTrial | null> {
    const dev = s.agents.some((a) => a === "developer" || a === "qa");
    const ref = dev ? this.#reference(s) : null;
    if (ref) {
      if (!this.#canBench()) return null;
      return this.#benchTrial(s, ref);
    }
    if (!this.#canBlind()) return null;
    return this.#blindTrial(s);
  }

  #quota(max5h: number, max7d: number): boolean {
    const w = this.usage?.snapshot().limits?.windows;
    const now = Date.parse(this.#clock.now());
    const busy = (x: { utilization: number; resetsAt: string } | undefined, max: number) => !!x && x.utilization >= max && Date.parse(x.resetsAt) > now;
    return !busy(w?.five_hour, max5h) && !busy(w?.seven_day, max7d);
  }

  #canBench(): boolean {
    return !!this.bench && this.status().trials.bench < this.#opts.trialsPerWeek && this.#tasks.activeRuns().length === 0 && this.#quota(0.5, 0.7);
  }

  #canBlind(): boolean {
    return this.status().trials.blind < this.#opts.blindPerWeek && this.#quota(0.8, 0.9);
  }

  /** Le chantier fusionné qui ressemble le plus à ce que la compétence couvre. */
  #reference(s: Skill): { project: string; task: Task } | null {
    const words = new Set((`${s.name} ${s.description}`.toLowerCase().match(/[a-zà-ÿ0-9]{4,}/g) ?? []).filter((w) => !["utiliser", "quand", "pour", "avec", "dans"].includes(w)));
    const projects = s.project ? [s.project] : this.#projects.list().map((p) => p.slug);
    let best: { project: string; task: Task; score: number } | null = null;
    for (const project of projects) {
      for (const t of this.#tasks.list(project)) {
        if (t.status !== "merged" || !t.base_commit || /^A-\d{4,}/.test(t.title)) continue;
        const text = `${t.title} ${t.goal}`.toLowerCase();
        const score = [...words].filter((w) => text.includes(w)).length + (Date.parse(t.updated_at) / 1e15);
        if (!best || score > best.score) best = { project, task: t, score };
      }
    }
    return best ? { project: best.project, task: best.task } : null;
  }

  async #benchTrial(s: Skill, ref: { project: string; task: Task }): Promise<SkillTrial> {
    const id = this.#startTrial(s, "bench");
    const input = { id: ref.task.id, title: ref.task.title, goal: ref.task.goal, base: ref.task.base_commit! };
    const withS = await this.bench!.trial(ref.project, input, { include: s.id });
    const without = await this.bench!.trial(ref.project, input, { exclude: s.id });
    const verdict = compareBench(withS, without);
    const fmt = (r: BenchResult) => `${r.ok ? "réussi" : "raté"}${r.costUsd != null ? `, ${r.costUsd.toFixed(2)} $` : ""}, ${Math.round(r.seconds / 60)} min`;
    const summary = `${ref.task.id} refait : avec ${fmt(withS)} ; sans ${fmt(without)}`;
    return this.#finishTrial(s, id, "bench", verdict, summary, { reference: `${ref.project}/${ref.task.id}`, with: withS, without });
  }

  async #blindTrial(s: Skill): Promise<SkillTrial> {
    const id = this.#startTrial(s, "blind");
    const agent = s.agents[0] ?? "developer";
    const block = `<competence nom="${s.name}" quand="${esc(s.description)}">\n${esc(s.body.slice(0, 8000))}\n</competence>`;
    const meta = { project: s.project, agent: "competences" };
    try {
      const scen = BlindScenario.parse((await this.#orchestrator.structured({ systemPrompt: BLIND_SCENARIO_PROMPT, prompt: `<agent>${ROLE[agent]}</agent>\n\n${block}`, jsonSchema: BLIND_SCENARIO_SCHEMA, meta })).data);
      const base = `Tu es le ${ROLE[agent]} d'un studio de jeux vidéo. Réponds en français, de façon concrète et utile.`;
      const plain = (await this.#orchestrator.reply({ systemPrompt: base, prompt: scen.request, meta })).text;
      const skilled = (await this.#orchestrator.reply({ systemPrompt: `${base}\n\nCompétence du studio, à appliquer si elle concerne la demande :\n${block}`, prompt: scen.request, meta })).text;
      // L'ordre ne dépend que de l'identifiant : le juge ne peut pas deviner, et l'essai reste reproductible.
      const skilledFirst = parseInt(s.id.replace(/[^0-9a-f]/g, "").slice(0, 2) || "0", 16) % 2 === 0;
      const [a, b] = skilledFirst ? [skilled, plain] : [plain, skilled];
      const v = BlindVerdict.parse(
        (await this.#orchestrator.structured({ systemPrompt: BLIND_JUDGE_PROMPT, prompt: `<demande>\n${esc(scen.request)}\n</demande>\n\n<reponse_A>\n${esc(a.slice(0, 6000))}\n</reponse_A>\n\n<reponse_B>\n${esc(b.slice(0, 6000))}\n</reponse_B>`, jsonSchema: BLIND_VERDICT_SCHEMA, meta })).data,
      );
      const won = v.winner === "egal" ? null : (v.winner === "A") === skilledFirst;
      const verdict = won === null ? "inconclusive" : won ? "pass" : "fail";
      return this.#finishTrial(s, id, "blind", verdict, `En aveugle : ${won === null ? "égalité" : won ? "la réponse avec la compétence l'emporte" : "la réponse sans la compétence l'emporte"} (${v.why})`, { request: scen.request, winner: v.winner, skilledFirst });
    } catch (err) {
      return this.#finishTrial(s, id, "blind", "inconclusive", `Essai interrompu : ${(err as Error).message.slice(0, 200)}`, {});
    }
  }

  #startTrial(s: Skill, kind: "bench" | "blind"): number {
    return Number(this.#db.prepare("INSERT INTO skill_trials (skill_id, kind, status, created_at) VALUES (?, ?, 'running', ?)").run(s.id, kind, this.#clock.now()).lastInsertRowid);
  }

  /** Tranche : en quarantaine, « réussi » active et le reste écarte (deux égalités de suite aussi) ; active, seul un échec retire. */
  #finishTrial(s: Skill, id: number, kind: "bench" | "blind", verdict: SkillTrial["verdict"], summary: string, detail: Record<string, unknown>): SkillTrial {
    const trial: SkillTrial = { kind, verdict, summary, at: this.#clock.now() };
    this.#db.prepare("UPDATE skill_trials SET status = 'done', verdict = ?, detail_json = ?, finished_at = ? WHERE id = ?").run(verdict, JSON.stringify(detail), this.#clock.now(), id);
    const ties = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM skill_trials WHERE skill_id = ? AND verdict = 'inconclusive'").get(s.id) as { n: number }).n);
    let status = s.status;
    if (s.status === "quarantine") status = verdict === "pass" ? "active" : verdict === "fail" || ties >= 2 ? "rejected" : "quarantine";
    else if (verdict === "fail") status = "rejected";
    this.#skills.setStatus(s.id, status, trial);
    const kept = status === "active";
    this.#journal.append({
      project: s.project,
      actor: { kind: "system" },
      type: kept || status === "quarantine" ? "skill.trial_passed" : "skill.trial_failed",
      subject: s.name,
      payload: { kind, verdict, summary, status },
    });
    return trial;
  }

  // ── Mesure continue ──────────────────────────────────────────────────────

  /** Compare la réussite du premier coup des chantiers où la compétence a été ouverte et de ceux où elle ne l'a pas été. */
  measure(): { retired: string[] } {
    const retired: string[] = [];
    for (const s of this.#skills.list().filter((x) => x.status === "active" && x.enabled && (x.source === "learned" || x.source === "hermes" || x.source === "public"))) {
      const rows = this.#db.prepare("SELECT project, task, used FROM skill_tasks WHERE skill_id = ?").all(s.id) as { project: string; task: string; used: number }[];
      const groups = { used: [] as boolean[], not: [] as boolean[] };
      for (const r of rows) {
        if (!/^T-\d+$/.test(r.task)) continue;
        let t: Task;
        try {
          t = this.#tasks.get(r.project, r.task);
        } catch {
          continue;
        }
        if (!["merged", "abandoned", "rejected", "failed"].includes(t.status)) continue;
        const refused = this.#tasks.runs(r.project, r.task).some((x) => !!x.result?.verification && verdictBlocks(x.result.verification));
        (r.used ? groups.used : groups.not).push(t.status === "merged" && !t.feedback.length && !refused);
      }
      if (groups.used.length < 6 || groups.not.length < 6) continue;
      const rate = (xs: boolean[]) => xs.filter(Boolean).length / xs.length;
      const [u, n] = [rate(groups.used), rate(groups.not)];
      if (u + 0.3 <= n) {
        const summary = `Du premier coup : ${Math.round(u * 100)} % quand elle est ouverte (${groups.used.length} chantiers), ${Math.round(n * 100)} % sans (${groups.not.length})`;
        this.#skills.setStatus(s.id, "rejected", { kind: "review", verdict: "fail", summary, at: this.#clock.now() });
        this.#journal.append({ project: s.project, actor: { kind: "system" }, type: "skill.retired", subject: s.name, payload: { why: summary } });
        retired.push(s.name);
      }
    }
    return { retired };
  }

  // ── Besoins, catalogue, éclaireur ────────────────────────────────────────

  #needs(status: string): { id: number; project: string | null; topic: string; origin: string }[] {
    return (this.#db.prepare("SELECT id, project, topic, origin FROM skill_needs WHERE status = ? ORDER BY id").all(status) as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      project: (r.project as string | null) ?? null,
      topic: String(r.topic),
      origin: String(r.origin),
    }));
  }

  async #detectNeeds(project: string): Promise<void> {
    const p = this.#projects.get(project);
    const tasks = this.#tasks.list(project).slice(-12);
    const lessons = this.#skills.list(project).find((s) => s.source === "lessons" && s.project === project);
    const prompt = [
      `<jeu nom="${esc(p.name)}" moteur="${p.engine}">\n${esc((this.#tasks.gameState?.(project) ?? "").slice(0, 3000))}\n</jeu>`,
      lessons ? `<lecons>\n${esc(lessons.body.slice(0, 3000))}\n</lecons>` : "",
      `<chantiers_recents>\n${tasks.map((t) => `- ${t.id} [${t.status}] ${esc(t.title)}${t.feedback.length ? ` — corrections : ${esc(t.feedback.join(" / ").slice(0, 200))}` : ""}`).join("\n")}\n</chantiers_recents>`,
      `<besoins_signales>\n${this.#needs("open").map((n) => `- ${esc(n.topic)}`).join("\n") || "(aucun)"}\n</besoins_signales>`,
      `<competences_presentes>\n${this.#skills.list(project).filter((s) => s.status !== "rejected").map((s) => `- ${s.name} : ${esc(s.description)}`).join("\n")}\n</competences_presentes>`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const { data } = await this.#orchestrator.structured({ systemPrompt: NEEDS_PROMPT, prompt, jsonSchema: NEEDS_SCHEMA, meta: { project, agent: "competences" } });
    for (const t of NeedsOutput.parse(data).topics) this.addNeed(project, t.topic, "analyse du jeu");
  }

  /** Relit le catalogue public (liste fixe de dépôts). */
  async refreshCatalog(): Promise<number> {
    const fetcher = this.#opts.fetcher;
    if (!fetcher) return 0;
    let n = 0;
    for (const source of this.#opts.sources) {
      try {
        const { entries } = await readSource(fetcher, source);
        for (const e of entries) {
          this.#db
            .prepare(
              `INSERT INTO skill_catalog (source, path, name, description, license, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(source, path) DO UPDATE SET name = excluded.name, description = excluded.description, license = excluded.license, fetched_at = excluded.fetched_at`,
            )
            .run(e.source, e.path, e.name, e.description, e.license, this.#clock.now());
          n++;
        }
      } catch (err) {
        this.#journal.append({ project: null, actor: { kind: "system" }, type: "skill.lab_failed", subject: source, payload: { error: (err as Error).message.slice(0, 300) } });
      }
    }
    return n;
  }

  /** Pour chaque besoin : une skill du catalogue (relue, adaptée, en quarantaine), sinon une compétence écrite (en quarantaine). */
  async #scout(needs: { id: number; project: string | null; topic: string }[]): Promise<void> {
    if (this.#opts.fetcher && !this.#catalog().length) await this.refreshCatalog();
    const catalog = this.#catalog();
    const matched = new Set<number>();
    if (catalog.length && this.#opts.fetcher) {
      const existing = this.#skills.list().map((s) => `- ${s.name} : ${esc(s.description)}`).join("\n");
      const picks: z.infer<typeof PublicPicks>["picks"] = [];
      for (let i = 0; i < catalog.length && picks.length < 3; i += 150) {
        const chunk = catalog.slice(i, i + 150);
        const prompt = [
          `<besoins>\n${needs.map((n) => `- ${esc(n.topic)}`).join("\n")}\n</besoins>`,
          `<competences_presentes>\n${existing}\n</competences_presentes>`,
          `<catalogue>\n${chunk.map((c) => `<skill source="${c.source}" chemin="${esc(c.path)}" nom="${esc(c.name)}">${esc(c.description)}</skill>`).join("\n")}\n</catalogue>`,
        ].join("\n\n");
        const { data } = await this.#orchestrator.structured({ systemPrompt: PUBLIC_PICK_PROMPT, prompt, jsonSchema: PUBLIC_PICKS_SCHEMA, meta: { agent: "competences" } });
        for (const p of PublicPicks.parse(data).picks) if (chunk.some((c) => c.source === p.source && c.path === p.path) && picks.length < 3) picks.push(p);
      }
      for (const pick of picks) {
        const need = needs.find((n) => n.topic.toLowerCase() === pick.topic.toLowerCase()) ?? needs.find((n) => pick.topic.toLowerCase().includes(n.topic.toLowerCase().slice(0, 12))) ?? null;
        const entry = catalog.find((c) => c.source === pick.source && c.path === pick.path)!;
        const name = await this.#importPublic(entry, pick.agents, need?.project ?? null);
        if (need && name) {
          matched.add(need.id);
          this.#db.prepare("UPDATE skill_needs SET status = 'done', result = ? WHERE id = ?").run(`${name} (catalogue, en essai)`, need.id);
        }
      }
    }
    // Rien de convenable dans le catalogue : le curateur écrit la compétence pour ce jeu, et elle passe aussi en essai.
    for (const need of needs.filter((n) => !matched.has(n.id))) {
      const name = await this.#write(need);
      this.#db.prepare("UPDATE skill_needs SET status = ?, result = ? WHERE id = ?").run(name ? "done" : "searched", name ? `${name} (écrite, en essai)` : "rien de convenable", need.id);
    }
  }

  #catalog(): { source: string; path: string; name: string; description: string; license: string }[] {
    return (this.#db.prepare("SELECT source, path, name, description, license FROM skill_catalog WHERE status IS NULL ORDER BY source, path").all() as Record<string, unknown>[])
      .map((r) => ({ source: String(r.source), path: String(r.path), name: String(r.name), description: String(r.description), license: (r.license as string | null) ?? "" }))
      .filter((r) => licenseAllowed(r.license));
  }

  async #importPublic(entry: { source: string; path: string; name: string; license: string }, agents: SkillAgent[], project: string | null): Promise<string | null> {
    const mark = (status: string) => this.#db.prepare("UPDATE skill_catalog SET status = ? WHERE source = ? AND path = ?").run(status, entry.source, entry.path);
    const refuse = (why: string[]) => {
      mark("refused");
      this.#journal.append({ project, actor: { kind: "system" }, type: "skill.public_refused", subject: entry.name, payload: { source: entry.source, path: entry.path, why } });
      return null;
    };
    try {
      const skill = await fetchSkill(this.#opts.fetcher!, entry.source, entry.path);
      const all = [skill.body, ...skill.files.map((f) => f.content)].join("\n\n");
      const flags = suspicious(all);
      if (flags.length) return refuse(flags);
      const review = ReviewOutput.parse(
        (await this.#orchestrator.structured({ systemPrompt: REVIEW_PROMPT, prompt: `<skill source="${entry.source}" chemin="${esc(entry.path)}">\n${esc(all.slice(0, 40_000))}\n</skill>`, jsonSchema: REVIEW_SCHEMA, meta: { agent: "competences" } })).data,
      );
      if (review.verdict !== "ok") return refuse(review.problems.length ? review.problems : ["refusée par la relecture"]);
      const adapted = HermesAdapted.parse(
        (
          await this.#orchestrator.structured({
            systemPrompt: PUBLIC_ADAPT_PROMPT,
            prompt: [
              `<skill_publique nom="${esc(entry.name)}" depot="${entry.source}" licence="${entry.license}" agents_proposes="${agents.join(",")}">\n${esc(skill.body.slice(0, 24_000))}\n</skill_publique>`,
              skill.files.length ? `<annexes>\n${skill.files.map((f) => `<annexe chemin="${esc(f.path)}">\n${esc(f.content.slice(0, 1500))}\n</annexe>`).join("\n")}\n</annexes>` : "<annexes>(aucune)</annexes>",
            ].join("\n\n"),
            jsonSchema: HERMES_ADAPT_SCHEMA,
            meta: { agent: "competences" },
          })
        ).data,
      );
      // Réservées au Développeur et au Testeur (ADR-105) : jamais aux agents qui ont le web.
      const allowed = adapted.agents.filter((a) => EXTERNAL_AGENTS.includes(a));
      if (!allowed.length) return refuse(["utile seulement au directeur, au Concepteur ou au DA : les compétences externes sont réservées au Développeur et au Testeur"]);
      const name = this.#skills.freeName(entry.name, "public");
      if (!name) return refuse([`nom « ${entry.name} » déjà pris`]);
      this.#skills.create({
        name,
        description: adapted.description.trim(),
        body: adapted.body.trim(),
        agents: allowed,
        source: "public",
        project,
        origin: `github:${entry.source}/${entry.path.replace(/\/?SKILL\.md$/, "")}`,
        status: "quarantine",
        files: skill.files.filter((f) => adapted.keep_files.includes(f.path)),
      });
      mark("imported");
      this.#journal.append({ project, actor: { kind: "system" }, type: "skill.public_imported", subject: name, payload: { source: entry.source, path: entry.path, license: entry.license, agents: allowed } });
      return name;
    } catch (err) {
      this.#journal.append({ project, actor: { kind: "system" }, type: "skill.lab_failed", subject: entry.name, payload: { error: (err as Error).message.slice(0, 300) } });
      return null;
    }
  }

  /** Écrit une compétence pour un besoin (contexte du jeu compris) ; elle reste en quarantaine jusqu'à son essai. */
  async #write(need: { id: number; project: string | null; topic: string }): Promise<string | null> {
    try {
      const p = need.project ? this.#projects.get(need.project) : null;
      const lessons = need.project ? this.#skills.list(need.project).find((s) => s.source === "lessons" && s.project === need.project) : undefined;
      const prompt = [
        `<besoin>${esc(need.topic)}</besoin>`,
        p ? `<jeu nom="${esc(p.name)}" moteur="${p.engine}">\n${esc((this.#tasks.gameState?.(p.slug) ?? "").slice(0, 3000))}\n</jeu>` : "",
        lessons ? `<lecons>\n${esc(lessons.body.slice(0, 2500))}\n</lecons>` : "",
        `<competences_existantes>\n${this.#skills.list().map((s) => `- ${s.name} [${s.source}] : ${esc(s.description)}`).join("\n")}\n</competences_existantes>`,
        "Aucune compétence du catalogue public ne couvre ce besoin. Écris-la (action « create ») si tu peux donner une méthode concrète et juste pour ce jeu ; sinon « none ».",
      ]
        .filter(Boolean)
        .join("\n\n");
      const out = ProcedureOutput.parse((await this.#orchestrator.structured({ systemPrompt: PROCEDURE_PROMPT, prompt, jsonSchema: PROCEDURE_SCHEMA, meta: { project: need.project, agent: "competences" } })).data);
      if (out.action === "none" || !out.body.trim()) return null;
      const name = this.#skills.freeName(out.name, "studio");
      if (!name) return null;
      this.#skills.create({ name, description: out.description.trim(), body: out.body.trim(), agents: out.agents.length ? out.agents : ["developer"], source: "learned", project: out.scope === "project" ? need.project : null, origin: `${need.project ?? "studio"}/besoin-${need.id}`, status: "quarantine" });
      this.#journal.append({ project: need.project, actor: { kind: "system" }, type: "skill.learned", subject: name, payload: { action: "create", task: `besoin « ${need.topic} »`, change: out.change, scope: out.scope } });
      return name;
    } catch (err) {
      this.#journal.append({ project: need.project, actor: { kind: "system" }, type: "skill.lab_failed", subject: need.topic, payload: { error: (err as Error).message.slice(0, 300) } });
      return null;
    }
  }

  // ── Motifs et ménage ─────────────────────────────────────────────────────

  async #patterns(project: string): Promise<void> {
    try {
      const merged = this.#tasks.list(project).filter((t) => t.status === "merged").slice(-PATTERN_EVERY);
      if (!merged.length) return;
      const blocks = merged.map((t) => {
        const runs = this.#tasks.runs(project, t.id);
        const rep = runs.findLast((r) => r.result?.report)?.result?.report;
        const ver = runs.findLast((r) => r.result?.verification)?.result?.verification;
        return `<chantier id="${t.id}" titre="${esc(t.title)}">\n${esc(t.goal.slice(0, 600))}\n${rep ? `Rapport : ${esc(rep.summary.slice(0, 800))}` : ""}\n${ver ? `Testeur (${ver.verdict}) : ${esc(ver.summary_simple)}\n${ver.checks.map((c) => `- ${esc(c.criterion)} : ${c.result}`).join("\n")}${ver.playtest ? `\nEn jouant : ${esc(ver.playtest.summary)}` : ""}` : ""}\n</chantier>`;
      });
      const learned = this.#skills.list(project).filter((s) => s.source === "learned").slice(0, 10);
      const prompt = [
        blocks.join("\n"),
        learned.length ? `<competences_apprises>\n${learned.map((s) => `<competence nom="${s.name}">\n${esc(s.body.slice(0, 1500))}\n</competence>`).join("\n")}\n</competences_apprises>` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const { data } = await this.#orchestrator.structured({ systemPrompt: PATTERNS_PROMPT, prompt, jsonSchema: PATTERNS_SCHEMA, meta: { project, agent: "competences" } });
      const day = this.#clock.now().slice(0, 10);
      for (const a of PatternsOutput.parse(data).actions) this.#skills.applyLearned(project, `${project}/motifs-${day}`, a);
    } catch (err) {
      this.#journal.append({ project, actor: { kind: "system" }, type: "skill.lab_failed", subject: "motifs", payload: { error: (err as Error).message.slice(0, 300) } });
    }
  }

  async #consolidate(): Promise<void> {
    const learned = this.#skills.list().filter((s) => s.source === "learned" && s.status === "active");
    if (learned.length < 6) return;
    const prompt = `<procedures_apprises>\n${learned
      .map((s) => `<competence nom="${s.name}" projet="${s.project ?? "tous"}" proposee="${s.stats.offered}" ouverte="${s.stats.used}">\n${esc(s.description)}\n${esc(s.body.slice(0, 1200))}\n</competence>`)
      .join("\n")}\n</procedures_apprises>`;
    const { data } = await this.#orchestrator.structured({ systemPrompt: CONSOLIDATE_PROMPT, prompt, jsonSchema: CONSOLIDATE_SCHEMA, meta: { agent: "competences" } });
    const out = ConsolidateOutput.parse(data);
    const byName = new Map(learned.map((s) => [s.name, s]));
    for (const m of out.merges) {
      const keep = byName.get(m.keep);
      if (!keep || !m.body.trim()) continue;
      this.#skills.rewrite(keep.id, m.description.trim() || keep.description, m.body.trim());
      for (const n of m.absorb) {
        const s = byName.get(n);
        if (!s || s.id === keep.id) continue;
        this.#skills.setStatus(s.id, "rejected", { kind: "review", verdict: "fail", summary: `fusionnée dans « ${keep.name} »`, at: this.#clock.now() });
        this.#journal.append({ project: s.project, actor: { kind: "system" }, type: "skill.merged", subject: s.name, payload: { into: keep.name } });
      }
    }
    for (const r of out.retire) {
      const s = byName.get(r.name);
      if (!s) continue;
      this.#skills.setStatus(s.id, "rejected", { kind: "review", verdict: "fail", summary: r.why, at: this.#clock.now() });
      this.#journal.append({ project: s.project, actor: { kind: "system" }, type: "skill.retired", subject: s.name, payload: { why: r.why } });
    }
  }

  // ── Interne ──────────────────────────────────────────────────────────────

  #get(key: string): string | null {
    const r = this.#db.prepare("SELECT value FROM skill_lab WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  #set(key: string, value: string): void {
    this.#db.prepare("INSERT INTO skill_lab (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Temps écoulé depuis une date gardée (infini si jamais). */
  #since(key: string): number {
    const v = this.#get(key);
    return v ? Date.parse(this.#clock.now()) - Date.parse(v.split(" ")[0]!) : Number.POSITIVE_INFINITY;
  }

  #track(p: Promise<unknown>): void {
    this.#background.add(p);
    void p.finally(() => this.#background.delete(p));
  }
}

/** Avec contre sans, sur le même chantier : réussite d'abord, puis coût et durée (30 % de marge). */
export function compareBench(withS: BenchResult, without: BenchResult): SkillTrial["verdict"] {
  if (withS.ok && !without.ok) return "pass";
  if (!withS.ok && without.ok) return "fail";
  if (!withS.ok && !without.ok) return "inconclusive";
  const cost = withS.costUsd != null && without.costUsd != null ? withS.costUsd <= without.costUsd * 1.3 : true;
  const time = withS.seconds <= Math.max(60, without.seconds * 1.3);
  return cost && time ? "pass" : "inconclusive";
}

const esc = (s: string) => s.replace(/</g, "‹").replace(/>/g, "›").replace(/"/g, "'");
