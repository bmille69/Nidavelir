import { AsyncLocalStorage } from "node:async_hooks";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import type { OrchestratorPort } from "../orchestrator/port.ts";

/**
 * Plafond de dépense par visuel (ADR-82). A-0013 a été refusé 5 fois de suite pour ~12 $ : le DA bouclait sans fin.
 * Chaque visuel a un compte (modèles, en équivalent API, et crédits Tripo), tenu d'une fabrication à l'autre. Arrivé au
 * plafond, le DA s'arrête et dit ce qui bloque ; vous seul pouvez le relever, d'un plafond de plus à chaque fois.
 */
export type AssetSpend = { usd: number; credits: number; capUsd: number; capCredits: number; over: boolean };

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export class AssetBudget {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #scope = new AsyncLocalStorage<{ project: string; asset: string }>();
  readonly capUsd: number;
  readonly capCredits: number;

  constructor(db: Db, clock: Clock, caps?: { usd?: number; credits?: number }) {
    this.#db = db;
    this.#clock = clock;
    this.capUsd = caps?.usd ?? num(process.env.STUDIO_ART_ASSET_USD, 6);
    this.capCredits = caps?.credits ?? num(process.env.STUDIO_ART_ASSET_CREDITS, 250);
  }

  /** Tout appel de modèle fait dans fn compte pour ce visuel. */
  run<T>(project: string, asset: string, fn: () => Promise<T>): Promise<T> {
    return this.#scope.run({ project, asset }, fn);
  }

  add(project: string, asset: string, spent: { usd?: number | null; credits?: number }): void {
    const usd = spent.usd && spent.usd > 0 ? spent.usd : 0;
    const credits = spent.credits && spent.credits > 0 ? Math.round(spent.credits) : 0;
    if (!usd && !credits) return;
    this.#db
      .prepare(
        `INSERT INTO art_spend (project, asset, usd, credits, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project, asset) DO UPDATE SET usd = usd + excluded.usd, credits = credits + excluded.credits, updated_at = excluded.updated_at`,
      )
      .run(project, asset, usd, credits, this.#clock.now());
  }

  get(project: string, asset: string): AssetSpend {
    const r = this.#db.prepare("SELECT usd, credits, raises FROM art_spend WHERE project = ? AND asset = ?").get(project, asset) as
      | { usd: number; credits: number; raises: number }
      | undefined;
    const usd = r?.usd ?? 0;
    const credits = r?.credits ?? 0;
    const capUsd = this.capUsd * (1 + (r?.raises ?? 0));
    const capCredits = this.capCredits * (1 + (r?.raises ?? 0));
    return { usd, credits, capUsd, capCredits, over: usd >= capUsd || credits >= capCredits };
  }

  all(project: string): Record<string, AssetSpend> {
    const ids = this.#db.prepare("SELECT asset FROM art_spend WHERE project = ?").all(project) as { asset: string }[];
    return Object.fromEntries(ids.map(({ asset }) => [asset, this.get(project, asset)]));
  }

  /** Votre clic : un plafond de plus pour ce visuel. */
  raise(project: string, asset: string): AssetSpend {
    this.#db
      .prepare(
        `INSERT INTO art_spend (project, asset, raises, updated_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (project, asset) DO UPDATE SET raises = raises + 1, updated_at = excluded.updated_at`,
      )
      .run(project, asset, this.#clock.now());
    return this.get(project, asset);
  }

  /** Le plafond atteint, en clair, ou null. */
  overMessage(project: string, asset: string): string | null {
    const s = this.get(project, asset);
    if (!s.over) return null;
    return `${asset} a atteint son plafond : ${euros(s.usd)} de modèles et ${s.credits} crédits Tripo dépensés (plafond ${euros(s.capUsd)} et ${s.capCredits} crédits)`;
  }

  /** L'orchestrateur, dont les appels faits pour un visuel sont comptés sur ce visuel. */
  wrap(orchestrator: OrchestratorPort): OrchestratorPort {
    const count = (costUsd: number | null) => {
      const s = this.#scope.getStore();
      if (s) this.add(s.project, s.asset, { usd: costUsd });
    };
    return {
      get name() {
        return orchestrator.name;
      },
      reply: async (input) => {
        const r = await orchestrator.reply(input);
        count(r.costUsd);
        return r;
      },
      structured: async (input) => {
        const r = await orchestrator.structured(input);
        count(r.costUsd);
        return r;
      },
    };
  }
}

export const euros = (usd: number) => `${usd.toFixed(2).replace(".", ",")} $`;
