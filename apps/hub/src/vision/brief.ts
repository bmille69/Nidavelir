import type { ItemFrontmatter, ItemType } from "@studio/contracts";

const SECTIONS: { type: ItemType; title: string }[] = [
  { type: "vision", title: "Vision et piliers" },
  { type: "goal", title: "Objectifs et priorités" },
  { type: "decision", title: "Décisions" },
  { type: "mechanic", title: "Mécaniques et règles" },
  { type: "constraint", title: "Contraintes" },
  { type: "reference", title: "Références et préférences" },
  { type: "spec", title: "Spécifications" },
  { type: "idea", title: "Idées retenues" },
];

/** Synthèse lisible du canon pour les agents (docs/VISION_ENGINE.md §4). Générée, jamais éditée. */
export function renderBrief(input: {
  name: string;
  rev: number;
  canon: ItemFrontmatter[];
  openProposals: ItemFrontmatter[];
}): string {
  const lines = [
    `# ${input.name} — brief de vision`,
    "",
    "<!-- Généré par Game Studio Hub. Ne pas modifier : toute modification de la vision passe par une proposition validée. -->",
    "",
    `Révision de vision : **${input.rev}**. Seuls les éléments ci-dessous sont validés par le directeur créatif.`,
    "",
  ];
  for (const section of SECTIONS) {
    const items = input.canon.filter((i) => i.type === section.type);
    if (!items.length) continue;
    lines.push(`## ${section.title}`, "");
    for (const i of items) lines.push(`- **${i.id} — ${i.title}** : ${i.statement.replace(/\n+/g, " ")}`);
    lines.push("");
  }
  if (!input.canon.length) lines.push("*Aucun élément validé pour l'instant.*", "");
  if (input.openProposals.length) {
    lines.push("## En attente de décision (non validé)", "");
    for (const p of input.openProposals) lines.push(`- ${p.id} — ${p.title}`);
    lines.push("");
  }
  return lines.join("\n");
}
