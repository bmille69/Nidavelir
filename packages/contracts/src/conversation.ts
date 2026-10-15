import { z } from "zod";
import { ItemId, Nature } from "./items.ts";

export const ThreadMode = z.enum(["exploration", "decision"]);
export type ThreadMode = z.infer<typeof ThreadMode>;

export const Thread = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  mode: ThreadMode,
  created_at: z.string(),
  /** Activité (liste des discussions) : nombre de messages, dernier message et son auteur. */
  messages: z.number().optional(),
  last_seq: z.number().optional(),
  last_at: z.string().nullable().optional(),
  last_role: z.enum(["human", "director"]).nullable().optional(),
});
export type Thread = z.infer<typeof Thread>;

export const ExtractionStatus = z.enum(["none", "pending", "done", "failed"]);

export const Message = z.object({
  id: z.string(),
  thread: z.string(),
  seq: z.number().int(),
  /** human = vous (directeur créatif) ; director = l'agent directeur. */
  role: z.enum(["human", "director"]),
  text: z.string(),
  at: z.string(),
  extraction: ExtractionStatus,
  cost_usd: z.number().nullable(),
});
export type Message = z.infer<typeof Message>;

/** Types qu'une extraction peut produire : jamais de décision ni de proposition. */
export const EXTRACTABLE_TYPES = ["vision", "goal", "mechanic", "constraint", "reference", "idea", "hypothesis", "question"] as const;

/** Sortie attendue du LLM d'extraction (docs/VISION_ENGINE.md §3). */
export const ExtractedItem = z.object({
  type: z.enum(EXTRACTABLE_TYPES),
  title: z.string().min(1).max(120),
  statement: z.string().min(1).max(2000),
  /** Extrait exact du texte source. Vérifié par le hub. */
  quote: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  domain: z.array(z.string().max(40)).max(5),
  duplicate_of: ItemId.nullable(),
  refines: ItemId.nullable(),
  looks_like_decision: z.boolean(),
});
export type ExtractedItem = z.infer<typeof ExtractedItem>;

export const ExtractionResult = z.object({ items: z.array(ExtractedItem).max(30) });
export type ExtractionResult = z.infer<typeof ExtractionResult>;

/** Un groupe d'éléments résumé en une proposition (docs/VISION_ENGINE.md §2.2). */
export const SynthesizedProposal = z.object({
  title: z.string().min(1).max(100),
  /** Un groupe est entièrement créatif ou entièrement technique, jamais mélangé. */
  nature: Nature,
  /** Une ou deux phrases sans chiffres techniques : ce que ça change pour le joueur. */
  summary: z.string().min(1).max(400),
  /** La règle détaillée qui serait décidée (chiffres compris). */
  statement: z.string().min(1).max(1500),
  rationale: z.string().max(800),
  based_on: z.array(ItemId).min(1).max(60),
  /** Décisions validées que cette proposition remplacerait (contradiction). */
  supersedes: z.array(ItemId).max(5),
  conflict_notes: z.array(z.string().max(400)).max(5),
  questions: z.array(z.string().max(300)).max(3),
  /** Vrai choix : deux ou trois versions complètes, que vous choisissez d'un clic (ADR-23). */
  options: z
    .array(
      z.object({
        key: z.string().min(1).max(4),
        label: z.string().min(1).max(80),
        statement: z.string().min(1).max(1500),
        tradeoffs: z.string().max(300),
      }),
    )
    .max(3)
    .default([]),
  /** Clé de l'option que le directeur recommande (vide s'il n'y a pas d'options). */
  recommended_option: z.string().max(4).default(""),
  domain: z.array(z.string().max(40)).max(3),
});
export type SynthesizedProposal = z.infer<typeof SynthesizedProposal>;

export const SynthesisResult = z.object({
  proposals: z.array(SynthesizedProposal).max(30),
  /** Éléments laissés de côté (trop vagues, hors sujet), avec la raison. */
  left_out: z.array(z.object({ id: ItemId, reason: z.string().max(200) })).max(200),
});
export type SynthesisResult = z.infer<typeof SynthesisResult>;
