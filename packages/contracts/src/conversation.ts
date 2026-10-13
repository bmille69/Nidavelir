import { z } from "zod";
import { ItemId } from "./items.ts";

export const ThreadMode = z.enum(["exploration", "decision"]);
export type ThreadMode = z.infer<typeof ThreadMode>;

export const Thread = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  mode: ThreadMode,
  created_at: z.string(),
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
