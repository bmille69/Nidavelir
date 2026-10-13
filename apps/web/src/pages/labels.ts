export const TYPE_LABEL: Record<string, string> = {
  vision: "Vision",
  goal: "Objectif",
  mechanic: "Mécanique",
  constraint: "Contrainte",
  reference: "Référence",
  idea: "Idée",
  hypothesis: "Hypothèse",
  question: "Question",
  decision: "Décision",
  proposal: "Proposition",
  spec: "Spécification",
};

export const STATUS_LABEL: Record<string, string> = {
  captured: "à trier",
  triaged: "retenu",
  open: "ouvert",
  proposed: "dans une proposition",
  validated: "validé",
  superseded: "remplacé",
  abandoned: "abandonné",
  rejected: "refusé",
  returned: "renvoyé en discussion",
  submitted: "en attente",
  discarded: "écarté",
  confirmed: "confirmé",
  answered: "répondu",
};

export function formatDate(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}
