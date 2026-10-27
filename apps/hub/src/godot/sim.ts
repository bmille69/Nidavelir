import { execFile } from "node:child_process";
import { godotErrors } from "./run.ts";

/**
 * Simulations d'équilibrage (ADR-86) : le lanceur du studio (addons/studio_tests/sim.gd) joue des centaines de parties
 * sans écran, une graine par partie ; ici, ce que chaque partie a mesuré devient des distributions lisibles.
 */

export type NumberStats = { kind: "number"; n: number; mean: number; min: number; max: number; p10: number; p50: number; p90: number; histogram: { from: number; to: number; count: number }[] };
export type BoolStats = { kind: "bool"; n: number; rate: number };
export type TextStats = { kind: "text"; n: number; top: { value: string; count: number }[] };
export type MetricStats = NumberStats | BoolStats | TextStats;
export type SimSummary = { name: string; runs: number; seconds: number; seed: number; metrics: Record<string, MetricStats>; error?: string };

const round = (v: number) => Math.round(v * 1000) / 1000;

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function summarize(runs: Record<string, unknown>[]): Record<string, MetricStats> {
  const keys = [...new Set(runs.flatMap((r) => Object.keys(r)))].sort();
  const out: Record<string, MetricStats> = {};
  for (const k of keys) {
    const values = runs.map((r) => r[k]).filter((v) => v !== undefined && v !== null);
    if (values.every((v) => typeof v === "boolean")) {
      out[k] = { kind: "bool", n: values.length, rate: round(values.filter(Boolean).length / Math.max(1, values.length)) };
    } else if (values.every((v) => typeof v === "number" && Number.isFinite(v))) {
      const nums = (values as number[]).slice().sort((a, b) => a - b);
      const min = nums[0] ?? 0;
      const max = nums.at(-1) ?? 0;
      const bins = min === max ? 1 : Math.min(10, new Set(nums).size);
      const width = (max - min) / bins || 1;
      const histogram = Array.from({ length: bins }, (_, i) => ({ from: round(min + i * width), to: round(min + (i + 1) * width), count: 0 }));
      for (const v of nums) histogram[Math.min(bins - 1, Math.floor((v - min) / width))]!.count++;
      out[k] = { kind: "number", n: nums.length, mean: round(nums.reduce((a, b) => a + b, 0) / Math.max(1, nums.length)), min, max, p10: round(quantile(nums, 0.1)), p50: round(quantile(nums, 0.5)), p90: round(quantile(nums, 0.9)), histogram };
    } else {
      const counts = new Map<string, number>();
      for (const v of values) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      out[k] = { kind: "text", n: values.length, top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([value, count]) => ({ value, count })) };
    }
  }
  return out;
}

/** Ce qui a bougé d'un passage à l'autre, en clair (écart de moyenne de plus de 10 %, ou de taux de plus de 5 points). */
export function compareSims(now: SimSummary, before: SimSummary | null): string[] {
  if (!before) return [];
  const out: string[] = [];
  for (const [k, m] of Object.entries(now.metrics)) {
    const b = before.metrics[k];
    if (!b || b.kind !== m.kind) continue;
    if (m.kind === "number" && b.kind === "number") {
      const ref = Math.abs(b.mean) || 1;
      if (Math.abs(m.mean - b.mean) / ref > 0.1) out.push(`${k} : ${fmt(b.mean)} → ${fmt(m.mean)} en moyenne (${m.mean > b.mean ? "+" : "−"}${Math.round((Math.abs(m.mean - b.mean) / ref) * 100)} %)`);
    } else if (m.kind === "bool" && b.kind === "bool") {
      if (Math.abs(m.rate - b.rate) > 0.05) out.push(`${k} : ${Math.round(b.rate * 100)} % → ${Math.round(m.rate * 100)} % des parties`);
    }
  }
  return out;
}

export const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1)).replace(".", ",");

/** Une simulation en quelques lignes, pour vous et pour le directeur. */
export function describeSim(s: SimSummary, before: SimSummary | null = null): string {
  if (s.error) return `${s.name} : ${s.error}`;
  const lines = [`${s.name.replace(/^res:\/\/tests\/sims\//, "")} — ${s.runs} parties en ${fmt(s.seconds)} s`];
  for (const [k, m] of Object.entries(s.metrics)) {
    if (m.kind === "number") lines.push(`- ${k} : moyenne ${fmt(m.mean)}, de ${fmt(m.min)} à ${fmt(m.max)} (9 parties sur 10 entre ${fmt(m.p10)} et ${fmt(m.p90)})`);
    else if (m.kind === "bool") lines.push(`- ${k} : ${Math.round(m.rate * 100)} % des parties`);
    else lines.push(`- ${k} : ${m.top.map((t) => `« ${t.value} » ${Math.round((t.count / Math.max(1, m.n)) * 100)} %`).join(", ")}`);
  }
  const moved = compareSims(s, before);
  if (moved.length) lines.push(`Depuis le passage précédent : ${moved.join(" ; ")}`);
  return lines.join("\n");
}

/** Lance le lanceur des simulations dans `cwd` (projet déjà importé) et lit ses lignes « STUDIO_SIM: ». */
export function godotSims(exe: string, cwd: string, options: { runs: number; only?: string | null; timeoutMs?: number }): Promise<{ sims: SimSummary[]; errors: string[]; log: string }> {
  const args = ["--headless", "--fixed-fps", "60", "--path", cwd, "-s", "res://addons/studio_tests/sim.gd", "--", `--runs=${Math.max(1, Math.min(2000, Math.round(options.runs)))}`];
  if (options.only) args.push(`--only=${options.only}`);
  return new Promise((resolve) => {
    execFile(exe, args, { cwd, windowsHide: true, timeout: options.timeoutMs ?? 10 * 60_000, maxBuffer: 64 * 1024 * 1024 }, (_err, stdout, stderr) => {
      const log = `${stdout}\n${stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
      const sims: SimSummary[] = [];
      for (const m of log.matchAll(/^STUDIO_SIM: (\{.*\})\s*$/gm)) {
        try {
          const d = JSON.parse(m[1]!) as { name: string; error?: string; seed?: number; seconds?: number; runs?: Record<string, unknown>[] };
          sims.push(d.error ? { name: d.name, runs: 0, seconds: 0, seed: 0, metrics: {}, error: d.error } : { name: d.name, runs: d.runs?.length ?? 0, seconds: d.seconds ?? 0, seed: d.seed ?? 1, metrics: summarize(d.runs ?? []) });
        } catch {
          /* ligne coupée */
        }
      }
      resolve({ sims, errors: godotErrors(log), log });
    });
  });
}
