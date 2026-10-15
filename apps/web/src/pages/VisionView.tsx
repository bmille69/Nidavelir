import { useCallback, useEffect, useState } from "react";
import { api, type Item, type Lineage, type TaskRow } from "../api.ts";
import { formatDate, STATUS_LABEL, TYPE_LABEL } from "./labels.ts";
import { ImplementButton } from "./TasksView.tsx";

export function VisionView({ slug }: { slug: string }) {
  const [canon, setCanon] = useState<Item[]>([]);
  const [past, setPast] = useState<Item[]>([]);
  const [rev, setRev] = useState(0);
  const [why, setWhy] = useState<Lineage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [built, setBuilt] = useState<TaskRow[]>([]);
  const [state, setState] = useState<{ text: string | null; updated_at: string | null } | null>(null);

  const refresh = useCallback(async () => {
    const [c, all] = await Promise.all([api.items(slug, "canon"), api.items(slug, "all")]);
    setCanon(c.items);
    setRev(c.vision_rev);
    setBuilt((await api.tasks(slug)).filter((t) => t.status === "merged").sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1)));
    // Un hub plus ancien ne connaît pas encore le carnet : on ne l'affiche pas, sans erreur.
    setState(await api.gameState(slug).catch(() => null));
    setPast(all.items.filter((i) => i.type === "decision" && (i.status === "superseded" || i.status === "abandoned")));
  }, [slug]);

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

  async function showWhy(id: string) {
    try {
      setWhy(await api.why(slug, id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function abandon(l: Lineage) {
    if (!window.confirm(`Abandonner la décision ${l.item.id} « ${l.item.title} » ? Elle restera dans l'historique, mais ne fera plus partie de la vision.`)) return;
    try {
      await api.abandon(slug, l.item.id, l.hash);
      setWhy(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const allDecisions = canon.filter((i) => i.type === "decision");
  const decisions = allDecisions.filter((d) => d.nature !== "technical");
  const technical = allDecisions.filter((d) => d.nature === "technical");
  const q = query.trim().toLowerCase();
  const shown = q ? decisions.filter((d) => `${d.title} ${d.statement} ${d.decision?.summary ?? ""}`.toLowerCase().includes(q)) : decisions;
  const themes = groupByTheme(shown);

  return (
    <main className="vision-layout">
      <section className="page wide bible">
        <div className="page-head">
          <div>
            <h1>Le jeu</h1>
            <p className="muted small">
              La bible du jeu : tout ce qui est décidé, par vous ou par le directeur. C'est la seule référence que l'équipe suit. Pour changer un
              point, dites-le simplement au directeur.
            </p>
          </div>
          {decisions.length > 6 && <input className="bible-search" placeholder="Chercher dans la bible…" value={query} onChange={(e) => setQuery(e.target.value)} />}
        </div>
        {error && <p className="error">{error}</p>}
        {state?.text && (
          <section className="theme">
            <h2 className="theme-title">État du jeu</h2>
            <p className="muted small">
              Ce que le directeur et le développeur savent du jeu avant chaque discussion et chaque chantier. Réécrit tout seul après chaque chantier fusionné
              {state.updated_at ? ` (dernière mise à jour le ${formatDate(state.updated_at)})` : ""}.
            </p>
            <article className="entry game-state">{renderNotes(state.text)}</article>
          </section>
        )}
        {built.length > 0 && (
          <section className="theme">
            <h2 className="theme-title">Réalisé dans le jeu</h2>
            {built.slice(0, 10).map((t) => (
              <article key={t.id} className="entry">
                <h3>
                  <a href={`#/p/${slug}/tasks/${t.id}`}>{t.title}</a>
                </h3>
                <p className="entry-text small">{t.goal.split("\n")[0]}</p>
                <span className="muted small">fusionné le {formatDate(t.updated_at)}</span>
              </article>
            ))}
          </section>
        )}
        {allDecisions.length === 0 && built.length === 0 && <p className="muted">Rien pour l'instant : parlez de votre jeu au directeur, puis dites « go ».</p>}
        {themes.length > 1 && (
          <nav className="toc">
            {themes.map(([theme, list]) => (
              <a key={theme} href={`#theme-${slugTheme(theme)}`} onClick={(e) => {
                e.preventDefault();
                document.getElementById(`theme-${slugTheme(theme)}`)?.scrollIntoView({ behavior: "smooth" });
              }}>
                {theme} <span className="muted">{list.length}</span>
              </a>
            ))}
          </nav>
        )}
        {themes.map(([theme, list]) => (
          <section key={theme} id={`theme-${slugTheme(theme)}`} className="theme">
            <h2 className="theme-title">{theme}</h2>
            <div className="decisions">
              {list.map((d) => (
                <article key={d.id} className={`entry decision ${why?.item.id === d.id ? "focus" : ""}`}>
                  <h3>{d.title}</h3>
                  <p className="entry-text">{d.decision?.summary ?? d.statement}</p>
                  {d.decision?.summary && (
                    <details>
                      <summary className="small">Détail</summary>
                      <p className="statement small">{d.statement}</p>
                    </details>
                  )}
                  <div className="entry-actions">
                    <span className="muted small">{d.validated_by?.kind === "delegated" ? "décidé par le directeur" : "décidé par vous"}</span>
                    <button className="link small" onClick={() => showWhy(d.id)}>
                      Pourquoi ?
                    </button>
                    <ImplementButton slug={slug} decision={d.id} />
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
        {q && shown.length === 0 && <p className="muted">Rien ne correspond à « {query} ».</p>}

        {technical.length > 0 && (
          <details className="card technical-section">
            <summary>
              <strong>Règles du code ({technical.length})</strong>
              <span className="muted small"> — l'état actuel du code, dont vous avez pris acte.</span>
            </summary>
            <ul className="history">
              {technical.map((d) => (
                <li key={d.id}>
                  <button className="link" onClick={() => showWhy(d.id)}>
                    {d.id} — {d.title}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}

        {past.length > 0 && (
          <details className="card">
            <summary>Historique : {past.length} point(s) remplacé(s) ou retiré(s)</summary>
            <ul className="history">
              {past.map((d) => (
                <li key={d.id}>
                  <button className="link" onClick={() => showWhy(d.id)}>
                    {d.id} — {d.title}
                  </button>{" "}
                  <span className="muted small">
                    {STATUS_LABEL[d.status]}
                    {d.decision?.superseded_by ? ` par ${d.decision.superseded_by}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {why && (
        <aside className="panel why">
          <div className="row">
            <h2 className="grow">Pourquoi {why.item.id} ?</h2>
            <button className="link" onClick={() => setWhy(null)}>
              Fermer
            </button>
          </div>
          <p>
            <strong>{why.item.title}</strong>
            <span className="muted small"> · {STATUS_LABEL[why.item.status] ?? why.item.status}</span>
          </p>
          <p className="small">{why.item.statement}</p>
          {why.item.validated_by && (
            <p className="muted small">
              {why.item.validated_by.kind === "delegated" ? "Décidée par le directeur, dans le cadre de l'autonomie que vous lui avez donnée," : "Validée par vous"} le{" "}
              {formatDate(why.item.validated_by.at)} (accord {why.item.validated_by.approval}).
            </p>
          )}
          {why.supersededBy && (
            <p className="notice small">
              Remplacée depuis par {why.supersededBy.id} « {why.supersededBy.title} ».
            </p>
          )}
          {why.ancestors.length > 0 && (
            <>
              <h3>D'où elle vient</h3>
              <ul className="sources">
                {why.ancestors.map((a) => (
                  <li key={a.id}>
                    <div>
                      <span className={`badge type-${a.type}`}>{TYPE_LABEL[a.type] ?? a.type}</span> {a.id} · {a.title}
                      <span className="muted small"> ({STATUS_LABEL[a.status] ?? a.status})</span>
                    </div>
                    {a.source.quote && (
                      <blockquote>
                        « {a.source.quote} »<cite>{a.source.kind === "file" ? a.source.ref : "vous, en discussion"}</cite>
                      </blockquote>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {why.item.type === "decision" && why.item.status === "validated" && (
            <button className="secondary danger small" onClick={() => abandon(why)}>
              Retirer de la bible
            </button>
          )}
        </aside>
      )}
    </main>
  );
}

const THEMES: Record<string, string> = {
  vision: "L'essentiel",
  gameplay: "Gameplay",
  combat: "Combat",
  armes: "Armes",
  arme: "Armes",
  tir: "Armes",
  ennemis: "Ennemis",
  ennemi: "Ennemis",
  boss: "Ennemis",
  progression: "Progression",
  butin: "Butin",
  loot: "Butin",
  narration: "Histoire",
  histoire: "Histoire",
  art: "Direction artistique",
  visuel: "Direction artistique",
  rendu: "Rendu et effets",
  effets: "Rendu et effets",
  vfx: "Rendu et effets",
  audio: "Son",
  son: "Son",
  ui: "Interface",
  interface: "Interface",
  rythme: "Rythme",
  économie: "Économie",
  technique: "Technique",
  "éléments": "Combat",
  build: "Combat",
  soins: "Combat",
  "capacités": "Personnage et capacités",
  mouvement: "Personnage et capacités",
  super: "Personnage et capacités",
  classes: "Personnage et capacités",
  missions: "Missions",
  mission: "Missions",
  spawn: "Ennemis",
  "légal": "Cadre du projet",
  architecture: "Technique",
  workflow: "Technique",
  "méthode": "Technique",
  "données": "Technique",
  performance: "Technique",
};

function themeOf(d: Item): string {
  for (const dom of d.domain) {
    const key = dom.toLowerCase();
    if (THEMES[key]) return THEMES[key];
  }
  const first = d.domain[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "Divers";
}

/** Regroupe les points de la bible par thème, « L'essentiel » d'abord, puis par taille. */
function groupByTheme(list: Item[]): [string, Item[]][] {
  const map = new Map<string, Item[]>();
  for (const d of list) {
    const t = themeOf(d);
    map.set(t, [...(map.get(t) ?? []), d]);
  }
  return [...map.entries()].sort((a, b) => (a[0] === "L'essentiel" ? -1 : b[0] === "L'essentiel" ? 1 : b[1].length - a[1].length));
}

const slugTheme = (t: string) => t.normalize("NFD").replace(/[^a-zA-Z]+/g, "-").toLowerCase();

/** Le carnet est du Markdown simple : titres « ## » et listes « - », rendus sans bibliothèque. */
function renderNotes(text: string) {
  return text.split("\n").map((line, k) => {
    const t = line.trim();
    if (!t) return null;
    if (/^#{1,4} /.test(t)) return <h3 key={k}>{t.replace(/^#+ /, "")}</h3>;
    if (/^[-*] /.test(t)) return <p key={k} className="entry-text small game-state-item">• {t.slice(2).replace(/\*\*/g, "")}</p>;
    return <p key={k} className="entry-text small">{t.replace(/\*\*/g, "")}</p>;
  });
}
