import type { Activity, AgentId, ForgeBench, ForgePhase, ForgeSnapshot, StudioSnapshot } from "../../api.ts";

/**
 * La Forge (ADR-106) : ce que la scène en voxels doit montrer, calculé à partir des vraies données du hub.
 * La mise en scène (marcher, taper sur l'enclume) suit ces états ; elle ne montre pas la réflexion des agents.
 */

export type ActorKind = "director" | "concepteur" | "art_director" | "archivist" | "developer" | "qa" | "guardian" | "foreman";
export type Mode = "work" | "wait" | "idle";

export type Actor = {
  id: string;
  kind: ActorKind;
  name: string;
  role: string;
  mode: Mode;
  /** Une ligne courte, au-dessus du personnage. */
  line: string | null;
  acts: Activity[];
  /** Développeurs : l'établi (0, 1…) et l'étape du chantier. */
  bench?: number;
  phase?: ForgePhase;
};

export type Bench = { index: number; data: ForgeBench | null };

export type ForgeState = {
  slug: string;
  name: string;
  parallel: number;
  actors: Actor[];
  benches: Bench[];
  queue: ForgeSnapshot["queue"];
  review: { id: string; title: string; kind: "plan" | "result" }[];
  escalations: ForgeSnapshot["escalations"];
  merged: ForgeSnapshot["merged"];
  today: ForgeSnapshot["today"];
  scouting: boolean;
  paused: ForgeSnapshot["paused"];
  pool: ForgeSnapshot["pool"];
  /** Le chantier sur le banc d'essai. */
  testing: { id: string; title: string } | null;
  demo: boolean;
};

export const MAX_BENCHES = 4;

export const ACTOR_INFO: Record<ActorKind, { name: string; role: string; color: string }> = {
  director: { name: "Le Directeur", role: "Chef d'équipe", color: "#00e5ff" },
  concepteur: { name: "Le Concepteur", role: "Game design", color: "#d99a6c" },
  art_director: { name: "Le Directeur artistique", role: "Art et son", color: "#ff8a4c" },
  archivist: { name: "L'Archiviste", role: "Mémoire du jeu", color: "#a99be0" },
  developer: { name: "Développeur", role: "Code, à la forge", color: "#84a9d9" },
  qa: { name: "Le Testeur", role: "Banc d'essai", color: "#7cc79a" },
  guardian: { name: "Le Gardien", role: "Sécurité, à la porte", color: "#d98a92" },
  foreman: { name: "Le Chef de chantier", role: "Répartit les chantiers", color: "#e0b050" },
};

export const PHASE_LABEL: Record<ForgePhase, string> = {
  starting: "S'installe à l'établi",
  plan: "Prépare le plan",
  plan_review: "Le plan attend votre accord",
  execute: "Forge le chantier",
  checks: "Contrôles du hub (tests, lancement, capture)",
  verify: "Sur le banc d'essai",
  review: "Attend votre mot",
  changes: "Reprend vos corrections",
};

const short = (s: string, n = 46) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Fusionne la vue Studio (états des agents) et la photographie de la Forge (établis, file). */
export function deriveForge(slug: string, snap: StudioSnapshot | null, forge: ForgeSnapshot | null, demo = false): ForgeState {
  const parallel = Math.max(1, Math.min(MAX_BENCHES, forge?.parallel ?? 1));
  const benchData = forge?.benches ?? [];
  const count = Math.min(MAX_BENCHES, Math.max(parallel, benchData.length));
  const benches: Bench[] = Array.from({ length: count }, (_, i) => ({ index: i, data: benchData[i] ?? null }));
  const escalations = forge?.escalations ?? [];
  const blocked = new Set(escalations.map((e) => e.task));

  const agentOf = (id: AgentId) => {
    const a = snap?.agents.find((x) => x.id === id);
    const acts = (a?.activities ?? []).filter((x) => x.project === slug);
    const mode: Mode = !acts.length ? "idle" : a?.state === "waiting" ? "wait" : "work";
    return { acts, mode };
  };
  const make = (kind: ActorKind, id: string, mode: Mode, line: string | null, acts: Activity[], extra: Partial<Actor> = {}): Actor => ({
    id,
    kind,
    name: ACTOR_INFO[kind].name,
    role: ACTOR_INFO[kind].role,
    mode,
    line: line ? short(line) : null,
    acts,
    ...extra,
  });

  const actors: Actor[] = [];
  for (const kind of ["director", "concepteur", "art_director", "archivist"] as const) {
    const { acts, mode } = agentOf(kind);
    actors.push(make(kind, kind, mode, acts[0]?.text ?? null, acts));
  }

  const devActs = agentOf("developer").acts;
  for (const b of benches) {
    const d = b.data;
    let mode: Mode = "idle";
    let line: string | null = null;
    if (d) {
      if (blocked.has(d.task.id)) {
        mode = "wait";
        line = `${d.task.id} : une action attend votre accord`;
      } else if (d.phase === "plan" || d.phase === "execute" || d.phase === "checks" || d.phase === "starting" || d.phase === "changes") {
        mode = "work";
        line = `${d.task.id} · ${PHASE_LABEL[d.phase]}`;
      }
    }
    const acts = d ? devActs.filter((a) => a.href.endsWith(`/tasks/${d.task.id}`)) : [];
    actors.push(make("developer", `dev${b.index}`, mode, line, acts, { name: `Développeur ${b.index + 1}`, bench: b.index, phase: d?.phase }));
  }

  const verifying = benches.find((b) => b.data?.phase === "verify")?.data ?? null;
  const qa = agentOf("qa");
  actors.push(make("qa", "qa", verifying ? "work" : qa.mode, verifying ? `Vérifie ${verifying.task.id} « ${verifying.task.title} »` : (qa.acts[0]?.text ?? null), qa.acts));

  const running = benches.some((b) => b.data?.run);
  actors.push(make("guardian", "guardian", escalations.length ? "wait" : running ? "work" : "idle", escalations.length ? `Bloque : ${escalations[0]!.summary}` : running ? "Surveille la forge" : null, agentOf("guardian").acts));

  const scouting = forge?.scouting ?? false;
  actors.push(make("foreman", "foreman", scouting ? "work" : "idle", scouting ? "Prépare la fiche d'un chantier" : null, []));

  const review = benchData
    .filter((b) => b.phase === "review" || b.phase === "plan_review")
    .map((b) => ({ id: b.task.id, title: b.task.title, kind: b.phase === "plan_review" ? ("plan" as const) : ("result" as const) }));

  return {
    slug,
    name: forge?.project.name ?? snap?.projects.find((p) => p.slug === slug)?.name ?? slug,
    parallel,
    actors,
    benches,
    queue: forge?.queue ?? [],
    review,
    escalations,
    merged: forge?.merged ?? [],
    today: forge?.today ?? { merged: 0, failed: 0 },
    scouting,
    paused: forge?.paused ?? null,
    pool: forge?.pool ?? { busy: 0, waiting: 0, max: 0 },
    testing: verifying ? { id: verifying.task.id, title: verifying.task.title } : null,
    demo,
  };
}

// ── Le cycle jour / nuit ─────────────────────────────────────────────────────

export type DayLight = {
  hour: number;
  label: "Nuit" | "Aube" | "Jour" | "Crépuscule";
  night: boolean;
  sky: string;
  sun: string;
  sunIntensity: number;
  ambient: string;
  ambientIntensity: number;
  /** Force des torches et des foyers (0 à 1). */
  torches: number;
};

type Key = [number, string, string, number, string, number, number];
const KEYS: Key[] = [
  [0, "#0a1030", "#7f9cff", 0.7, "#5060a8", 0.9, 1],
  [5.5, "#121a40", "#8fa6ff", 0.7, "#5060a8", 0.95, 1],
  [7, "#ff9a62", "#ffb27a", 2.0, "#c09888", 1.3, 0.6],
  [9, "#8fd0ff", "#fff1d6", 3.2, "#d4e4ff", 1.7, 0.3],
  [17, "#8fd0ff", "#fff1d6", 3.0, "#d4e4ff", 1.7, 0.3],
  [19.5, "#ff7a3c", "#ff9a50", 2.0, "#b88070", 1.3, 0.65],
  [21.5, "#0a1030", "#7f9cff", 0.7, "#5060a8", 0.9, 1],
  [24, "#0a1030", "#7f9cff", 0.7, "#5060a8", 0.9, 1],
];

const hex = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const mix = (a: string, b: string, t: number) =>
  `#${hex(a)
    .map((v, i) => Math.round(v + (hex(b)[i]! - v) * t).toString(16).padStart(2, "0"))
    .join("")}`;

/** La lumière à une heure donnée (0 à 24), interpolée entre quelques heures clés. */
export function dayLight(hour: number): DayLight {
  const h = ((hour % 24) + 24) % 24;
  let k = 0;
  while (k < KEYS.length - 2 && KEYS[k + 1]![0] <= h) k++;
  const a = KEYS[k]!;
  const b = KEYS[k + 1]!;
  const t = (h - a[0]) / (b[0] - a[0] || 1);
  const label = h < 6 || h >= 21.5 ? "Nuit" : h < 8.5 ? "Aube" : h < 18.5 ? "Jour" : "Crépuscule";
  return {
    hour: h,
    label,
    night: label === "Nuit",
    sky: mix(a[1], b[1], t),
    sun: mix(a[2], b[2], t),
    sunIntensity: a[3] + (b[3] - a[3]) * t,
    ambient: mix(a[4], b[4], t),
    ambientIntensity: a[5] + (b[5] - a[5]) * t,
    torches: a[6] + (b[6] - a[6]) * t,
  };
}

export const hourOf = (d: Date) => d.getHours() + d.getMinutes() / 60;

// ── La démonstration (données fictives, clairement annoncées) ────────────────

const DEMO_TITLES = ["Boss de glace", "Grille d'inventaire", "Sons de pas", "Menu des options", "Effets de neige", "Arbre de talents"];

/** Une minute de studio imaginaire, en boucle : chaque poste change d'état, un chantier passe au banc d'essai puis au trésor. */
export function demoData(slug: string, name: string, ms: number): { snap: StudioSnapshot; forge: ForgeSnapshot } {
  const cycle = Math.floor(ms / 60_000);
  const s = (ms % 60_000) / 1000;
  const at = new Date(ms).toISOString();
  const ago = (sec: number) => new Date(ms - sec * 1000).toISOString();
  const id = (n: number) => `T-${String(40 + ((cycle * 3 + n) % 900)).padStart(4, "0")}`;
  const title = (n: number) => DEMO_TITLES[(cycle * 3 + n) % DEMO_TITLES.length]!;
  const run = (kind: "plan" | "execute" | "verify", text: string, since: number) => ({ id: `RUN-${kind}`, kind, started_at: ago(since), last: { at, type: "tool", text } });

  const benches: ForgeBench[] = [];
  benches.push({ task: { id: id(0), title: title(0), status: "running" }, phase: s < 8 ? "plan" : "execute", run: run(s < 8 ? "plan" : "execute", s < 8 ? "Lit src/boss.ts" : "Modifie src/boss/glace.ts", s), note: "Le boss, ses attaques et sa scène.", files: ["src/boss/glace.ts", "scenes/boss.tscn"], since: ago(s) });
  if (s < 20) benches.push({ task: { id: id(1), title: title(1), status: "running" }, phase: "execute", run: run("execute", "Écrit les tests de la grille", s + 120), note: "L'inventaire et son écran.", files: ["src/ui/inventaire.ts"], since: ago(s + 120) });
  else if (s < 34) benches.push({ task: { id: id(1), title: title(1), status: "running" }, phase: s < 23 ? "checks" : "verify", run: s < 23 ? null : run("verify", "Lance npm test", s - 23), note: "L'inventaire et son écran.", files: ["src/ui/inventaire.ts"], since: ago(s - 20) });
  else if (s > 44) benches.push({ task: { id: id(2), title: title(2), status: "running" }, phase: s < 48 ? "starting" : "execute", run: s < 48 ? null : run("execute", "Ajoute les sons de pas", s - 48), note: "Les sons de pas.", files: ["audio/pas/"], since: ago(s - 44) });
  benches.push({ task: { id: "T-0039", title: "Écran titre animé", status: "review" }, phase: "review", run: null, note: null, files: [], since: ago(600) });

  const merged = [
    ...(s >= 34 ? [{ id: id(1), title: title(1), at: ago(s - 34) }] : []),
    { id: "T-0038", title: "Saut plus nerveux", at: ago(900 + s) },
    { id: "T-0037", title: "Caméra qui suit", at: ago(2400 + s) },
  ];
  const queue = [
    ...(s <= 44 ? [{ id: id(2), title: title(2), scoped: s > 6, waiting: s > 6 ? "les 3 établis sont pris" : "le chef de chantier prépare sa fiche" }] : []),
    { id: id(3), title: title(3), scoped: true, waiting: `attend ${id(0)} : ils touchent tous deux scenes/boss.tscn` },
  ];
  const escalations = s > 50 && s < 57 ? [{ id: "E-0001", task: id(0), summary: "Installer le paquet « noise-js »" }] : [];

  const act = (text: string, href = `#/p/${slug}`, since = 30): Activity => ({ project: slug, text, href, since: ago(since) });
  const agents: StudioSnapshot["agents"] = [
    { id: "you", state: "waiting", activities: [act("Relire le résultat : Écran titre animé")] },
    { id: "concepteur", state: s > 30 && s < 46 ? "working" : "idle", activities: s > 30 && s < 46 ? [act("Conçoit « Le village nordique »")] : [] },
    { id: "director", state: s > 10 && s < 28 ? "working" : "idle", activities: s > 10 && s < 28 ? [act("Vous répond dans « Les boss »")] : [] },
    { id: "art_director", state: s > 22 && s < 52 ? "working" : "idle", activities: s > 22 && s < 52 ? [act("Fabrique le décor de glace (générateur local)", `#/p/${slug}/art`)] : [] },
    { id: "archivist", state: s > 4 && s < 16 ? "working" : "idle", activities: s > 4 && s < 16 ? [act("Note les idées de votre dernier message")] : [] },
    { id: "developer", state: escalations.length ? "waiting" : "working", activities: [] },
    { id: "qa", state: "idle", activities: [] },
    { id: "guardian", state: escalations.length ? "waiting" : "working", activities: [] },
  ];
  const snap = { at, usage: null, models: null, agents, projects: [{ slug, name, engine: "web", autonomy: "workshop", delegated: 0, busy: true, waiting: 1, decisions: 0, proposals: 0, tasks: 0 }], events: [] } as unknown as StudioSnapshot;
  const forge: ForgeSnapshot = {
    at,
    project: { slug, name, autonomy: "workshop" },
    parallel: 3,
    pool: { busy: 2, waiting: 0, max: 3 },
    benches,
    queue,
    scouting: s < 6,
    escalations,
    merged,
    today: { merged: merged.length, failed: 0 },
    paused: null,
  };
  return { snap, forge };
}
