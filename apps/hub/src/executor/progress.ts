/**
 * L'avancement estimé d'un chantier, sans appel à un modèle : la phase où il en est, et pendant l'exécution la part des
 * étapes du plan dont un fichier a déjà été modifié (repli : le temps écoulé face à la durée habituelle d'une exécution).
 */
export type TaskProgress = { pct: number; phase: "plan" | "execute" | "checks" | "verify" | "merge"; label: string };

type RunLike = { kind: string; status: string; started_at: string; finished_at: string | null };

export function taskProgress(input: {
  status: string;
  runs: RunLike[];
  steps: { files: string[] }[] | null;
  /** Fichiers modifiés ou écrits pendant l'exécution en cours (chemins tels que l'agent les a donnés). */
  touched: string[];
  now: number;
  /** Durée habituelle d'une exécution dans ce projet, en ms (médiane des exécutions réussies). */
  typicalMs: number | null;
}): TaskProgress | null {
  const { status, runs, steps } = input;
  if (status === "planning" || status === "plan_review" || status === "approved") return { pct: 5, phase: "plan", label: "Préparation du plan" };
  if (status === "review") return { pct: 97, phase: "merge", label: "Fusion en cours" };
  if (status !== "running") return null;
  const exec = runs.filter((r) => r.kind === "execute").at(-1);
  const verify = runs.filter((r) => r.kind === "verify" && exec && r.started_at >= exec.started_at).at(-1);
  if (verify) return { pct: verify.status === "running" ? 90 : 96, phase: "verify", label: "Le testeur vérifie" };
  if (exec && exec.status !== "running") return { pct: 84, phase: "checks", label: "Tests et lancement du jeu" };
  if (!exec) return { pct: 10, phase: "execute", label: "Démarrage" };

  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase().replace(/^\.?\//, "");
  const touched = input.touched.map(norm);
  const planned = (steps ?? []).filter((s) => s.files.length);
  const done = planned.filter((s) => s.files.some((f) => touched.some((t) => t === norm(f) || t.endsWith(`/${norm(f)}`)))).length;
  const elapsed = Math.max(0, input.now - Date.parse(exec.started_at));
  const byTime = input.typicalMs ? Math.min(0.95, elapsed / input.typicalMs) : 0;
  const bySteps = planned.length ? done / planned.length : 0;
  // Les étapes guident quand le plan nomme ses fichiers ; le temps empêche la barre de rester figée sur une longue étape.
  const frac = Math.min(0.97, Math.max(bySteps * 0.95, byTime * 0.9));
  const pct = Math.round(10 + frac * 70);
  const label = planned.length ? `Étape ${Math.min(planned.length, done + 1)} sur ${planned.length}` : "Le développeur travaille";
  return { pct, phase: "execute", label };
}

/** Les fichiers modifiés ou écrits, lus dans les événements d'un run (« Modifie <chemin> », « Écrit <chemin> »). */
export function touchedFiles(events: { type: string; text: string }[]): string[] {
  return events.filter((e) => e.type === "tool").map((e) => /^(?:Modifie|Écrit) (.+)$/.exec(e.text)?.[1] ?? "").filter(Boolean);
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
