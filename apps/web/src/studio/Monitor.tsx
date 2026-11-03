import { useEffect, useState } from "react";
import { api, type Monitor } from "../api.ts";
import { AGENTS } from "./agents.ts";
import { useNow, useStudio } from "./context.tsx";

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(".", ",")} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n));
const go = (bytes: number) => (bytes / 1024 ** 3).toFixed(1).replace(".", ",");
const hm = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

function inTime(iso: string, now: number): string {
  const ms = Math.max(0, Date.parse(iso) - now);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}

/** Une jauge horizontale, de vert à orange puis rouge. */
function Meter({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <span className="mon-meter" aria-hidden="true">
      <span className={v >= 85 ? "hot" : v >= 60 ? "warm" : ""} style={{ width: `${v}%` }} />
    </span>
  );
}

/**
 * Le moniteur (ADR-64), en tête des chantiers : la file (en cours, en pause et jusqu'à quand), qui travaille, la machine
 * (processeur, mémoire, carte graphique) et la consommation de la dernière heure. Interrogé toutes les 5 secondes.
 */
export function MonitorBar({ slug, team = true }: { slug?: string; team?: boolean }) {
  const snap = useStudio();
  const now = useNow(15_000);
  const [m, setM] = useState<Monitor | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.monitor().then((x) => alive && setM(x), () => {});
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!m) return null;
  const queues = slug ? m.queues.filter((q) => q.project === slug) : m.queues;
  const five = snap?.usage.limits?.windows.five_hour;
  const working = snap?.agents.filter((a) => a.id !== "you" && a.state === "working") ?? [];
  const max = Math.max(1, ...m.tokens.buckets.map((b) => b.tokens));
  const g = m.machine.gpu;
  return (
    <section className={`monitor ${queues.some((q) => q.paused) ? "paused" : ""}`} aria-label="Moniteur du studio">
      {queues.length === 0 && <div className="mon-queue muted">Aucun chantier en cours ni en file.</div>}
      {queues.map((q) => (
        <div key={q.project} className={`mon-queue ${q.paused ? "paused" : ""}`}>
          {q.paused ? (
            <>
              <b>⏸ File en pause</b> : jauge {q.paused.window === "five_hour" ? "des 5 h" : "de la semaine"}
              {five && q.paused.window === "five_hour" ? ` à ${Math.round(five.utilization * 100)} %` : ""}. Elle repart seule à {hm(q.paused.until)} (dans {inTime(q.paused.until, now)}).
              {q.running && <span className="muted"> En cours : {q.running.id} « {q.running.title} ».</span>}
            </>
          ) : q.running ? (
            <>
              <b>{q.running.status === "review" ? `⏳ ${q.running.id} attend votre mot` : q.running.status === "plan_review" ? `⏳ ${q.running.id} : plan à valider` : `▶ ${q.running.id} en cours`}</b> « {q.running.title} »
              {q.alongside?.map((a) => (
                <span key={a.id} className="mon-alongside">
                  {" "}· <b>⇉ {a.status === "review" ? `${a.id} attend votre mot` : `${a.id} en même temps`}</b> « {a.title} »
                </span>
              ))}
              {q.queued ? <span className="muted"> · {q.queued} en file derrière</span> : null}
            </>
          ) : (
            <>
              <b>{q.queued} en file</b>
              {q.next && <span className="muted"> · prochain : {q.next.id} « {q.next.title} »</span>}
            </>
          )}
          {!slug && <span className="muted small"> ({q.name})</span>}
        </div>
      ))}
      <div className="mon-tiles">
        {/* Dans le panneau d'activité du projet (ADR-113), « qui fait quoi » est juste au-dessus. */}
        {team && (
          <div className="mon-tile">
            <span className="mon-label">Au travail</span>
            <span className="mon-value small">{working.length ? working.map((a) => AGENTS[a.id].name).join(", ") : "personne"}</span>
          </div>
        )}
        <div className="mon-tile">
          <span className="mon-label">Processeur · mémoire</span>
          <span className="mon-value">
            {m.machine.cpu ?? "…"} % · {go(m.machine.ram.used)}/{go(m.machine.ram.total)} Go
          </span>
          <Meter value={m.machine.cpu ?? 0} />
        </div>
        {g && (
          <div className="mon-tile" title={g.name}>
            <span className="mon-label">Carte graphique</span>
            <span className="mon-value">
              {g.load} % · {go(g.memUsed * 1024 ** 2)}/{go(g.memTotal * 1024 ** 2)} Go
            </span>
            <Meter value={g.load} />
          </div>
        )}
        <div className="mon-tile" title="Jetons comptés à la fin de chaque appel ; équivalent en dollars, pris sur votre abonnement">
          <span className="mon-label">Jetons · 15 min</span>
          <span className="mon-value">
            {fmtTokens(m.tokens.last15.tokens)} · ≈ {m.tokens.last15.costUsd.toFixed(2).replace(".", ",")} $
          </span>
          <span className="mon-spark" aria-hidden="true">
            {m.tokens.buckets.map((b) => (
              <span key={b.at} style={{ height: `${Math.max(4, (100 * b.tokens) / max)}%` }} className={b.tokens ? "" : "empty"} />
            ))}
          </span>
        </div>
        {five && (
          <div className="mon-tile">
            <span className="mon-label">Jauge 5 h</span>
            <span className="mon-value">
              {Math.round(five.utilization * 100)} % · remise à zéro {hm(five.resetsAt)}
            </span>
            <Meter value={five.utilization * 100} />
          </div>
        )}
      </div>
    </section>
  );
}
