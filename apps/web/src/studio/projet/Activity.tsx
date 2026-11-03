import { useEffect, useRef, useState } from "react";
import { api, type Monitor } from "../../api.ts";
import { AgentAvatar } from "../AgentAvatar.tsx";
import { AGENTS } from "../agents.ts";
import { useStudio } from "../context.tsx";
import { Icon } from "../Icon.tsx";
import { MonitorBar } from "../Monitor.tsx";

const hm = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/**
 * La pastille d'activité de l'en-tête du projet (ADR-113) : « L'équipe travaille · n » ou « Équipe au repos ». Un clic
 * ouvre qui fait quoi sur ce jeu, puis la machine (le moniteur, ADR-64 : la file, processeur, carte graphique, jetons,
 * jauge 5 h). Elle remplace la bande d'équipe et la barre du moniteur, toujours visibles auparavant.
 */
export function ActivityPill({ slug }: { slug: string }) {
  const snap = useStudio();
  const [open, setOpen] = useState(false);
  const [paused, setPaused] = useState<Monitor["queues"][number]["paused"]>(null);
  const box = useRef<HTMLDivElement>(null);
  const team = (snap?.agents ?? [])
    .filter((a) => a.id !== "you")
    .map((a) => ({ ...a, acts: a.activities.filter((x) => x.project === slug) }))
    .filter((a) => a.acts.length > 0 && a.state !== "idle");

  // La file en pause (jauge d'abonnement) se voit sans ouvrir le panneau.
  useEffect(() => {
    let alive = true;
    const load = () => api.monitor().then((m) => alive && setPaused(m.queues.find((q) => q.project === slug)?.paused ?? null), () => {});
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slug]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const busy = team.length > 0;
  return (
    <div className="activity-box" ref={box}>
      <button className={`activity-pill ${busy ? "busy" : "idle"}${paused ? " paused" : ""}${open ? " open" : ""}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <span className="pulse" aria-hidden="true" />
        {paused ? (
          <span>File en pause · {hm(paused.until)}</span>
        ) : busy ? (
          <>
            <span className="lg">L'équipe travaille ·</span>
            <span className="sh">Équipe ·</span> <b className="n">{team.length}</b>
          </>
        ) : (
          <>
            <span className="lg">Équipe au repos</span>
            <span className="sh">Au repos</span>
          </>
        )}
        <Icon name="down" size={13} className="chev" />
      </button>
      {open && (
        <div className="activity-pop" role="dialog" aria-label="Activité de l'équipe">
          <p className="pop-h">{busy ? "Qui fait quoi" : "Personne ne travaille en ce moment"}</p>
          {busy ? (
            team.map((a) => (
              <a key={a.id} className="who-row" href={a.acts[0]!.href} onClick={() => setOpen(false)}>
                <AgentAvatar agent={a.id} state={a.state} size={26} />
                <span>
                  <b>{AGENTS[a.id].name}</b>
                  {a.acts.slice(0, 2).map((x, k) => (
                    <small key={k}>
                      {x.text}
                      {x.detail ? ` · ${x.detail}` : ""}
                    </small>
                  ))}
                </span>
              </a>
            ))
          ) : (
            <div className="who-row">
              <AgentAvatar agent="director" state="idle" size={26} />
              <span>
                <b>{AGENTS.director.name}</b>
                <small>Prêt : écrivez-lui dans la discussion.</small>
              </span>
            </div>
          )}
          <p className="pop-h">La machine</p>
          <MonitorBar slug={slug} team={false} />
          <div className="pop-links">
            <a href="#/pilotage" onClick={() => setOpen(false)}>
              Ouvrir le pilotage
            </a>
            <a href={`#/forge/${slug}`} onClick={() => setOpen(false)}>
              La Forge
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
