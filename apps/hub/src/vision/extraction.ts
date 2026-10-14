import { ExtractionResult, type Author, type ExtractedItem, type ItemFrontmatter, type Source } from "@studio/contracts";
import { z } from "zod";
import type { Journal } from "../journal/journal.ts";
import type { OrchestratorPort } from "../orchestrator/port.ts";
import { EXTRACTION_SYSTEM_PROMPT } from "../conversation/prompts.ts";
import type { VisionService } from "./vision-service.ts";

export const MIN_CONFIDENCE = 0.5;
const EXTRACTION_JSON_SCHEMA = z.toJSONSchema(ExtractionResult, { target: "draft-7" });

export type ExtractionOutcome = {
  created: ItemFrontmatter[];
  /** Éléments écartés par le hub, avec la raison (citation introuvable, doublon…). */
  rejected: { title: string; reason: string }[];
  costUsd: number | null;
};

/** Normalise pour comparer une citation au texte source sans être piégé par la typographie. */
export function normalizeForQuote(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/[“”«»„]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/…/g, "...")
    // Les guillemets et apostrophes sont ignorés : « simple », "simple" et 'simple' se valent.
    .replace(/["']/g, "")
    .replace(/[  ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function quoteIsIn(quote: string, source: string): boolean {
  const q = normalizeForQuote(quote);
  return q.length >= 3 && normalizeForQuote(source).includes(q);
}

/**
 * Transforme un texte libre (message ou document) en items `captured`
 * (docs/VISION_ENGINE.md §3 et §7). Ne crée jamais rien au canon.
 */
export class ExtractionService {
  readonly #vision: VisionService;
  readonly #orchestrator: OrchestratorPort;
  readonly #journal: Journal;

  constructor(vision: VisionService, orchestrator: OrchestratorPort, journal: Journal) {
    this.#vision = vision;
    this.#orchestrator = orchestrator;
    this.#journal = journal;
  }

  async extract(input: {
    project: string;
    author: Author;
    /** Texte dont les citations doivent provenir. */
    text: string;
    /** Contexte facultatif (messages précédents), jamais citable. */
    context?: string;
    kind: "message" | "file";
    /** Référence de la source ; pour un fichier, `ref(quote)` calcule la ligne. */
    ref: (quote: string) => string;
    /** Marque le contenu comme non fiable (documents). */
    untrusted: boolean;
    /** Nature imposée aux éléments (ex. document qui décrit le code = technique). */
    nature?: "creative" | "technical";
  }): Promise<ExtractionOutcome> {
    const existing = this.#vision
      .list(input.project)
      .filter((i) => !["discarded", "rejected", "superseded", "abandoned"].includes(i.status) && i.type !== "proposal")
      .slice(-150);
    const prompt = [
      "Éléments déjà connus (pour duplicate_of / refines) :",
      existing.length ? existing.map((i) => `- ${i.id} (${i.type}) ${i.title}`).join("\n") : "(aucun)",
      "",
      input.context ? `Contexte (NE PAS citer, sert seulement à comprendre) :\n<context>\n${input.context}\n</context>\n` : "",
      input.untrusted
        ? `Texte source à analyser (document du projet) :\n<untrusted_content>\n${input.text}\n</untrusted_content>`
        : `Texte source à analyser (message du directeur créatif) :\n<source>\n${input.text}\n</source>`,
    ].join("\n");

    const { data, costUsd } = await this.#orchestrator.structured({
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      prompt,
      jsonSchema: EXTRACTION_JSON_SCHEMA,
    });
    const parsed = ExtractionResult.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Sortie d'extraction invalide : ${parsed.error.issues[0]?.message ?? "?"}`);
    }

    const known = new Set(existing.map((i) => i.id));
    const created: ItemFrontmatter[] = [];
    const rejected: ExtractionOutcome["rejected"] = [];
    for (const x of parsed.data.items) {
      const reason = this.#rejectReason(x, input.text, known);
      if (reason) {
        rejected.push({ title: x.title, reason });
        continue;
      }
      const source: Source = { kind: input.kind, ref: input.ref(x.quote), quote: x.quote };
      const item = this.#vision.capture(input.project, input.author, {
        type: x.type,
        title: x.title,
        statement: x.statement,
        source,
        domain: x.domain,
        confidence: x.confidence,
        links: x.refines ? [{ rel: "refines", to: x.refines }] : [],
        hint: x.looks_like_decision && input.kind === "file" ? "existing_decision" : undefined,
        nature: input.nature,
      });
      created.push(item);
      known.add(item.id);
    }
    this.#journal.append({
      project: input.project,
      actor: input.author,
      type: "extraction.completed",
      subject: input.ref(""),
      payload: { created: created.map((i) => i.id), rejected, cost_usd: costUsd },
    });
    return { created, rejected, costUsd };
  }

  #rejectReason(x: ExtractedItem, text: string, known: Set<string>): string | null {
    if (!quoteIsIn(x.quote, text)) return "citation absente du texte source";
    if (x.confidence < MIN_CONFIDENCE) return `confiance trop faible (${x.confidence})`;
    if (x.duplicate_of && known.has(x.duplicate_of)) return `doublon de ${x.duplicate_of}`;
    if (x.refines && !known.has(x.refines)) x.refines = null;
    return null;
  }
}

/** Découpe un document Markdown en morceaux d'au plus maxChars, aux titres si possible. */
export function chunkDocument(text: string, maxChars = 12_000): { text: string; startLine: number }[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const chunks: { text: string; startLine: number }[] = [];
  let current: string[] = [];
  let start = 1;
  let size = 0;
  lines.forEach((l, idx) => {
    const isHeading = /^#{1,3}\s/.test(l);
    if (current.length && (size + l.length > maxChars || (isHeading && size > maxChars / 2))) {
      chunks.push({ text: current.join("\n"), startLine: start });
      current = [];
      size = 0;
      start = idx + 1;
    }
    current.push(l.length > maxChars ? l.slice(0, maxChars) : l);
    size += l.length + 1;
  });
  if (current.join("").trim()) chunks.push({ text: current.join("\n"), startLine: start });
  return chunks;
}

/** Numéro de ligne (1-based) où commence la citation dans le document, ou null. */
export function lineOf(quote: string, text: string): number | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const q = normalizeForQuote(quote).slice(0, 60);
  if (!q) return null;
  const norm = lines.map(normalizeForQuote);
  // 1) La ligne contient le début de la citation.
  const head = q.slice(0, 30);
  const direct = norm.findIndex((l) => l.includes(head));
  if (direct >= 0) return direct + 1;
  // 2) Citation à cheval sur plusieurs lignes : on part d'une ligne non vide.
  for (let i = 0; i < lines.length; i++) {
    if (!norm[i]) continue;
    if (normalizeForQuote(lines.slice(i, i + 4).join(" ")).includes(q)) return i + 1;
  }
  return null;
}
