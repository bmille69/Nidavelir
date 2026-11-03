import { DissectionHome, DissectionView } from "./studio/Dissection.tsx";
import { ExpressHome, ExpressView } from "./studio/Express.tsx";
import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type SessionInfo } from "./api.ts";
import { ImportFlow } from "./pages/ImportFlow.tsx";
import { ProjectShell } from "./pages/ProjectShell.tsx";
import { StudioProvider } from "./studio/context.tsx";
import { Sidebar, Logo } from "./studio/Sidebar.tsx";
import { Home } from "./studio/Home.tsx";
import { ForgePage } from "./studio/forge/ForgePage.tsx";
import { Pilotage } from "./studio/Pilotage.tsx";
import { Icon, type IconName } from "./studio/Icon.tsx";
import { ForYou } from "./studio/ForYou.tsx";
import { ModsHome, ModView } from "./studio/Mods.tsx";
import { useStudio } from "./studio/context.tsx";
import { QualityView } from "./studio/Quality.tsx";
import { SkillsView } from "./studio/Skills.tsx";
import { PhoneView } from "./studio/Phone.tsx";
import { ConceptionStart, ConceptionView } from "./studio/Conception.tsx";
import { CommandPalette } from "./studio/CommandPalette.tsx";
import { TitleBar } from "./studio/TitleBar.tsx";
import { MemoryView } from "./studio/Memory.tsx";
import { IdeasHome, IdeaView } from "./studio/Ideas.tsx";

/** Dans l'application de bureau (apps/desktop), qui l'annonce par son preload. */
const DESKTOP = typeof window !== "undefined" && window.nidavellir?.desktop === true;

export type Route =
  | { page: "dashboard" }
  | { page: "forge"; slug?: string }
  | { page: "pilot" }
  | { page: "import" }
  | { page: "quality" }
  | { page: "skills" }
  | { page: "phone" }
  | { page: "dissections" }
  | { page: "express" }
  | { page: "expressGame"; id: string }
  | { page: "mods" }
  | { page: "mod"; id: string }
  | { page: "dissection"; id: string }
  | { page: "conceive"; project?: string; thread?: string }
  | { page: "conception"; id: string }
  | { page: "memory" }
  | { page: "ideas" }
  | { page: "idea"; id: string }
  | { page: "project"; slug: string; thread?: string; task?: string; view?: ProjectView; fresh?: boolean };

/**
 * Les pages d'un projet (ADR-113). Onglets : Discussion, Récap (« recap » ; « tasks » et « plans » y vivent), Le jeu
 * (« vision » ; « decisions » y vit), Art & son (« art » ; l'adresse « son » y mène).
 */
export type ProjectView = "discussion" | "recap" | "decisions" | "vision" | "tasks" | "art" | "plans";

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "import") return { page: "import" };
  // La Forge remplace « En direct » : les anciens liens (#/direct, #/p/<jeu>/forge) y mènent.
  if (parts[0] === "forge") return { page: "forge", slug: parts[1] };
  if (parts[0] === "direct") return { page: "forge" };
  if (parts[0] === "pilotage") return { page: "pilot" };
  if (parts[0] === "qualite") return { page: "quality" };
  if (parts[0] === "competences") return { page: "skills" };
  if (parts[0] === "telephone") return { page: "phone" };
  if (parts[0] === "express") return parts[1] ? { page: "expressGame", id: parts[1] } : { page: "express" };
  if (parts[0] === "mods") return parts[1] ? { page: "mod", id: parts[1] } : { page: "mods" };
  if (parts[0] === "demontage") return parts[1] ? { page: "dissection", id: parts[1] } : { page: "dissections" };
  if (parts[0] === "concevoir") return { page: "conceive" };
  if (parts[0] === "memoire") return { page: "memory" };
  if (parts[0] === "idees") return parts[1] ? { page: "idea", id: parts[1] } : { page: "ideas" };
  if (parts[0] === "c" && parts[1]) return { page: "conception", id: parts[1] };
  if (parts[0] === "p" && parts[1] && parts[2] === "concevoir") return { page: "conceive", project: parts[1], thread: parts[3] };
  if (parts[0] === "p" && parts[1]) {
    if (parts[2] === "forge") return { page: "forge", slug: parts[1] };
    if (parts[2] === "decisions" || parts[2] === "vision" || parts[2] === "art" || parts[2] === "plans" || parts[2] === "recap") return { page: "project", slug: parts[1], view: parts[2] };
    if (parts[2] === "son") return { page: "project", slug: parts[1], view: "art" };
    if (parts[2] === "tasks") return { page: "project", slug: parts[1], view: "tasks", task: parts[3] };
    // « nouvelle » : une page blanche ; la discussion n'existe qu'au premier message envoyé.
    if (parts[2] === "nouvelle") return { page: "project", slug: parts[1], view: "discussion", fresh: true };
    return { page: "project", slug: parts[1], thread: parts[2] === "t" ? parts[3] : undefined, view: "discussion" };
  }
  return { page: "dashboard" };
}

export function href(route: Route): string {
  if (route.page === "import") return "#/import";
  if (route.page === "forge") return route.slug ? `#/forge/${encodeURIComponent(route.slug)}` : "#/forge";
  if (route.page === "pilot") return "#/pilotage";
  if (route.page === "quality") return "#/qualite";
  if (route.page === "skills") return "#/competences";
  if (route.page === "phone") return "#/telephone";
  if (route.page === "express") return "#/express";
  if (route.page === "expressGame") return `#/express/${route.id}`;
  if (route.page === "mods") return "#/mods";
  if (route.page === "mod") return `#/mods/${route.id}`;
  if (route.page === "dissections") return "#/demontage";
  if (route.page === "dissection") return `#/demontage/${route.id}`;
  if (route.page === "conceive") return route.project ? `#/p/${encodeURIComponent(route.project)}/concevoir${route.thread ? `/${route.thread}` : ""}` : "#/concevoir";
  if (route.page === "conception") return `#/c/${route.id}`;
  if (route.page === "memory") return "#/memoire";
  if (route.page === "ideas") return "#/idees";
  if (route.page === "idea") return `#/idees/${route.id}`;
  if (route.page === "project") {
    const base = `#/p/${encodeURIComponent(route.slug)}`;
    if (route.view === "decisions" || route.view === "vision" || route.view === "art" || route.view === "plans" || route.view === "recap") return `${base}/${route.view}`;
    if (route.view === "tasks") return `${base}/tasks${route.task ? `/${route.task}` : ""}`;
    if (route.fresh) return `${base}/nouvelle`;
    return `${base}${route.thread ? `/t/${route.thread}` : ""}`;
  }
  return "#/";
}

export function navigate(route: Route): void {
  window.location.hash = href(route);
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  // Sur téléphone, la barre latérale devient un menu qui se replie.
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [route]);
  // Le dernier projet ouvert : un onglet du téléphone y ramène en un geste.
  useEffect(() => {
    if (route.page !== "project") return;
    try {
      localStorage.setItem(LAST_PROJECT, route.slug);
    } catch {
      /* stockage indisponible : l'onglet « Projet » n'est simplement pas proposé */
    }
  }, [route]);

  useEffect(() => {
    const onHash = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    api.session().then(setSession, (e: unknown) =>
      setAuthError(e instanceof ApiError && e.status === 401 ? "session" : String((e as Error).message)),
    );
  }, []);

  if (authError) {
    return (
      <div className="centered">
        <div className="card narrow auth-card">
          <Logo size={64} />
          <h1>Nidavellir</h1>
          {authError === "session" ? (
            <>
              <p>
                Aucune session active. Ouvrez le <strong>lien de connexion</strong> affiché dans le terminal où le hub a été lancé
                (il n'est valable qu'une fois ; relancez le hub pour en obtenir un nouveau).
              </p>
              <p>
                Sur un téléphone : <a href="/login">connectez-le avec le code</a> affiché dans la page « Téléphone » du hub, sur le PC.
              </p>
            </>
          ) : (
            <p className="error">{authError}</p>
          )}
        </div>
      </div>
    );
  }
  if (!session) return <div className="centered muted">Connexion…</div>;

  return (
    <StudioProvider>
      <div className={`app ${menu ? "menu-open" : ""} page-${route.page}`}>
        <header className="mobile-bar">
          <button className="menu-btn" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <Icon name="menu" size={22} />
          </button>
          <a href="#/" className="mobile-brand">
            <Logo size={28} />
            <span>Nidavellir</span>
          </a>
          <LiveBadge exclude={route.page === "project" ? route.slug : undefined} />
        </header>
        {/* Dans un projet, ce qui le concerne est dans sa boîte « À vous » : le bouton ne montre que les autres (ADR-113). */}
        <ForYou floating exclude={route.page === "project" ? route.slug : undefined} />
        <CommandPalette />
        {DESKTOP && <TitleBar route={route} />}
        <Sidebar route={route} session={session} onClose={() => setMenu(false)} />
        <div className="menu-backdrop" onClick={() => setMenu(false)} />
        <div className="main">
          {route.page === "dashboard" && <Home />}
          {route.page === "forge" && <ForgePage slug={route.slug} />}
          {route.page === "pilot" && <Pilotage />}
          {route.page === "import" && <ImportFlow gamesRoot={session.gamesRoot} />}
          {route.page === "quality" && <QualityView />}
          {route.page === "skills" && <SkillsView />}
          {route.page === "phone" && <PhoneView session={session} />}
          {route.page === "express" && <ExpressHome />}
          {route.page === "expressGame" && <ExpressView key={route.id} id={route.id} />}
          {route.page === "mods" && <ModsHome />}
          {route.page === "mod" && <ModView key={route.id} id={route.id} />}
          {route.page === "dissections" && <DissectionHome />}
          {route.page === "dissection" && <DissectionView key={route.id} id={route.id} />}
          {route.page === "conceive" && <ConceptionStart project={route.project} thread={route.thread} />}
          {route.page === "conception" && <ConceptionView key={route.id} id={route.id} />}
          {route.page === "memory" && <MemoryView />}
          {route.page === "ideas" && <IdeasHome />}
          {route.page === "idea" && <IdeaView key={route.id} id={route.id} />}
          {route.page === "project" && <ProjectShell slug={route.slug} view={route.view ?? "discussion"} threadId={route.thread} taskId={route.task} fresh={route.fresh} />}
        </div>
        <TabBar route={route} onMenu={() => setMenu((m) => !m)} menuOpen={menu} />
      </div>
    </StudioProvider>
  );
}

const LAST_PROJECT = "studio:last-project";

/** Pastille d'état de la barre du haut, sur téléphone : mène à la Forge. */
function LiveBadge({ exclude }: { exclude?: string }) {
  const snap = useStudio();
  const working = snap?.agents.filter((a) => a.id !== "you" && a.state !== "idle").length ?? 0;
  const forYou = snap?.agents.find((a) => a.id === "you")?.activities.filter((a) => !exclude || a.project !== exclude).length ?? 0;
  if (forYou) return <ForYou exclude={exclude} />;
  return (
    <a href={forYou ? "#/" : "#/forge"} className={`live-badge ${working ? "on" : ""} ${forYou ? "warn" : ""}`}>
      {forYou ? (
        <>
          <Icon name="bell" size={16} /> {forYou}
        </>
      ) : working ? (
        <>
          <span className="live-dot" /> {working} au travail
        </>
      ) : (
        "Au repos"
      )}
    </a>
  );
}

/** Barre d'onglets du téléphone : les quatre endroits où l'on va le plus souvent, au pouce. */
function TabBar({ route, onMenu, menuOpen }: { route: Route; onMenu: () => void; menuOpen: boolean }) {
  const snap = useStudio();
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_PROJECT);
  } catch {
    last = null;
  }
  const project = snap?.projects.find((p) => p.slug === (route.page === "project" ? route.slug : last)) ?? null;
  const forYou = snap?.agents.find((a) => a.id === "you")?.activities.length ?? 0;
  const working = snap?.agents.some((a) => a.id !== "you" && a.state !== "idle") ?? false;
  const tab = (key: string, hrefTo: string, icon: IconName, label: string, active: boolean, extra?: ReactNode) => (
    <a key={key} href={hrefTo} className={`tab-item ${active && !menuOpen ? "active" : ""}`}>
      <span className="tab-icon">
        <Icon name={icon} size={22} />
        {extra}
      </span>
      <span className="tab-label">{label}</span>
    </a>
  );
  const menu = (
    <button className={`tab-item ${menuOpen ? "active" : ""}`} onClick={onMenu} aria-expanded={menuOpen}>
      <span className="tab-icon">
        <Icon name="menu" size={22} />
      </span>
      <span className="tab-label">Menu</span>
    </button>
  );
  // Dans un jeu, les onglets du projet passent en bas, au pouce (ADR-113) ; le menu mène au reste du studio.
  if (route.page === "project" && project) {
    const view = route.view ?? "discussion";
    const base = `#/p/${project.slug}`;
    return (
      <nav className="tabbar project-tabbar" aria-label="Onglets du projet">
        {tab("discussion", base, "chat", "Discussion", view === "discussion", project.waiting > 0 && <i className="tab-count">{project.waiting}</i>)}
        {tab("recap", `${base}/recap`, "chart", "Récap", view === "recap" || view === "tasks" || view === "plans")}
        {tab("vision", `${base}/vision`, "book", "Le jeu", view === "vision" || view === "decisions")}
        {tab("art", `${base}/art`, "palette", "Art & son", view === "art")}
        {menu}
      </nav>
    );
  }
  return (
    <nav className="tabbar" aria-label="Navigation principale">
      {tab("home", "#/", "home", "Accueil", route.page === "dashboard", forYou > 0 && <i className="tab-count">{forYou}</i>)}
      {project
        ? tab("project", `#/p/${project.slug}`, "chat", project.name, route.page === "project", project.waiting > 0 && <i className="tab-count">{project.waiting}</i>)
        : tab("new", "#/concevoir", "sparkle", "Créer", route.page === "conceive")}
      {tab("forge", "#/forge", "cube", "La Forge", route.page === "forge", working && <i className="tab-live" />)}
      {menu}
    </nav>
  );
}
