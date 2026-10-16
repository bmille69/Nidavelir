import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Autonomy, type Item } from "../api.ts";
import { formatDate } from "../pages/labels.ts";
import { useStudioRefresh } from "./context.tsx";

export const AUTONOMY: Record<Autonomy, { label: string; short: string; explain: string[] }> = {
  workshop: {
    label: "Atelier",
    short: "Vous parlez, le directeur fait coder, le testeur valide, c'est fusionné.",
    explain: [
      "Le directeur, chef de projet, connaît votre code et propose des solutions concrètes.",
      "Quand vous dites « go », il rédige la consigne et le Développeur se met au travail. Un chantier à la fois : les suivants attendent leur tour.",
      "Si le testeur valide, c'est fusionné dans votre jeu tout seul. Sinon le développeur corrige une fois, puis le chantier attend votre mot dans la discussion (« fusionne », « corrige… », « laisse tomber »).",
      "« Bosse en autonomie 2 h » : il fait son plan de séance, enchaîne les chantiers et vous fait le bilan à la fin.",
    ],
  },
  supervised: {
    label: "Je valide tout",
    short: "Vous validez chaque proposition.",
    explain: [
      "Le directeur reformule et vous pose des questions.",
      "Chaque proposition attend votre validation.",
      "Chaque plan du développeur attend votre accord.",
    ],
  },
  balanced: {
    label: "Équilibré",
    short: "Le directeur décide de ce qui ne fait pas débat.",
    explain: [
      "Le directeur propose des solutions concrètes, sans demander de confirmation.",
      "Il décide seul de ce qui ne fait pas débat. Vous pouvez revenir dessus en un clic.",
      "Il vous demande seulement en cas de conflit avec une décision existante, ou s'il y a plusieurs bonnes façons de faire.",
      "Les plans du développeur attendent votre accord.",
    ],
  },
  autonomous: {
    label: "Autonome",
    short: "Le directeur tranche aussi les conflits simples.",
    explain: [
      "Comme « Équilibré », et le directeur remplace aussi une ancienne décision quand c'est clair.",
      "Il valide et lance lui-même les plans sans risque : rien de supprimé, aucune bibliothèque ajoutée, aucune question.",
      "Vous gardez toujours le dernier mot : rien n'entre dans votre jeu sans votre clic « Fusionner ».",
    ],
  },
};

/** Sélecteur du niveau d'autonomie, dans l'en-tête de chaque projet. */
export function AutonomyPicker({ slug, level }: { slug: string; level: Autonomy }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useStudioRefresh();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function choose(next: Autonomy) {
    if (next === level) return setOpen(false);
    setBusy(true);
    setError(null);
    try {
      await api.setAutonomy(slug, next);
      refresh();
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="autonomy" ref={box}>
      <button className={`autonomy-btn level-${level}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Niveau d'autonomie du directeur">
        <span className="gauge" aria-hidden="true">
          <i className="on" />
          <i className={level !== "supervised" ? "on" : ""} />
          <i className={level === "autonomous" || level === "workshop" ? "on" : ""} />
        </span>
        <span className="autonomy-prefix">Autonomie : </span>
        {AUTONOMY[level].label}
      </button>
      {open && (
        <div className="autonomy-menu" role="dialog" aria-label="Niveau d'autonomie">
          <p className="muted small">Jusqu'où le directeur peut-il décider seul sur ce projet ?</p>
          {(["workshop", "supervised", ...(level === "balanced" || level === "autonomous" ? [level] : [])] as Autonomy[]).map((k) => (
            <button key={k} className={`autonomy-option ${k === level ? "current" : ""}`} disabled={busy} onClick={() => choose(k)}>
              <strong>
                {AUTONOMY[k].label}
                {k === "workshop" && <span className="badge">recommandé</span>}
                {k === level && <span className="badge">actuel</span>}
              </strong>
              <ul>
                {AUTONOMY[k].explain.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </button>
          ))}
          {error && <p className="error small">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** Ce que le directeur a décidé seul, avec la possibilité de revenir dessus. */
export function DelegatedDigest({ slug }: { slug: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { items } = await api.items(slug, "canon");
    setItems(
      items
        .filter((i) => i.type === "decision" && i.validated_by?.kind === "delegated")
        .sort((a, b) => (b.validated_by!.at > a.validated_by!.at ? 1 : -1)),
    );
  }, [slug]);
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
    const t = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [load]);

  async function undo(d: Item) {
    if (!window.confirm(`Revenir sur « ${d.title} » ? La décision sera retirée de la vision (elle reste dans l'historique).`)) return;
    try {
      const why = await api.why(slug, d.id);
      await api.abandon(slug, d.id, why.hash);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 5);
  return (
    <section className="card delegated">
      <div className="proposal-head">
        <h2 className="grow">Décidé par le directeur</h2>
        <span className="muted small">{items.length} décision(s) prise(s) seul</span>
      </div>
      <p className="muted small">Ce qui ne faisait pas débat. Tout est dans la vision ; vous pouvez revenir sur chaque point.</p>
      <ul className="delegated-list">
        {shown.map((d) => (
          <li key={d.id}>
            <div className="grow">
              <strong>{d.title}</strong>
              <p className="small">{d.decision?.summary ?? d.statement}</p>
              <span className="muted small">
                {d.id} · {formatDate(d.validated_by?.at)}
                {d.decision?.supersedes.length ? ` · remplace ${d.decision.supersedes.join(", ")}` : ""}
              </span>
            </div>
            <button className="secondary small" onClick={() => undo(d)}>
              Revenir dessus
            </button>
          </li>
        ))}
      </ul>
      {items.length > 5 && (
        <button className="link small" onClick={() => setAll((a) => !a)}>
          {all ? "Afficher moins" : `Afficher les ${items.length - 5} autres`}
        </button>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
