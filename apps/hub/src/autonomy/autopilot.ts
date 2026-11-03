import type { Autonomy, ItemFrontmatter, Task } from "@studio/contracts";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { ApprovalService } from "../approvals/approval-service.ts";
import type { Clock } from "../clock.ts";
import { CAPTURE_MARK, type ConversationService, type Directives, type ImplementRequest } from "../conversation/conversation-service.ts";
import { reconcileFeedback } from "../executor/prompts.ts";
import { isBigTask, type ScheduleEvent, type TaskService } from "../executor/task-service.ts";
import type { Journal } from "../journal/journal.ts";
import { describeChecks, regressionFeedback, relevantPoses, POSE_MARK, type CheckService } from "../quality/checks.ts";
import { blockingChecks, describePoint, pointsToFix, verdictBlocks } from "../quality/verdict.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import type { OrchestratorPort } from "../orchestrator/port.ts";
import { applyReview, reviewBrief, reviewMark, type Brief } from "./brief-review.ts";
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
/** Vérifications du testeur avant de vous demander votre mot : deux corrections automatiques (choix du 23/10/2026). */
const VERIFY_ROUNDS = 3;
/** Dernière correction automatique : un modèle plus fort plutôt que la même passe une troisième fois (audit du 28/10). */
const STRONGER = " (dernière tentative automatique, avec le modèle des gros chantiers)";

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
  /** Le Concepteur, à qui le directeur peut confier une grosse demande (ADR-34). */
  conceptions: {
    startDelegated(project: string, input: { idea: string; thread: string }): { id: string; title: string };
    list(): { id: string; kind: string; project: string | null; title: string; status: string; data: { ready: boolean; questions: unknown[]; chantiers: { title: string }[] } }[];
  } | null = null;
  /** Carnet « État du jeu » montré au directeur (ADR-33). */
  gameState: { get(project: string): { text: string } | null } | null = null;
  /** Vérifications objectives avant fusion (ADR-32) ; absent = fusion sur le seul avis du testeur. */
  checks: CheckService | null = null;
  /** Le relecteur de la consigne du Directeur (ADR-125) ; absent : la consigne part telle quelle. */
  reviewer: OrchestratorPort | null = null;
  /** Notification sur vos appareils (posée par le hub). */
  alert: ((n: { title: string; body: string; url: string; tag: string }) => void) | null = null;
  /** Les plans de production (ADR-107) ; absent (STUDIO_PRODUCTION=0) : le bloc [[PRODUCTION]] est ignoré. */
  productions: {
    propose(project: string, thread: string, brief: string, opts: { auto?: boolean }): { id: string };
    summary(project: string): string[];
  } | null = null;

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
    const held = task.status === "failed" ? this.#tasks.heldBy(task.project, task.id) : [];
    if (held.length)
      text.failed += `\n⏸ La file s'arrête là : ${held.join(", ")} s'appuient sur ce travail et ne partent pas sans lui. Ils restent prêts ; dites « relance ${task.id} et enchaîne » quand c'est réglé.`;
    if (text[task.status]) this.conversations?.notify(task.project, task.origin.thread, text[task.status]!);
  }

  /**
   * Fin de la vérification (résultats enregistrés). En atelier ou en autonomie (ADR-31) :
   * - le testeur valide → le hub fusionne tout seul ;
   * - il trouve des problèmes → le développeur corrige, dans la même copie, jusqu'à deux fois (trois vérifications, 23/10/2026) ;
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
    if (verdict && !verdictBlocks(verdict)) {
      const key = `${project}/${id}`;
      // Plusieurs chantiers sur le jeu (ADR-104) : une fusion à la fois, du « réunir » au « fusionner ».
      const release = this.#tasks.parallel > 1 ? await this.#lock(project) : () => {};
      this.#autoMerging.add(key);
      try {
        // Le testeur est un agent : le hub a vérifié lui-même les tests et le lancement du jeu juste avant lui (ADR-32).
        const check = this.checks?.get(project, id) ?? null;
        if (check?.regression) {
          this.#journal.append({ project, actor: { kind: "system" }, type: "tester.missed", subject: id, payload: { tests: check.tests.status, launch: check.launch.status } });
          if (task.direct && rounds < VERIFY_ROUNDS) {
            const last = rounds === VERIFY_ROUNDS - 1 && !isBigTask({ title });
            say(`↻ Chantier ${id} « ${title} » : le testeur était d'accord, mais le hub a vérifié lui-même et quelque chose ne marche plus (${describeChecks(check)}). Le développeur corrige${last ? STRONGER : ""}. Rien à faire de votre côté.`);
            await this.#tasks.correct(project, id, regressionFeedback(check), "tester", { stronger: last });
          } else {
            say(this.#reviewReport(project, id, title, "needs_you"));
            this.alert?.({ title: "✋ Un chantier attend votre avis", body: `${title} — il casse quelque chose qui marchait`, url: `#/p/${project}/tasks/${id}`, tag: id });
          }
          return;
        }
        // Plusieurs chantiers sur le jeu (ADR-104) : réuni d'abord avec ce qui a été fusionné depuis son départ.
        if (this.#tasks.parallel > 1 && task.direct) {
          const step = await this.#tasks.integrate(project, id);
          if (step.status === "conflict") {
            say(`↻ Chantier ${id} « ${title} » : pendant qu'il travaillait, d'autres chantiers ont été fusionnés et touchent les mêmes lignes (${step.files.slice(0, 3).join(", ")}${step.files.length > 3 ? "…" : ""}). Le développeur réconcilie les deux versions, puis le testeur revérifie. Rien à faire de votre côté.`);
            await this.#tasks.correct(project, id, reconcileFeedback(step.files), "tester");
            return;
          }
          const after = step.status === "integrated" ? (this.checks?.get(project, id) ?? null) : null;
          if (after?.regression) {
            this.#journal.append({ project, actor: { kind: "system" }, type: "integration.regression", subject: id, payload: { tests: after.tests.status, launch: after.launch.status } });
            if (rounds < VERIFY_ROUNDS) {
              say(`↻ Chantier ${id} « ${title} » : réuni avec les chantiers fusionnés entre-temps, quelque chose ne marche plus (${describeChecks(after)}). Le développeur corrige. Rien à faire de votre côté.`);
              await this.#tasks.correct(project, id, `Ta copie contient maintenant la version actuelle du jeu (d'autres chantiers ont été fusionnés entre-temps). Une fois réunis :\n${regressionFeedback(after)}`, "tester");
            } else {
              say(this.#reviewReport(project, id, title, "needs_you"));
              this.alert?.({ title: "✋ Un chantier attend votre avis", body: `${title} — réuni avec les autres chantiers, il casse quelque chose`, url: `#/p/${project}/tasks/${id}`, tag: id });
            }
            return;
          }
        }
        await this.#tasks.autoMerge(project, id, level, check ? "Validé par le testeur et vérifié par le hub" : "Validé par le testeur");
        say(this.#reviewReport(project, id, title, "merged"));
      } catch (err) {
        say(this.#reviewReport(project, id, title, "blocked", (err as Error).message));
        this.alert?.({ title: "⚠ Chantier à fusionner", body: `${title} : ${(err as Error).message.slice(0, 120)}`, url: `#/p/${project}/tasks/${id}`, tag: id });
      } finally {
        this.#autoMerging.delete(key);
        release();
      }
      return;
    }
    if (verdict && task.direct && rounds < VERIFY_ROUNDS) {
      const problems = [...pointsToFix(verdict).map(describePoint), ...verdict.regressions.map((r) => `Régression : ${r}`)];
      const last = rounds === VERIFY_ROUNDS - 1 && !isBigTask({ title });
      // Un avis favorable, mais un point de rendu ou de votre demande pas prouvé (ADR-124) : ça ne fusionne pas.
      const why =
        verdict.verdict === "fail"
          ? `le testeur a trouvé des problèmes (${verdict.summary_simple})`
          : `le testeur était plutôt d'accord, mais un point de rendu ou de votre demande n'est pas prouvé : ${blockingChecks(verdict).slice(0, 3).map((c) => c.criterion).join(" ; ")}`;
      say(`↻ Chantier ${id} « ${title} » : ${why}. Le développeur corrige${last ? STRONGER : ""}, puis le testeur revérifie. Rien à faire de votre côté.`);
      const check = this.checks?.get(project, id);
      // Tous les points relevés passent au développeur : rien n'est coupé (le testeur en rend 20 au plus).
      const feedback = [`Le testeur a relevé : ${verdict.summary_simple}`, ...problems.map((p) => `- ${p}`), ...(check?.regression ? ["", regressionFeedback(check)] : [])];
      await this.#tasks.correct(project, id, feedback.join("\n"), "tester", { stronger: last });
      return;
    }
    say(this.#reviewReport(project, id, title, "needs_you"));
    this.alert?.({ title: "✋ Un chantier attend votre avis", body: `${title} — ${verdict?.verdict === "fail" || !verdict ? "le testeur a trouvé des problèmes" : "un point de rendu ou de votre demande n'est pas prouvé"}`, url: `#/p/${project}/tasks/${id}`, tag: id });
  }

  /** Compte rendu de fin de chantier, dans la discussion : ce qui a changé, l'avis du testeur, comment essayer. */
  #reviewReport(project: string, id: string, title: string, outcome: "manual" | "merged" | "blocked" | "needs_you", error?: string): string {
    const runs = this.#tasks.runs(project, id);
    const report = runs.findLast((r) => r.result?.report)?.result?.report;
    const verdict = runs.findLast((r) => r.result?.verification)?.result?.verification;
    const ok = !verdict || !verdictBlocks(verdict);
    // Vérifications du hub, faites juste avant le testeur (ADR-32, ADR-33).
    const check = this.checks?.get(project, id) ?? null;
    const done = outcome === "merged" ? " et fusionné dans votre jeu" : "";
    const head = check?.regression && ok && verdict
      ? "⚠ Chantier " + `${id} « ${title} » terminé — le testeur était d'accord, mais le hub a trouvé un problème`
      : `${ok ? "✓" : "⚠"} Chantier ${id} « ${title} » terminé${verdict ? (ok ? `, vérifié par le testeur${done}` : verdict.verdict === "fail" ? " — le testeur a trouvé des problèmes" : " — un point de rendu ou de votre demande n'est pas prouvé") : ""}`;
    const lines = [`${head}.`];
    if (report?.summary_simple) lines.push("", `Ce qui a changé : ${report.summary_simple}`);
    if (verdict) {
      lines.push("", `Avis du testeur : ${verdict.summary_simple}`);
      // Ce qu'il a vérifié en jouant, et ce qu'il n'a pas pu vérifier (ADR-69) : jamais présenté comme joué s'il ne l'a pas fait.
      if (verdict.playtest?.played) lines.push(`  ▶ Essayé en jouant : ${verdict.playtest.summary}`);
      else if (verdict.playtest) lines.push("  Le testeur n'a pas joué au jeu cette fois : il a vérifié par le code et les tests.");
      if (verdict.playtest?.unverified.length) lines.push(`  Pas vérifié en jeu : ${verdict.playtest.unverified.slice(0, 3).join(" ; ")}`);
      for (const c of pointsToFix(verdict).slice(0, 4)) lines.push(`  ✗ ${c.criterion}${c.result === "not_verifiable" ? " (non prouvé)" : ""}`);
      for (const r of verdict.regressions.slice(0, 3)) lines.push(`  ⚠ ${r}`);
    }
    if (check && describeChecks(check)) lines.push("", describeChecks(check));
    // L'image du jeu, affichée dans la discussion (ADR-33).
    if (check?.launch.screenshot) lines.push("", `${CAPTURE_MARK}${id} ${check.at}`);
    // Les poses de contrôle photographiées par le hub (ADR-122) : celles que le testeur cite d'abord, trois au plus.
    for (const p of check ? relevantPoses(check, verdict ?? null) : []) lines.push(`${POSE_MARK}${id} ${check!.at} ${encodeURIComponent(p.nom)}`);
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
        const release = this.#tasks.parallel > 1 ? await this.#lock(project) : () => {};
        this.#autoMerging.add(key);
        try {
          // Plusieurs chantiers sur le jeu (ADR-104) : votre « fusionne » passe aussi par la réunion avec la version actuelle.
          const t = this.#tasks.get(project, id);
          if (this.#tasks.parallel > 1 && t.direct && t.status === "review") {
            const step = await this.#tasks.integrate(project, id);
            if (step.status === "conflict") {
              await this.#tasks.correct(project, id, reconcileFeedback(step.files), "you");
              return `↻ ${id} : d'autres chantiers ont été fusionnés entre-temps sur les mêmes lignes (${step.files.slice(0, 3).join(", ")}). Le développeur réconcilie, le testeur revérifie, puis je fusionne.`;
            }
            const after = step.status === "integrated" ? (this.checks?.get(project, id) ?? null) : null;
            if (after?.regression) return `✗ ${id} n'est pas fusionné : réuni avec les chantiers fusionnés entre-temps, il casse quelque chose (${describeChecks(after)}). Dites-moi « corrige ${id} ».`;
          }
          await this.#tasks.autoMerge(project, id, level, "Vous avez dit de fusionner, dans la discussion");
        } finally {
          this.#autoMerging.delete(key);
          release();
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
    if (d.concevoir && this.conceptions) {
      await attempt("Concepteur", async () => {
        const c = this.conceptions!.startDelegated(project, { idea: d.concevoir!, thread });
        return `✦ Conception confiée au Concepteur : « ${c.title} ». Il étudie le jeu, prépare le dossier et vous pose ses questions sur sa page : #/c/${c.id}\nQuand vous lui direz « transmets », les chantiers reviendront ici, chacun avec le dossier complet.`;
      });
    }
    if (d.production && this.productions) {
      const auto = this.#sessions.has(project);
      await attempt("Plan de production", async () => {
        const prod = this.productions!.propose(project, thread, d.production!, { auto });
        return `▶ Je prépare le plan de production ${prod.id} (étapes par métier, critères d'acceptation) : il arrive ici dans un instant${auto ? " et part tout de suite, séance autonome oblige ; les choix de visuels et de sons vous attendront au bilan" : ", à valider d'un clic"}.`;
      });
    }
    const launched: string[] = [];
    for (const id of d.launch) await attempt(id, async () => this.#launch(project, this.#tasks.get(project, id), launched));
    for (const r of d.requests) {
      await attempt(r.title, async () => {
        const named = r.decisions.filter((id) => this.#isValidated(project, id));
        const reviewed = await this.#review(project, r);
        const task = this.#tasks.createFromConversation(project, { title: reviewed.brief.title, goal: reviewed.brief.goal, decisions: named, reworks: r.reworks, ...(r.request ? { request: r.request } : {}) }, thread);
        reviewed.log(task.id);
        const launchedLine = await this.#launch(project, task, launched);
        return reviewed.mark ? `${launchedLine}\n${reviewed.mark}` : launchedLine;
      });
    }
    const session = this.#sessions.get(project);
    if (session) session.tasks.push(...launched.filter((id) => !session.tasks.includes(id)));
    if (session && d.session && !fromHub) {
      lines.unshift(`▶ Séance autonome jusqu'à ${hhmm(session.until)} : ${session.goal || "objectif ci-dessus"}. J'enchaîne les chantiers, je fusionne ce que le testeur valide, et je vous fais le bilan à la fin. Dites « stop » pour arrêter.`);
    }
    if (lines.length) this.conversations?.notify(project, thread, lines.join("\n"));
    if (fromHub && session && !launched.length && !d.endSession && !d.production) this.#endSession(project, "pas de suite proposée");
  }

  /**
   * La contre-expertise avant le lancement (ADR-125) : une seule passe, jamais bloquante. `log` l'inscrit au journal
   * une fois le chantier créé, `mark` est sa carte repliée dans la discussion.
   */
  async #review(project: string, r: ImplementRequest): Promise<{ brief: Brief; mark: string | null; log(task: string): void }> {
    const original: Brief = { title: r.title, goal: r.goal };
    if (!this.reviewer) return { brief: original, mark: null, log: () => {} };
    const key = `${project}/relecture/${r.title}/${this.#clock.now()}`;
    this.#handing.set(key, { project, title: r.title, since: this.#clock.now() });
    try {
      const review = await reviewBrief(this.reviewer, { project, brief: original, ...(r.request ? { request: r.request } : {}) });
      const brief = applyReview(original, review);
      return {
        brief,
        mark: reviewMark(original, brief, review),
        log: (task) => this.#journal.append({ project, actor: { kind: "system" }, type: "brief.reviewed", subject: task, payload: { ok: review.ok, objections: review.objections, corrected: !!review.consigne_corrigee && !review.ok, title: r.title } }),
      };
    } catch (err) {
      const error = (err as Error).message.slice(0, 300);
      return { brief: original, mark: null, log: (task) => this.#journal.append({ project, actor: { kind: "system" }, type: "brief.review_failed", subject: task, payload: { error, title: r.title } }) };
    } finally {
      this.#handing.delete(key);
    }
  }

  async #launch(project: string, task: Task, launched: string[]): Promise<string> {
    const { after, scouting } = await this.#tasks.launch(project, task.id);
    launched.push(task.id);
    if (after && scouting) return `⏳ Chantier ${task.id} « ${task.title} » en file : le chef de chantier regarde s'il peut avancer en même temps que ${after.id}.`;
    if (after) return `⏳ Chantier ${task.id} « ${task.title} » en attente : il partira tout seul après ${after.id}.`;
    return `→ Chantier ${task.id} « ${task.title} » lancé : le développeur est au travail (suivi en direct à droite). Je vous préviens ici quand c'est prêt.`;
  }

  /** Fusions d'un même jeu, une à la fois (ADR-104) : rend la fonction qui libère la place. */
  readonly #locks = new Map<string, Promise<void>>();
  async #lock(project: string): Promise<() => void> {
    const prev = this.#locks.get(project) ?? Promise.resolve();
    let free!: () => void;
    const mine = new Promise<void>((r) => (free = r));
    const chain = prev.then(() => mine);
    this.#locks.set(project, chain);
    await prev;
    return () => {
      free();
      if (this.#locks.get(project) === chain) this.#locks.delete(project);
    };
  }

  /** Décision du chef de chantier (ADR-104), dite une fois dans la discussion d'origine. */
  onScheduled(task: Task, event: ScheduleEvent): void {
    if (!task.origin) return;
    const text =
      event.kind === "parallel"
        ? `⇉ Chantier ${task.id} « ${task.title} » démarre en même temps que ${event.with.map((t) => t.id).join(", ")} : le chef de chantier ne voit aucun fichier en commun${task.scope?.note ? ` (${task.scope.note.replace(/\.$/, "")})` : ""}.`
        : `⏳ Chantier ${task.id} « ${task.title} » attend ${event.on} : ${event.reason}.`;
    this.conversations?.notify(task.project, task.origin.thread, text);
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
    // Conceptions du Concepteur pour ce projet : le directeur peut en parler et y renvoyer (ADR-34).
    const conceptions = (this.conceptions?.list() ?? [])
      .filter((c) => c.project === project && c.kind === "feature")
      .slice(0, 4)
      .map((c) => {
        const where =
          c.status === "done"
            ? "transmise : ses chantiers sont dans la liste ci-dessous"
            : c.status === "thinking"
              ? "le Concepteur y travaille"
              : c.data.questions.length
                ? "attend les réponses du directeur créatif"
                : c.data.ready
                  ? `prête : ${c.data.chantiers.length} chantier(s) ; il suffit de dire « transmets » au Concepteur`
                  : "en cours";
        return `- « ${c.title} » : ${where} (page : #/c/${c.id})`;
      });
    return [
      state ? `<etat_du_jeu note="carnet tenu à jour par le hub après chaque chantier fusionné : ce qui existe déjà, les choix faits, les limites connues">\n${state.replace(/</g, "‹")}\n</etat_du_jeu>` : "",
      `<chantiers>\n${rows.join("\n") || "(aucun)"}\n</chantiers>`,
      conceptions.length ? `<conceptions note="travail du Concepteur sur ce jeu">\n${conceptions.join("\n").replace(/</g, "‹")}\n</conceptions>` : "",
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
    const plans = this.productions?.summary(project) ?? [];
    if (plans.length) lines.push("", "Plans de production :", ...plans);
    if (cost > 0) lines.push("", `Coût de la séance : environ ${cost.toFixed(2).replace(".", ",")} $ (équivalent API, pris sur votre abonnement).`);
    this.conversations?.notify(project, s.thread, lines.join("\n"));
    this.alert?.({ title: "■ Séance terminée", body: `${merged}/${s.tasks.length} chantier(s) fusionné(s) — ${reason}`, url: `#/p/${project}`, tag: `session-${project}` });
    this.#journal.append({ project, actor: { kind: "agent", role: "director", run: "autopilot" }, type: "session.ended", subject: s.thread, payload: { reason, tasks: s.tasks, merged } });
  }

  /** Chantiers lancés par un plan de production pendant une séance : la séance les suit comme les siens (ADR-107). */
  adopt(project: string, ids: string[]): void {
    const s = this.#sessions.get(project);
    if (s) s.tasks.push(...ids.filter((id) => !s.tasks.includes(id)));
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
        await this.workshop(project, thread, { requests: [request], session: null, endSession: false, merge: [], abandon: [], launch: [], fixes: [], concevoir: null });
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
      const reviewed = await this.#review(project, request);
      const task = this.#tasks.createDelegated(project, { decisions, title: reviewed.brief.title, goal: reviewed.brief.goal, ...(request.request ? { request: request.request } : {}) }, level);
      reviewed.log(task.id);
      if (reviewed.mark) say(reviewed.mark);
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
