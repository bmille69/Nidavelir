import { useEffect, useRef, useState } from "react";
import { navigate } from "../App.tsx";
import { api, type Mod, type ModGame } from "../api.ts";
import { Icon } from "./Icon.tsx";

const STATUS: Record<Mod["status"], string> = { planning: "Plan en cours", waiting: "Plan à valider", running: "En fabrication", ready: "Prêt", failed: "Échec", cancelled: "Arrêté" };
const KIND: Record<string, string> = { regles: "Règles et équilibrage", confort: "Confort", apparence: "Apparence" };

/** L'outillage d'un jeu pris en charge, en étapes : chargeur, premier lancement, carte des types. */
function Toolchain({ game, onChange }: { game: ModGame; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const t = game.toolchain;
  const r = game.recipe!;
  if (!t) return null;
  const act = (fn: () => Promise<unknown>) => fn().then(onChange, (e: Error) => setError(e.message));
  const steps = [
    {
      done: t.dotnet.installed,
      label: ".NET sur votre PC",
      detail: t.dotnet.installed ? `SDK ${t.dotnet.version}` : "Le SDK .NET n'est pas installé : demandez-moi de vous guider.",
    },
    {
      done: t.loader.installed,
      label: `${r.loader.name} dans le jeu`,
      detail: t.loader.installed ? `${r.loader.version}, installé` : `Le chargeur de mods de la communauté (${r.loader.size}, page officielle GitHub). Retirable d'un clic.`,
      action: !t.loader.installed && (
        <button className="small" disabled={t.loader.installing} onClick={() => void act(() => api.modLoaderInstall(game.appid))}>
          <Icon name="download" size={14} /> {t.loader.installing ? "Installation…" : `Installer ${r.loader.name}`}
        </button>
      ),
      error: t.loader.error,
    },
    {
      done: t.loader.generated,
      label: "Premier lancement du jeu",
      detail: t.loader.generated ? "Le jeu est préparé pour les mods." : r.loader.firstRun,
    },
    {
      done: t.typemap.ready,
      label: "Carte des types",
      detail: t.typemap.ready ? `${t.typemap.types ?? "?"} types du jeu, consultables par le développeur` : "La liste des noms du jeu (types, méthodes), pour que le développeur sache où brancher ses changements.",
      action: !t.typemap.ready && t.loader.generated && (
        <button className="small" disabled={t.typemap.building} onClick={() => void act(() => api.modTypemap(game.appid))}>
          <Icon name="book" size={14} /> {t.typemap.building ? "Préparation…" : "Préparer la carte"}
        </button>
      ),
      error: t.typemap.error,
    },
  ];
  const next = steps.findIndex((s) => !s.done);
  return (
    <ol className="mod-steps">
      {steps.map((s, k) => (
        <li key={s.label} className={s.done ? "done" : k === next ? "now" : ""}>
          <span className="dot">{s.done ? <Icon name="check" size={14} /> : k + 1}</span>
          <div className="grow">
            <b>{s.label}</b>
            <p className="small muted">{s.detail}</p>
            {s.error && <p className="error small">{s.error}</p>}
            {k === next && s.action}
          </div>
        </li>
      ))}
      {error && <li className="error small">{error}</li>}
    </ol>
  );
}

/** Le studio de modding (ADR-65) : vos jeux Steam, leur outillage, vos mods. */
export function ModsHome() {
  const [games, setGames] = useState<ModGame[] | null>(null);
  const [mods, setMods] = useState<Mod[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [others, setOthers] = useState(false);

  const load = () =>
    Promise.all([api.modGames(), api.mods()]).then(
      ([g, m]) => {
        setGames(g);
        setMods(m.mods);
        setRunning(m.running);
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, []);

  const supported = games?.filter((g) => g.recipe && !g.protection) ?? [];
  const game = supported.find((g) => g.appid === pick) ?? supported[0] ?? null;
  const ready = !!game?.toolchain && game.toolchain.dotnet.installed && game.toolchain.loader.generated && game.toolchain.typemap.ready;

  async function create() {
    if (!game) return;
    setBusy(true);
    setError(null);
    try {
      const m = await api.modCreate(game.appid, idea.trim());
      navigate({ page: "mod", id: m.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="studio-page mods">
      <header className="studio-hero">
        <div>
          <p className="eyebrow">
            <Icon name="puzzle" size={14} /> Studio de modding
          </p>
          <h1>Vos idées, dans vos jeux.</h1>
          <p className="hero-sub">Décrivez un mod en français : le studio en fait un plan, l'écrit, le construit et l'installe sur votre clic. Après une partie, il lit le journal du jeu et le corrige. Désinstaller remet le jeu comme avant.</p>
        </div>
      </header>

      {games === null && <p className="muted">Recherche de vos jeux Steam…</p>}
      {games && supported.length === 0 && <p className="muted">Aucun jeu pris en charge trouvé dans vos bibliothèques Steam. Pour l'instant, le studio sait modder : Vampire Survivors.</p>}

      {supported.length > 0 && (
        <div className="mod-games">
          {supported.map((g) => (
            <button key={g.appid} className={`mod-game ${game?.appid === g.appid ? "on" : ""}`} onClick={() => setPick(g.appid)}>
              <Icon name="puzzle" size={18} />
              <span>
                <b>{g.name}</b>
                <small className="muted">{g.dir}</small>
              </span>
            </button>
          ))}
        </div>
      )}

      {game && (
        <section className="panel-card mod-game-card">
          <h2>{game.name}</h2>
          {game.recipe!.warnings.map((w) => (
            <p key={w} className="small mod-warning">
              ⚠ {w}
            </p>
          ))}
          <Toolchain game={game} onChange={() => void load()} />
          <div className="express-form">
            <textarea value={idea} onChange={(e) => setIdea(e.target.value)} rows={3} placeholder={`Votre idée de mod pour ${game.name}… (ex. : le Fouet fait 30 % de dégâts en plus)`} aria-label="Idée de mod" />
            <div className="row">
              <button disabled={busy || idea.trim().length < 3 || !!running} onClick={() => void create()}>
                <Icon name="sparkle" size={16} /> {busy ? "…" : "Faire le plan du mod"}
              </button>
              {!ready && <span className="small muted">Le plan peut se faire tout de suite ; la fabrication attend que l'outillage soit prêt.</span>}
            </div>
            {running && (
              <p className="small">
                <span className="live-dot" /> Un mod est en travail : <a href={`#/mods/${running}`}>le suivre</a>.
              </p>
            )}
            {error && <p className="error small">{error}</p>}
          </div>
        </section>
      )}

      {mods.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Vos mods</h2>
          </div>
          <div className="mod-list">
            {mods.map((m) => (
              <a key={m.id} href={`#/mods/${m.id}`} className={`mod-tile st-${m.status}`}>
                <strong>{m.title}</strong>
                <span className="muted small">{m.game}</span>
                <span className="row">
                  <span className={`pill mod-status st-${m.status}`}>{STATUS[m.status]}</span>
                  {m.installed && <span className="pill mod-status st-installed">Installé</span>}
                  {m.outdated && <span className="pill mod-status st-failed">Jeu mis à jour</span>}
                </span>
              </a>
            ))}
          </div>
        </section>
      )}

      {games && games.some((g) => !g.recipe || g.protection) && (
        <section>
          <button className="link small" onClick={() => setOthers((o) => !o)}>
            {others ? "Masquer" : "Voir"} vos autres jeux ({games.filter((g) => !g.recipe || g.protection).length})
          </button>
          {others && (
            <ul className="small muted mod-others">
              {games
                .filter((g) => !g.recipe || g.protection)
                .map((g) => (
                  <li key={g.appid}>
                    {g.name} — {g.protection ? `protégé (${g.protection}) : jamais modé` : "pas encore de recette"}
                  </li>
                ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}

/** L'image comme en jeu : le fond magenta devient transparent, comme le fera le mod au chargement. */
function Keyed({ src, alt }: { src: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < d.data.length; i += 4) if (d.data[i]! > 216 && d.data[i + 1]! < 64 && d.data[i + 2]! > 216) d.data[i + 3] = 0;
      ctx.putImageData(d, 0, 0);
      if (alive) setUrl(c.toDataURL("image/png"));
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return url ? <img src={url} alt={alt} /> : <span className="muted small">…</span>;
}

/** Un sprite du mod : agrandi au pixel près, avec « Redessiner » (et une précision facultative). */
function Sprite({ mod, visual, drawn, disabled, onDone, onError }: { mod: Mod; visual: { file: string; description: string; size: number }; drawn: boolean; disabled: boolean; onDone: () => void; onError: (m: string) => void }) {
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  async function redraw() {
    setBusy(true);
    try {
      await api.modRedraw(mod.id, visual.file, hint);
      setHint("");
      onDone();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <figure className="mod-sprite">
      <div className="mod-sprite-img">{drawn ? <Keyed src={api.modAsset(mod.id, visual.file, mod.updated_at)} alt={visual.description} /> : <span className="muted small">pas encore dessiné</span>}</div>
      <figcaption className="small">
        <b>{visual.file}</b> <span className="muted">· {visual.size}×{visual.size}</span>
        <br />
        <span className="muted">{visual.description}</span>
      </figcaption>
      {mod.root && (
        <div className="row">
          <input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="Précision (facultatif)" aria-label={`Précision pour ${visual.file}`} />
          <button className="secondary small" disabled={disabled || busy} onClick={() => void redraw()}>
            {busy ? "…" : drawn ? "Redessiner" : "Dessiner"}
          </button>
        </div>
      )}
    </figure>
  );
}

/** Un mod : son plan, sa fabrication en direct, puis Installer / J'ai joué / Améliorer / Désinstaller. */
export function ModView({ id }: { id: string }) {
  const [m, setM] = useState<Mod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const feed = useRef<HTMLOListElement>(null);

  const load = () => api.modGet(id).then(setM, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, [id]);
  const working = m?.status === "running" || m?.status === "planning";
  useEffect(() => {
    const t = setInterval(() => void load(), working ? 1500 : 6000);
    return () => clearInterval(t);
  }, [working, id]);
  const last = m?.events.at(-1)?.seq ?? 0;
  useEffect(() => {
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last]);

  async function act(fn: () => Promise<unknown>, clear = false) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (clear) setText("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!m) return <main className="studio-page muted">{error ?? "Chargement…"}</main>;
  const p = m.plan;
  return (
    <main className="studio-page mod-view">
      <header className="express-head">
        <div className="grow">
          <p className="eyebrow">
            <a href="#/mods">
              <Icon name="puzzle" size={14} /> Studio de modding
            </a>{" "}
            · {m.game}
          </p>
          <h1>{m.title}</h1>
          <p className="muted">{m.idea}</p>
        </div>
        <span className={`pill mod-status st-${m.status}`}>{STATUS[m.status]}</span>
      </header>

      {m.outdated && (
        <p className="mod-warning">
          ⚠ {m.game} a été mis à jour depuis la construction de ce mod : il peut ne plus marcher.{" "}
          <button className="small" disabled={busy || working} onClick={() => void act(() => api.modRebuild(m.id))}>
            Reconstruire
          </button>
        </p>
      )}

      <div className="mod-layout">
        <div className="mod-main">
          {p && (
            <section className="panel-card">
              <p className="eyebrow">{KIND[p.kind] ?? "Mod"}</p>
              <p>{p.summary}</p>
              <ul>
                {p.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              {p.settings.length > 0 && (
                <>
                  <p className="small">
                    <b>Réglages</b> (modifiables sans reconstruire) :
                  </p>
                  <ul className="small">
                    {p.settings.map((s) => (
                      <li key={s.name}>
                        <b>{s.name}</b> ({s.default}) : {s.description}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {p.questions.length > 0 && (
                <div className="mod-questions">
                  {p.questions.map((q) => (
                    <p key={q}>❓ {q}</p>
                  ))}
                </div>
              )}
              {p.risks.length > 0 && <p className="small muted">À savoir : {p.risks.join(" ")}</p>}
            </section>
          )}

          {p?.visuals && p.visuals.length > 0 && (
            <section className="panel-card">
              <p className="eyebrow">Visuels du mod</p>
              <div className="mod-sprites">
                {p.visuals.map((v) => (
                  <Sprite key={v.file} mod={m} visual={v} drawn={!!m.assets?.includes(v.file)} disabled={busy || working} onDone={() => void load()} onError={setError} />
                ))}
              </div>
            </section>
          )}

          {m.report && m.status === "ready" && (
            <section className="panel-card">
              <p>
                <b>Pour le voir en jeu :</b> {m.report.how_to_test}
              </p>
              <p className="small muted">{m.report.summary}</p>
              {m.report.known_issues.length > 0 && <p className="small muted">Limites : {m.report.known_issues.join(" ; ")}</p>}
            </section>
          )}

          {m.played && (
            <section className="panel-card">
              <p className="small">
                <b>Dernière partie :</b>{" "}
                {!m.played.found ? "pas de journal trouvé." : m.played.errors.length ? `${m.played.errors.length} erreur(s) du mod.` : m.played.loaded ? "le mod a été chargé, sans erreur." : "le mod n'a pas été chargé."}
                {m.played.gameVersion && <span className="muted"> · version du jeu {m.played.gameVersion}</span>}
              </p>
              {m.played.lines.length > 0 && <pre className="mod-log">{m.played.lines.slice(-8).join("\n")}</pre>}
            </section>
          )}

          {m.error && !working && <p className="error">{m.error}</p>}
          {error && <p className="error">{error}</p>}

          <section className="mod-actions">
            {working && (
              <button className="secondary" onClick={() => void act(() => api.modCancel(m.id))}>
                Arrêter
              </button>
            )}
            {m.status === "waiting" && (
              <>
                <button disabled={busy} onClick={() => void act(() => api.modGo(m.id))}>
                  <Icon name="play" size={16} /> Fabriquer
                </button>
                <div className="express-improve">
                  <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Ou dites ce qu'il faut changer dans le plan…" />
                  <button className="secondary" disabled={busy || text.trim().length < 2} onClick={() => void act(() => api.modReply(m.id, text), true)}>
                    Revoir le plan
                  </button>
                </div>
              </>
            )}
            {m.status === "ready" && !m.installed && (
              <button disabled={busy || m.outdated} onClick={() => void act(() => api.modInstall(m.id))}>
                <Icon name="download" size={16} /> Installer dans le jeu
              </button>
            )}
            {m.installed && !working && (
              <>
                <div className="express-improve">
                  <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Après une partie : ce que vous avez remarqué (facultatif)…" />
                  <button disabled={busy} onClick={() => void act(() => api.modPlayed(m.id, text), true)}>
                    <Icon name="check" size={16} /> J'ai joué
                  </button>
                </div>
                <button className="secondary" disabled={busy} onClick={() => void act(() => api.modUninstall(m.id))}>
                  Désinstaller
                </button>
              </>
            )}
            {(m.status === "ready" || m.status === "failed") && !m.installed && m.root && (
              <div className="express-improve">
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Améliorer : ce que vous voulez changer…" />
                <button className="secondary" disabled={busy || text.trim().length < 3} onClick={() => void act(() => api.modImprove(m.id, text), true)}>
                  Améliorer
                </button>
              </div>
            )}
            {!working && !m.installed && (
              <button
                className="link small"
                onClick={() =>
                  void act(async () => {
                    await api.modHide(m.id);
                    navigate({ page: "mods" });
                  })
                }
              >
                Retirer de la liste
              </button>
            )}
          </section>
        </div>

        <ol className="express-feed mod-feed" ref={feed} aria-live="polite">
          {m.events.map((e) => (
            <li key={e.seq} className={`ev-${e.kind}`}>
              {e.kind === "tool" ? <code>{e.text}</code> : e.text}
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}
