import type { Db } from "../db/database.ts";

/**
 * Comparaison des chantiers passés en direct et par le relais Caveman (ADR-90), avec les chiffres réels que
 * Claude Code rapporte à chaque passage (pas les estimations du relais). Seuls comptent les passages mesurés
 * depuis l'ajout de la mesure, et pour les jetons et le coût, les chantiers fusionnés.
 */
export type RouteStats = {
  route: "direct" | "caveman";
  /** Chantiers fusionnés dont tout le travail du Développeur a pris ce chemin. */
  chantiers: number;
  /** Jetons du Développeur par chantier fusionné (entrée, sortie et cache), médiane. */
  tokensMedian: number | null;
  /** Les mêmes sans la relecture du cache, qui compte peu dans vos limites : médiane. */
  freshMedian: number | null;
  /** Coût en équivalent API du Développeur par chantier fusionné, médiane. */
  costMedian: number | null;
  /** Exécutions du Développeur par chantier fusionné : 1 si rien n'a été repris. */
  executeRunsMean: number | null;
  /** Vérifications du Testeur par chantier fusionné : 1 s'il a accepté du premier coup. */
  verifyRunsMean: number | null;
  /** Passages du Développeur sur ce chemin, et ceux qui ont échoué. */
  runs: number;
  failedRuns: number;
};

export type RouteReport = { measuredSince: string | null; routes: RouteStats[] };

type Row = { project: string; task: string; kind: string; status: string; route: string | null; tokens_json: string | null; cost_usd: number | null; started_at: string; task_status: string | null };

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]): number | null => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

export function routeReport(db: Db, project?: string): RouteReport {
  const rows = db
    .prepare(
      `SELECT r.project, r.task, r.kind, r.status, r.route, r.tokens_json, r.cost_usd, r.started_at, t.status AS task_status
       FROM runs r LEFT JOIN tasks t ON t.project = r.project AND t.id = r.task
       WHERE r.route IS NOT NULL ${project ? "AND r.project = ?" : ""}`,
    )
    .all(...(project ? [project] : [])) as Row[];
  const measuredSince = rows.reduce<string | null>((min, r) => (min === null || r.started_at < min ? r.started_at : min), null);

  const byTask = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.project}/${r.task}`;
    byTask.set(key, [...(byTask.get(key) ?? []), r]);
  }

  const routes: RouteStats[] = (["direct", "caveman"] as const).map((route) => {
    const devRuns = rows.filter((r) => r.route === route && (r.kind === "plan" || r.kind === "execute"));
    const tokens: number[] = [];
    const fresh: number[] = [];
    const costs: number[] = [];
    const executes: number[] = [];
    const verifies: number[] = [];
    for (const list of byTask.values()) {
      const dev = list.filter((r) => r.kind === "plan" || r.kind === "execute");
      // Un chantier mixte (relais tombé en cours de route) ne compte d'aucun côté.
      if (!dev.length || dev.some((r) => r.route !== route) || list[0]!.task_status !== "merged") continue;
      let t = 0;
      let f = 0;
      for (const r of dev) {
        const u = r.tokens_json ? (JSON.parse(r.tokens_json) as { input: number; output: number; cacheRead: number; cacheWrite: number }) : null;
        if (!u) continue;
        t += u.input + u.output + u.cacheRead + u.cacheWrite;
        f += u.input + u.output + u.cacheWrite;
      }
      tokens.push(t);
      fresh.push(f);
      costs.push(dev.reduce((s, r) => s + (r.cost_usd ?? 0), 0));
      executes.push(dev.filter((r) => r.kind === "execute").length);
      verifies.push(list.filter((r) => r.kind === "verify").length);
    }
    return {
      route,
      chantiers: tokens.length,
      tokensMedian: median(tokens),
      freshMedian: median(fresh),
      costMedian: median(costs),
      executeRunsMean: mean(executes),
      verifyRunsMean: mean(verifies),
      runs: devRuns.length,
      failedRuns: devRuns.filter((r) => r.status === "failed").length,
    };
  });
  return { measuredSince, routes };
}
