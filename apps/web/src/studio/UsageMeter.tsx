import { useState } from "react";
import { api } from "../api.ts";
import { useNow, useStudio, useStudioRefresh } from "./context.tsx";

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(".", ",")} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n));

function resetIn(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return "réinitialisée";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  if (h >= 24) return `réinit. ${new Date(iso).toLocaleDateString("fr-FR", { weekday: "short" })} ${new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  return `réinit. dans ${h ? `${h} h ` : ""}${m} min`;
}

/** Vos limites d'abonnement Claude (telles que Claude Code les rapporte) et les jetons utilisés par le hub. */
export function UsageMeter() {
  const snap = useStudio();
  const refresh = useStudioRefresh();
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  const usage = snap?.usage;
  if (!usage) return null;
  const { limits } = usage;
  const stale = !limits || now - Date.parse(limits.at) > 30 * 60_000;

  async function update() {
    setBusy(true);
    try {
      await api.refreshUsage();
      refresh();
    } finally {
      setBusy(false);
    }
  }

  const bar = (label: string, w?: { utilization: number; resetsAt: string }) =>
    w && (
      <div className="meter">
        <div className="meter-head">
          <span>{label}</span>
          <b className={w.utilization >= 0.9 ? "hot" : w.utilization >= 0.7 ? "warm" : ""}>{Math.round(w.utilization * 100)} %</b>
        </div>
        <div className="meter-track">
          <div className={`meter-fill ${w.utilization >= 0.9 ? "hot" : w.utilization >= 0.7 ? "warm" : ""}`} style={{ width: `${Math.min(100, w.utilization * 100)}%` }} />
        </div>
        <span className="meter-foot">{resetIn(w.resetsAt, now)}</span>
      </div>
    );

  return (
    <div className="usage" title="Limites de votre abonnement Claude, telles que Claude Code les rapporte à chaque appel">
      <p className="side-title">Utilisation Claude</p>
      {limits ? (
        <>
          {bar("5 heures", limits.windows.five_hour)}
          {bar("Semaine", limits.windows.seven_day)}
        </>
      ) : (
        <p className="muted small">Limites inconnues pour l'instant.</p>
      )}
      <div className="usage-today">
        <span>
          Hub aujourd'hui : <b>{fmtTokens(usage.today.tokens)}</b> jetons · {usage.today.calls} appel(s)
        </span>
        {stale && (
          <button className="link small" disabled={busy} onClick={update}>
            {busy ? "Mise à jour…" : "Mettre à jour"}
          </button>
        )}
      </div>
    </div>
  );
}
