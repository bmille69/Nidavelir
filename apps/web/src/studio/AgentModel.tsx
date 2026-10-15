import { useState } from "react";
import { api, type AgentId, type ModelRole, type StudioSnapshot } from "../api.ts";
import { useStudioRefresh } from "./context.tsx";

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(".", ",")} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n));

/**
 * Sous chaque agent du studio : son modèle (modifiable, avec celui que nous recommandons)
 * et ce qu'il a consommé (ADR-37). Le gardien n'a pas de modèle : il applique des règles fixes.
 */
export function AgentModel({ agent, snap }: { agent: AgentId; snap: StudioSnapshot }) {
  const refresh = useStudioRefresh();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (agent === "guardian") {
    return (
      <div className="agent-model">
        <p className="agent-usage">Aucun modèle : des règles fixes, sans consommation.</p>
      </div>
    );
  }
  const setting = snap.models?.roles.find((r) => r.role === agent);
  if (!setting) return null;
  const choices = snap.models.choices;
  const label = (id: string) => choices.find((c) => c.id === id)?.label ?? id;
  const use = snap.usage.agents?.[agent];
  const total = Object.values(snap.usage.agents ?? {}).reduce((n, a) => n + a.week.tokens, 0);
  const share = use && total ? Math.round((use.week.tokens / total) * 100) : 0;
  const recommended = setting.model === setting.recommended;

  async function change(model: string) {
    setBusy(true);
    setError(null);
    try {
      await api.setModel(agent as ModelRole, model);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="agent-model" onClick={(e) => e.stopPropagation()}>
      <div className="model-row">
        <label className="model-pick">
          Modèle
          <select value={setting.model} disabled={busy} onChange={(e) => void change(e.target.value)} aria-label={`Modèle de ${agent}`} title={setting.why}>
            {choices.map((c) => (
              <option key={c.id} value={c.id} title={c.note}>
                {c.label}
                {c.id === setting.recommended ? " ★ recommandé" : ""}
              </option>
            ))}
            {!choices.some((c) => c.id === setting.model) && <option value={setting.model}>{setting.model}</option>}
          </select>
        </label>
        {recommended ? (
          <span className="model-reco on" title={setting.why}>
            ★ Recommandé
          </span>
        ) : (
          <button className="model-reco" disabled={busy} onClick={() => void change(setting.recommended)} title={setting.why}>
            Conseillé : {label(setting.recommended)}
          </button>
        )}
      </div>
      <p className="model-why">{setting.why}</p>
      <p className="agent-usage" title={use ? `Équivalent indicatif au tarif de l'API : ${use.week.costUsd.toFixed(2).replace(".", ",")} $ sur 7 jours (inclus dans votre abonnement)` : undefined}>
        {use ? (
          <>
            Aujourd'hui <b>{fmtTokens(use.today.tokens)}</b> jetons · 7 jours <b>{fmtTokens(use.week.tokens)}</b>
            {share > 0 && <span className="usage-share"> · {share} % du studio</span>}
          </>
        ) : (
          "Aucune consommation ces 7 derniers jours."
        )}
      </p>
      {use && share > 0 && (
        <div className="usage-bar" aria-hidden="true">
          <i style={{ width: `${share}%` }} />
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
