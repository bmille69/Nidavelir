import { execFile } from "node:child_process";
import { join } from "node:path";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { Journal } from "../journal/journal.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import type { VcsPort } from "../vcs/git.ts";
import { ensureIgnored, ensurePreset, godotExport, listBuilds, pruneBuilds, type Build } from "./export.ts";
import { hasWindowsTemplates, installWindowsTemplates, templatesDir } from "./templates.ts";
import { isGodot, type GodotInstall } from "./toolchain.ts";

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

export type ExportState = {
  available: boolean;
  godot: string | null;
  templates: boolean;
  templatesDir: string | null;
  installing: { step: string; progress: number } | null;
  running: boolean;
  error: string | null;
  builds: Build[];
};

/** L'export local des jeux Godot (ADR-90), sur votre clic : jamais d'envoi, le jeu reste sur ce PC. */
export class ExportService {
  readonly #projects: ProjectRegistry;
  readonly #vcs: VcsPort;
  readonly #journal: Journal;
  readonly #clock: Clock;
  readonly #godot: () => GodotInstall | null;
  readonly #running = new Set<string>();
  readonly #errors = new Map<string, string>();
  readonly #background = new Set<Promise<unknown>>();
  #installing: { step: string; progress: number } | null = null;
  #installError: string | null = null;
  /** Remplaçables dans les tests. */
  exporter = godotExport;
  installer = installWindowsTemplates;
  hasTemplates = hasWindowsTemplates;

  constructor(deps: { projects: ProjectRegistry; vcs: VcsPort; journal: Journal; clock: Clock; godot: () => GodotInstall | null }) {
    this.#projects = deps.projects;
    this.#vcs = deps.vcs;
    this.#journal = deps.journal;
    this.#clock = deps.clock;
    this.#godot = deps.godot;
  }

  state(project: string): ExportState {
    const root = this.#projects.get(project).root;
    const godot = this.#godot();
    return {
      available: isGodot(root) && !!godot,
      godot: godot?.version ?? null,
      templates: godot ? this.hasTemplates(godot.version) : false,
      templatesDir: godot ? templatesDir(godot.version) : null,
      installing: this.#installing,
      running: this.#running.has(project),
      error: this.#errors.get(project) ?? this.#installError,
      builds: listBuilds(root),
    };
  }

  /** Les modèles d'export Windows de votre version de Godot (≈ 70 Mo lus dans l'archive officielle de 1,25 Go). */
  installTemplates(session: HumanSession, project: string): ExportState {
    assertHumanSession(session);
    const godot = this.#godot();
    if (!godot) throw new ExportError("Godot introuvable sur ce PC");
    if (this.#installing || this.hasTemplates(godot.version)) return this.state(project);
    this.#installing = { step: "Préparation", progress: 0 };
    this.#installError = null;
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "tool.install_started", subject: "godot-templates", payload: { version: godot.version } });
    const job = this.installer(godot.version, (step, done) => (this.#installing = { step, progress: done })).then(
      () => {
        this.#installing = null;
        this.#journal.append({ project: null, actor: { kind: "system" }, type: "tool.installed", subject: "godot-templates", payload: { version: godot.version } });
      },
      (err: Error) => {
        this.#installing = null;
        this.#installError = `Modèles d'export : ${err.message.slice(0, 400)}`;
      },
    );
    this.#background.add(job);
    void job.finally(() => this.#background.delete(job));
    return this.state(project);
  }

  /** « Exporter » : la version actuelle du jeu (votre branche, telle qu'elle est commitée ou non) devient un .exe dans build/. */
  start(session: HumanSession, project: string): ExportState {
    assertHumanSession(session);
    const p = this.#projects.get(project);
    const godot = this.#godot();
    if (!isGodot(p.root)) throw new ExportError("L'export local concerne les jeux Godot");
    if (!godot) throw new ExportError("Godot introuvable sur ce PC");
    if (!this.hasTemplates(godot.version)) throw new ExportError("Installez d'abord les modèles d'export de Godot");
    if (this.#running.has(project)) return this.state(project);
    this.#running.add(project);
    this.#errors.delete(project);
    const job = (async () => {
      try {
        const changed = [ensurePreset(p.root) ? "export_presets.cfg" : "", ensureIgnored(p.root) ? ".gitignore" : ""].filter(Boolean);
        if (changed.length) await this.#vcs.commitPaths(p.root, changed, "studio: réglage d'export Windows (build/ jamais commité)");
        const at = this.#clock.now();
        const id = at.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
        const commit = await this.#vcs.head(p.root).catch(() => null);
        const build = await this.exporter(godot.exe, p.root, { name: p.name, id, commit, at });
        pruneBuilds(p.root);
        this.#journal.append({ project, actor: { kind: "human" }, type: "export.done", subject: build.id, payload: { bytes: build.bytes, smoke: build.smoke.ok, commit } });
      } catch (err) {
        this.#errors.set(project, (err as Error).message.slice(0, 600));
      } finally {
        this.#running.delete(project);
      }
    })();
    this.#background.add(job);
    void job.finally(() => this.#background.delete(job));
    return this.state(project);
  }

  /** Ouvre le dossier d'un export dans l'explorateur de ce PC. */
  reveal(session: HumanSession, project: string, id: string): void {
    assertHumanSession(session);
    const build = listBuilds(this.#projects.get(project).root).find((b) => b.id === id);
    if (!build) throw new ExportError("Export introuvable");
    execFile("explorer.exe", [`/select,${join(this.#projects.get(project).root, build.exe).replace(/\//g, "\\")}`], { windowsHide: false }, () => {});
  }

  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }
}
