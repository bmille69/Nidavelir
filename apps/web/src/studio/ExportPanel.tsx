import { useCallback, useEffect, useState } from "react";
import { api, type ExportState } from "../api.ts";

const mb = (b: number) => `${(b / 1_048_576).toFixed(0)} Mo`;
const when = (iso: string) => new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * L'export local d'un jeu Godot (ADR-90) : un .exe autonome dans build/ du jeu, essayé sans fenêtre par le hub.
 * Jamais d'envoi : le fichier reste sur ce PC, à vous d'en faire ce que vous voulez.
 */
export function ExportPanel({ slug }: { slug: string }) {
  const [state, setState] = useState<ExportState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = !!state && (state.running || !!state.installing);
  const load = useCallback(() => api.exportState(slug).then(setState, (e: Error) => setError(e.message)), [slug]);
  useEffect(() => {
    void load();
    const t = setInterval(load, busy ? 1500 : 15_000);
    return () => clearInterval(t);
  }, [load, busy]);
  if (!state || !state.available) return null;
  const act = (run: () => Promise<ExportState | { ok: boolean }>) =>
    run().then(
      (s) => ("builds" in s ? setState(s) : load()),
      (e: Error) => setError(e.message),
    );
  return (
    <div className="pilot-export">
      <p className="pilot-sub">Export Windows</p>
      {!state.templates ? (
        state.installing ? (
          <>
            <p className="small">{state.installing.step}…</p>
            <div className="progress">
              <span style={{ width: `${Math.round(state.installing.progress * 100)}%` }} />
            </div>
          </>
        ) : (
          <>
            <p className="muted small">Godot {state.godot} a besoin de ses modèles d'export Windows : environ 70 Mo, lus dans l'archive officielle de Godot.</p>
            <button className="small secondary" onClick={() => act(() => api.exportTemplates(slug))}>
              Installer les modèles d'export
            </button>
          </>
        )
      ) : (
        <button className="small" disabled={state.running} onClick={() => act(() => api.exportStart(slug))}>
          {state.running ? "Export en cours…" : "Exporter le jeu (.exe)"}
        </button>
      )}
      {(error || state.error) && <p className="error small">{error ?? state.error}</p>}
      {state.builds.map((b) => (
        <article key={b.id} className="pilot-row">
          <span className={`dot ${b.smoke.ok ? "ok" : "ko"}`} />
          <div className="pilot-row-body">
            <span className="pilot-row-title">{b.exe}</span>
            <span className="muted small">
              {when(b.at)} · {mb(b.bytes)} · version {b.commit?.slice(0, 7) ?? "?"} · {b.smoke.detail}
            </span>
          </div>
          <button className="small link" onClick={() => act(() => api.exportReveal(slug, b.id))}>
            Ouvrir le dossier
          </button>
        </article>
      ))}
    </div>
  );
}
