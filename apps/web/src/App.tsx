import { DissectionHome, DissectionView } from "./studio/Dissection.tsx";
import { ExpressHome, ExpressView } from "./studio/Express.tsx";
import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type SessionInfo } from "./api.ts";
import { ImportFlow } from "./pages/ImportFlow.tsx";
import { ProjectShell } from "./pages/ProjectShell.tsx";
import { StudioProvider } from "./studio/context.tsx";
import { Sidebar, Logo } from "./studio/Sidebar.tsx";
import { Home } from "./studio/Home.tsx";
import { StudioLive } from "./studio/Live.tsx";
import { Icon, type IconName } from "./studio/Icon.tsx";
import { useStudio } from "./studio/context.tsx";
import { QualityView } from "./studio/Quality.tsx";
import { SkillsView } from "./studio/Skills.tsx";
import { PhoneView } from "./studio/Phone.tsx";
import { ConceptionStart, ConceptionView } from "./studio/Conception.tsx";

export type Route =
  | { page: "dashboard" }
  | { page: "live" }
  | { page: "import" }
  | { page: "quality" }
  | { page: "skills" }
  | { page: "phone" }
  | { page: "dissections" }
  | { page: "express" }
  | { page: "expressGame"; id: string }
  | { page: "dissection"; id: string }
  | { page: "conceive"; project?: string; thread?: string }
  | { page: "conception"; id: string }
  | { page: "project"; slug: string; thread?: string; task?: string; view?: "discussion" | "decisions" | "vision" | "tasks" | "art"; fresh?: boolean };

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "import") return { page: "import" };
  if (parts[0] === "direct") return { page: "live" };
  if (parts[0] === "qualite") return { page: "quality" };
  if (parts[0] === "competences") return { page: "skills" };
  if (parts[0] === "telephone") return { page: "phone" };
  if (parts[0] === "express") return parts[1] ? { page: "expressGame", id: parts[1] } : { page: "express" };
  if (parts[0] === "demontage") return parts[1] ? { page: "dissection", id: parts[1] } : { page: "dissections" };
  if (parts[0] === "concevoir") return { page: "conceive" };
  if (parts[0] === "c" && parts[1]) return { page: "conception", id: parts[1] };
  if (parts[0] === "p" && parts[1] && parts[2] === "concevoir") return { page: "conceive", project: parts[1], thread: parts[3] };
  if (parts[0] === "p" && parts[1]) {
    if (parts[2] === "decisions" || parts[2] === "vision" || parts[2] === "art") return { page: "project", slug: parts[1], view: parts[2] };
    if (parts[2] === "tasks") return { page: "project", slug: parts[1], view: "tasks", task: parts[3] };
    // « nouvelle » : une page blanche ; la discussion n'existe qu'au premier message envoyé.
    if (parts[2] === "nouvelle") return { page: "project", slug: parts[1], view: "discussion", fresh: true };
    return { page: "project", slug: parts[1], thread: parts[2] === "t" ? parts[3] : undefined, view: "discussion" };
  }
  return { page: "dashboard" };
}

export function href(route: Route): string {
  if (route.page === "import") return "#/import";
  if (route.page === "live") return "#/direct";
  if (route.page === "quality") return "#/qualite";
  if (route.page === "skills") return "#/competences";
  if (route.page === "phone") return "#/telephone";
  if (route.page === "express") return "#/express";
  if (route.page === "expressGame") return `#/express/${route.id}`;
  if (route.page === "dissections") return "#/demontage";
  if (route.page === "dissection") return `#/demontage/${route.id}`;
  if (route.page === "conceive") return route.project ? `#/p/${encodeURIComponent(route.project)}/concevoir${route.thread ? `/${route.thread}` : ""}` : "#/concevoir";
  if (route.page === "conception") return `#/c/${route.id}`;
  if (route.page === "project") {
    const base = `#/p/${encodeURIComponent(route.slug)}`;
    if (route.view === "decisions" || route.view === "vision" || route.view === "art") return `${base}/${route.view}`;
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
          <LiveBadge />
        </header>
        <Sidebar route={route} session={session} onClose={() => setMenu(false)} />
        <div className="menu-backdrop" onClick={() => setMenu(false)} />
        <div className="main">
          {route.page === "dashboard" && <Home />}
          {route.page === "live" && <StudioLive />}
          {route.page === "import" && <ImportFlow gamesRoot={session.gamesRoot} />}
          {route.page === "quality" && <QualityView />}
          {route.page === "skills" && <SkillsView />}
          {route.page === "phone" && <PhoneView session={session} />}
          {route.page === "express" && <ExpressHome />}
          {route.page === "expressGame" && <ExpressView key={route.id} id={route.id} />}
          {route.page === "dissections" && <DissectionHome />}
          {route.page === "dissection" && <DissectionView key={route.id} id={route.id} />}
          {route.page === "conceive" && <ConceptionStart project={route.project} thread={route.thread} />}
          {route.page === "conception" && <ConceptionView key={route.id} id={route.id} />}
          {route.page === "project" && <ProjectShell slug={route.slug} view={route.view ?? "discussion"} threadId={route.thread} taskId={route.task} fresh={route.fresh} />}
        </div>
        <TabBar route={route} onMenu={() => setMenu((m) => !m)} menuOpen={menu} />
      </div>
    </StudioProvider>
  );
}

const LAST_PROJECT = "studio:last-project";

/** Pastille « en direct » de la barre du haut, sur téléphone. */
function LiveBadge() {
  const snap = useStudio();
  const working = snap?.agents.filter((a) => a.id !== "you" && a.state !== "idle").length ?? 0;
  const forYou = snap?.agents.find((a) => a.id === "you")?.activities.length ?? 0;
  return (
    <a href={forYou ? "#/" : "#/direct"} className={`live-badge ${working ? "on" : ""} ${forYou ? "warn" : ""}`}>
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
  return (
    <nav className="tabbar" aria-label="Navigation principale">
      {tab("home", "#/", "home", "Accueil", route.page === "dashboard", forYou > 0 && <i className="tab-count">{forYou}</i>)}
      {project
        ? tab("project", `#/p/${project.slug}`, "chat", project.name, route.page === "project", project.waiting > 0 && <i className="tab-count">{project.waiting}</i>)
        : tab("new", "#/concevoir", "sparkle", "Créer", route.page === "conceive")}
      {tab("live", "#/direct", "live", "En direct", route.page === "live", working && <i className="tab-live" />)}
      <button className={`tab-item ${menuOpen ? "active" : ""}`} onClick={onMenu} aria-expanded={menuOpen}>
        <span className="tab-icon">
          <Icon name="menu" size={22} />
        </span>
        <span className="tab-label">Menu</span>
      </button>
    </nav>
  );
}
