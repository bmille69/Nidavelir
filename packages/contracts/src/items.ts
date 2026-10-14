import { z } from "zod";

/** Types d'items de vision (docs/VISION_ENGINE.md §1.2). */
export const ITEM_TYPES = [
  "vision",
  "goal",
  "mechanic",
  "constraint",
  "reference",
  "idea",
  "hypothesis",
  "question",
  "objection",
  "proposal",
  "decision",
  "spec",
  "conflict",
] as const;
export const ItemType = z.enum(ITEM_TYPES);
export type ItemType = z.infer<typeof ItemType>;

export const ITEM_PREFIX: Record<ItemType, string> = {
  vision: "V",
  goal: "G",
  mechanic: "M",
  constraint: "C",
  reference: "R",
  idea: "I",
  hypothesis: "H",
  question: "Q",
  objection: "O",
  proposal: "P",
  decision: "D",
  spec: "S",
  conflict: "K",
};

/** Contenus qui suivent le cycle captured → triaged → proposed → validated. */
export const CONTENT_TYPES = ["vision", "goal", "mechanic", "constraint", "reference", "idea", "spec"] as const;

export const CONTENT_STATUSES = [
  "captured",
  "triaged",
  "discarded",
  "proposed",
  "rejected",
  "validated",
  "superseded",
  "abandoned",
] as const;
export const PROPOSAL_STATUSES = ["submitted", "validated", "rejected", "returned", "deferred", "withdrawn"] as const;
export const DECISION_STATUSES = ["validated", "superseded", "abandoned"] as const;
export const QUESTION_STATUSES = ["open", "answered", "deferred"] as const;
export const HYPOTHESIS_STATUSES = ["open", "confirmed", "refuted"] as const;
export const ISSUE_STATUSES = ["open", "resolved", "dismissed"] as const;

export const STATUSES_BY_TYPE: Record<ItemType, readonly string[]> = {
  vision: CONTENT_STATUSES,
  goal: CONTENT_STATUSES,
  mechanic: CONTENT_STATUSES,
  constraint: CONTENT_STATUSES,
  reference: CONTENT_STATUSES,
  idea: CONTENT_STATUSES,
  spec: CONTENT_STATUSES,
  hypothesis: HYPOTHESIS_STATUSES,
  question: QUESTION_STATUSES,
  objection: ISSUE_STATUSES,
  conflict: ISSUE_STATUSES,
  proposal: PROPOSAL_STATUSES,
  decision: DECISION_STATUSES,
};

export const Tier = z.enum(["canon", "working"]);

/** Créatif = ce que vit le joueur (votre domaine) ; technique = comment le code est fait (domaine de l'architecte). */
export const Nature = z.enum(["creative", "technical"]);
export type Nature = z.infer<typeof Nature>;
export type Tier = z.infer<typeof Tier>;

export const ROLES = ["director", "game_designer", "architect", "developer", "qa"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

export const Author = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human") }),
  z.object({ kind: z.literal("agent"), role: Role, run: z.string().min(1) }),
]);
export type Author = z.infer<typeof Author>;

export const Source = z.object({
  kind: z.enum(["message", "item", "run", "file", "human"]),
  ref: z.string().min(1),
  quote: z.string().optional(),
});
export type Source = z.infer<typeof Source>;

export const LINK_RELS = [
  "derived_from",
  "refines",
  "depends_on",
  "constrains",
  "implements",
  "supersedes",
  "conflicts_with",
  "answers",
  "challenges",
] as const;
export const LinkRel = z.enum(LINK_RELS);
export type LinkRel = z.infer<typeof LinkRel>;

export const ItemId = z.string().regex(/^[A-Z]-\d{4,}$/, "identifiant d'item invalide");

export const Link = z.object({ rel: LinkRel, to: ItemId });
export type Link = z.infer<typeof Link>;

export const ValidatedBy = z.object({
  kind: z.literal("human"),
  at: z.string(),
  approval: z.string().regex(/^A-\d{4,}$/),
});
export type ValidatedBy = z.infer<typeof ValidatedBy>;

export const ProposalOption = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  statement: z.string().min(1),
  tradeoffs: z.string().default(""),
});
export type ProposalOption = z.infer<typeof ProposalOption>;

/** Nouvel item que la validation d'une proposition fera entrer au canon. */
export const NewCanonItem = z.object({
  type: z.enum(CONTENT_TYPES),
  title: z.string().min(1).max(200),
  statement: z.string().min(1),
  domain: z.array(z.string()).default([]),
});
export type NewCanonItem = z.infer<typeof NewCanonItem>;

export const ProposalDetails = z.object({
  /** Résumé en langage courant, affiché en premier. */
  summary: z.string().optional(),
  rationale: z.string().default(""),
  based_on: z.array(ItemId).default([]),
  supersedes: z.array(ItemId).default([]),
  creates: z.array(NewCanonItem).default([]),
  options: z.array(ProposalOption).default([]),
  recommended_option: z.string().optional(),
  assumptions: z.array(ItemId).default([]),
  open_questions: z.array(ItemId).default([]),
  /** Contradictions repérées avec le canon, expliquées simplement. */
  conflict_notes: z.array(z.string()).default([]),
  /** Questions que la proposition laisse ouvertes, formulées pour vous. */
  questions: z.array(z.string()).default([]),
});
export type ProposalDetails = z.infer<typeof ProposalDetails>;

export const DecisionDetails = z.object({
  summary: z.string().optional(),
  rationale: z.string().default(""),
  from_proposal: ItemId.optional(),
  chosen_option: z.string().optional(),
  supersedes: z.array(ItemId).default([]),
  superseded_by: ItemId.optional(),
  human_edits: z.boolean().default(false),
});
export type DecisionDetails = z.infer<typeof DecisionDetails>;

/**
 * En-tête YAML d'un fichier studio/items/<id>.md.
 * Le fichier est la source de vérité ; le corps Markdown est un rendu lisible.
 */
export const ItemFrontmatter = z
  .object({
    id: ItemId,
    project: z.string().min(1),
    type: ItemType,
    status: z.string(),
    tier: Tier,
    title: z.string().min(1).max(200),
    statement: z.string().default(""),
    domain: z.array(z.string()).default([]),
    source: Source,
    authored_by: Author,
    validated_by: ValidatedBy.optional(),
    links: z.array(Link).default([]),
    proposal: ProposalDetails.optional(),
    decision: DecisionDetails.optional(),
    confidence: z.number().min(0).max(1).optional(),
    /** Indice d'aide au tri, jamais un statut : « ressemble à une décision déjà prise ». */
    hint: z.enum(["existing_decision"]).optional(),
    nature: Nature.optional(),
    vision_rev: z.number().int().min(0),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .superRefine((item, ctx) => {
    if (!STATUSES_BY_TYPE[item.type].includes(item.status)) {
      ctx.addIssue({ code: "custom", path: ["status"], message: `statut « ${item.status} » invalide pour ${item.type}` });
    }
    if (!item.id.startsWith(`${ITEM_PREFIX[item.type]}-`)) {
      ctx.addIssue({ code: "custom", path: ["id"], message: `préfixe incompatible avec le type ${item.type}` });
    }
    if (item.tier === "canon" && !item.validated_by) {
      ctx.addIssue({ code: "custom", path: ["validated_by"], message: "un item canon doit porter validated_by" });
    }
    if (item.status === "validated" && !item.validated_by) {
      ctx.addIssue({ code: "custom", path: ["validated_by"], message: "un item validé doit porter validated_by" });
    }
  });
export type ItemFrontmatter = z.infer<typeof ItemFrontmatter>;
