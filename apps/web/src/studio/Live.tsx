import { useState } from "react";
import { ago, describeEvent } from "./agents.ts";
import { useNow, useStudio } from "./context.tsx";
import { OrgChart } from "./OrgChart.tsx";
import { MonitorBar } from "./Monitor.tsx";

/**
 * Le studio en direct : la salle de contrôle. L'équipe sur son organigramme animé
 * (qui travaille, sur quoi, qui vous attend) et le journal qui défile.
 */
export function StudioLive() {
  const snap = useStudio();
  const now = useNow(1000);
  const [filter, setFilter] = useState<string | undefined>(undefined);

  if (!snap) return <main className="studio-page muted">Chargement du studio…</main>;
  const names = new Map(snap.projects.map((p) => [p.slug, p.name]));
  const working = snap.agents.filter((a) => a.id !== "you" && a.state !== "idle").length;
  const forYou = snap.agents.find((a) => a.id === "you")?.activities.length ?? 0;
  const events = snap.events.map((e) => ({ e, d: describeEvent(e) })).filter((x) => x.d);
  const clock = new Date(now).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <main className={`live-page ${working ? "is-working" : ""}`}>
      <div className="live-bg" aria-hidden="true">
        <div className="live-aurora" />
        <div className="live-grid" />
      </div>
      <div className="studio-page live-inner">
        <header className="live-hero">
          <div>
            <p className="eyebrow live-eyebrow">
              <span className="live-dot" /> En direct · <span className="live-clock">{clock}</span>
            </p>
            <h1>Le studio en direct</h1>
            <p className="hero-sub">
              {working === 0 && forYou === 0 && "Toute l'équipe est au repos. Lancez une discussion pour la mettre au travail."}
              {working > 0 && `${working} agent${working > 1 ? "s" : ""} au travail. `}
              {forYou > 0 && `${forYou} chose${forYou > 1 ? "s" : ""} vous attend${forYou > 1 ? "ent" : ""}.`}
            </p>
          </div>
          <div className="hero-stats">
            <Stat value={working} label="agent(s) actif(s)" accent={working > 0} />
            <Stat value={forYou} label="pour vous" warn={forYou > 0} />
            <Stat value={snap.projects.length} label="projet(s)" />
            <Stat value={snap.projects.reduce((n, p) => n + p.decisions, 0)} label="décision(s) validée(s)" />
          </div>
        </header>
        <MonitorBar />

        <section className="panel-card team stage">
          <div className="section-head">
            <div>
              <h2>L'équipe</h2>
              <p className="muted small">Qui fait quoi, en ce moment. Cliquez sur une activité pour l'ouvrir.</p>
            </div>
            {snap.projects.length > 1 && (
              <div className="chips">
                <button className={`chip ${!filter ? "on" : ""}`} onClick={() => setFilter(undefined)}>
                  Tous les projets
                </button>
                {snap.projects.map((p) => (
                  <button key={p.slug} className={`chip ${filter === p.slug ? "on" : ""}`} onClick={() => setFilter(p.slug)}>
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <OrgChart snap={snap} projectNames={names} filter={filter} />
        </section>

        <section className="panel-card feed terminal">
          <div className="section-head">
            <h2>Journal du studio</h2>
            <span className="muted small">{events.length} événement(s) récents</span>
          </div>
          {events.length === 0 && <p className="muted small">Rien pour l'instant. Les actions de l'équipe apparaîtront ici.</p>}
          <ol className="feed-list">
            {events.map(({ e, d }) => (
              <li key={e.seq} className={d!.tone ? `tone-${d!.tone}` : ""}>
                <span className={`feed-dot agent-${d!.agent}`} />
                <div>
                  <p>{d!.text}</p>
                  <span className="muted small">
                    {e.project ? (names.get(e.project) ?? e.project) : "Studio"} · {ago(e.at, now)}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}

function Stat({ value, label, accent, warn }: { value: number; label: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className={`stat ${accent ? "accent" : ""} ${warn ? "warn" : ""}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}
