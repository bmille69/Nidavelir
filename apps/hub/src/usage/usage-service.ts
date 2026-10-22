import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";

/** Jetons d'un appel, tels que Claude Code les rapporte (champ `usage` du résultat). */
export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/**
 * Vos limites d'abonnement, telles que Claude Code les publie lui-même
 * (`rate_limit_event` du flux stream-json). Le hub ne lit aucun identifiant.
 */
export type RateLimits = {
  status: string;
  windows: Partial<Record<"five_hour" | "seven_day", { utilization: number; resetsAt: string }>>;
};

export type UsageEvent = {
  project?: string | null;
  agent: string;
  model?: string | null;
  tokens: TokenUsage | null;
  costUsd: number | null;
  limits?: RateLimits | null;
};

export type UsageSnapshot = {
  limits: (RateLimits & { at: string }) | null;
  today: { tokens: number; calls: number; costUsd: number };
  week: { tokens: number; calls: number; costUsd: number };
  byAgent: { agent: string; tokens: number; calls: number }[];
  /** Consommation de chaque agent du studio, aujourd'hui et sur 7 jours, avec le modèle le plus utilisé (ADR-37). */
  agents: Record<string, AgentUsage>;
};

export type AgentUsage = { today: { tokens: number; calls: number }; week: { tokens: number; calls: number; costUsd: number }; models: Record<string, number> };

/** Appels rangés sous l'agent dont ils utilisent le modèle : les leçons passent par celui de l'archiviste. */
const AGENT_OF: Record<string, string> = { lecons: "archivist" };

/** Lit l'usage et les limites dans la sortie JSON de Claude Code. */
export function parseUsage(json: Record<string, unknown> | null | undefined): TokenUsage | null {
  const u = json?.usage as Record<string, unknown> | undefined;
  if (!u) return null;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) };
}

export function parseRateLimit(event: Record<string, unknown>): RateLimits | null {
  const info = event.rate_limit_info as Record<string, unknown> | undefined;
  if (!info) return null;
  const windows: RateLimits["windows"] = {};
  const raw = (info.unifiedWindows ?? {}) as Record<string, { utilization?: unknown; resetsAt?: unknown }>;
  for (const key of ["five_hour", "seven_day"] as const) {
    const w = raw[key];
    if (w && typeof w.utilization === "number" && typeof w.resetsAt === "number") {
      windows[key] = { utilization: w.utilization, resetsAt: new Date(w.resetsAt * 1000).toISOString() };
    }
  }
  // Ancien format : une seule fenêtre au premier niveau.
  const type = info.rateLimitType;
  if ((type === "five_hour" || type === "seven_day") && !windows[type] && typeof info.utilization === "number" && typeof info.resetsAt === "number") {
    windows[type] = { utilization: info.utilization, resetsAt: new Date(info.resetsAt * 1000).toISOString() };
  }
  return { status: String(info.status ?? "unknown"), windows };
}

/** Compteur d'utilisation de Claude par le hub (ADR-21). */
export class UsageService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #probe?: () => Promise<void>;

  constructor(db: Db, clock: Clock, probe?: () => Promise<void>) {
    this.#db = db;
    this.#clock = clock;
    this.#probe = probe;
  }

  record(e: UsageEvent): void {
    const now = this.#clock.now();
    if (e.tokens) {
      this.#db
        .prepare(
          "INSERT INTO usage_log (at, project, agent, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(now, e.project ?? null, e.agent, e.model ?? null, e.tokens.input, e.tokens.output, e.tokens.cacheRead, e.tokens.cacheWrite, e.costUsd);
    }
    if (e.limits && Object.keys(e.limits.windows).length) {
      this.#db
        .prepare("INSERT INTO usage_limits (id, at, data_json) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET at = excluded.at, data_json = excluded.data_json")
        .run(now, JSON.stringify(e.limits));
    }
  }

  /** Demande à Claude Code un appel minimal pour rafraîchir vos limites. */
  async refresh(): Promise<UsageSnapshot> {
    if (!this.#probe) throw new Error("Rafraîchissement indisponible");
    await this.#probe();
    return this.snapshot();
  }

  /** La dernière heure, par tranches de 5 minutes (ADR-64) : jetons et équivalent en dollars, comptés à la fin de chaque appel. */
  recent(): { buckets: { at: string; tokens: number; costUsd: number }[]; last15: { tokens: number; costUsd: number; calls: number }; hour: { tokens: number; costUsd: number; calls: number } } {
    const now = Date.parse(this.#clock.now());
    const rows = this.#db
      .prepare("SELECT at, input_tokens + output_tokens + cache_read_tokens + cache_write_tokens AS tokens, cost_usd FROM usage_log WHERE at >= ?")
      .all(new Date(now - 3_600_000).toISOString()) as { at: string; tokens: number; cost_usd: number | null }[];
    const buckets = Array.from({ length: 12 }, (_, k) => ({ at: new Date(now - (12 - k) * 300_000).toISOString(), tokens: 0, costUsd: 0 }));
    const last15 = { tokens: 0, costUsd: 0, calls: 0 };
    const hour = { tokens: 0, costUsd: 0, calls: 0 };
    for (const r of rows) {
      const age = now - Date.parse(r.at);
      const b = buckets[Math.min(11, Math.max(0, 11 - Math.floor(age / 300_000)))]!;
      b.tokens += Number(r.tokens);
      b.costUsd += r.cost_usd ?? 0;
      hour.tokens += Number(r.tokens);
      hour.costUsd += r.cost_usd ?? 0;
      hour.calls++;
      if (age <= 900_000) {
        last15.tokens += Number(r.tokens);
        last15.costUsd += r.cost_usd ?? 0;
        last15.calls++;
      }
    }
    return { buckets, last15, hour };
  }

  snapshot(): UsageSnapshot {
    const now = Date.parse(this.#clock.now());
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const sum = (since: string) => {
      const r = this.#db
        .prepare(
          "SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost FROM usage_log WHERE at >= ?",
        )
        .get(since) as { calls: number; tokens: number; cost: number };
      return { tokens: Number(r.tokens), calls: Number(r.calls), costUsd: Number(r.cost) };
    };
    const today = dayStart.toISOString();
    const byAgent = this.#db
      .prepare(
        "SELECT agent, COUNT(*) AS calls, SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens FROM usage_log WHERE at >= ? GROUP BY agent ORDER BY tokens DESC",
      )
      .all(today) as { agent: string; calls: number; tokens: number }[];
    const agents: Record<string, AgentUsage> = {};
    const rows = this.#db
      .prepare(
        "SELECT agent, model, at >= ? AS today, COUNT(*) AS calls, COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost FROM usage_log WHERE at >= ? AND agent <> 'compteur' GROUP BY agent, model, at >= ?",
      )
      .all(today, new Date(now - 7 * 86_400_000).toISOString(), today) as { agent: string; model: string | null; today: number; calls: number; tokens: number; cost: number }[];
    for (const r of rows) {
      const key = AGENT_OF[r.agent] ?? r.agent;
      const a = (agents[key] ??= { today: { tokens: 0, calls: 0 }, week: { tokens: 0, calls: 0, costUsd: 0 }, models: {} });
      a.week.tokens += Number(r.tokens);
      a.week.calls += Number(r.calls);
      a.week.costUsd += Number(r.cost);
      if (Number(r.today)) {
        a.today.tokens += Number(r.tokens);
        a.today.calls += Number(r.calls);
      }
      if (r.model) a.models[r.model] = (a.models[r.model] ?? 0) + Number(r.tokens);
    }
    const row = this.#db.prepare("SELECT at, data_json FROM usage_limits WHERE id = 1").get() as { at: string; data_json: string } | undefined;
    return {
      limits: row ? { ...(JSON.parse(row.data_json) as RateLimits), at: row.at } : null,
      today: sum(today),
      week: sum(new Date(now - 7 * 86_400_000).toISOString()),
      byAgent: byAgent.map((a) => ({ agent: a.agent, calls: Number(a.calls), tokens: Number(a.tokens) })),
      agents,
    };
  }
}
