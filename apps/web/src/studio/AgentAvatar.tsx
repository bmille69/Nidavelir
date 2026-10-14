import { useId } from "react";
import type { AgentId, AgentState } from "../api.ts";

const GLYPHS: Record<AgentId, string[]> = {
  you: ["★", "✦", "★"],
  concepteur: ["✎", "◇", "?"],
  director: ["✦", "?", "✦"],
  archivist: ["✎", "¶", "✎"],
  developer: ["</>", "{ }", ";"],
  qa: ["✓", "✓", "✓"],
  guardian: ["◆", "✓", "◆"],
};

/**
 * Petit personnage animé : un robot à son bureau pour chaque agent, une silhouette
 * dorée pour vous. L'animation suit l'état (au repos, au travail, vous attend).
 */
export function AgentAvatar({ agent, state, size = 96 }: { agent: AgentId; state: AgentState; size?: number }) {
  const glyphs = GLYPHS[agent];
  const clip = `clip${useId().replace(/:/g, "")}`;
  return (
    <div className={`avatar agent-${agent} state-${state}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 120 120" width={size} height={size}>
        <defs>
          <clipPath id={clip}>
            <circle cx="60" cy="60" r="58" />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clip})`}>
          <circle cx="60" cy="60" r="58" className="a-bg" />
          <circle cx="60" cy="54" r="34" className="a-halo" />
          {agent === "you" ? <You /> : <Bot agent={agent} />}
        </g>
        <g className="fx">
          {state === "working" &&
            glyphs.map((g, k) => (
              <text key={k} className={`particle p${k + 1}`} x={70 + k * 9} y={36}>
                {g}
              </text>
            ))}
          {state === "idle" && agent !== "you" && (
            <>
              <text className="zz z1" x="80" y="30">
                z
              </text>
              <text className="zz z2" x="88" y="22">
                z
              </text>
            </>
          )}
          {state === "waiting" && (
            <g className="bubble">
              <circle cx="96" cy="22" r="12" />
              <text x="96" y="27.5">
                !
              </text>
            </g>
          )}
        </g>
      </svg>
    </div>
  );
}

function Bot({ agent }: { agent: AgentId }) {
  return (
    <>
      <g className="bot">
        {agent === "guardian" ? (
          <path d="M48 27 Q60 8 72 27 Z" className="a-main" />
        ) : (
          <>
            <line x1="60" y1="27" x2="60" y2="17" className="a-stroke" />
            <circle cx="60" cy="15" r="3.6" className="a-main antenna" />
          </>
        )}
        <path d="M38 96 V73 a13 13 0 0 1 13 -13 h18 a13 13 0 0 1 13 13 V96 Z" className="a-main" />
        <rect x="35" y="37" width="6" height="12" rx="3" className="a-main" />
        <rect x="79" y="37" width="6" height="12" rx="3" className="a-main" />
        <rect x="39" y="25" width="42" height="35" rx="14" className="a-shell" />
        <rect x="44" y="31" width="32" height="22" rx="9" className="a-face" />
        <g className="eyes">
          <rect x="50" y="38" width="5.5" height="8" rx="2.75" className="a-eye" />
          <rect x="64.5" y="38" width="5.5" height="8" rx="2.75" className="a-eye" />
        </g>
        <path d="M55 49.5 q5 3 10 0" className="a-mouth" />
        {agent === "director" && (
          <>
            <path d="M36 42 a24 24 0 0 1 48 0" className="a-dark-stroke" />
            <path d="M38 48 q1 11 13 11" className="a-dark-stroke thin" />
            <circle cx="52" cy="59" r="2.6" className="a-dark" />
          </>
        )}
        {agent === "concepteur" && (
          <>
            <ellipse cx="57" cy="27" rx="18" ry="6" className="a-dark" />
            <circle cx="57" cy="20.5" r="2.2" className="a-dark" />
          </>
        )}
        {agent === "archivist" && (
          <g className="a-glasses">
            <circle cx="52.75" cy="42" r="6.2" />
            <circle cx="67.25" cy="42" r="6.2" />
            <line x1="59" y1="42" x2="61" y2="42" />
          </g>
        )}
        {agent === "developer" && (
          <>
            <path d="M39 33 Q60 10 81 33 Z" className="a-main" />
            <rect x="72" y="29" width="16" height="4.5" rx="2.2" className="a-main" />
          </>
        )}
        {agent === "qa" && <path d="M55 75 l4 4 l8 -9" className="a-check" />}
      </g>
      <rect x="6" y="90" width="108" height="8" rx="3" className="a-desk" />
      <rect x="12" y="98" width="96" height="30" className="a-desk-front" />
      {agent === "guardian" ? (
        <g className="shield">
          <path d="M60 64 L80 71 V82 Q80 96 60 104 Q40 96 40 82 V71 Z" className="a-main" />
          <path d="M60 70 L74 75 V83 Q74 93 60 98 Q46 93 46 83 V75 Z" className="a-face" />
          <path d="M53 83 l5 5 l9 -10" className="a-check" />
        </g>
      ) : (
        <>
          <ellipse cx="60" cy="58" rx="24" ry="12" className="a-glow" />
          <path d="M40 90 L44.5 70 H75.5 L80 90 Z" className="a-laptop" />
          <circle cx="60" cy="80" r="2.6" className="a-main logo" />
          <circle cx="40" cy="88" r="5" className="a-main hand hand-l" />
          <circle cx="80" cy="88" r="5" className="a-main hand hand-r" />
        </>
      )}
      {agent === "archivist" && (
        <g className="papers">
          <rect x="12" y="80" width="20" height="10" rx="1.5" className="a-paper" />
          <rect x="14" y="76" width="20" height="10" rx="1.5" className="a-paper" />
          <rect x="13" y="72" width="20" height="10" rx="1.5" className="a-paper flying" />
        </g>
      )}
      {agent === "concepteur" && (
        <g className="blueprint">
          <rect x="84" y="74" width="24" height="16" rx="1.5" className="a-blueprint" />
          <path d="M88 86 L96 78 L104 86" className="a-blueprint-line" />
        </g>
      )}
      {agent === "qa" && (
        <g className="magnifier">
          <circle cx="96" cy="76" r="7" className="a-lens" />
          <line x1="101" y1="81" x2="107" y2="88" className="a-dark-stroke" />
        </g>
      )}
    </>
  );
}

function You() {
  return (
    <g className="bot">
      <path d="M26 112 Q26 72 60 70 Q94 72 94 112 Z" className="y-body" />
      <path d="M50 71 L60 84 L70 71" className="y-collar" />
      <circle cx="60" cy="45" r="16" className="y-head" />
      <g className="eyes">
        <circle cx="54" cy="46" r="2" className="y-eye" />
        <circle cx="66" cy="46" r="2" className="y-eye" />
      </g>
      <path d="M55 52.5 q5 3.5 10 0" className="y-smile" />
      <ellipse cx="56" cy="31.5" rx="17" ry="6.5" className="y-beret" />
      <circle cx="56" cy="24.5" r="2.4" className="y-beret" />
      <path d="M60 89 l2.4 4.9 5.4 0.8 -3.9 3.8 0.9 5.4 -4.8 -2.5 -4.8 2.5 0.9 -5.4 -3.9 -3.8 5.4 -0.8 Z" className="y-star" />
    </g>
  );
}
