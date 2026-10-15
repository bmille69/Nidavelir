import type { ReactNode } from "react";

const LINK = /(#\/[\w\-./]+)/g;

function label(href: string): string {
  if (href.startsWith("#/c/")) return "Ouvrir la conception →";
  if (/^#\/p\/[^/]+\/t\//.test(href)) return "Ouvrir la discussion →";
  if (/^#\/p\/[^/]+\/tasks\//.test(href)) return "Ouvrir le chantier →";
  return "Ouvrir →";
}

/** Texte d'un agent où les liens internes du hub (« #/c/… », « #/p/… ») deviennent cliquables (ADR-34). */
export function Linkify({ text }: { text: string }): ReactNode {
  const parts = text.split(LINK);
  if (parts.length === 1) return text;
  return parts.map((p, k) =>
    k % 2 ? (
      <a key={k} className="inline-link" href={p}>
        {label(p)}
      </a>
    ) : (
      p
    ),
  );
}
