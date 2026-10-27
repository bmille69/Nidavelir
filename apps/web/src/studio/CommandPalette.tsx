import { useEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "./context.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { useMotion } from "./motion.tsx";

type Command = { id: string; label: string; hint?: string; icon: IconName; group: string; run: () => void };

const go = (hash: string) => () => {
  window.location.hash = hash;
};

/** Sans accents ni casse : « equilibrage » trouve « Équilibrage ». */
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * La palette de commandes (ADR-94) : Ctrl+K (ou /) ouvre une recherche qui mène partout, au clavier.
 * Aucune action nouvelle : seulement des chemins plus courts vers ce qui existe déjà.
 */
export function CommandPalette() {
  const snap = useStudio();
  const [motion, setMotion] = useMotion();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "/" && !typing && !open) {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("studio:palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("studio:palette", onOpen);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const c: Command[] = [
      { id: "home", label: "Accueil", icon: "home", group: "Aller à", run: go("#/") },
      { id: "pilot", label: "Pilotage", hint: "chantiers, visuels, galerie, son", icon: "chart", group: "Aller à", run: go("#/pilotage") },
      { id: "live", label: "Le studio en direct", icon: "live", group: "Aller à", run: go("#/direct") },
      { id: "quality", label: "Qualité", icon: "chart", group: "Aller à", run: go("#/qualite") },
      { id: "skills", label: "Compétences", icon: "puzzle", group: "Aller à", run: go("#/competences") },
      { id: "phone", label: "Téléphone", icon: "phone", group: "Aller à", run: go("#/telephone") },
    ];
    for (const p of snap?.projects ?? []) {
      c.push(
        { id: `p-${p.slug}`, label: p.name, hint: "discussion", icon: "chat", group: "Vos jeux", run: go(`#/p/${p.slug}`) },
        { id: `p-${p.slug}-tasks`, label: `${p.name} · Chantiers`, icon: "hammer", group: "Vos jeux", run: go(`#/p/${p.slug}/tasks`) },
        { id: `p-${p.slug}-vision`, label: `${p.name} · Le jeu`, icon: "book", group: "Vos jeux", run: go(`#/p/${p.slug}/vision`) },
        { id: `p-${p.slug}-art`, label: `${p.name} · Direction artistique`, icon: "palette", group: "Vos jeux", run: go(`#/p/${p.slug}/art`) },
      );
    }
    c.push(
      { id: "express", label: "Jeu express", icon: "bolt", group: "Créer", run: go("#/express") },
      { id: "concevoir", label: "Concevoir un nouveau jeu", icon: "sparkle", group: "Créer", run: go("#/concevoir") },
      { id: "import", label: "Importer un jeu", icon: "download", group: "Créer", run: go("#/import") },
      { id: "demontage", label: "Démonter un jeu", icon: "hammer", group: "Créer", run: go("#/demontage") },
      { id: "mods", label: "Modder un jeu", icon: "puzzle", group: "Créer", run: go("#/mods") },
      {
        id: "motion",
        label: motion === "reduced" ? "Rétablir les animations" : "Réduire les animations",
        icon: "motion",
        group: "Réglages",
        run: () => setMotion(motion === "reduced" ? "full" : "reduced"),
      },
    );
    return c;
  }, [snap?.projects, motion, setMotion]);

  const shown = useMemo(() => {
    const words = fold(q).split(/\s+/).filter(Boolean);
    return words.length ? commands.filter((c) => words.every((w) => fold(`${c.label} ${c.hint ?? ""} ${c.group}`).includes(w))) : commands;
  }, [q, commands]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-k="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;
  const run = (c: Command | undefined) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };
  let k = -1;
  const groups = [...new Set(shown.map((c) => c.group))];

  return (
    <div className="palette" role="dialog" aria-modal="true" aria-label="Palette de commandes" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette-box">
        <div className="palette-search">
          <Icon name="search" size={16} />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Aller à, ouvrir un jeu, créer…"
            aria-label="Rechercher une commande"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(shown.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(shown[sel]);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
          />
          <kbd>Échap</kbd>
        </div>
        <div className="palette-list" ref={list}>
          {shown.length === 0 && <p className="palette-empty">Rien ne correspond.</p>}
          {groups.map((g) => (
            <div key={g} className="palette-group">
              <p className="palette-title">{g}</p>
              {shown
                .filter((c) => c.group === g)
                .map((c) => {
                  k++;
                  const idx = k;
                  return (
                    <button key={c.id} data-k={idx} className={`palette-item ${idx === sel ? "on" : ""}`} onMouseMove={() => setSel(idx)} onClick={() => run(c)}>
                      <Icon name={c.icon} size={16} />
                      <span>{c.label}</span>
                      {c.hint && <small>{c.hint}</small>}
                      {idx === sel && <kbd>↵</kbd>}
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> naviguer
          </span>
          <span>
            <kbd>↵</kbd> ouvrir
          </span>
          <span>
            <kbd>Ctrl</kbd>
            <kbd>K</kbd> ouvrir ou fermer
          </span>
        </div>
      </div>
    </div>
  );
}
