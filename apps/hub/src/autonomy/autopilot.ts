import type { Autonomy, ItemFrontmatter } from "@studio/contracts";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { ApprovalService } from "../approvals/approval-service.ts";
import type { Clock } from "../clock.ts";
import type { ConversationService, ImplementRequest } from "../conversation/conversation-service.ts";
import type { TaskService } from "../executor/task-service.ts";
import type { Journal } from "../journal/journal.ts";
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
    if (!task.origin) return;
    const text: Record<string, string> = {
      failed: `✗ Chantier ${task.id} « ${task.title} » : le travail a échoué. Le détail est dans « Chantiers » ; dites-moi si on relance autrement.`,
      merged: `Chantier ${task.id} fusionné dans votre jeu.`,
    };
    if (text[task.status]) this.conversations?.notify(task.project, task.origin.thread, text[task.status]!);
  }

  /** Fin de la vérification (résultats enregistrés) : compte rendu complet dans la discussion. */
  onRunFinished(task: { id: string; project: string; title: string; status: string; origin: { thread: string } | null }, kind: string): void {
    if (!task.origin || kind !== "verify" || task.status !== "review") return;
    this.conversations?.notify(task.project, task.origin.thread, this.#reviewReport(task.project, task.id, task.title));
  }

  /** Compte rendu de fin de chantier, dans la discussion : ce qui a changé, l'avis du testeur, comment essayer. */
  #reviewReport(project: string, id: string, title: string): string {
    const runs = this.#tasks.runs(project, id);
    const report = runs.findLast((r) => r.result?.report)?.result?.report;
    const verdict = runs.findLast((r) => r.result?.verification)?.result?.verification;
    const ok = !verdict || verdict.verdict !== "fail";
    const lines = [`${ok ? "✓" : "⚠"} Chantier ${id} « ${title} » terminé${verdict ? (ok ? ", vérifié par le testeur" : " — le testeur a trouvé des problèmes") : ""}.`];
    if (report?.summary_simple) lines.push("", `Ce qui a changé : ${report.summary_simple}`);
    if (verdict) {
      lines.push("", `Avis du testeur : ${verdict.summary_simple}`);
      for (const c of verdict.checks.filter((c) => c.result === "fail").slice(0, 4)) lines.push(`  ✗ ${c.criterion}`);
      for (const r of verdict.regressions.slice(0, 3)) lines.push(`  ⚠ ${r}`);
    }
    if (report?.deviations.length) lines.push("", "Écarts par rapport au plan :", ...report.deviations.slice(0, 4).map((d) => `  • ${d.what}`));
    if (report?.open_issues.length) lines.push("", "Reste à faire :", ...report.open_issues.slice(0, 4).map((x) => `  • ${x}`));
    if (report?.how_to_test.length) lines.push("", "Pour essayer :", ...report.how_to_test.map((s, k) => `  ${k + 1}. ${s}`));
    lines.push(
      "",
      `Cliquez sur « ▶ Essayer » à droite pour lancer cette version du jeu, puis « Fusionner » si elle vous plaît${ok ? "" : ", ou dites-moi ce qu'il faut corriger"}.`,
    );
    return lines.join("\n");
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
        const named = request.decisions.filter((id) => this.#isValidated(project, id));
        const task = this.#tasks.createFromConversation(project, { title: request.title, goal: request.goal, decisions: named }, thread);
        await this.#tasks.startPlanning(project, task.id);
        say(`→ Chantier ${task.id} « ${task.title} » lancé. Le développeur étudie le code et prépare son plan ; s'il est sans risque, il passe directement au travail. Je vous préviens ici quand c'est prêt à relire.`);
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
