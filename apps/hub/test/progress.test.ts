import { describe, expect, it } from "vitest";
import { median, taskProgress, touchedFiles } from "../src/executor/progress.ts";

const T0 = Date.parse("2026-10-23T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const exec = (status = "running", finished: string | null = null) => ({ kind: "execute", status, started_at: at(0), finished_at: finished });
const steps = [{ files: ["src/a.ts"] }, { files: ["src/b.ts", "src/c.ts"] }, { files: [] }, { files: ["tests/d.test.ts"] }];

describe("avancement d'un chantier (pilotage)", () => {
  it("suit les étapes du plan d'après les fichiers déjà modifiés", () => {
    const touched = touchedFiles([
      { type: "tool", text: "Lit C:/w/T-0001/src/a.ts" },
      { type: "tool", text: "Modifie C:/w/T-0001/src/a.ts" },
      { type: "tool", text: "Écrit C:\\w\\T-0001\\src\\c.ts" },
      { type: "text", text: "Modifie src/x.ts" },
    ]);
    expect(touched).toEqual(["C:/w/T-0001/src/a.ts", "C:\\w\\T-0001\\src\\c.ts"]);
    const p = taskProgress({ status: "running", runs: [exec()], steps, touched, now: T0 + 60_000, typicalMs: null })!;
    // 2 étapes sur 3 qui nomment des fichiers : 10 + 2/3 × 0,95 × 70.
    expect(p).toEqual({ pct: 54, phase: "execute", label: "Étape 3 sur 3" });
  });

  it("sans fichiers au plan, le temps écoulé face à la durée habituelle fait avancer la barre, sans jamais finir", () => {
    expect(taskProgress({ status: "running", runs: [exec()], steps: null, touched: [], now: T0 + 5 * 60_000, typicalMs: 10 * 60_000 })).toEqual({
      pct: 42,
      phase: "execute",
      label: "Le développeur travaille",
    });
    expect(taskProgress({ status: "running", runs: [exec()], steps: null, touched: [], now: T0 + 60 * 60_000, typicalMs: 10 * 60_000 })!.pct).toBeLessThan(80);
  });

  it("les phases : plan, contrôles du hub, testeur, fusion ; rien pour un chantier fini ou en file", () => {
    expect(taskProgress({ status: "planning", runs: [], steps: null, touched: [], now: T0, typicalMs: null })!.phase).toBe("plan");
    expect(taskProgress({ status: "running", runs: [exec("done", at(9))], steps, touched: [], now: T0, typicalMs: null })).toMatchObject({ phase: "checks", pct: 84 });
    const verify = { kind: "verify", status: "running", started_at: at(10), finished_at: null };
    expect(taskProgress({ status: "running", runs: [exec("done", at(9)), verify], steps, touched: [], now: T0, typicalMs: null })).toMatchObject({ phase: "verify", pct: 90 });
    expect(taskProgress({ status: "review", runs: [], steps, touched: [], now: T0, typicalMs: null })).toMatchObject({ phase: "merge", pct: 97 });
    // Une retouche : l'ancienne vérification précède la nouvelle exécution, elle ne compte plus.
    const old = { kind: "verify", status: "done", started_at: at(-5), finished_at: at(-4) };
    expect(taskProgress({ status: "running", runs: [old, exec()], steps, touched: [], now: T0, typicalMs: null })!.phase).toBe("execute");
    for (const status of ["draft", "merged", "failed", "cancelled"]) expect(taskProgress({ status, runs: [], steps, touched: [], now: T0, typicalMs: null })).toBeNull();
  });

  it("médiane", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
  });
});
