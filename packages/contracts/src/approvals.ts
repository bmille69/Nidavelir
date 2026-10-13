import { z } from "zod";
import { ItemId } from "./items.ts";

export const ApprovalSubjectKind = z.enum(["proposal", "plan", "escalation", "merge", "abandon", "import"]);
export type ApprovalSubjectKind = z.infer<typeof ApprovalSubjectKind>;

/** Modifications que vous pouvez apporter au moment de valider une proposition. */
export const ApprovalEdits = z.object({
  title: z.string().min(1).max(200).optional(),
  statement: z.string().min(1).optional(),
  chosen_option: z.string().optional(),
  /** Éléments sources que vous retirez du groupe : ils reviennent au tri, non validés. */
  exclude: z.array(ItemId).max(500).optional(),
});
export type ApprovalEdits = z.infer<typeof ApprovalEdits>;

/** Enregistrement d'une validation humaine (docs/SECURITY.md §4). */
export const Approval = z.object({
  id: z.string().regex(/^A-\d{4,}$/),
  project: z.string().min(1),
  subject: z.object({ kind: ApprovalSubjectKind, id: ItemId, hash: z.string().length(64) }),
  verdict: z.enum(["approved", "rejected"]),
  note: z.string().optional(),
  edits: ApprovalEdits.optional(),
  at: z.string(),
  session: z.string().min(1),
  consumed_at: z.string().optional(),
});
export type Approval = z.infer<typeof Approval>;
