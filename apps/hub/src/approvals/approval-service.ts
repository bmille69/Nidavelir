import { Approval, type ApprovalEdits, type ApprovalSubjectKind } from "@studio/contracts";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import type { Journal } from "../journal/journal.ts";
import { nextId } from "../util/ids.ts";

/** Préfixe de session des validations déléguées au directeur. */
export const DELEGATED = "delegation:";
export const isDelegated = (a: { session: string }) => a.session.startsWith(DELEGATED);

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

export type ApprovalRequest = {
  project: string;
  subject: { kind: ApprovalSubjectKind; id: string; hash: string };
  verdict: "approved" | "rejected";
  note?: string;
  edits?: ApprovalEdits;
};

/**
 * Seul point de création des validations humaines (docs/SECURITY.md §4).
 * Une approbation est liée au hash exact de son objet et ne sert qu'une fois.
 */
export class ApprovalService {
  readonly #db: Db;
  readonly #journal: Journal;
  readonly #clock: Clock;

  constructor(db: Db, journal: Journal, clock: Clock) {
    this.#db = db;
    this.#journal = journal;
    this.#clock = clock;
  }

  record(session: HumanSession, request: ApprovalRequest): Approval {
    assertHumanSession(session);
    const approval = Approval.parse({
      id: nextId(this.#db, request.project, "A"),
      project: request.project,
      subject: request.subject,
      verdict: request.verdict,
      note: request.note,
      edits: request.edits,
      at: this.#clock.now(),
      session: session.id,
    });
    this.#db
      .prepare(
        `INSERT INTO approvals (id, project, subject_kind, subject_id, subject_hash, verdict, note, edits_json, at, session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.project,
        approval.subject.kind,
        approval.subject.id,
        approval.subject.hash,
        approval.verdict,
        approval.note ?? null,
        approval.edits ? JSON.stringify(approval.edits) : null,
        approval.at,
        approval.session,
      );
    this.#journal.append({
      project: approval.project,
      actor: { kind: "human" },
      type: "approval.recorded",
      subject: approval.subject.id,
      payload: { approval: approval.id, kind: approval.subject.kind, verdict: approval.verdict, hash: approval.subject.hash },
    });
    return approval;
  }

  /**
   * Validation déléguée : le directeur décide dans le cadre de l'autonomie que vous avez
   * choisie pour ce projet (ADR-20). Jamais pour une fusion, une escalade ou un import.
   */
  recordDelegated(request: ApprovalRequest & { autonomy: string; run: string }): Approval {
    if (!["proposal", "plan"].includes(request.subject.kind)) throw new ApprovalError(`Délégation impossible pour : ${request.subject.kind}`);
    const approval = Approval.parse({
      id: nextId(this.#db, request.project, "A"),
      project: request.project,
      subject: request.subject,
      verdict: request.verdict,
      note: request.note,
      at: this.#clock.now(),
      session: `${DELEGATED}${request.autonomy}`,
    });
    this.#db
      .prepare(
        `INSERT INTO approvals (id, project, subject_kind, subject_id, subject_hash, verdict, note, edits_json, at, session)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(approval.id, approval.project, approval.subject.kind, approval.subject.id, approval.subject.hash, approval.verdict, approval.note ?? null, approval.at, approval.session);
    this.#journal.append({
      project: approval.project,
      actor: { kind: "agent", role: "director", run: request.run },
      type: "approval.delegated",
      subject: approval.subject.id,
      payload: { approval: approval.id, kind: approval.subject.kind, verdict: approval.verdict, autonomy: request.autonomy, note: request.note },
    });
    return approval;
  }

  get(project: string, id: string): Approval | undefined {
    const row = this.#db.prepare("SELECT * FROM approvals WHERE project = ? AND id = ?").get(project, id) as
      | Record<string, string | null>
      | undefined;
    if (!row) return undefined;
    return Approval.parse({
      id: row.id,
      project: row.project,
      subject: { kind: row.subject_kind, id: row.subject_id, hash: row.subject_hash },
      verdict: row.verdict,
      note: row.note ?? undefined,
      edits: row.edits_json ? JSON.parse(row.edits_json) : undefined,
      at: row.at,
      session: row.session,
      consumed_at: row.consumed_at ?? undefined,
    });
  }

  /**
   * Vérifie qu'une approbation correspond exactement à l'objet présenté, puis la
   * marque consommée. À appeler dans la transaction qui applique l'effet.
   */
  consume(project: string, id: string, expected: { kind: ApprovalSubjectKind; id: string; hash: string }): Approval {
    const approval = this.get(project, id);
    if (!approval) throw new ApprovalError(`Approbation ${id} introuvable`);
    if (approval.consumed_at) throw new ApprovalError(`Approbation ${id} déjà utilisée`);
    if (approval.subject.kind !== expected.kind || approval.subject.id !== expected.id) {
      throw new ApprovalError(`Approbation ${id} ne porte pas sur ${expected.kind} ${expected.id}`);
    }
    if (approval.subject.hash !== expected.hash) {
      throw new ApprovalError(`L'objet ${expected.id} a changé depuis l'approbation ${id} : nouvelle validation requise`);
    }
    const at = this.#clock.now();
    this.#db.prepare("UPDATE approvals SET consumed_at = ? WHERE project = ? AND id = ?").run(at, project, id);
    return { ...approval, consumed_at: at };
  }
}
