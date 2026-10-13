import {
  CONTENT_TYPES,
  ITEM_PREFIX,
  ItemFrontmatter,
  ProposalDetails,
  type Author,
  type ItemType,
  type Link,
  type Source,
  type ValidatedBy,
} from "@studio/contracts";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import type { ApprovalService } from "../approvals/approval-service.ts";
import type { Clock } from "../clock.ts";
import { transaction, type Db } from "../db/database.ts";
import type { Journal } from "../journal/journal.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import { canonicalJson, sha256 } from "../util/hash.ts";
import { bumpCounterTo, nextId } from "../util/ids.ts";
import type { VcsPort } from "../vcs/git.ts";
import { renderBrief } from "./brief.ts";
import { parseItem, serializeItem } from "./item-file.ts";

export class VisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionError";
  }
}

type Item = ItemFrontmatter;

/** Types qu'un agent ou vous pouvez capter depuis une conversation ou un document. */
const CAPTURABLE: readonly ItemType[] = [...CONTENT_TYPES, "hypothesis", "question"];
const isContent = (t: ItemType) => (CONTENT_TYPES as readonly string[]).includes(t);

export type CaptureInput = {
  type: ItemType;
  title: string;
  statement: string;
  source: Source;
  domain?: string[];
  confidence?: number;
  links?: Link[];
  hint?: "existing_decision";
};

export type ProposalInput = {
  title: string;
  statement: string;
  domain?: string[];
  source: Source;
  details: z.input<typeof ProposalDetails>;
};

export type ItemFilter = { type?: ItemType; status?: string; tier?: "canon" | "working" };

/**
 * Unique écrivain de la vision d'un projet (docs/VISION_ENGINE.md, ADR-05).
 *
 * Invariants garantis ici :
 *  - aucun item ne devient `validated` / `canon` sans une approbation humaine
 *    consommée, liée au hash exact de la proposition ;
 *  - le contenu d'une décision validée n'est jamais réécrit : on la remplace ;
 *  - les fichiers studio/items/*.md font foi, SQLite n'est qu'un index.
 */
export class VisionService {
  readonly #db: Db;
  readonly #journal: Journal;
  readonly #clock: Clock;
  readonly #vcs: VcsPort;
  readonly #projects: ProjectRegistry;
  readonly #approvals: ApprovalService;

  constructor(deps: {
    db: Db;
    journal: Journal;
    clock: Clock;
    vcs: VcsPort;
    projects: ProjectRegistry;
    approvals: ApprovalService;
  }) {
    this.#db = deps.db;
    this.#journal = deps.journal;
    this.#clock = deps.clock;
    this.#vcs = deps.vcs;
    this.#projects = deps.projects;
    this.#approvals = deps.approvals;
  }

  // ── Lecture ──────────────────────────────────────────────────────────────

  get(project: string, id: string): Item {
    const path = this.#itemPath(project, id);
    if (!existsSync(path)) throw new VisionError(`Item introuvable : ${id}`);
    return parseItem(readFileSync(path, "utf8"), id);
  }

  list(project: string, filter: ItemFilter = {}): Item[] {
    const where = ["project = ?"];
    const params: string[] = [project];
    for (const key of ["type", "status", "tier"] as const) {
      if (filter[key]) {
        where.push(`${key} = ?`);
        params.push(filter[key]);
      }
    }
    const rows = this.#db.prepare(`SELECT id FROM items WHERE ${where.join(" AND ")} ORDER BY id`).all(...params) as {
      id: string;
    }[];
    return rows.map((r) => this.get(project, r.id));
  }

  /** Recherche plein texte (FTS5) sur le titre et l'énoncé. */
  search(project: string, query: string, limit = 20): Item[] {
    const terms = query
      .split(/\s+/)
      .map((t) => t.replace(/["*^:()]/g, ""))
      .filter(Boolean)
      .map((t) => `"${t}"*`);
    if (!terms.length) return [];
    const rows = this.#db
      .prepare("SELECT id FROM items_fts WHERE project = ? AND items_fts MATCH ? ORDER BY rank LIMIT ?")
      .all(project, terms.join(" OR "), limit) as { id: string }[];
    return rows.map((r) => this.get(project, r.id));
  }

  visionRev(project: string): number {
    const row = this.#db.prepare("SELECT rev FROM vision_revs WHERE project = ?").get(project) as
      | { rev: number }
      | undefined;
    return row?.rev ?? 0;
  }

  /** Hash présenté à l'humain et porté par son approbation (docs/SECURITY.md §4). */
  proposalHash(project: string, id: string): string {
    const item = this.get(project, id);
    if (item.type !== "proposal") throw new VisionError(`${id} n'est pas une proposition`);
    return hashOf(item);
  }

  // ── Écritures « working » (agents ou humain) ─────────────────────────────

  capture(project: string, actor: Author, input: CaptureInput): Item {
    if (!CAPTURABLE.includes(input.type)) {
      throw new VisionError(`Le type ${input.type} ne peut pas être capté directement`);
    }
    const now = this.#clock.now();
    const item = this.#draft(project, input.type, {
      status: isContent(input.type) ? "captured" : "open",
      title: input.title,
      statement: input.statement,
      domain: input.domain ?? [],
      source: input.source,
      authored_by: actor,
      links: input.links ?? [],
      confidence: input.confidence,
      hint: input.hint,
      created_at: now,
      updated_at: now,
    });
    this.#persist(project, [item]);
    this.#log(project, actor, "item.captured", item.id, { type: item.type, source: item.source.ref });
    return item;
  }

  triage(project: string, actor: Author, id: string, action: "keep" | "discard" | "restore"): Item {
    const item = this.get(project, id);
    if (!isContent(item.type)) throw new VisionError(`${id} (${item.type}) ne se trie pas`);
    const allowed: Record<typeof action, { from: string[]; to: string }> = {
      keep: { from: ["captured"], to: "triaged" },
      discard: { from: ["captured", "triaged"], to: "discarded" },
      restore: { from: ["discarded"], to: "triaged" },
    };
    const rule = allowed[action];
    if (!rule.from.includes(item.status)) {
      throw new VisionError(`Impossible de ${action} ${id} depuis le statut ${item.status}`);
    }
    const updated = { ...item, status: rule.to, updated_at: this.#clock.now() };
    this.#persist(project, [updated]);
    this.#log(project, actor, "item.triaged", id, { from: item.status, to: rule.to });
    return updated;
  }

  submitProposal(project: string, actor: Author, input: ProposalInput): { proposal: Item; hash: string } {
    const details = ProposalDetails.parse(input.details);
    const basedOn = details.based_on.map((id) => this.get(project, id));
    for (const b of basedOn) {
      if (b.tier === "canon") throw new VisionError(`${b.id} est déjà au canon : proposez de le remplacer (supersedes)`);
      if (isContent(b.type) && !["captured", "triaged"].includes(b.status)) {
        throw new VisionError(`${b.id} est au statut ${b.status} : il ne peut pas fonder une nouvelle proposition`);
      }
      if (!isContent(b.type) && !["hypothesis", "question"].includes(b.type)) {
        throw new VisionError(`${b.id} (${b.type}) ne peut pas fonder une proposition`);
      }
      if (!isContent(b.type) && b.status !== "open") {
        throw new VisionError(`${b.id} est au statut ${b.status} : il ne peut pas fonder une nouvelle proposition`);
      }
    }
    for (const id of details.supersedes) {
      const d = this.get(project, id);
      if (d.type !== "decision" || d.status !== "validated") {
        throw new VisionError(`${id} n'est pas une décision validée : rien à remplacer`);
      }
    }
    if (details.recommended_option && !details.options.some((o) => o.key === details.recommended_option)) {
      throw new VisionError(`Option recommandée inconnue : ${details.recommended_option}`);
    }

    const now = this.#clock.now();
    const proposal = this.#draft(project, "proposal", {
      status: "submitted",
      title: input.title,
      statement: input.statement,
      domain: input.domain ?? [],
      source: input.source,
      authored_by: actor,
      links: [
        ...details.based_on.map((to) => ({ rel: "derived_from" as const, to })),
        ...details.supersedes.map((to) => ({ rel: "supersedes" as const, to })),
      ],
      proposal: details,
      created_at: now,
      updated_at: now,
    });
    const marked = basedOn
      .filter((b) => isContent(b.type))
      .map((b) => ({ ...b, status: "proposed", updated_at: now }));
    this.#persist(project, [proposal, ...marked]);
    this.#log(project, actor, "proposal.submitted", proposal.id, { based_on: details.based_on, supersedes: details.supersedes });
    return { proposal, hash: hashOf(proposal) };
  }

  // ── Effets d'une approbation humaine ─────────────────────────────────────

  /**
   * Applique votre verdict sur une proposition. C'est le SEUL chemin qui fait
   * entrer quelque chose au canon.
   */
  async decideProposal(project: string, approvalId: string): Promise<{ decision?: Item; commit: string | null }> {
    const pending = this.#approvals.get(project, approvalId);
    if (!pending) throw new VisionError(`Approbation ${approvalId} introuvable`);
    const proposal = this.get(project, pending.subject.id);
    if (proposal.type !== "proposal") throw new VisionError(`${proposal.id} n'est pas une proposition`);
    if (proposal.status !== "submitted") throw new VisionError(`${proposal.id} est déjà ${proposal.status}`);
    const details = proposal.proposal!;
    this.#assertStillApplicable(project, proposal);

    const now = this.#clock.now();
    const { changed, decision, approval } = transaction(this.#db, () => {
      const changed: Item[] = [];
      const approval = this.#approvals.consume(project, approvalId, { kind: "proposal", id: proposal.id, hash: hashOf(proposal) });
      if (approval.verdict === "rejected") {
        changed.push({ ...proposal, status: "rejected", updated_at: now });
        for (const id of details.based_on) {
          const b = this.get(project, id);
          if (b.status === "proposed") changed.push({ ...b, status: "triaged", updated_at: now });
        }
        return { changed, decision: undefined, approval };
      }

      const rev = this.visionRev(project) + 1;
      const validatedBy: ValidatedBy = { kind: "human", at: now, approval: approval.id };
      const edits = approval.edits ?? {};
      const chosen = edits.chosen_option ?? (details.options.length ? details.recommended_option : undefined);
      const option = details.options.find((o) => o.key === chosen);
      if (details.options.length && !option) {
        throw new VisionError("Cette proposition a des options : choisissez-en une pour la valider");
      }

      const decision = this.#draft(project, "decision", {
        status: "validated",
        tier: "canon",
        title: edits.title ?? proposal.title,
        statement: edits.statement ?? option?.statement ?? proposal.statement,
        domain: proposal.domain,
        source: { kind: "item", ref: proposal.id },
        authored_by: proposal.authored_by,
        validated_by: validatedBy,
        links: [
          { rel: "derived_from", to: proposal.id },
          ...details.supersedes.map((to) => ({ rel: "supersedes" as const, to })),
        ],
        decision: {
          rationale: details.rationale,
          from_proposal: proposal.id,
          chosen_option: option?.key,
          supersedes: details.supersedes,
          human_edits: !!(edits.title || edits.statement),
        },
        vision_rev: rev,
        created_at: now,
        updated_at: now,
      });
      changed.push(decision);
      changed.push({ ...proposal, status: "validated", validated_by: validatedBy, updated_at: now });

      for (const id of details.based_on) {
        const b = this.get(project, id);
        if (isContent(b.type)) {
          changed.push({ ...b, status: "validated", tier: "canon", validated_by: validatedBy, vision_rev: rev, updated_at: now });
        } else if (b.type === "hypothesis") {
          changed.push({ ...b, status: "confirmed", vision_rev: rev, updated_at: now, links: [...b.links, { rel: "answers", to: decision.id }] });
        } else if (b.type === "question") {
          changed.push({ ...b, status: "answered", vision_rev: rev, updated_at: now, links: [...b.links, { rel: "answers", to: decision.id }] });
        }
      }
      for (const created of details.creates) {
        changed.push(
          this.#draft(project, created.type, {
            status: "validated",
            tier: "canon",
            title: created.title,
            statement: created.statement,
            domain: created.domain,
            source: { kind: "item", ref: proposal.id },
            authored_by: proposal.authored_by,
            validated_by: validatedBy,
            links: [{ rel: "derived_from", to: decision.id }],
            vision_rev: rev,
            created_at: now,
            updated_at: now,
          }),
        );
      }
      for (const id of details.supersedes) {
        const old = this.get(project, id);
        // Seuls le statut et superseded_by changent : l'énoncé reste tel qu'il a été validé.
        changed.push({
          ...old,
          status: "superseded",
          decision: { ...old.decision!, superseded_by: decision.id },
          updated_at: now,
        });
      }
      this.#db.prepare("INSERT INTO vision_revs (project, rev) VALUES (?, ?) ON CONFLICT (project) DO UPDATE SET rev = excluded.rev").run(project, rev);
      return { changed, decision, approval };
    });

    this.#persist(project, changed);
    this.#writeBrief(project);
    const message = decision
      ? `vision: ${decision.id} validée — ${decision.title} (${approval.id})`
      : `vision: ${proposal.id} refusée (${approval.id})`;
    const commit = await this.#vcs.commitPaths(this.#root(project), ["studio"], message);
    this.#log(project, { kind: "human" }, decision ? "decision.validated" : "proposal.rejected", decision?.id ?? proposal.id, {
      approval: approval.id,
      proposal: proposal.id,
      supersedes: details.supersedes,
      vision_rev: this.visionRev(project),
      commit,
    });
    return { decision, commit };
  }

  /** Retire une décision validée sans la remplacer (votre approbation de type « abandon »). */
  async abandonDecision(project: string, approvalId: string): Promise<{ commit: string | null }> {
    const approval = this.#approvals.get(project, approvalId);
    if (!approval) throw new VisionError(`Approbation ${approvalId} introuvable`);
    const decision = this.get(project, approval.subject.id);
    if (decision.type !== "decision" || decision.status !== "validated") {
      throw new VisionError(`${decision.id} n'est pas une décision validée`);
    }
    const now = this.#clock.now();
    let rev = 0;
    transaction(this.#db, () => {
      const used = this.#approvals.consume(project, approvalId, { kind: "abandon", id: decision.id, hash: hashOf(decision) });
      if (used.verdict !== "approved") throw new VisionError("Abandon refusé");
      rev = this.visionRev(project) + 1;
      this.#db.prepare("UPDATE vision_revs SET rev = ? WHERE project = ?").run(rev, project);
    });
    this.#persist(project, [{ ...decision, status: "abandoned", updated_at: now }]);
    this.#writeBrief(project);
    const commit = await this.#vcs.commitPaths(this.#root(project), ["studio"], `vision: ${decision.id} abandonnée (${approvalId})`);
    this.#log(project, { kind: "human" }, "decision.abandoned", decision.id, { approval: approvalId, vision_rev: rev, commit });
    return { commit };
  }

  /** Hash d'un item quelconque, pour les approbations autres que les propositions. */
  itemHash(project: string, id: string): string {
    return hashOf(this.get(project, id));
  }

  // ── Index ────────────────────────────────────────────────────────────────

  /** Reconstruit l'index SQLite à partir des fichiers (ADR-05). */
  rebuildIndex(project: string): { items: number } {
    const dir = this.#itemsDir(project);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^[A-Z]-\d+\.md$/.test(f)) : [];
    const items = files.map((f) => parseItem(readFileSync(join(dir, f), "utf8"), f));
    transaction(this.#db, () => {
      for (const table of ["items", "links", "items_fts"]) {
        this.#db.prepare(`DELETE FROM ${table} WHERE project = ?`).run(project);
      }
      for (const item of items) {
        this.#index(project, item);
        bumpCounterTo(this.#db, project, item.id);
      }
      const rev = items.reduce((max, i) => Math.max(max, i.vision_rev), 0);
      this.#db
        .prepare("INSERT INTO vision_revs (project, rev) VALUES (?, ?) ON CONFLICT (project) DO UPDATE SET rev = MAX(rev, excluded.rev)")
        .run(project, rev);
    });
    return { items: items.length };
  }

  // ── Interne ──────────────────────────────────────────────────────────────

  #draft(
    project: string,
    type: ItemType,
    fields: Omit<Partial<Item>, "id" | "type" | "project"> &
      Pick<Item, "status" | "title" | "source" | "authored_by" | "created_at" | "updated_at">,
  ): Item {
    return ItemFrontmatter.parse({
      tier: "working",
      statement: "",
      domain: [],
      links: [],
      vision_rev: this.visionRev(project),
      ...fields,
      id: nextId(this.#db, project, ITEM_PREFIX[type]),
      project,
      type,
    });
  }

  /** Vérifie que le canon n'a pas bougé sous la proposition depuis sa soumission. */
  #assertStillApplicable(project: string, proposal: Item): void {
    for (const id of proposal.proposal!.supersedes) {
      const d = this.get(project, id);
      if (d.status !== "validated") {
        throw new VisionError(`${id} est désormais ${d.status} : la proposition ${proposal.id} doit être remise à jour`);
      }
    }
    for (const id of proposal.proposal!.based_on) {
      const b = this.get(project, id);
      if (isContent(b.type) && b.status !== "proposed") {
        throw new VisionError(`${id} est désormais ${b.status} : la proposition ${proposal.id} doit être remise à jour`);
      }
    }
  }

  #persist(project: string, items: Item[]): void {
    const dir = this.#itemsDir(project);
    mkdirSync(dir, { recursive: true });
    for (const raw of items) {
      const item = ItemFrontmatter.parse(raw);
      const path = join(dir, `${item.id}.md`);
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, serializeItem(item), "utf8");
      renameSync(tmp, path);
    }
    transaction(this.#db, () => {
      for (const item of items) {
        for (const table of ["items", "links", "items_fts"]) {
          const col = table === "links" ? "from_id" : "id";
          this.#db.prepare(`DELETE FROM ${table} WHERE project = ? AND ${col} = ?`).run(project, item.id);
        }
        this.#index(project, item);
      }
    });
  }

  #index(project: string, item: Item): void {
    this.#db
      .prepare(
        "INSERT INTO items (project, id, type, status, tier, title, domain_json, vision_rev, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(project, item.id, item.type, item.status, item.tier, item.title, JSON.stringify(item.domain), item.vision_rev, item.updated_at);
    for (const link of item.links) {
      this.#db.prepare("INSERT OR IGNORE INTO links (project, from_id, rel, to_id) VALUES (?, ?, ?, ?)").run(project, item.id, link.rel, link.to);
    }
    this.#db.prepare("INSERT INTO items_fts (project, id, title, statement) VALUES (?, ?, ?, ?)").run(project, item.id, item.title, item.statement);
  }

  #writeBrief(project: string): void {
    const p = this.#projects.get(project);
    const canon = this.list(project, { tier: "canon" }).filter((i) => i.status === "validated");
    const open = this.list(project, { type: "proposal", status: "submitted" });
    const path = join(p.root, "studio", "BRIEF.md");
    writeFileSync(path, renderBrief({ name: p.name, rev: this.visionRev(project), canon, openProposals: open }), "utf8");
  }

  #log(project: string, actor: Author, type: string, subject: string, payload: Record<string, unknown>): void {
    this.#journal.append({ project, actor, type, subject, payload });
  }

  #root(project: string): string {
    return this.#projects.get(project).root;
  }

  #itemsDir(project: string): string {
    return join(this.#root(project), "studio", "items");
  }

  #itemPath(project: string, id: string): string {
    if (!/^[A-Z]-\d{4,}$/.test(id)) throw new VisionError(`Identifiant invalide : ${id}`);
    return join(this.#itemsDir(project), `${id}.md`);
  }
}

/** Hash du contenu d'un item, hors champs purement techniques. */
function hashOf(item: Item): string {
  const { updated_at: _u, ...content } = item;
  return sha256(canonicalJson(content));
}
