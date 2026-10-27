import { useEffect, useState } from "react";
import { api, type QualityReport, type QualityStats, type RouteReport } from "../api.ts";
import { formatDate } from "../pages/labels.ts";
import { StatusBadge } from "../pages/TasksView.tsx";
import { useStudio } from "./context.tsx";
import { money } from "./Workshop.tsx";

const pct = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "—" : `${Math.round(v * 100)} %`);
const num = (v: number | null, digits = 1) => (v === null ? "—" : v.toFixed(digits).replace(".", ","));

/**
 * Tableau « Qualité » (ADR-27) : est-ce que le workflow marche ? Réussite, coût par résultat,
 * temps, vos interventions et votre avis, au global et semaine par semaine.
 */
export function QualityView() {
  const snap = useStudio();
  const [project, setProject] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<QualityReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReport(null);
    api.quality(project).then(setReport, (e: Error) => setError(e.message));
  }, [project]);

  const names = new Map((snap?.projects ?? []).map((p) => [p.slug, p.name]));
  const o = report?.overall;

  return (
    <main className="studio-page quality">
      <header className="studio-hero">
        <div>
          <h1>Qualité</h1>
          <p className="hero-sub">
            Est-ce que le studio travaille bien ? Ces chiffres se lisent sur la durée : après 10 à 20 chantiers, ils montrent où le travail coince.
          </p>
        </div>
        {(snap?.projects.length ?? 0) > 1 && (
          <div className="chips">
            <button className={`chip ${!project ? "on" : ""}`} onClick={() => setProject(undefined)}>
              Tous les projets
            </button>
            {snap!.projects.map((p) => (
              <button key={p.slug} className={`chip ${project === p.slug ? "on" : ""}`} onClick={() => setProject(p.slug)}>
                {p.name}
              </button>
            ))}
          </div>
        )}
      </header>

      {error && <p className="error">{error}</p>}
      {!report && !error && <p className="muted">Calcul…</p>}
      {o && o.launched === 0 && <p className="muted">Aucun chantier pour l'instant : dites « go » au directeur dans une discussion.</p>}

      {o && o.launched > 0 && (
        <>
          <section className="kpis">
            <Kpi
              label="Réussite"
              value={pct(o.success_rate)}
              hint={`${o.held} réussi(s) sur ${o.merged + o.abandoned} terminé(s)${o.reworked ? ` · ${o.reworked} à refaire ensuite` : ""}`}
              explain="Chantiers fusionnés qui ont tenu (ni repris par un autre chantier, ni annulés), parmi ceux qui sont terminés (fusionnés ou abandonnés)."
            />
            <Kpi label="Du premier coup" value={pct(o.first_try_rate)} hint={`${o.first_try} sans correction`} explain="Réussis sans aucune correction, ni du testeur ni de vous, et pas repris ensuite." />
            <Kpi
              label="Le jeu se lance"
              value={o.launch_checked ? pct(o.launch_ok / o.launch_checked) : "—"}
              hint={`${o.launch_checked} chantier(s) vérifié(s)`}
              explain="Avant chaque fusion, le hub ouvre le jeu dans un navigateur invisible et vérifie qu'il démarre sans erreur. Ce sont des faits, pas l'avis d'un agent."
            />
            <Kpi
              label="Tests du jeu"
              value={o.tests_checked ? pct(o.tests_ok / o.tests_checked) : "—"}
              hint={`${o.tests_checked} chantier(s) vérifié(s)`}
              explain="Avant chaque fusion, le hub lance lui-même les tests du jeu (npm test). Un chantier qui casse des tests qui passaient n'est pas fusionné."
            />
            <Kpi
              label="Fiabilité du testeur"
              value={pct(o.tester_rate)}
              hint={o.tester_judged ? `${o.tester_right} validation(s) sur ${o.tester_judged} ont tenu` : "pas encore assez de recul"}
              explain="Quand le testeur dit « c'est bon », est-ce que ça tient ? Raté si le hub trouve ensuite une régression, si le chantier doit être repris, ou s'il est annulé."
            />
            <Kpi label="Coût par chantier fusionné" value={o.cost_per_merged === null ? "—" : money(o.cost_per_merged)} hint={`${money(o.cost_usd)} au total`} explain="Équivalent API, pris sur votre abonnement. Compte aussi les chantiers abandonnés : c'est le vrai prix d'un résultat." />
            <Kpi label="Travail des agents" value={o.median_agent_minutes === null ? "—" : `${num(o.median_agent_minutes)} min`} hint="médiane par chantier" explain="Temps cumulé de travail du développeur et du testeur, pour un chantier typique." />
            <Kpi label="Vos interventions" value={num(o.interventions_per_chantier)} hint="par chantier" explain="Plans validés à la main, autorisations et corrections demandées. Plus c'est bas, plus le studio est autonome." />
            <Kpi label="Votre avis" value={`${o.up} 👍  ${o.down} 👎`} hint={o.up + o.down < o.merged ? `${o.merged - o.up - o.down} fusionné(s) sans avis` : "merci !"} explain="Le signal le plus important : un chantier peut être réussi techniquement sans être ce que vous vouliez." />
          </section>
          {o.qa_fail_rate !== null && o.qa_fail_rate > 0.3 && (
            <p className="notice small">
              ⚠ Le testeur trouve des problèmes dans {pct(o.qa_fail_rate)} des chantiers. Si ces problèmes ne sont pas réels, ses consignes sont à revoir ; s'ils le sont, les consignes du directeur
              manquent de précision.
            </p>
          )}
          {o.tester_rate !== null && o.tester_judged >= 5 && o.tester_rate < 0.8 && (
            <p className="notice small">
              ⚠ Le testeur valide trop facilement : {o.tester_judged - o.tester_right} de ses {o.tester_judged} validations n'ont pas tenu. Ses consignes sont à durcir.
            </p>
          )}

          <section className="panel-card">
            <h2>Semaine par semaine</h2>
            <div className="table-wrap">
              <table className="qtable">
                <thead>
                  <tr>
                    <th>Semaine</th>
                    <th>Lancés</th>
                    <th>Fusionnés</th>
                    <th>Réussite</th>
                    <th>Du premier coup</th>
                    <th>Coût / fusionné</th>
                    <th>Interventions</th>
                    <th>Avis</th>
                  </tr>
                </thead>
                <tbody>
                  {report.weeks.map((w) => (
                    <tr key={w.week}>
                      <td>{w.label}</td>
                      <td>{w.launched}</td>
                      <td>{w.merged}</td>
                      <td>
                        <Bar value={w.success_rate} />
                      </td>
                      <td>{pct(w.first_try_rate)}</td>
                      <td>{w.cost_per_merged === null ? "—" : money(w.cost_per_merged)}</td>
                      <td>{num(w.interventions_per_chantier)}</td>
                      <td>
                        {w.up} 👍 {w.down} 👎
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <RouteCompare project={project} />

          <section className="panel-card">
            <h2>Chantiers</h2>
            <div className="table-wrap">
              <table className="qtable">
                <thead>
                  <tr>
                    <th>Chantier</th>
                    <th>État</th>
                    <th>Corrections</th>
                    <th>Testeur</th>
                    <th>Vérifié par le hub</th>
                    <th>Agents</th>
                    <th>Coût</th>
                    <th>Avis</th>
                  </tr>
                </thead>
                <tbody>
                  {report.chantiers.map((c) => (
                    <tr key={`${c.project}/${c.id}`}>
                      <td>
                        <a href={`#/p/${c.project}/tasks/${c.id}`}>{c.title}</a>
                        <span className="muted small">
                          {" "}
                          · {!project && names.get(c.project) ? `${names.get(c.project)} · ` : ""}
                          {formatDate(c.created_at)}
                        </span>
                      </td>
                      <td>
                        <StatusBadge status={c.status} />
                        {c.reworked_by.length > 0 && <span className="muted small"> · repris par {c.reworked_by.join(", ")}</span>}
                        {c.reverted && <span className="muted small"> · annulé avec Git</span>}
                      </td>
                      <td>{c.corrections}</td>
                      <td>{c.qa === "fail" ? "⚠ problèmes" : c.qa ? "✓" : "—"}{c.tester_missed ? " (a laissé passer une régression)" : ""}</td>
                      <td>
                        {c.checks
                          ? [c.checks.tests !== "none" && `tests ${c.checks.tests === "pass" ? "✓" : "✗"}`, c.checks.launch !== "none" && `lancement ${c.checks.launch === "pass" ? "✓" : "✗"}`]
                              .filter(Boolean)
                              .join(" · ") || "—"
                          : "—"}
                      </td>
                      <td>{c.agent_minutes ? `${num(c.agent_minutes)} min` : "—"}</td>
                      <td>{c.cost_usd ? money(c.cost_usd) : "—"}</td>
                      <td title={c.rating?.note ?? undefined}>{c.rating ? (c.rating.rating === "up" ? "👍" : "👎") + (c.rating.note ? " …" : "") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

const tokens = (v: number | null) => (v === null ? "—" : v >= 1_000_000 ? `${num(v / 1_000_000, 2)} M` : `${Math.round(v / 1000)} k`);
const MODE = { off: "éteint", record: "mesure seule (le relais ne modifie rien)", compress: "compression" } as const;

/**
 * Ce que coûte vraiment le travail du Développeur, par chantier fusionné, et l'essai Caveman (ADR-92) :
 * les chantiers passés par le relais face à ceux restés en direct, avec les chiffres de Claude Code.
 */
function RouteCompare({ project }: { project?: string }) {
  const [data, setData] = useState<RouteReport | null>(null);
  useEffect(() => {
    setData(null);
    api.qualityRoutes(project).then(setData, () => setData(null));
  }, [project]);
  if (!data) return null;
  const c = data.caveman;
  const rows = data.routes.filter((r) => r.route === "direct" || (c && c.mode !== "off") || r.runs > 0);
  return (
    <section className="panel-card route-compare">
      <h2>Jetons du Développeur par chantier</h2>
      <p className="muted small">
        Chiffres réels rapportés par Claude Code à chaque passage
        {data.measuredSince ? `, mesurés depuis le ${formatDate(data.measuredSince)}` : " : la mesure commence avec le prochain chantier"}. Médiane par chantier fusionné. La relecture du
        cache compte peu dans vos limites : la colonne « hors cache » est la plus parlante.
      </p>
      <p className="small">
        Essai Caveman : <b>{c ? MODE[c.mode] : MODE.off}</b>
        {c && c.mode !== "off" && (
          <>
            {" "}
            · {Math.round(c.share * 100)} % des chantiers · relais {c.running ? "prêt" : "arrêté"}
            {c.lastError && <span className="error"> · {c.lastError}</span>}
          </>
        )}
        {(!c || c.mode === "off") && <span className="muted"> (STUDIO_CAVEMAN=record ou compress au lancement du hub)</span>}
      </p>
      <div className="table-wrap">
        <table className="qtable">
          <thead>
            <tr>
              <th>Chemin</th>
              <th>Chantiers fusionnés</th>
              <th>Jetons</th>
              <th>Hors cache</th>
              <th>Coût (équiv. API)</th>
              <th>Exécutions</th>
              <th>Vérifications</th>
              <th>Passages échoués</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.route}>
                <td>{r.route === "direct" ? "Direct" : "Par Caveman"}</td>
                <td>{r.chantiers}</td>
                <td>{tokens(r.tokensMedian)}</td>
                <td>{tokens(r.freshMedian)}</td>
                <td>{r.costMedian === null ? "—" : money(r.costMedian)}</td>
                <td>{num(r.executeRunsMean, 2)}</td>
                <td>{num(r.verifyRunsMean, 2)}</td>
                <td>{r.runs ? `${r.failedRuns} / ${r.runs}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {c && c.mode !== "off" && data.routes.some((r) => r.chantiers < 10) && (
        <p className="muted small">Comparaison à lire à partir d'une dizaine de chantiers fusionnés de chaque côté.</p>
      )}
    </section>
  );
}

function Kpi({ label, value, hint, explain }: { label: string; value: string; hint: string; explain: string }) {
  return (
    <div className="stat kpi" title={explain}>
      <span>{label}</span>
      <b>{value}</b>
      <span className="kpi-hint">{hint}</span>
    </div>
  );
}

/** Barre de pourcentage (une seule série : la couleur ne porte aucune autre information). */
function Bar({ value }: { value: QualityStats["success_rate"] }) {
  if (value === null) return <span className="muted">—</span>;
  return (
    <span className="pct-bar" title={pct(value)}>
      <span className="pct-track">
        <span className="pct-fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span>{pct(value)}</span>
    </span>
  );
}
