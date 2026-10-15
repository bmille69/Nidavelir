import type { Autonomy, ItemFrontmatter, Task } from "@studio/contracts";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { ApprovalService } from "../approvals/approval-service.ts";
import type { Clock } from "../clock.ts";
import { CAPTURE_MARK, type ConversationService, type Directives, type ImplementRequest } from "../conversation/conversation-service.ts";
import type { TaskService } from "../executor/task-service.ts";
import type { Journal } from "../journal/journal.ts";
import { describeChecks, regressionFeedback, type CheckService } from "../quality/checks.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import type { SynthesisJob, SynthesisService } from "../vision/synthesis.ts";
import type { VisionService } from "../vision/vision-service.ts";

/**
 * Ce que le directeur peut trancher seul, selon votre niveau d'autonomie (ADR-20) :
 * - « supervised » : rien ;
 * - « balanced » : les propositions sans conflit avec le canon et sans question ;
 * - « autonomous » : idem, plus celles qui remplacent une décision (sans question).
 * Une proposition avec des questions ou des options vous revient toujours.
 */
export function canDecide(level: Autonomy, p: ItemFrontmatter): boolean {
  if (level === "supervised" || level === "workshop" || p.type !== "proposal" || p.status !== "submitted" || !p.proposal) return false;
  const d = p.proposal;
  if (d.questions.length || d.options.length) return false;
  if (d.supersedes.length) return level === "autonomous";
  return true;
}

/** Au-delà, une séance s'arrête et vous fait le bilan (garde-fou contre une séance qui s'emballe). */
const MAX_SESSION_TASKS = 12;

type Session = { thread: string; goal: string; started: number; until: number; tasks: string[]; failures: number; turning: boolean; timer: ReturnType<typeof setTimeout> };

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }).replace(":", "h");

export type AutopilotOptions = {
  /** Délai d'attente après le dernier message avant de regrouper les idées (les échanges rapprochés sont regroupés ensemble). */
  synthesisDelayMs: number;
};

/** Pilote automatique : regroupe après les échanges, décide ce qui peut l'être, lance les plans sans risque. */
export class Autopilot {
  readonly #projects: ProjectRegistry;
  readonly #vision: VisionService;
  readonly #approvals: ApprovalService;
  readonly #synthesis: SynthesisService;
  readonly #tasks: TaskService;
  readonly #journal: Journal;
  readonly #clock: Clock;
  readonly #opts: AutopilotOptions;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #background = new Set<Promise<unknown>>();
  readonly #deciding = new Map<string, { project: string; count: number; since: string }>();
  #closed = false;
  /** Pour répondre dans la discussion (posé par le hub, évite une dépendance circulaire). */
  conversations: ConversationService | null = null;
  readonly #handing = new Map<string, { project: string; title: string; since: string }>();
  /** Séances autonomes en cours, par projet (en mémoire : un arrêt du hub les termine). */
  readonly #sessions = new Map<string, Session>();
  /** Fusions faites par le hub (le compte rendu les annonce déjà). */
  readonly #autoMerging = new Set<string>();
  /** Carnet « État du jeu » montré au directeur (ADR-33). */
  gameState: { get(project: string): { text: string } | null } | null = null;
  /** Vérifications objectives avant fusion (ADR-32) ; absent = fusion sur le seul avis du testeur. */
  checks: CheckService | null = null;
  /** Notification sur vos appareils (posée par le hub). */
  alert: ((n: { title: string; body: string; url: string; tag: string }) => void) | null = null;

  constructor(deps: {
    projects: ProjectRegistry;
    vision: VisionService;
    approvals: ApprovalService;
    synthesis: SynthesisService;
    tasks: TaskService;
    journal: Journal;
    clock: Clock;
    options: AutopilotOptions;
  }) {
    this.#projects = deps.projects;
    this.#vision = deps.vision;
    this.#approvals = deps.approvals;
    this.#synthesis = deps.synthesis;
    this.#tasks = deps.tasks;
    this.#journal = deps.journal;
    this.#clock = deps.clock;
    this.#opts = deps.options;
  }

  /** Après un échange : une fois les idées notées, regroupe la discussion (avec un délai, pour grouper les messages rapprochés). */
  afterExchange(project: string, thread: string, settled: Promise<unknown>): void {
    this.#track(
      settled.then(() => {
        if (this.#closed) return;
        const key = `${project}/${thread}`;
        clearTimeout(this.#timers.get(key));
        this.#timers.set(
          key,
          setTimeout(() => {
            this.#timers.delete(key);
            this.#track(this.#synthesize(project, thread));
          }, this.#opts.synthesisDelayMs),
        );
      }),
    );
  }

  /** Fin d'un regroupement : décide ce que l'autonomie du projet permet. */
  async onSynthesis(job: SynthesisJob): Promise<void> {
    const level = this.#projects.get(job.project).autonomy;
    if (level === "supervised" || level === "workshop") return;
    await this.#decideAll(job.project, level, job.proposals);
  }

  /** Votre demande explicite : laisser le directeur trancher les propositions en attente qu'il peut décider. */
  async decidePending(session: HumanSession, project: string): Promise<{ decided: string[]; left: number }> {
    assertHumanSession(session);
    const level = this.#projects.get(project).autonomy;
    const pending = this.#vision.list(project, { type: "proposal", status: "submitted" });
    const decided = await this.#decideAll(project, level === "supervised" || level === "workshop" ? "balanced" : level, pending.map((p) => p.id));
    return { decided, left: pending.length - decided.length };
  }

  /** Plan proposé : en atelier ou en autonomie complète, un plan sans risque part tout seul. */
  async onPlanSubmitted(project: string, task: string): Promise<void> {
    const level = this.#projects.get(project).autonomy;
    if (level !== "autonomous" && level !== "workshop") return;
    if (await this.#tasks.autoApprovePlan(project, task, level)) return;
    const t = this.#tasks.get(project, task);
    if (t.origin && t.plan) {
      const why = this.#tasks.planNeedsYou(this.#tasks.plan(project, t.plan), level);
      this.conversations?.notify(project, t.origin.thread, `⚠ Le plan de ${t.id} a besoin de votre accord : ${why.join(" ; ")}. Ouvrez « Chantiers » pour le valider ou le refuser.`);
    }
  }

  /** Nouvelles d'un chantier lancé depuis une discussion. */
  onTaskStatus(task: { id: string; project: string; title: string; status: string; origin: { thread: string } | null }): void {
    const session = this.#sessions.get(task.project);
    if (session?.tasks.includes(task.id) && task.status === "failed") session.failures++;
    if (!task.origin) return;
    // Fusion automatique : le compte rendu complet le dit déjà.
    if (task.status === "merged" && this.#autoMerging.has(`${task.project}/${task.id}`)) return;
    const text: Record<string, string> = {
      failed: `✗ Chantier ${task.id} « ${task.title} » : le travail a échoué. Le détail est dans « Chantiers » ; dites-moi si on relance autrement.`,
      merged: `Chantier ${task.id} fusionné dans votre jeu. Un mot pour la suite : 👍 ou 👎 à droite, ça aide à juger le studio (onglet « Qualité »).`,
    };
    if (text[task.status]) this.conversations?.notify(task.project, task.origin.thread, text[task.status]!);
  }

  /**
   * Fin de la vérification (résultats enregistrés). En atelier ou en autonomie (ADR-31) :
   * - le testeur valide → le hub fusionne tout seul ;
   * - il trouve des problèmes → le développeur corrige une fois, dans la même copie ;
   * - toujours des problèmes (ou pas d'avis du testeur) → le chantier attend votre mot dans la discussion.
   */
  onRunFinished(task: { id: string; project: string; title: string; status: string; direct?: boolean; origin: { thread: string } | null }, kind: string): Promise<void> | void {
    if (!task.origin || kind !== "verify" || task.status !== "review") return;
    const level = this.#projects.get(task.project).autonomy;
    if (level !== "workshop" && level !== "autonomous") {
      this.conversations?.notify(task.project, task.origin.thread, this.#reviewReport(task.project, task.id, task.title, "manual"));
      return;
    }
    return this.#afterVerify({ ...task, origin: task.origin }, level);
  }

  async #afterVerify(task: { id: string; project: string; title: string; direct?: boolean; origin: { thread: string } }, level: Autonomy): Promise<void> {
    const { project, id, title } = task;
    const say = (text: string) => this.conversations?.notify(project, task.origin.thread, text);
    const runs = this.#tasks.runs(project, id);
    const verdict = runs.findLast((r) => r.result?.verification)?.result?.verification;
    const rounds = runs.filter((r) => r.kind === "verify").length;
    if (verdict && verdict.verdict !== "fail") {
      const key = `${project}/${id}`;
      this.#autoMerging.add(key);
      try {
        // Le testeur est un agent : le hub a vérifié lui-même les tests et le lancement du jeu juste avant lui (ADR-32).
        const check = this.checks?.get(project, id) ?? null;
        if (check?.regression) {
          this.#journal.append({ project, actor: { kind: "system" }, type: "tester.missed", subject: id, payload: { tests: check.tests.status, launch: check.launch.status } });
          if (task.direct && rounds < 2) {
            say(`↻ Chantier ${id} « ${title} » : le testeur était d'accord, mais le hub a vérifié lui-même et quelque chose ne marche plus (${describeChecks(check)}). Le développeur corrige. Rien à faire de votre côté.`);
            await this.#tasks.correct(project, id, regressionFeedback(check), "tester");
          } else {
            say(this.#reviewReport(project, id, title, "needs_you"));
            this.alert?.({ title: "✋ Un chantier attend votre avis", body: `${title} — il casse quelque chose qui marchait`, url: `#/p/${project}/tasks/${id}`, tag: id });
          }
          return;
        }
        await this.#tasks.autoMerge(project, id, level, check ? "Validé par le testeur et vérifié par le hub" : "Validé par le testeur");
        say(this.#reviewReport(project, id, title, "merged"));
      } catch (err) {
        say(this.#reviewReport(project, id, title, "blocked", (err as Error).message));
        this.alert?.({ title: "⚠ Chantier à fusionner", body: `${title} : ${(err as Error).message.slice(0, 120)}`, url: `#/p/${project}/tasks/${id}`, tag: id });
      } finally {
        this.#autoMerging.delete(key);
      }
      return;
    }
    if (verdict && task.direct && rounds < 2) {
      const problems = [...verdict.checks.filter((c) => c.result === "fail").map((c) => `${c.criterion} : ${c.evidence}`), ...verdict.regressions.map((r) => `Régression : ${r}`)];
      say(`↻ Chantier ${id} « ${title} » : le testeur a trouvé des problèmes (${verdict.summary_simple}). Le développeur corrige, puis le testeur revérifie. Rien à faire de votre côté.`);
      const check = this.checks?.get(project, id);
      const feedback = [`Le testeur a relevé : ${verdict.summary_simple}`, ...problems.slice(0, 8).map((p) => `- ${p}`), ...(check?.regression ? ["", regressionFeedback(check)] : [])];
      await this.#tasks.correct(project, id, feedback.join("\n"), "tester");
      return;
    }
    say(this.#reviewReport(project, id, title, "needs_you"));
    this.alert?.({ title: "✋ Un chantier attend votre avis", body: `${title} — le testeur a trouvé des problèmes`, url: `#/p/${project}/tasks/${id}`, tag: id });
  }

  /** Compte rendu de fin de chantier, dans la discussion : ce qui a changé, l'avis du testeur, comment essayer. */
  #reviewReport(project: string, id: string, title: string, outcome: "manual" | "merged" | "blocked" | "needs_you", error?: string): string {
    const runs = this.#tasks.runs(project, id);
    const report = runs.findLast((r) => r.result?.report)?.result?.report;
    const verdict = runs.findLast((r) => r.result?.verification)?.result?.verification;
    const ok = !verdict || verdict.verdict !== "fail";
    // Vérifications du hub, faites juste avant le testeur (ADR-32, ADR-33).
    const check = this.checks?.get(project, id) ?? null;
    const done = outcome === "merged" ? " et fusionné dans votre jeu" : "";
    const head = check?.regression && ok && verdict
      ? "⚠ Chantier " + `${id} « ${title} » terminé — le testeur était d'accord, mais le hub a trouvé un problème`
      : `${ok ? "✓" : "⚠"} Chantier ${id} « ${title} » terminé${verdict ? (ok ? `, vérifié par le testeur${done}` : " — le testeur a trouvé des problèmes") : ""}`;
    const lines = [`${head}.`];
    if (report?.summary_simple) lines.push("", `Ce qui a changé : ${report.summary_simple}`);
    if (verdict) {
      lines.push("", `Avis du testeur : ${verdict.summary_simple}`);
      for (const c of verdict.checks.filter((c) => c.result === "fail").slice(0, 4)) lines.push(`  ✗ ${c.criterion}`);
      for (const r of verdict.regressions.slice(0, 3)) lines.push(`  ⚠ ${r}`);
    }
    if (check && describeChecks(check)) lines.push("", describeChecks(check));
    // L'image du jeu, affichée dans la discussion (ADR-33).
    if (check?.launch.screenshot) lines.push("", `${CAPTURE_MARK}${id} ${check.at}`);
    if (report?.deviations.length) lines.push("", "Écarts par rapport au plan :", ...report.deviations.slice(0, 4).map((d) => `  • ${d.what}`));
    if (report?.open_issues.length) lines.push("", "Reste à faire :", ...report.open_issues.slice(0, 4).map((x) => `  • ${x}`));
    if (report?.how_to_test.length) lines.push("", "Pour essayer :", ...report.how_to_test.map((s, k) => `  ${k + 1}. ${s}`));
    const cost = runs.reduce((n, r) => n + (r.cost_usd ?? 0), 0);
    if (cost > 0) lines.push("", `Coût de ce chantier : environ ${cost.toFixed(2).replace(".", ",")} $ (équivalent API, pris sur votre abonnement).`);
    const waiting = this.#tasks.queued(project).length;
    const next = waiting ? ` ${waiting} chantier(s) attendent leur tour derrière lui.` : "";
    lines.push(
      "",
      {
        manual: `Cliquez sur « ▶ Essayer » à droite pour lancer cette version du jeu, puis « Fusionner » si elle vous plaît${ok ? "" : ", ou dites-moi ce qu'il faut corriger"}.`,
        merged: "C'est dans votre jeu (annulable avec Git). « ▶ Lancer le jeu » à droite pour essayer ; un 👍 ou 👎 aide à juger le studio.",
        blocked: `Je n'ai pas pu le fusionner : ${error ?? "?"} Dites-moi « fusionne » quand c'est réglé, ou « laisse tomber ».${next}`,
        needs_you: `Il attend votre avis : essayez-le (« ▶ Essayer » à droite), puis dites-moi ici « fusionne », ce qu'il faut corriger, ou « laisse tomber ».${next}`,
      }[outcome],
    );
    return lines.join("\n");
  }

  // ── Atelier : vos consignes dans la discussion (ADR-31) ──────────────────

  /**
   * Ce que le directeur a demandé au hub dans sa réponse : fusionner, corriger, abandonner, lancer
   * des chantiers (à la suite, un à la fois), ouvrir ou fermer une séance autonome.
   */
  async workshop(project: string, thread: string, d: Directives, fromHub = false): Promise<void> {
    const lines: string[] = [];
    const level = this.#projects.get(project).autonomy;
    if (level !== "workshop") return;
    const attempt = async (id: string, fn: () => Promise<string>) => {
      try {
        lines.push(await fn());
      } catch (err) {
        lines.push(`✗ ${id} : ${(err as Error).message}`);
      }
    };
    if (d.endSession && this.#sessions.has(project)) {
      this.#endSession(project, fromHub ? "objectif atteint ou choix à faire" : "à votre demande");
    }
    if (d.session && !fromHub) this.#startSession(project, thread, d.session);
    for (const id of d.merge) {
      await attempt(id, async () => {
        const key = `${project}/${id}`;
        this.#autoMerging.add(key);
        try {
          await this.#tasks.autoMerge(project, id, level, "Vous avez dit de fusionner, dans la discussion");
        } finally {
          this.#autoMerging.delete(key);
        }
        return `✓ ${id} fusionné dans votre jeu.`;
      });
    }
    for (const f of d.fixes) {
      await attempt(f.task, async () => {
        await this.#tasks.correct(project, f.task, f.note, "you");
        return `↻ ${f.task} : le développeur corrige selon vos remarques ; le testeur revérifiera.`;
      });
    }
    for (const id of d.abandon) {
      await attempt(id, async () => {
        await this.#tasks.abandonDelegated(project, id);
        return `${id} abandonné : ses modifications sont supprimées, votre jeu reste intact.`;
      });
    }
    const launched: string[] = [];
    for (const id of d.launch) await attempt(id, async () => this.#launch(project, this.#tasks.get(project, id), launched));
    for (const r of d.requests) {
      await attempt(r.title, async () => {
        const named = r.decisions.filter((id) => this.#isValidated(project, id));
        const task = this.#tasks.createFromConversation(project, { title: r.title, goal: r.goal, decisions: named, reworks: r.reworks }, thread);
        return this.#launch(project, task, launched);
      });
    }
    const session = this.#sessions.get(project);
    if (session) session.tasks.push(...launched.filter((id) => !session.tasks.includes(id)));
    if (session && d.session && !fromHub) {
      lines.unshift(`▶ Séance autonome jusqu'à ${hhmm(session.until)} : ${session.goal || "objectif ci-dessus"}. J'enchaîne les chantiers, je fusionne ce que le testeur valide, et je vous fais le bilan à la fin. Dites « stop » pour arrêter.`);
    }
    if (lines.length) this.conversations?.notify(project, thread, lines.join("\n"));
    if (fromHub && session && !launched.length && !d.endSession) this.#endSession(project, "pas de suite proposée");
  }

  async #launch(project: string, task: Task, launched: string[]): Promise<string> {
    const { after } = await this.#tasks.launch(project, task.id);
    launched.push(task.id);
    if (after) return `⏳ Chantier ${task.id} « ${task.title} » en attente : il partira tout seul après ${after.id}.`;
    return `→ Chantier ${task.id} « ${task.title} » lancé : le développeur est au travail (suivi en direct à droite). Je vous préviens ici quand c'est prêt.`;
  }

  /** Ce que le directeur sait des chantiers et de la séance, pour agir sur votre mot. */
  workshopState(project: string): string {
    const label: Record<string, string> = {
      draft: "brouillon (pas lancé)",
      approved: "en cours",
      running: "en cours",
      review: "à relire : attend le directeur créatif",
      merged: "fusionné",
      failed: "en échec",
      cancelled: "arrêté",
      abandoned: "abandonné",
    };
    const all = this.#tasks.list(project);
    const shown = [...all.filter((t) => !["merged", "abandoned", "cancelled", "failed", "rejected"].includes(t.status)), ...all.filter((t) => t.status === "merged").slice(0, 8)];
    const rows = shown.map((t) => {
      const busy = t.status === "review" && this.#autoMerging.has(`${project}/${t.id}`);
      const state = t.queued_at ? "en attente de son tour" : busy ? "en vérification avant fusion" : (label[t.status] ?? t.status);
      return `- ${t.id} « ${t.title} » : ${state}`;
    });
    const s = this.#sessions.get(project);
    const now = Date.parse(this.#clock.now());
    const state = this.gameState?.get(project)?.text ?? null;
    return [
      state ? `<etat_du_jeu note="carnet tenu à jour par le hub après chaque chantier fusionné : ce qui existe déjà, les choix faits, les limites connues">\n${state.replace(/</g, "‹")}\n</etat_du_jeu>` : "",
      `<chantiers>\n${rows.join("\n") || "(aucun)"}\n</chantiers>`,
      s ? `<seance objectif="${s.goal.replace(/"/g, "'")}" fin="${hhmm(s.until)}" reste_minutes="${Math.max(0, Math.round((s.until - now) / 60_000))}" />` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // ── Séance autonome (ADR-31) ─────────────────────────────────────────────

  #startSession(project: string, thread: string, spec: { minutes: number; goal: string }): void {
    const old = this.#sessions.get(project);
    if (old) clearTimeout(old.timer);
    const started = Date.parse(this.#clock.now());
    const until = started + spec.minutes * 60_000;
    const timer = setTimeout(() => this.#deadline(project), spec.minutes * 60_000);
    timer.unref?.();
    this.#sessions.set(project, { thread, goal: spec.goal, started, until, tasks: old?.thread === thread ? old.tasks : [], failures: 0, turning: false, timer });
    this.#journal.append({ project, actor: { kind: "agent", role: "director", run: "autopilot" }, type: "session.started", subject: thread, payload: spec });
  }

  /** Temps écoulé : le chantier en cours se termine, ceux qui attendaient redeviennent des brouillons. */
  #deadline(project: string): void {
    const s = this.#sessions.get(project);
    if (!s) return;
    s.until = Math.min(s.until, Date.parse(this.#clock.now()));
    for (const t of this.#tasks.queued(project)) if (s.tasks.includes(t.id)) this.#tasks.unqueue(project, t.id);
    if (!this.#tasks.busy(project)) this.#endSession(project, "temps écoulé");
  }

  /** Projet libre et file vide : la séance continue (le directeur propose la suite) ou se termine. */
  async onQueueEmpty(project: string): Promise<void> {
    const s = this.#sessions.get(project);
    if (!s || s.turning || this.#tasks.busy(project) || this.#tasks.queued(project).length) return;
    const now = Date.parse(this.#clock.now());
    if (now >= s.until - 5 * 60_000) return this.#endSession(project, "temps écoulé");
    if (s.failures >= 2) return this.#endSession(project, "deux chantiers en échec : mieux vaut que vous regardiez");
    if (s.tasks.length >= MAX_SESSION_TASKS) return this.#endSession(project, `${MAX_SESSION_TASKS} chantiers réalisés, maximum d'une séance`);
    if (!this.conversations) return;
    s.turning = true;
    try {
      const { directives } = await this.conversations.hubTurn(project, s.thread, this.#checkpoint(project, s, now));
      await this.workshop(project, s.thread, directives, true);
    } catch (err) {
      this.#endSession(project, `je n'ai pas pu préparer la suite (${(err as Error).message.slice(0, 200)})`);
    } finally {
      s.turning = false;
    }
  }

  #checkpoint(project: string, s: Session, now: number): string {
    return [
      `Point d'étape de la séance autonome « ${s.goal} » : il reste environ ${Math.round((s.until - now) / 60_000)} min (fin prévue à ${hhmm(s.until)}).`,
      "Chantiers de la séance :",
      ...this.#sessionRows(project, s),
      "Propose les chantiers suivants vers l'objectif (blocs [[CHANTIER]], 1 à 3), ou termine par [[FIN_SEANCE]] avec un bilan clair si l'objectif est atteint ou si la suite demande ses choix.",
    ].join("\n");
  }

  #sessionRows(project: string, s: Session): string[] {
    const state: Record<string, string> = {
      merged: "✓ fusionné",
      review: "⚠ attend votre avis",
      failed: "✗ en échec",
      abandoned: "abandonné",
      cancelled: "arrêté",
      draft: "⏸ pas commencé (« ▶ Lancer » à droite)",
    };
    return s.tasks.map((id) => {
      const t = this.#tasks.get(project, id);
      return `- ${t.id} « ${t.title} » : ${state[t.status] ?? "en cours"}`;
    });
  }

  #endSession(project: string, reason: string): void {
    const s = this.#sessions.get(project);
    if (!s) return;
    clearTimeout(s.timer);
    this.#sessions.delete(project);
    const minutes = Math.round((Date.parse(this.#clock.now()) - s.started) / 60_000);
    const cost = s.tasks.reduce((n, id) => n + this.#tasks.runs(project, id).reduce((m, r) => m + (r.cost_usd ?? 0), 0), 0);
    const merged = s.tasks.filter((id) => this.#tasks.get(project, id).status === "merged").length;
    const lines = [
      `■ Fin de la séance « ${s.goal || "autonome"} » (${reason}), après ${minutes} min : ${merged} chantier(s) fusionné(s) sur ${s.tasks.length}.`,
      ...this.#sessionRows(project, s),
    ];
    if (cost > 0) lines.push("", `Coût de la séance : environ ${cost.toFixed(2).replace(".", ",")} $ (équivalent API, pris sur votre abonnement).`);
    this.conversations?.notify(project, s.thread, lines.join("\n"));
    this.alert?.({ title: "■ Séance terminée", body: `${merged}/${s.tasks.length} chantier(s) fusionné(s) — ${reason}`, url: `#/p/${project}`, tag: `session-${project}` });
    this.#journal.append({ project, actor: { kind: "agent", role: "director", run: "autopilot" }, type: "session.ended", subject: s.thread, payload: { reason, tasks: s.tasks, merged } });
  }

  /** Séance en cours (vue « Studio » et discussion). */
  session(project: string): { thread: string; goal: string; until: string; tasks: string[] } | null {
    const s = this.#sessions.get(project);
    return s ? { thread: s.thread, goal: s.goal, until: new Date(s.until).toISOString(), tasks: [...s.tasks] } : null;
  }

  #isValidated(project: string, id: string): boolean {
    try {
      const d = this.#vision.get(project, id);
      return d.type === "decision" && d.status === "validated";
    } catch {
      return false;
    }
  }

  /**
   * Vous avez dit « go » : le directeur confie le travail au développeur (ADR-22).
   * 1. Les idées de la discussion sont regroupées et décidées tout de suite (sans attendre le délai).
   * 2. La tâche s'appuie sur les décisions citées par le directeur et sur celles issues de cette discussion
   *    qui ne sont pas déjà confiées à une tâche.
   * 3. Le développeur prépare son plan ; en « autonome », un plan sans risque est validé et lancé.
   */
  async implement(project: string, thread: string, request: ImplementRequest, settled: Promise<unknown>): Promise<void> {
    const key = `${project}/${thread}/${this.#clock.now()}`;
    this.#handing.set(key, { project, title: request.title, since: this.#clock.now() });
    const say = (text: string) => this.conversations?.notify(project, thread, text);
    try {
      await settled;
      const level = this.#projects.get(project).autonomy;
      if (level === "workshop") {
        // Atelier (ADR-24) : pas de fiches ; la consigne du directeur est le cahier des charges.
        await this.workshop(project, thread, { requests: [request], session: null, endSession: false, merge: [], abandon: [], launch: [], fixes: [] });
        return;
      }
      await this.#flush(project, thread);
      const taken = new Set(this.#tasks.list(project).filter((t) => !["abandoned", "rejected"].includes(t.status)).flatMap((t) => t.authorized_by));
      const named = request.decisions.filter((id) => this.#isValidated(project, id));
      const fromThread = this.#decisionsFromThread(project, thread).filter((id) => !taken.has(id));
      const decisions = [...new Set([...named, ...fromThread])].slice(0, 10);
      if (!decisions.length) {
        say("Je n'ai pas encore de décision validée sur laquelle appuyer ce travail : précisez ce qu'il faut réaliser, ou répondez d'abord aux questions affichées à droite de la discussion.");
        return;
      }
      const task = this.#tasks.createDelegated(project, { decisions, title: request.title, goal: request.goal }, level);
      await this.#tasks.startPlanning(project, task.id);
      say(
        `Tâche ${task.id} « ${task.title} » confiée au développeur (appuyée sur ${decisions.join(", ")}). Il étudie le code et prépare un plan, sans rien modifier.` +
          (level === "autonomous"
            ? " Si le plan est sans risque, il sera validé et lancé automatiquement ; vous n'aurez qu'à relire et fusionner."
            : " Vous validerez ce plan dans l'onglet « Chantiers » avant qu'il ne touche au code."),
      );
    } catch (err) {
      say(`Je n'ai pas pu confier ce travail au développeur : ${(err as Error).message}`);
    } finally {
      this.#handing.delete(key);
    }
  }

  /** Ce que le pilote est en train de faire (vue « Studio »). */
  activity(): { project: string; count: number; since: string }[] {
    return [...this.#deciding.values()];
  }

  handing(): { project: string; title: string; since: string }[] {
    return [...this.#handing.values()];
  }

  /** Regroupe et décide tout de suite les idées de la discussion. */
  async #flush(project: string, thread: string): Promise<void> {
    const key = `${project}/${thread}`;
    clearTimeout(this.#timers.get(key));
    this.#timers.delete(key);
    await this.#synthesis.idle();
    if (!this.#synthesis.candidates(project, { thread }).length) return;
    this.#synthesis.start(project, { thread });
    await this.#synthesis.idle();
  }

  /** Décisions validées dont une des idées sources vient de cette discussion. */
  #decisionsFromThread(project: string, thread: string): string[] {
    const fromThread = (id: string) => {
      try {
        const i = this.#vision.get(project, id);
        return i.source.kind === "message" && i.source.ref.startsWith(`${thread}/`);
      } catch {
        return false;
      }
    };
    return this.#vision
      .list(project, { type: "decision", status: "validated" })
      .filter((d) => {
        const proposal = d.decision?.from_proposal;
        if (!proposal) return false;
        return (this.#vision.get(project, proposal).proposal?.based_on ?? []).some(fromThread);
      })
      .map((d) => d.id);
  }

  async idle(): Promise<void> {
    while (this.#background.size || this.#timers.size) {
      if (!this.#background.size) {
        // Des regroupements sont programmés : on les lance sans attendre le délai.
        for (const [key, t] of this.#timers) {
          clearTimeout(t);
          this.#timers.delete(key);
          const [project, thread] = key.split("/") as [string, string];
          this.#track(this.#synthesize(project, thread));
        }
      }
      await Promise.allSettled([...this.#background]);
      await this.#synthesis.idle();
    }
  }

  close(): void {
    this.#closed = true;
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    for (const s of this.#sessions.values()) clearTimeout(s.timer);
    this.#sessions.clear();
  }

  async #synthesize(project: string, thread: string): Promise<void> {
    if (this.#closed || !this.#synthesis.candidates(project, { thread }).length) return;
    if (this.#synthesis.list(project).some((j) => j.status === "running")) {
      // Un regroupement est déjà en cours : on réessaie un peu plus tard.
      this.afterExchange(project, thread, Promise.resolve());
      return;
    }
    this.#synthesis.start(project, { thread });
  }

  async #decideAll(project: string, level: Autonomy, ids: string[]): Promise<string[]> {
    const decided: string[] = [];
    const key = `${project}:${this.#clock.now()}`;
    this.#deciding.set(key, { project, count: ids.length, since: this.#clock.now() });
    try {
      for (const id of ids) {
        const p = this.#vision.get(project, id);
        if (!canDecide(level, p)) continue;
        try {
          const approval = this.#approvals.recordDelegated({
            project,
            subject: { kind: "proposal", id, hash: this.#vision.proposalHash(project, id) },
            verdict: "approved",
            autonomy: level,
            run: "autopilot",
            note: p.proposal!.supersedes.length ? `Remplace ${p.proposal!.supersedes.join(", ")}` : "Sans conflit ni question",
          });
          const { decision } = await this.#vision.decideProposal(project, approval.id);
          if (decision) decided.push(decision.id);
        } catch (err) {
          this.#journal.append({
            project,
            actor: { kind: "agent", role: "director", run: "autopilot" },
            type: "autopilot.failed",
            subject: id,
            payload: { error: (err as Error).message.slice(0, 300) },
          });
        }
      }
    } finally {
      this.#deciding.delete(key);
    }
    return decided;
  }

  #track(p: Promise<unknown>): void {
    const safe = p.catch(() => {});
    this.#background.add(safe);
    void safe.finally(() => this.#background.delete(safe));
  }
}
