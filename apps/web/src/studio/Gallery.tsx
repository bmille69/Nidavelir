import { useEffect, useState } from "react";
import { api, type ArtAsset, type ArtState, type AssetStatus, type TaskRow } from "../api.ts";
import { STATUS } from "./ArtDirection.tsx";

type Filter = "tous" | "en_cours" | "valides" | "jeu" | "ecartes";
const FILTERS: { key: Filter; label: string; match: (s: AssetStatus) => boolean }[] = [
  { key: "tous", label: "Tous", match: () => true },
  { key: "en_cours", label: "En cours", match: (s) => s === "propose" || s === "production" || s === "a_valider" },
  { key: "valides", label: "Validés", match: (s) => s === "valide" || s === "integration" },
  { key: "jeu", label: "Dans le jeu", match: (s) => s === "integre" },
  { key: "ecartes", label: "Mis de côté", match: (s) => s === "ecarte" },
];

/** Toutes les images d'un asset, dans l'ordre de sa fabrication, avec une légende. */
export function assetImages(a: ArtAsset): { file: string; caption: string }[] {
  const out: { file: string; caption: string }[] = [];
  for (const s of a.sketches ?? []) if (s.file) out.push({ file: s.file, caption: `Croquis : ${s.label}` });
  for (const r of a.renders) out.push({ file: r, caption: "Image" });
  for (const v of a.model?.views ?? []) out.push({ file: v, caption: "Planche 4 vues" });
  for (const r of a.model?.renders ?? []) out.push({ file: r, caption: "Modèle 3D" });
  for (const b of a.model?.bandes ?? []) out.push({ file: b, caption: "Animation" });
  if (a.ingame?.file) out.push({ file: a.ingame.file, caption: "Dans le jeu" });
  return out;
}

const cover = (a: ArtAsset) => a.model?.renders[0] ?? a.renders.at(-1) ?? a.direction?.file ?? a.sketches?.find((s) => s.file)?.file ?? null;

/** La galerie des assets d'un projet : une grille filtrable, et un visualiseur pour feuilleter chaque asset (← →). */
export function Gallery({ slug, art, tasks }: { slug: string; art: ArtState; tasks: TaskRow[] }) {
  const [filter, setFilter] = useState<Filter>("tous");
  const [kind, setKind] = useState<"tout" | "3d" | "image">("tout");
  const [open, setOpen] = useState<string | null>(null);
  const match = FILTERS.find((f) => f.key === filter)!.match;
  const list = art.assets.filter((a) => match(a.status) && (kind === "tout" || (kind === "3d") === !!a.model3d));
  const asset = open ? art.assets.find((a) => a.id === open) ?? null : null;
  return (
    <section className="gallery" aria-label="Galerie des assets">
      <div className="gallery-tools">
        <div className="segmented small">
          {FILTERS.map((f) => (
            <button key={f.key} className={filter === f.key ? "on" : ""} onClick={() => setFilter(f.key)}>
              {f.label} <span className="muted">{art.assets.filter((a) => f.match(a.status)).length}</span>
            </button>
          ))}
        </div>
        <div className="segmented small">
          {(["tout", "3d", "image"] as const).map((k) => (
            <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {k === "tout" ? "Tout" : k === "3d" ? "3D" : "Images"}
            </button>
          ))}
        </div>
      </div>
      {list.length === 0 && <p className="pilot-empty">Aucun asset ici.</p>}
      <div className="gallery-grid">
        {list.map((a) => {
          const c = cover(a);
          return (
            <button key={a.id} className="gallery-card" onClick={() => setOpen(a.id)}>
              {c ? <img src={api.artFile(slug, c)} alt="" loading="lazy" /> : <span className="gallery-empty">{a.model3d ? "3D" : "—"}</span>}
              <span className="gallery-meta">
                <b>{a.name}</b>
                <span className={`status-pill s-${a.status}`}>{STATUS[a.status]}</span>
              </span>
            </button>
          );
        })}
      </div>
      {asset && <Viewer slug={slug} asset={asset} tasks={tasks} onClose={() => setOpen(null)} onMove={(d) => setOpen(list[(list.findIndex((x) => x.id === asset.id) + d + list.length) % list.length]?.id ?? null)} />}
    </section>
  );
}

function Viewer({ slug, asset, tasks, onClose, onMove }: { slug: string; asset: ArtAsset; tasks: TaskRow[]; onClose: () => void; onMove: (d: number) => void }) {
  const images = assetImages(asset);
  const [i, setI] = useState(Math.max(0, images.length - 1));
  const [busy, setBusy] = useState(false);
  useEffect(() => setI(Math.max(0, images.length - 1)), [asset.id, images.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
      else if (e.key === "ArrowRight") setI((x) => Math.min(images.length - 1, x + 1));
      else if (e.key === "ArrowUp") onMove(-1);
      else if (e.key === "ArrowDown") onMove(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [images.length, onClose, onMove]);
  const img = images[i];
  const linked = tasks.filter((t) => t.visuals?.some((v) => v.id === asset.id));
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    fn().finally(() => setBusy(false));
  };
  const verdict = asset.model?.verdict ?? asset.verdict;
  return (
    <div className="viewer" role="dialog" aria-label={asset.name}>
      <div className="viewer-backdrop" onClick={onClose} />
      <div className="viewer-box">
        <div className="viewer-stage">
          {img ? <img src={api.artFile(slug, img.file)} alt={img.caption} /> : <p className="muted">Pas encore d'image.</p>}
          {images.length > 1 && (
            <>
              <button className="viewer-nav prev" aria-label="Image précédente" disabled={i === 0} onClick={() => setI(i - 1)}>
                ‹
              </button>
              <button className="viewer-nav next" aria-label="Image suivante" disabled={i === images.length - 1} onClick={() => setI(i + 1)}>
                ›
              </button>
            </>
          )}
          {img && (
            <p className="viewer-caption">
              {img.caption} · {i + 1}/{images.length}
            </p>
          )}
        </div>
        <aside className="viewer-side">
          <button className="viewer-close" aria-label="Fermer" onClick={onClose}>
            ×
          </button>
          <p className="muted small">
            {asset.id} · {asset.type}
          </p>
          <h2>{asset.name}</h2>
          <span className={`status-pill s-${asset.status}`}>{STATUS[asset.status]}</span>
          {asset.usage && <p className="small">{asset.usage}</p>}
          {verdict && (
            <div className={`viewer-verdict ${verdict.ok ? "ok" : ""}`}>
              <b>{verdict.ok ? "Validé" : "Verdict"}</b> {verdict.summary}
            </div>
          )}
          {linked.length > 0 && (
            <div className="small">
              <p className="pilot-sub">Chantiers liés</p>
              {linked.map((t) => (
                <a key={t.id} className="viewer-link" href={`#/p/${slug}/tasks/${t.id}`}>
                  {t.id} {t.title}
                </a>
              ))}
            </div>
          )}
          {images.length > 1 && (
            <div className="viewer-thumbs">
              {images.map((m, k) => (
                <button key={m.file + k} className={k === i ? "on" : ""} onClick={() => setI(k)} title={m.caption}>
                  <img src={api.artFile(slug, m.file)} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
          <div className="viewer-actions">
            {(asset.status === "propose" || asset.status === "production") && (
              <button disabled={busy} onClick={() => act(() => api.artLaunch(slug, asset.id))}>
                Lancer maintenant
              </button>
            )}
            {asset.status !== "integre" && (
              <button className="secondary" disabled={busy} onClick={() => act(() => api.artAside(slug, asset.id, asset.status !== "ecarte"))}>
                {asset.status === "ecarte" ? "Remettre dans la file" : "Mettre de côté"}
              </button>
            )}
            <a className="secondary-link" href={`#/p/${slug}/art`}>
              Direction artistique
            </a>
          </div>
          <p className="muted small">← → images · ↑ ↓ assets · Échap fermer</p>
        </aside>
      </div>
    </div>
  );
}
