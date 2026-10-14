import { useLayoutEffect, useRef, useState } from "react";
import type { AgentId, AgentState, StudioSnapshot } from "../api.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { AGENTS, STATE_LABEL, YOU_STATE_LABEL, since } from "./agents.ts";
import { useNow } from "./context.tsx";

/** Qui rend compte à qui : vous, le directeur, puis l'équipe ; le gardien surveille le développeur. */
const EDGES: [AgentId, AgentId][] = [
  ["you", "director"],
  ["director", "archivist"],
  ["director", "developer"],
  ["director", "qa"],
  ["developer", "guardian"],
];
const ROWS: AgentId[][] = [["you"], ["director"], ["archivist", "developer", "qa"], ["guardian"]];

type Path = { d: string; state: AgentState; key: string };

export function OrgChart({ snap, projectNames, filter }: { snap: StudioSnapshot; projectNames: Map<string, string>; filter?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<AgentId, HTMLElement>());
  const [paths, setPaths] = useState<Path[]>([]);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  const agents = new Map(
    snap.agents.map((a) => {
      const activities = filter ? a.activities.filter((x) => x.project === filter) : a.activities;
      const state: AgentState = activities.length ? a.state : "idle";
      return [a.id, { ...a, state, activities }];
    }),
  );

  // Trace les liens entre cartes à partir de leurs positions réelles (s'adapte à la largeur).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const draw = () => {
      const r = el.getBoundingClientRect();
      const at = (id: AgentId) => nodes.current.get(id)?.getBoundingClientRect();
      const out: Path[] = [];
      for (const [from, to] of EDGES) {
        const a = at(from);
        const b = at(to);
        if (!a || !b) continue;
        const x1 = a.left + a.width / 2 - r.left;
        const y1 = a.bottom - r.top;
        const x2 = b.left + b.width / 2 - r.left;
        const y2 = b.top - r.top;
        const mid = y1 + (y2 - y1) / 2;
        const rad = Math.min(14, Math.abs(x2 - x1) / 2, (y2 - y1) / 2);
        const dir = Math.sign(x2 - x1);
        const d =
          dir === 0
            ? `M${x1},${y1} V${y2}`
            : `M${x1},${y1} V${mid - rad} q0,${rad} ${dir * rad},${rad} H${x2 - dir * rad} q${dir * rad},0 ${dir * rad},${rad} V${y2}`;
        out.push({ d, state: agents.get(to)?.state ?? "idle", key: `${from}-${to}` });
      }
      setPaths(out);
      setDims({ w: r.width, h: r.height });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    for (const n of nodes.current.values()) ro.observe(n);
    return () => ro.disconnect();
    // Les états changent la couleur des liens : on retrace à chaque photographie.
  }, [snap, filter]);

  return (
    <div className="org" ref={box}>
      <svg className="org-links" width={dims.w} height={dims.h} aria-hidden="true">
        {paths.map((p) => (
          <g key={p.key} className={`link link-${p.state}`}>
            <path d={p.d} className="link-base" />
            <path d={p.d} className="link-flow" />
          </g>
        ))}
      </svg>
      {ROWS.map((row, k) => (
        <div key={k} className={`org-row org-row-${k}`}>
          {row.map((id) => {
            const a = agents.get(id);
            return (
              <AgentCard
                key={id}
                id={id}
                state={a?.state ?? "idle"}
                activities={a?.activities ?? []}
                projectNames={filter ? undefined : projectNames}
                nodeRef={(el) => {
                  if (el) nodes.current.set(id, el);
                  else nodes.current.delete(id);
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function AgentCard(props: {
  id: AgentId;
  state: AgentState;
  activities: StudioSnapshot["agents"][number]["activities"];
  projectNames?: Map<string, string>;
  nodeRef: (el: HTMLElement | null) => void;
}) {
  const { id, state, activities } = props;
  const now = useNow();
  const meta = AGENTS[id];
  const label = id === "you" ? YOU_STATE_LABEL[state] : STATE_LABEL[state];
  const shown = activities.slice(0, id === "you" ? 4 : 2);
  return (
    <article className={`agent-card agent-${id} state-${state}`} ref={props.nodeRef} data-agent={id} title={meta.tagline}>
      <div className="agent-top">
        <AgentAvatar agent={id} state={state} size={id === "you" ? 76 : 68} />
        <div className="agent-id">
          <h3>{meta.name}</h3>
          <p className="agent-role">{meta.role}</p>
          <span className={`state-pill pill-${state}`}>
            <i />
            {label}
          </span>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="agent-idle">{meta.idle}</p>
      ) : (
        <ul className="agent-acts">
          {shown.map((a, k) => (
            <li key={k}>
              <a href={a.href}>
                {props.projectNames && <span className="proj-tag">{props.projectNames.get(a.project) ?? a.project}</span>}
                <span className="act-text">{a.text}</span>
                {(a.detail || a.since) && (
                  <span className="act-detail">
                    {a.detail}
                    {a.detail && a.since ? " · " : ""}
                    {since(a.since, now)}
                  </span>
                )}
              </a>
            </li>
          ))}
          {activities.length > shown.length && <li className="more">et {activities.length - shown.length} autre(s)…</li>}
        </ul>
      )}
    </article>
  );
}
