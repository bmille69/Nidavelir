import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Item, type Lineage, type TaskRow } from "../api.ts";
import { Icon } from "../studio/Icon.tsx";
import { KeyImage, useKeyImages } from "../studio/KeyImage.tsx";
import { formatDate, STATUS_LABEL, TYPE_LABEL } from "./labels.ts";
import { ImplementButton } from "./TasksView.tsx";
import { DelegatedDigest } from "../studio/Autonomy.tsx";
import { useStudio } from "../studio/context.tsx";

export function VisionView({ slug }: { slug: string }) {
  const [canon, setCanon] = useState<Item[]>([]);
  const [past, setPast] = useState<Item[]>([]);
  const [rev, setRev] = useState(0);
  const [why, setWhy] = useState<Lineage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [built, setBuilt] = useState<TaskRow[]>([]);
  const [state, setState] = useState<{ text: string | null; updated_at: string | null; task?: string | null } | null>(null);
  const [done, setDone] = useState<{ id: string; title: string; summary: string | null; at: string }[]>([]);
  const [jargon, setJargon] = useState(false);
  const project = useStudio()?.projects.find((p) => p.slug === slug);
  const auto = (project?.autonomy ?? "supervised") !== "supervised";
  const keyImages = useKeyImages(slug, "vision");

  const refresh = useCallback(async () => {
    const [c, all] = await Promise.all([api.items(slug, "canon"), api.items(slug, "all")]);
    setCanon(c.items);
    setRev(c.vision_rev);
    setBuilt((await api.tasks(slug)).filter((t) => t.status === "merged").sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1)));
    // Un hub plus ancien ne connaît pas encore le carnet : on ne l'affiche pas, sans erreur.
    setState(await api.gameState(slug).catch(() => null));
    setPast(all.items.filter((i) => i.type === "decision" && (i.status === "superseded" || i.status === "abandoned")));
    // Les comptes rendus en clair des chantiers fusionnés, par le Récap (ADR-113) ; un hub plus ancien : les titres suffisent.
    const recap = await api.recap(slug).catch(() => null);
    if (recap)
      setDone(
        recap.weeks
          .flatMap((w) => w.tasks)
          .filter((c) => c.status === "merged")
          .sort((x, y) => (y.merged_at ?? y.at).localeCompare(x.merged_at ?? x.at))
          .map((c) => ({ id: c.id, title: c.title, summary: c.summary, at: c.merged_at ?? c.at })),
      );
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
  // Le pitch : la vision notée dans la bible, sinon le premier point de « L'essentiel ».
  const vision = canon.find((i) => i.type === "vision");
  const essential = groupByTheme(decisions).find(([t]) => t === "L'essentiel")?.[1][0];
  const pitch = vision?.statement ?? essential?.decision?.summary ?? essential?.statement ?? null;
  const sections = state?.text ? parseGameState(state.text) : [];
  // Réalisé récemment (ADR-113) : ce que le Développeur a dit en clair à la fin de chaque chantier fusionné, pas sa consigne.
  const recent = done.length ? done.slice(0, 8) : built.slice(0, 8).map((t) => ({ id: t.id, title: t.title, summary: null, at: t.updated_at }));

  return (
    <main className="vision-layout">
      <section className="page wide bible jeu-page">
        <h1 className="sr-only">Le jeu</h1>
        <header className="jeu-hero">
          <KeyImage urls={keyImages} className="jeu-hero-shot" fallback={<span className="jeu-hero-shot ph" />} />
          <div className="jeu-hero-b">
            <span className="eyebrow">La bible, en clair</span>
            <h2>{project?.name ?? slug}</h2>
            <p>{pitch ?? "Ce qui existe dans le jeu, ce qui est décidé et ce qui a été réalisé, tenu à jour par le directeur après chaque chantier."}</p>
            <div className="facts-chips">
              {decisions.length > 0 && (
                <span className="fact">
                  <b>{decisions.length}</b> point{decisions.length > 1 ? "s" : ""} dans la bible
                </span>
              )}
              <span className="fact">
                <b>{built.length}</b> chantier{built.length > 1 ? "s" : ""} fusionné{built.length > 1 ? "s" : ""}
              </span>
              {technical.length > 0 && (
                <span className="fact">
                  <b>{technical.length}</b> règle{technical.length > 1 ? "s" : ""} du code
                </span>
              )}
            </div>
          </div>
        </header>
        {error && <p className="error">{error}</p>}
        {/* Hors « Je valide tout », c'est ici, en tête, qu'on revient sur ce que le directeur a tranché seul (ADR-113). */}
        {auto && <DelegatedDigest slug={slug} onChange={() => refresh().catch((e: Error) => setError(e.message))} />}

        {(sections.length > 0 || recent.length > 0) && (
          <div className={`jeu-two${sections.length && recent.length ? "" : " solo"}`}>
            <div className="jeu-state">
              {sections.length > 0 && (
                <>
                  <div className="sec-h">
                    <h3>État du jeu</h3>
                    {state?.updated_at && (
                      <small>
                        mis à jour le {formatDate(state.updated_at)}
                        {state.task ? ` après ${state.task}` : ""}
                      </small>
                    )}
                    <span className="sp" />
                    <button className={`recap-chip${jargon ? " on" : ""}`} aria-pressed={jargon} onClick={() => setJargon(!jargon)} title="Noms de fichiers, réglages et coordonnées">
                      Termes techniques : {jargon ? "visibles" : "atténués"}
                    </button>
                  </div>
                  <p className="muted small jeu-state-why">Ce que le directeur et le développeur savent du jeu avant chaque discussion et chaque chantier. Réécrit tout seul après chaque chantier fusionné.</p>
                  <div className={`game-state${jargon ? " jargon-on" : ""}`}>
                    {sections.map((s, si) => (
                      <div key={s.head} className="gs-block">
                        <h4>
                          {PLAIN_HEAD[s.head] ?? s.head}
                          <span className="rc-pill grey nodot">{s.items.length}</span>
                        </h4>
                        <div className="gs-list">
                          {s.items.map((it, i) =>
                            it.title ? (
                              <details key={i} className="gs" open={si === 0 && i === 0}>
                                <summary>
                                  <b>{rich(it.title)}</b>
                                  <span>{plain(it.body || it.sub[0] || "")}</span>
                                </summary>
                                <div className="gs-body">
                                  {it.body && <p>{rich(it.body)}</p>}
                                  {it.sub.length > 0 && (
                                    <ul>
                                      {it.sub.map((x, k) => (
                                        <li key={k}>{rich(x)}</li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              </details>
                            ) : (
                              <p key={i} className="gs-line">
                                {rich(it.body)}
                              </p>
                            ),
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            {recent.length > 0 && (
              <aside className="jeu-recent">
                <div className="sec-h">
                  <h3>Réalisé récemment</h3>
                  <span className="sp" />
                  <a className="rail-link accent" href={`#/p/${slug}/recap`}>
                    Récap <Icon name="arrow" size={13} />
                  </a>
                </div>
                <ol className="tl">
                  {recent.map((t) => (
                    <li key={t.id}>
                      <a href={`#/p/${slug}/tasks/${t.id}`}>
                        <small>
                          {formatDate(t.at)} · {t.id}
                        </small>
                        <b>{t.title}</b>
                        {t.summary && <p>{t.summary}</p>}
                      </a>
                    </li>
                  ))}
                </ol>
              </aside>
            )}
          </div>
        )}

        <div className="page-head jeu-bible-h">
          <div>
            <h2>Ce qui est décidé</h2>
            <p className="muted small">
              Tout ce qui est décidé, par vous ou par le directeur : c'est la seule référence que l'équipe suit. Pour changer un point, dites-le simplement au
              directeur.{" "}
              <a href={`#/p/${slug}/decisions`}>Toutes les décisions →</a>
            </p>
          </div>
          {decisions.length > 6 && <input className="bible-search" placeholder="Chercher dans la bible…" value={query} onChange={(e) => setQuery(e.target.value)} />}
        </div>
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

/** Les rubriques du carnet « État du jeu », en clair (ADR-113). */
const PLAIN_HEAD: Record<string, string> = {
  "Ce qui existe": "Ce qui existe dans le jeu",
  "Choix déjà faits": "Règles déjà actées",
  "Limites connues et reste à faire": "Ce qui reste à faire ou à vérifier",
};

type GsItem = { title: string | null; body: string; sub: string[] };

/**
 * Le carnet est du Markdown simple (titres « ## », lignes « **Sujet** : … », listes « - ») : découpé en rubriques et en
 * sujets repliables, sans bibliothèque. Un sujet sans texte sur sa ligne regroupe les lignes « - » qui le suivent.
 */
export function parseGameState(text: string): { head: string; items: GsItem[] }[] {
  return text
    .split(/^#{1,4} /m)
    .filter((sec) => sec.trim())
    .map((sec) => {
      const [first, ...lines] = sec.split("\n");
      // Un carnet sans titre de rubrique : tout va dans « État du jeu ».
      const titled = /^#{1,4} /m.test(text);
      const head = titled ? first!.trim() : "État du jeu";
      const items: (GsItem & { group: boolean })[] = [];
      for (const raw of titled ? lines : [first!, ...lines]) {
        const l = raw.trim();
        if (!l) continue;
        const sub = /^[-*] /.test(l);
        const body = sub ? l.slice(2) : l;
        const m = /^\*\*(.+?)\*\*\s*:?\s*(.*)$/.exec(body);
        const last = items.at(-1);
        if (sub && last?.group) last.sub.push(body);
        else if (m) items.push({ title: m[1]!.replace(/\s*\(`[^`]+`\)/, ""), body: m[2]!, sub: [], group: !m[2] });
        else items.push({ title: null, body, sub: [], group: false });
      }
      return { head, items };
    });
}

/** Le jargon (noms de fichiers, réglages, coordonnées) en petit et atténué ; le gras du carnet en gras. */
function rich(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\(\d+\s?,\s?\d+\))/).map((part, k) => {
    if (/^`[^`]+`$/.test(part)) return <code key={k} className="j">{part.slice(1, -1)}</code>;
    if (/^\*\*[^*]+\*\*$/.test(part)) return <b key={k}>{part.slice(2, -2)}</b>;
    if (/^\(\d+\s?,\s?\d+\)$/.test(part)) return <code key={k} className="j">{part}</code>;
    return part;
  });
}

/** L'aperçu d'un sujet replié : sans le jargon. */
const plain = (text: string) => text.replace(/`[^`]+`/g, "…").replace(/\*\*/g, "").replace(/\(\d+\s?,\s?\d+\)/g, "");
