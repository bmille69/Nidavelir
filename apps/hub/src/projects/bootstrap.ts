import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import { nextId } from "../util/ids.ts";
import { chunkDocument, lineOf, type ExtractionService } from "../vision/extraction.ts";
import type { ProjectRegistry } from "./project-registry.ts";

export type BootstrapJob = {
  id: string;
  project: string;
  status: "running" | "done" | "failed";
  documents: { path: string; status: "pending" | "running" | "done" | "failed" | "skipped"; created: number; note?: string }[];
  created: number;
  costUsd: number;
  started_at: string;
  finished_at?: string;
};

const MAX_DOC_BYTES = 200_000;

/**
 * Amorçage de la vision depuis les documents d'un projet importé
 * (docs/VISION_ENGINE.md §7). Ne lit que les documents choisis, ne les modifie pas.
 */
export class BootstrapService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #projects: ProjectRegistry;
  readonly #extraction: ExtractionService;
  readonly #jobs = new Map<string, BootstrapJob>();
  readonly #running = new Set<Promise<void>>();

  constructor(deps: { db: Db; clock: Clock; projects: ProjectRegistry; extraction: ExtractionService }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#projects = deps.projects;
    this.#extraction = deps.extraction;
  }

  start(project: string, documents: string[]): BootstrapJob {
    const root = this.#projects.get(project).root;
    const job: BootstrapJob = {
      id: randomUUID(),
      project,
      status: "running",
      documents: documents.map((path) => ({ path, status: "pending", created: 0 })),
      created: 0,
      costUsd: 0,
      started_at: this.#clock.now(),
    };
    for (const d of job.documents) {
      const abs = safeJoin(root, d.path);
      if (!abs || !existsSync(abs) || !statSync(abs).isFile()) {
        d.status = "skipped";
        d.note = "fichier introuvable ou hors du projet";
      } else if (statSync(abs).size > MAX_DOC_BYTES) {
        d.status = "skipped";
        d.note = `trop volumineux (> ${MAX_DOC_BYTES / 1000} Ko)`;
      }
    }
    this.#jobs.set(job.id, job);
    const p = this.#run(job, root);
    this.#running.add(p);
    void p.finally(() => this.#running.delete(p));
    return job;
  }

  get(id: string): BootstrapJob | undefined {
    return this.#jobs.get(id);
  }

  list(project: string): BootstrapJob[] {
    return [...this.#jobs.values()].filter((j) => j.project === project);
  }

  async idle(): Promise<void> {
    while (this.#running.size) await Promise.allSettled([...this.#running]);
  }

  async #run(job: BootstrapJob, root: string): Promise<void> {
    for (const doc of job.documents) {
      if (doc.status === "skipped") continue;
      doc.status = "running";
      try {
        const text = readFileSync(safeJoin(root, doc.path)!, "utf8");
        const run = nextId(this.#db, job.project, "RUN");
        for (const chunk of chunkDocument(text)) {
          const outcome = await this.#extraction.extract({
            project: job.project,
            author: { kind: "agent", role: "director", run },
            text: chunk.text,
            kind: "file",
            ref: (quote) => {
              const line = quote ? lineOf(quote, chunk.text) : null;
              return line ? `${doc.path}#L${chunk.startLine + line - 1}` : doc.path;
            },
            untrusted: true,
          });
          doc.created += outcome.created.length;
          job.created += outcome.created.length;
          job.costUsd += outcome.costUsd ?? 0;
        }
        doc.status = "done";
      } catch (err) {
        doc.status = "failed";
        doc.note = (err as Error).message.slice(0, 200);
      }
    }
    job.status = job.documents.some((d) => d.status === "failed") && job.created === 0 ? "failed" : "done";
    job.finished_at = this.#clock.now();
  }
}

/** Résout un chemin relatif au projet, ou null s'il en sort. */
export function safeJoin(root: string, rel: string): string | null {
  if (isAbsolute(rel)) return null;
  const abs = normalize(join(root, rel));
  const back = relative(root, abs);
  return back && !back.startsWith("..") && !isAbsolute(back) ? abs : null;
}
