import { z } from "zod";
import { Author } from "./items.ts";

export const Actor = z.union([Author, z.object({ kind: z.literal("system") })]);
export type Actor = z.infer<typeof Actor>;

/** Entrée du journal append-only (docs/SECURITY.md §8). */
export const HubEvent = z.object({
  seq: z.number().int().positive(),
  at: z.string(),
  project: z.string().nullable(),
  actor: Actor,
  type: z.string().min(1),
  subject: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type HubEvent = z.infer<typeof HubEvent>;
