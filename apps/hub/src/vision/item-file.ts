import { ItemFrontmatter } from "@studio/contracts";
import { parse, stringify } from "yaml";

export class ItemFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItemFileError";
  }
}

/** Sérialise un item en Markdown avec en-tête YAML. Le corps est un rendu lisible. */
export function serializeItem(item: ItemFrontmatter): string {
  const clean = JSON.parse(JSON.stringify(item)) as ItemFrontmatter;
  const yaml = stringify(clean, { lineWidth: 0, aliasDuplicateObjects: false });
  return `---\n${yaml}---\n${renderBody(item)}`;
}

export function parseItem(text: string, origin = "item"): ItemFrontmatter {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) throw new ItemFileError(`${origin} : en-tête YAML manquant`);
  let data: unknown;
  try {
    data = parse(match[1]!);
  } catch (err) {
    throw new ItemFileError(`${origin} : YAML invalide (${(err as Error).message})`);
  }
  const result = ItemFrontmatter.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`).join(" ; ");
    throw new ItemFileError(`${origin} : ${details}`);
  }
  return result.data;
}

const STATUS_LABEL: Record<string, string> = {
  validated: "validé",
  superseded: "remplacé",
  abandoned: "abandonné",
  submitted: "soumis",
  rejected: "refusé",
  captured: "capté",
  triaged: "retenu",
  proposed: "proposé",
  discarded: "écarté",
};

function renderBody(item: ItemFrontmatter): string {
  const lines: string[] = [
    "<!-- Fichier géré par Game Studio Hub. Modifiez la vision depuis le hub : l'en-tête YAML fait foi. -->",
    "",
    `# ${item.id} — ${item.title}`,
    "",
    `*${item.type} · ${STATUS_LABEL[item.status] ?? item.status} · ${item.tier}*`,
    "",
  ];
  if (item.statement) lines.push("## Énoncé", "", item.statement, "");
  const rationale = item.decision?.rationale || item.proposal?.rationale;
  if (rationale) lines.push("## Justification", "", rationale, "");
  if (item.proposal?.options.length) {
    lines.push("## Options", "");
    for (const o of item.proposal.options) {
      lines.push(`- **${o.key} — ${o.label}** : ${o.statement}${o.tradeoffs ? ` *(compromis : ${o.tradeoffs})*` : ""}`);
    }
    lines.push("");
  }
  if (item.source.quote) lines.push("## Source", "", `> ${item.source.quote.replace(/\n/g, "\n> ")}`, "", `— ${item.source.ref}`, "");
  if (item.links.length) {
    lines.push("## Liens", "", ...item.links.map((l) => `- ${l.rel} → ${l.to}`), "");
  }
  return lines.join("\n");
}
