import { useEffect, useState } from "react";
import { api, type Preview } from "../api.ts";

/** Bouton « ▶ Essayer » : lance le jeu (version du chantier, ou le jeu lui-même) et l'ouvre dans un onglet. */
export function TryButton({ slug, task, label, small }: { slug: string; task?: string; label?: string; small?: boolean }) {
  const [state, setState] = useState<"idle" | "starting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<Preview | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api.previews(slug).then((ps) => alive && setRunning(ps.find((p) => p.task === (task ?? null)) ?? null), () => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slug, task]);

  // Le hub ouvre le jeu dans Edge (sur l'ordinateur) ; sinon, un onglet ici en secours.
  async function start() {
    setState("starting");
    setError(null);
    try {
      const p = await api.startPreview(slug, task);
      setRunning(p);
      if (!p.opened && !p.desktop) window.open(p.url, "_blank");
      setState("idle");
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  }

  async function stop() {
    await api.stopPreview(slug);
    setRunning(null);
  }

  return (
    <span className="try">
      {running ? (
        <>
          {running.desktop ? (
            <span className="try-open small">▶ Le jeu est ouvert sur le PC</span>
          ) : (
            <button className="link try-open" onClick={start}>
              ▶ Le jeu tourne : ouvrir
            </button>
          )}
          <button className={`link ${small ? "small" : ""}`} onClick={stop}>
            arrêter
          </button>
        </>
      ) : (
        <button className={`try-btn ${small ? "small" : ""}`} disabled={state === "starting"} onClick={start}>
          {state === "starting" ? "Lancement du jeu…" : (label ?? "▶ Essayer")}
        </button>
      )}
      {error && <span className="error small try-error">{error}</span>}
    </span>
  );
}
