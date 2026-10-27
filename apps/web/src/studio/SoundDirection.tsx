import { useCallback, useEffect, useState } from "react";
import { api, type Sound, type SoundState } from "../api.ts";

const STATUS: Record<Sound["status"], string> = {
  propose: "proposé",
  a_choisir: "à écouter",
  choisi: "choisi",
  en_integration: "en cours d'intégration",
  integre: "dans le jeu, joué",
  non_branche: "copié, jamais joué",
};
const KIND: Record<Sound["kind"], string> = { effet: "Effet", interface: "Interface", ambiance: "Ambiance", musique: "Musique" };

/**
 * Le directeur sonore (ADR-91) : il propose une liste de sons, vous écoutez des essais ElevenLabs et choisissez, puis
 * un chantier les branche dans le jeu ; après la fusion, le hub vérifie que chacun est vraiment joué.
 */
export function SoundDirection({ slug }: { slug: string }) {
  const [state, setState] = useState<SoundState | null>(null);
  const [request, setRequest] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const busy = !!state && (state.busy.proposing || state.busy.generating.length > 0);
  const load = useCallback(() => api.sound(slug).then(setState, (e: Error) => setError(e.message)), [slug]);
  useEffect(() => {
    void load();
    const t = setInterval(load, busy ? 2000 : 15_000);
    return () => clearInterval(t);
  }, [load, busy]);
  const act = async (run: () => Promise<unknown>) => {
    setError(null);
    try {
      await run();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!state) return error ? <p className="error">{error}</p> : <p className="muted">Chargement…</p>;
  const chosen = state.sounds.filter((s) => s.status === "choisi" || s.status === "non_branche");
  return (
    <section className="balance sound" aria-label="Son">
      {!state.configured ? (
        <div className="sound-key">
          <p className="small">
            Le directeur sonore génère effets et musiques avec ElevenLabs. Collez votre clé (page « API Keys » de votre compte) : elle reste sur ce PC, dans
            les données du hub.
          </p>
          <span className="bilan-actions">
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk_…" aria-label="Clé ElevenLabs" autoComplete="off" />
            <button className="small" disabled={key.trim().length < 10} onClick={() => act(async () => (await api.soundKey(key), setKey("")))}>
              Enregistrer la clé
            </button>
          </span>
        </div>
      ) : (
        state.credits && (
          <p className="muted small">
            ElevenLabs ({state.credits.tier}) : {state.credits.used.toLocaleString("fr-FR")} crédits utilisés sur {state.credits.limit.toLocaleString("fr-FR")}
            {state.credits.resetsAt ? `, remise à zéro le ${new Date(state.credits.resetsAt).toLocaleDateString("fr-FR")}` : ""}. Chaque essai coûte des crédits : rien
            n'est généré sans votre clic.
          </p>
        )
      )}
      <div className="balance-send">
        <textarea
          className="small"
          rows={2}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          placeholder="Votre demande au directeur sonore (vide : les sons essentiels du jeu). Ex. : « les tirs des tourelles et une musique de saloon néon, tendue »"
        />
        <button className="secondary" disabled={state.busy.proposing} onClick={() => act(() => api.soundPropose(slug, request))}>
          {state.busy.proposing ? "Le directeur sonore réfléchit…" : "Demander des sons"}
        </button>
      </div>
      {(error || state.error) && <p className="error small">{error ?? state.error}</p>}
      {info && <p className="muted small">{info}</p>}
      {chosen.length > 0 && (
        <span className="bilan-actions">
          <button
            onClick={() =>
              act(async () => {
                const r = await api.soundIntegrate(slug);
                setInfo(r.after ? `${r.task.id} attend son tour (après ${r.after}).` : `${r.task.id} lancé : le développeur branche les sons.`);
              })
            }
          >
            Intégrer {chosen.length} son(s) dans le jeu
          </button>
        </span>
      )}
      <div className="sound-list">
        {state.sounds.map((s) => (
          <SoundCard key={s.id} slug={slug} s={s} configured={state.configured} generating={state.busy.generating.includes(s.id)} act={act} />
        ))}
      </div>
    </section>
  );
}

function SoundCard({ slug, s, configured, generating, act }: { slug: string; s: Sound; configured: boolean; generating: boolean; act: (run: () => Promise<unknown>) => Promise<void> }) {
  const [prompt, setPrompt] = useState(s.prompt);
  const locked = s.status === "en_integration" || s.status === "integre" || s.status === "non_branche";
  return (
    <article className={`sim-card sound-card ${s.status}`}>
      <header>
        <span>
          <b>{s.name}</b> <span className="muted small">{s.id} · {KIND[s.kind]}{s.seconds ? ` · ${String(s.seconds).replace(".", ",")} s` : ""}{s.loop ? " · en boucle" : ""}</span>
        </span>
        <span className={`small sound-status ${s.status}`}>
          {STATUS[s.status]}
          {s.task ? ` (${s.task})` : ""}
        </span>
      </header>
      <p className="small">{s.usage}</p>
      {s.note && <p className="small warn">{s.note}</p>}
      {!locked && (
        <textarea className="small mono" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} onBlur={() => prompt !== s.prompt && act(() => api.soundEdit(slug, s.id, { prompt }))} aria-label="Description pour le générateur" />
      )}
      {s.takes.length > 0 && (
        <div className="sound-takes">
          {s.takes.map((t, k) => (
            <div key={t.file} className={`sound-take ${s.chosen === t.file ? "on" : ""}`}>
              <span className="small">Essai {k + 1}{t.credits !== null ? ` · ${t.credits} crédits` : ""}</span>
              <audio controls preload="none" src={api.soundTake(slug, t.file)} />
              {!locked && (
                <button className="small secondary" disabled={s.chosen === t.file} onClick={() => act(() => api.soundChoose(slug, s.id, t.file))}>
                  {s.chosen === t.file ? "Choisi" : "Choisir"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {!locked && (
        <span className="bilan-actions">
          <button className="small" disabled={!configured || generating} onClick={() => act(() => api.soundGenerate(slug, s.id, 2))}>
            {generating ? "Génération…" : s.takes.length ? "Deux essais de plus" : "Générer deux essais"}
          </button>
          <button className="small link" onClick={() => act(() => api.soundRemove(slug, s.id))}>
            Retirer
          </button>
        </span>
      )}
    </article>
  );
}
