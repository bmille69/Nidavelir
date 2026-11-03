import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { ConversationService } from "../conversation/conversation-service.ts";
import type { Db } from "../db/database.ts";
import type { TaskService } from "../executor/task-service.ts";
import type { Journal } from "../journal/journal.ts";
import type { OrchestratorPort } from "../orchestrator/port.ts";
import { codeContext } from "../projects/code-context.ts";
import type { Project, ProjectRegistry } from "../projects/project-registry.ts";
import type { VcsPort } from "../vcs/git.ts";
import type { VisionService } from "../vision/vision-service.ts";
import { WEB_TOOLS } from "../llm/claude-cli.ts";
import { CONCEPT_SCHEMA, ConceptTurn, conceptSystemPrompt, missingSections } from "./prompts.ts";
import { godotTests } from "../godot/run.ts";
import { claudeMdGodot, DEFAULT_SETUP, scaffoldGodot } from "../godot/scaffold.ts";
import type { GodotInstall } from "../godot/toolchain.ts";
import { PENDING_VISUALS } from "../art/manifest.ts";
import { compactMarks, withMarks, type TeamService } from "../team/team-service.ts";

export class ConceptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConceptionError";
  }
}

/** `thread` : discussion d'où le directeur a demandé la conception (ADR-34) ; les chantiers y reviendront. */
/** `missing` : les sections du dossier encore absentes ou vides (ADR-73), calculées par le hub à chaque lecture. */
export type ConceptionData = Omit<ConceptTurn, "reply" | "questions" | "transmettre"> & { questions: ConceptTurn["questions"]; error?: string; thread?: string; missing?: string[] };
export type Conception = {
  id: string;
  kind: "project" | "feature";
  project: string | null;
  title: string;
  /** thinking : le Concepteur travaille ; open : à vous ; done : projet créé ou chantiers ajoutés. */
  status: "thinking" | "open" | "done";
  data: ConceptionData;
  created_at: string;
  updated_at: string;
};
export type ConceptionMessage = { id: string; seq: number; role: "human" | "concepteur"; text: string; turn: ConceptTurn | null; cost_usd: number | null; at: string };

const EMPTY: ConceptionData = { title: "Nouvelle conception", engine: "", godot: null, dossier: "", chantiers: [], visuels: [], ready: false, claude_md: "", sources: [], questions: [] };

/** Ce que le Concepteur confie au Directeur artistique (ADR-59) : des fiches de visuels, rattachées à la conception. */
export type ArtBriefPort = {
  brief(project: string, input: { conception: string; dossier: string; visuels: ConceptTurn["visuels"] }): Promise<Record<string, string>>;
};
const HISTORY = 12;

/**
 * Le Concepteur (ADR-28) : transforme une idée floue en dossier de conception et en premiers
 * chantiers, en posant les bonnes questions. Il cherche sur le web (lecture seule) ; il n'écrit
 * rien dans un jeu avant que vous cliquiez « Créer le projet » ou « Ajouter les chantiers ».
 */
export class ConceptionService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #projects: ProjectRegistry;
  readonly #tasks: TaskService;
  readonly #conversations: ConversationService;
  readonly #vision: VisionService;
  readonly #vcs: VcsPort;
  readonly #orchestrator: OrchestratorPort;
  readonly #web: boolean;
  readonly #background = new Set<Promise<void>>();
  /** Prévenu à la fin de chaque tour (notification, ADR-30). */
  onTurn: ((c: Conception) => void) | null = null;
  /** Compétences ajoutées aux consignes du Concepteur (ADR-29). */
  skills: { promptFor(agent: "concepteur", project: string | null): { text: string; dir: string | null } } | null = null;
  /** Racine des jeux, pour créer un projet quand vous dites « transmets » (posée par le serveur). */
  gamesRoot: string | null = null;
  /** Le Godot du PC (ADR-73) : sa version guide le Concepteur, et « Créer le projet » pose le socle d'un jeu Godot. */
  godot: (() => GodotInstall | null) | null = null;
  /** État du jeu et chantiers du projet, pour une fonctionnalité d'un jeu existant (ADR-34). */
  projectState: ((project: string) => string) | null = null;
  /** Le Directeur artistique, qui reçoit les visuels de la conception (ADR-59) ; et ce qu'il a déjà, pour ne pas le redemander. */
  art: ArtBriefPort | null = null;
  artState: ((project: string) => string | null) | null = null;
  /** L'équipe (ADR-98) : consulter un collègue, proposer un souvenir, lire le jeu d'une fonctionnalité. */
  team: TeamService | null = null;

  constructor(deps: {
    db: Db;
    clock: Clock;
    journal: Journal;
    projects: ProjectRegistry;
    tasks: TaskService;
    conversations: ConversationService;
    vision: VisionService;
    vcs: VcsPort;
    orchestrator: OrchestratorPort;
    web?: boolean;
  }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#projects = deps.projects;
    this.#tasks = deps.tasks;
    this.#conversations = deps.conversations;
    this.#vision = deps.vision;
    this.#vcs = deps.vcs;
    this.#orchestrator = deps.orchestrator;
    this.#web = deps.web ?? true;
  }

  list(): Conception[] {
    return (this.#db.prepare("SELECT * FROM conceptions ORDER BY updated_at DESC").all() as Row[]).map(toConception);
  }

  get(id: string): Conception {
    const row = this.#db.prepare("SELECT * FROM conceptions WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new ConceptionError("Conception introuvable");
    return toConception(row);
  }

  messages(id: string): ConceptionMessage[] {
    return (this.#db.prepare("SELECT * FROM conception_messages WHERE conception = ? ORDER BY seq").all(id) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      seq: Number(r.seq),
      role: r.role as ConceptionMessage["role"],
      text: String(r.text),
      turn: r.data_json ? (JSON.parse(String(r.data_json)) as ConceptTurn) : null,
      cost_usd: (r.cost_usd as number | null) ?? null,
      at: String(r.at),
    }));
  }

  /** Ce que le Concepteur est en train de faire (vue « Studio »). */
  activity(): { id: string; title: string; project: string | null; since: string }[] {
    return this.list()
      .filter((c) => c.status === "thinking")
      .map((c) => ({ id: c.id, title: c.title, project: c.project, since: c.updated_at }));
  }

  /**
   * Au démarrage (ADR-61) : une conception restée « le Concepteur travaille » quand le hub s'est arrêté vous revient,
   * avec un mot. Elle ne repart pas seule : une transmission coupée en route ne doit pas créer les chantiers deux fois.
   */
  recoverInterrupted(): void {
    for (const c of this.list().filter((x) => x.status === "thinking")) {
      this.#insert(c.id, "concepteur", "Le hub a redémarré pendant que je travaillais. Renvoyez votre dernier message pour que je reprenne. Si je transmettais, regardez d'abord « Chantiers » : une partie est peut-être déjà créée.", null, null);
      this.#update(c.id, { status: "open" });
    }
  }

  /** Démarre une conception à partir de votre idée, même en vrac. Le premier tour part en arrière-plan. */
  start(session: HumanSession, input: { kind: "project" | "feature"; project?: string; idea: string; thread?: string }): Conception {
    assertHumanSession(session);
    const idea = input.idea.trim();
    if (!idea) throw new ConceptionError("Décrivez votre idée, même en quelques mots");
    if (input.kind === "feature") this.#projects.get(input.project ?? "");
    // Lancée depuis une discussion : les chantiers y reviendront (ADR-35), pas dans une nouvelle fenêtre.
    const thread = input.kind === "feature" && input.thread ? this.#conversations.getThread(input.project!, input.thread).id : undefined;
    const now = this.#clock.now();
    const c: Conception = {
      id: randomUUID(),
      kind: input.kind,
      project: input.kind === "feature" ? input.project! : null,
      title: idea.slice(0, 60),
      status: "thinking",
      data: thread ? { ...EMPTY, thread } : EMPTY,
      created_at: now,
      updated_at: now,
    };
    this.#db
      .prepare("INSERT INTO conceptions (id, kind, project, title, status, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(c.id, c.kind, c.project, c.title, c.status, JSON.stringify(c.data), now, now);
    this.#journal.append({ project: c.project, actor: { kind: "human" }, type: "conception.started", subject: c.id, payload: { kind: c.kind } });
    this.#insert(c.id, "human", idea, null, null);
    if (thread) {
      this.#conversations.notify(
        c.project!,
        thread,
        `✦ Conception ouverte avec le Concepteur : « ${c.title} ». Répondez-lui sur sa page : #/c/${c.id}\nQuand vous lui direz « transmets », les chantiers reviendront ici.`,
      );
    }
    this.#track(this.#turn(c.id, session));
    return c;
  }

  /**
   * Le directeur confie une grosse demande au Concepteur (ADR-34), depuis une discussion.
   * Vous répondez ensuite au Concepteur sur sa page ; les chantiers reviendront dans cette discussion.
   */
  startDelegated(project: string, input: { idea: string; thread: string }): Conception {
    const p = this.#projects.get(project);
    if (p.autonomy !== "workshop") throw new ConceptionError("Réservé au mode atelier");
    const idea = input.idea.trim();
    if (!idea) throw new ConceptionError("Sujet de conception vide");
    const now = this.#clock.now();
    const c: Conception = { id: randomUUID(), kind: "feature", project, title: idea.split("\n")[0]!.slice(0, 60), status: "thinking", data: { ...EMPTY, thread: input.thread }, created_at: now, updated_at: now };
    this.#db
      .prepare("INSERT INTO conceptions (id, kind, project, title, status, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(c.id, c.kind, c.project, c.title, c.status, JSON.stringify(c.data), now, now);
    this.#journal.append({ project, actor: { kind: "agent", role: "director", run: "autopilot" }, type: "conception.started", subject: c.id, payload: { kind: c.kind, thread: input.thread } });
    this.#insert(c.id, "human", `(Demande transmise par le directeur, depuis votre discussion)\n\n${idea}`, null, null);
    this.#track(this.#turn(c.id));
    return c;
  }

  /** Vos réponses ou précisions : le Concepteur reprend en arrière-plan. */
  reply(session: HumanSession, id: string, text: string): Conception {
    assertHumanSession(session);
    const c = this.get(id);
    if (c.status === "thinking") throw new ConceptionError("Le Concepteur travaille encore : attendez sa réponse");
    if (c.status === "done") throw new ConceptionError("Cette conception est terminée");
    if (!text.trim()) throw new ConceptionError("Message vide");
    this.#insert(id, "human", text.trim(), null, null);
    this.#update(id, { status: "thinking" });
    this.#track(this.#turn(id, session));
    return this.get(id);
  }

  /**
   * « Créer le projet » : dossier du jeu, Git, CLAUDE.md, dossier de conception, discussion
   * « Conception » et premiers chantiers en attente (mode atelier). Rien n'est lancé.
   */
  async createProject(session: HumanSession, id: string, gamesRoot: string, opts: { launch?: boolean } = {}): Promise<{ project: Project; tasks: string[]; thread: string | null }> {
    assertHumanSession(session);
    const c = this.get(id);
    if (c.kind !== "project" || c.status === "done") throw new ConceptionError("Cette conception ne peut pas créer de projet");
    if (!c.data.ready) throw new ConceptionError("La conception n'est pas encore prête : répondez d'abord aux questions bloquantes");
    if (c.data.missing?.length) throw new ConceptionError(`Le dossier a encore des trous : ${c.data.missing.join(", ")}. Demandez au Concepteur de les compléter.`);
    const slug = slugify(c.data.title);
    const root = join(gamesRoot, slug);
    if (existsSync(root) && readdirSync(root).length) throw new ConceptionError(`Le dossier ${root} existe déjà et n'est pas vide`);
    mkdirSync(root, { recursive: true });
    const project = await this.#projects.register(session, { path: root, slug, name: c.data.title, initGit: true });
    if (c.data.claude_md.trim()) writeFileSync(join(root, "CLAUDE.md"), c.data.claude_md.trim() + "\n", "utf8");
    writeFileSync(join(root, "studio", "conception.md"), c.data.dossier.trim() + "\n", "utf8");
    await this.#vcs.commitPaths(root, ["CLAUDE.md", "studio"].filter((p) => existsSync(join(root, p))), `conception: dossier initial de ${c.data.title}`);
    const socle = c.data.engine === "godot" ? await this.#godotSocle(root, c) : null;
    const { tasks, thread } = await this.#seed(project.slug, c, { dossier: "studio/conception.md", launch: !!opts.launch });
    if (socle && thread) this.#conversations.notify(project.slug, thread, socle);
    this.#finish(id, project.slug, { tasks });
    return { project, tasks, thread };
  }

  /**
   * Le socle d'un jeu Godot (ADR-73) : projet réglé d'après la conception, outils du studio, section du CLAUDE.md, puis
   * import et premier test avec le Godot du PC. Rend le compte rendu pour la discussion du projet.
   */
  async #godotSocle(root: string, c: Conception): Promise<string> {
    const godot = this.godot?.() ?? null;
    const version = godot?.version ?? "4.6";
    const setup = { ...DEFAULT_SETUP, ...(c.data.godot ?? {}) };
    if (setup.langage === "csharp" && !godot?.mono) setup.langage = "gdscript";
    const claudeMd = join(root, "CLAUDE.md");
    writeFileSync(claudeMd, `${existsSync(claudeMd) ? readFileSync(claudeMd, "utf8").trimEnd() + "\n" : `# ${c.data.title}\n`}${claudeMdGodot(version, setup)}`, "utf8");
    const files = scaffoldGodot(root, c.data.title, version, setup);
    const check = godot ? await godotTests(godot.exe, root) : null;
    // L'import de Godot écrit un .uid à côté de chaque script : on les enregistre avec le socle, sinon ils bloquent la
    // fusion du premier chantier, qui crée les siens (ADR-76).
    const uids = files.map((f) => `${f}.uid`).filter((f) => existsSync(join(root, f)));
    await this.#vcs.commitPaths(root, ["CLAUDE.md", ...files, ...uids], `studio: socle Godot ${version} (projet, tests, relais du testeur)`);
    const how = `Godot ${version}, rendu ${setup.rendu}, ${setup.dimension.toUpperCase()}, écran ${setup.largeur}×${setup.hauteur}, ${setup.langage === "csharp" ? "C#" : "GDScript"}`;
    if (!check) return `Socle Godot posé (${how}) : projet, dossiers, outil de tests et relais du testeur. Godot n'est pas sur ce PC : rien n'a pu être lancé.`;
    return check.status === "pass"
      ? `Socle Godot posé et vérifié (${how}) : le projet s'importe, la scène de départ se lance et son premier test passe. Le premier chantier part de là.`
      : `Socle Godot posé (${how}), mais sa vérification a échoué : ${check.detail.slice(0, 400)}`;
  }

  /** « Ajouter les chantiers » : dossier dans studio/conceptions/, discussion et chantiers en attente dans le projet. */
  async addToProject(session: HumanSession, id: string): Promise<{ tasks: string[] }> {
    assertHumanSession(session);
    return this.#addToProject(id, { launch: false });
  }

  /** Dossier dans le jeu, chantiers créés ; `launch` : mis en file d'attente tout de suite (« transmets », ADR-34). */
  async #addToProject(id: string, opts: { launch: boolean }): Promise<{ tasks: string[]; thread: string | null }> {
    const c = this.get(id);
    if (c.kind !== "feature" || c.status === "done" || !c.project) throw new ConceptionError("Cette conception ne peut pas être ajoutée à un projet");
    const p = this.#projects.get(c.project);
    const dir = join(p.root, "studio", "conceptions");
    mkdirSync(dir, { recursive: true });
    const file = `${slugify(c.data.title)}.md`;
    writeFileSync(join(dir, file), c.data.dossier.trim() + "\n", "utf8");
    await this.#vcs.commitPaths(p.root, ["studio"], `conception: ${c.data.title}`);
    const { tasks, thread } = await this.#seed(p.slug, c, { dossier: `studio/conceptions/${file}`, launch: opts.launch });
    this.#finish(id, p.slug, { tasks });
    return { tasks, thread };
  }

  /**
   * Vous avez dit « transmets » au Concepteur (ADR-34) : sans bouton ni copier-coller, le dossier
   * part dans le jeu et les chantiers dans la file de l'équipe. Le Concepteur vous le confirme.
   */
  async #handoff(id: string, session?: HumanSession): Promise<void> {
    const c = this.get(id);
    if (c.status === "done") return;
    const say = (text: string) => this.#insert(id, "concepteur", text, null, null);
    if (!c.data.ready || !c.data.chantiers.length) {
      say("Je ne peux pas encore transmettre : il reste des questions à trancher ou aucun chantier n'est prêt. Répondez-moi et je transmets dès que c'est bon.");
      return;
    }
    try {
      let project: string;
      let r: { tasks: string[]; thread: string | null };
      if (c.kind === "feature") {
        project = c.project!;
        r = await this.#addToProject(id, { launch: true });
      } else {
        if (!session || !this.gamesRoot) {
          say("Pour créer le projet, cliquez sur « ✦ Créer le projet » en bas du dossier, à droite.");
          return;
        }
        const created = await this.createProject(session, id, this.gamesRoot, { launch: true });
        project = created.project.slug;
        r = created;
      }
      const auto = this.#projects.get(project).autonomy === "workshop";
      say(
        [
          `✓ C'est transmis à l'équipe : ${r.tasks.length} chantier(s)${steps(c) > 1 ? `, sur ${steps(c)} étapes` : ""} (${r.tasks.join(", ")}).`,
          auto
            ? "Ils partent un par un, dans l'ordre ; le développeur reçoit pour chacun la consigne complète et le dossier de conception, sans résumé."
            : "Ils attendent dans « Chantiers » : lancez-les quand vous voulez.",
          c.data.visuels?.length
            ? `Les ${c.data.visuels.length} visuel(s) prévus partent chez le Directeur artistique, avec le dossier : il cadre le style avec vous sur sa page (« Direction artistique » du projet), puis chaque visuel validé entre dans le jeu par son propre chantier. En attendant, le développeur pose des visuels provisoires.`
            : "",
          r.thread ? `Suivez-les dans la discussion du projet : #/p/${project}/t/${r.thread}` : `Suivez-les dans le projet : #/p/${project}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (err) {
      say(`Je n'ai pas pu transmettre : ${(err as Error).message.slice(0, 300)}`);
    }
  }

  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }

  /**
   * Crée les chantiers de la conception, chacun avec sa consigne complète et le chemin du dossier
   * (le développeur le lit dans sa copie du jeu), dans la discussion d'origine ou une discussion dédiée.
   * `launch` : en atelier, ils partent tout de suite, un à la fois (file d'attente, ADR-31).
   */
  async #seed(project: string, c: Conception, opts: { dossier: string; launch: boolean }): Promise<{ tasks: string[]; thread: string | null }> {
    const p = this.#projects.get(project);
    if (p.autonomy === "supervised") return { tasks: [], thread: null };
    let thread = c.data.thread ?? null;
    try {
      if (thread) this.#conversations.getThread(project, thread);
    } catch {
      thread = null;
    }
    thread ??= this.#conversations.createThread(project, `Conception : ${c.data.title}`, "conception").id;
    const launch = opts.launch && p.autonomy === "workshop";
    // Les visuels partent d'abord chez le Directeur artistique : leurs numéros (A-xxxx) entrent dans les consignes.
    let ids: Record<string, string> = {};
    let artNote = "";
    if (c.data.visuels?.length && this.art) {
      try {
        ids = await this.art.brief(project, { conception: c.data.title, dossier: opts.dossier, visuels: c.data.visuels });
        artNote = `\n\nVisuels confiés au Directeur artistique (il cadre le style avec vous, sur sa page) : ${c.data.visuels.map((v) => `${ids[v.cle] ?? v.cle} ${v.nom}`).join(", ")}. Chacun arrivera dans le jeu par son propre chantier d'intégration une fois validé.`;
      } catch (err) {
        artNote = `\n\nLes visuels n'ont pas pu être confiés au Directeur artistique (${(err as Error).message.slice(0, 200)}) : demandez-les-lui sur sa page.`;
      }
    }
    const visualsOf = (ch: ConceptionData["chantiers"][number]) =>
      (ch.visuels ?? [])
        .map((k) => c.data.visuels?.find((v) => v.cle === k))
        .filter((v): v is NonNullable<typeof v> => !!v)
        .map((v) => `- ${ids[v.cle] ?? v.cle} « ${v.nom} » (${v.type}) : ${v.usage}`);
    const list = c.data.chantiers
      .map((ch, k, all) => `${ch.etape && ch.etape !== all[k - 1]?.etape ? `\n${ch.etape}\n` : ""}${k + 1}. ${ch.title}`)
      .join("\n")
      .trim();
    this.#conversations.notify(
      project,
      thread,
      launch
        ? `Conception « ${c.data.title} » transmise par le Concepteur. Le dossier est dans ${opts.dossier}.\n\nChantiers, réalisés un par un dans cet ordre (chacun reçoit sa consigne complète et le dossier) :\n${list || "(aucun)"}${artNote}\n\nParlez-moi ici pour ajuster ou arrêter quoi que ce soit.`
        : `Conception « ${c.data.title} » terminée. Le dossier est dans ${opts.dossier}.\n\nChantiers de toutes les étapes, prêts à lancer dans l'ordre (bouton « ▶ Lancer » à droite) :\n${list || "(aucun)"}${artNote}\n\nVous pouvez aussi me parler ici pour ajuster quoi que ce soit avant de lancer.`,
    );
    const tasks = c.data.chantiers.map(
      (ch) =>
        this.#tasks.createFromConversation(
          project,
          {
            title: ch.title,
            goal: (() => {
              // La fin (visuels, dossier) passe toujours : c'est le corps de la consigne qui est raccourci si besoin (4 000 caractères).
              const tail = [
                visualsOf(ch).length
                  ? `${PENDING_VISUALS} :\n${visualsOf(ch).join("\n").slice(0, 900)}\nN'en fabrique aucun et ne les attends pas : pose un visuel provisoire simple (forme ou couleur unie) au bon endroit, facile à remplacer (un seul point de chargement par visuel, au nom de son identifiant). Le vrai visuel arrivera par un chantier d'intégration séparé ; s'il est déjà branché quand tu commences (statut « integre » dans studio/art/assets.json), sers-toi de lui plutôt que d'un provisoire.`
                  : "",
                `Dossier de conception complet : ${opts.dossier} (« ${c.data.title} »). Consultes-y les sections utiles à ce chantier (piliers, choix faits, contraintes) plutôt que de tout relire.`,
              ]
                .filter(Boolean)
                .join("\n\n");
              const body = `${ch.etape ? `Étape : ${ch.etape}\n\n` : ""}${ch.goal.trim()}`;
              return `${body.slice(0, 4000 - tail.length - 2)}\n\n${tail}`;
            })(),
          },
          thread!,
        ).id,
    );
    if (launch) for (const id of tasks) await this.#tasks.launch(project, id);
    return { tasks, thread };
  }

  #finish(id: string, project: string, payload: Record<string, unknown>): void {
    this.#db.prepare("UPDATE conceptions SET status = 'done', project = ?, updated_at = ? WHERE id = ?").run(project, this.#clock.now(), id);
    this.#journal.append({ project, actor: { kind: "human" }, type: "conception.done", subject: id, payload });
  }

  async #turn(id: string, session?: HumanSession): Promise<void> {
    const c = this.get(id);
    try {
      const context = c.kind === "feature" && c.project ? await this.#featureContext(c.project) : "";
      const history = this.messages(id).slice(-HISTORY);
      const prompt = [
        c.data.dossier ? `<dossier_actuel>\n${esc(c.data.dossier)}\n</dossier_actuel>` : "<dossier_actuel>(vide : premier tour)</dossier_actuel>",
        `<echanges>\n${history.map((m) => (m.role === "human" ? `<directeur_creatif>${esc(m.text)}</directeur_creatif>` : `<toi>${esc(compactMarks(m.text))}</toi>`)).join("\n")}\n</echanges>`,
        "Réponds au dernier message du directeur créatif, mets le dossier à jour, puis pose les questions les plus utiles (ou aucune).",
      ].join("\n\n");
      const skills = this.skills?.promptFor("concepteur", c.project) ?? { text: "", dir: null };
      // L'équipe (ADR-98) : il peut consulter le DA, le directeur sonore… et lire le jeu d'une fonctionnalité.
      const team = this.team?.open(c.project, "concepteur", { consult: true, remember: true, read: c.kind === "feature" }) ?? null;
      let out: { data: unknown; costUsd: number | null };
      try {
        out = await this.#orchestrator.structured({
          systemPrompt: [conceptSystemPrompt(c.kind, context, c.kind === "project" ? (this.godot?.() ?? null) : null), skills.text, team?.prompt ?? ""].filter(Boolean).join("\n\n"),
          prompt,
          jsonSchema: CONCEPT_SCHEMA,
          meta: { project: c.project, agent: "concepteur" },
          tools: this.#web ? WEB_TOOLS : undefined,
          tier: "concept",
          ...(skills.dir ? { skillsDir: skills.dir } : {}),
          ...(team ? { team: team.grant } : {}),
        });
      } finally {
        team?.close();
      }
      const { data, costUsd } = out;
      const parsed = ConceptTurn.parse(data);
      // Le hub numérote lui-même les chantiers : on retire « 1. » ou « 1) » en tête de titre.
      const turn = { ...parsed, chantiers: parsed.chantiers.map((ch) => ({ ...ch, title: ch.title.replace(/^\s*\d+\s*[.)-]\s*/, "") })) };
      this.#insert(id, "concepteur", withMarks(turn.reply, team), turn, costUsd);
      const { reply: _r, transmettre, ...rest } = turn;
      this.#update(id, { status: transmettre ? "thinking" : "open", title: turn.title, data: { ...rest, thread: c.data.thread, claude_md: c.kind === "project" ? turn.claude_md : "" } });
      if (transmettre) {
        await this.#handoff(id, session);
        if (this.get(id).status === "thinking") this.#update(id, { status: "open" });
      }
      this.onTurn?.(this.get(id));
    } catch (err) {
      this.#insert(id, "concepteur", `Je n'ai pas pu terminer ma réponse : ${(err as Error).message.slice(0, 300)}. Renvoyez votre message pour réessayer.`, null, null);
      this.#update(id, { status: "open", data: { ...c.data, error: (err as Error).message.slice(0, 300) } });
    }
  }

  async #featureContext(project: string): Promise<string> {
    const p = this.#projects.get(project);
    const code = await codeContext(p.root);
    const bible = this.#vision
      .list(project, { type: "decision", status: "validated" })
      .map((d) => `- ${d.title} : ${(d.decision?.summary ?? d.statement).replace(/\s+/g, " ").slice(0, 240)}`)
      .join("\n");
    return [
      `<projet nom="${esc(p.name)}" />`,
      code.claudeMd ? `<consignes_du_projet source="CLAUDE.md">\n${esc(code.claudeMd)}\n</consignes_du_projet>` : "",
      code.files.length ? `<fichiers_du_jeu total="${code.totalFiles}">\n${code.files.join("\n")}\n</fichiers_du_jeu>` : "",
      bible ? `<bible_du_jeu>\n${esc(bible)}\n</bible_du_jeu>` : "",
      this.projectState?.(project) ?? "",
      (() => {
        const visuals = this.artState?.(project);
        return visuals ? `<visuels_du_projet source="Directeur artistique">\n${esc(visuals)}\n</visuels_du_projet>` : "";
      })(),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  #insert(id: string, role: ConceptionMessage["role"], text: string, turn: ConceptTurn | null, cost: number | null): void {
    const row = this.#db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM conception_messages WHERE conception = ?").get(id) as { next: number };
    this.#db
      .prepare("INSERT INTO conception_messages (id, conception, seq, role, text, data_json, cost_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), id, row.next, role, text, turn ? JSON.stringify(turn) : null, cost, this.#clock.now());
  }

  #update(id: string, patch: Partial<Pick<Conception, "status" | "title" | "data">>): void {
    const c = this.get(id);
    const next = { ...c, ...patch };
    this.#db
      .prepare("UPDATE conceptions SET status = ?, title = ?, data_json = ?, updated_at = ? WHERE id = ?")
      .run(next.status, next.title, JSON.stringify(next.data), this.#clock.now(), id);
  }

  #track(p: Promise<void>): void {
    this.#background.add(p);
    void p.finally(() => this.#background.delete(p));
  }
}

type Row = Record<string, unknown>;
function toConception(r: Row): Conception {
  return {
    id: String(r.id),
    kind: r.kind as Conception["kind"],
    project: (r.project as string | null) ?? null,
    title: String(r.title),
    status: r.status as Conception["status"],
    data: withMissing(r.kind as Conception["kind"], { ...EMPTY, ...(JSON.parse(String(r.data_json)) as Partial<ConceptionData>) }),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

/** Les trous du dossier, seulement une fois qu'il existe (ADR-73). */
function withMissing(kind: Conception["kind"], data: ConceptionData): ConceptionData {
  return { ...data, missing: data.dossier.trim() ? missingSections(data.dossier, kind) : [] };
}

const steps = (c: Conception) => new Set(c.data.chantiers.map((ch) => ch.etape).filter(Boolean)).size;
const esc = (s: string) => s.replace(/</g, "‹").replace(/>/g, "›");

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
