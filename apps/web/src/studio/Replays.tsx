import { useCallback, useEffect, useState } from "react";
import { api, type Recording, type SavedReplay } from "../api.ts";

/**
 * Vos parties (ADR-85) : chaque « ▶ Essayer » d'un jeu Godot enregistre ce que vous jouez. Une partie qui montre quelque
 * chose d'important (un bug, une règle) devient un test : elle est rejouée à l'identique avant chaque fusion.
 */
export function Replays({ slug }: { slug: string }) {
  const [data, setData] = useState<{ recordings: Recording[]; saved: SavedReplay[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.replays(slug).then(setData, () => {}), [slug]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);
  if (!data || (!data.recordings.length && !data.saved.length)) return null;

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
      setOpen(null);
      setName("");
      setNote("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const when = (at: string) => (at ? at.replace("T", " ").slice(5, 16) : "");

  return (
    <section className="replays">
      <h3>Vos parties</h3>
      {error && <p className="error small">{error}</p>}
      {data.recordings.length > 0 && (
        <ul className="replay-list">
          {data.recordings.slice(0, 6).map((r) => (
            <li key={r.id}>
              <span className="small">
                {when(r.at)} · {r.seconds} s · {r.inputs} action(s){r.task ? ` · version ${r.task}` : ""}
              </span>
              {open === r.id ? (
                <span className="replay-form">
                  <input className="small" placeholder="Nom (ex. « la tourelle tire après la vague 2 »)" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                  <input className="small" placeholder="Ce qu'elle vérifie (facultatif)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
                  <button className="small" disabled={!!busy || !name.trim()} onClick={() => act(r.id, () => api.saveRecording(slug, r.id, name, note))}>
                    {busy === r.id ? "Je la rejoue deux fois…" : "Garder comme test"}
                  </button>
                  <button className="link small" onClick={() => setOpen(null)}>
                    annuler
                  </button>
                </span>
              ) : (
                <span className="row">
                  <button className="secondary small" disabled={!r.checkpoints} title={r.checkpoints ? "Elle sera rejouée à l'identique avant chaque fusion" : "Le jeu n'expose pas son état (nœud « studio_test » avec snapshot()) : rien à comparer"} onClick={() => setOpen(r.id)}>
                    En faire un test
                  </button>
                  <button className="link small" disabled={!!busy} onClick={() => act(`x-${r.id}`, () => api.deleteRecording(slug, r.id))}>
                    oublier
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {data.saved.length > 0 && (
        <>
          <p className="muted small">Rejouées avant chaque fusion :</p>
          <ul className="replay-list">
            {data.saved.map((s) => (
              <li key={s.file}>
                <span className="small" title={s.note || undefined}>
                  ▶ {s.name} · {s.seconds} s
                </span>
                <button className="link small" disabled={!!busy} onClick={() => act(`d-${s.file}`, () => api.deleteReplay(slug, s.file))}>
                  retirer
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
