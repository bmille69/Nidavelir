import { useEffect, useState } from "react";
import { api, ApiError, type SessionInfo } from "./api.ts";
import { ImportFlow } from "./pages/ImportFlow.tsx";
import { ProjectShell } from "./pages/ProjectShell.tsx";
import { StudioProvider } from "./studio/context.tsx";
import { Sidebar } from "./studio/Sidebar.tsx";
import { StudioHome } from "./studio/StudioHome.tsx";
import { QualityView } from "./studio/Quality.tsx";
import { ConceptionStart, ConceptionView } from "./studio/Conception.tsx";

export type Route =
  | { page: "dashboard" }
  | { page: "import" }
  | { page: "quality" }
  | { page: "conceive"; project?: string }
  | { page: "conception"; id: string }
  | { page: "project"; slug: string; thread?: string; task?: string; view?: "discussion" | "decisions" | "vision" | "tasks" };

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "import") return { page: "import" };
  if (parts[0] === "qualite") return { page: "quality" };
  if (parts[0] === "concevoir") return { page: "conceive" };
  if (parts[0] === "c" && parts[1]) return { page: "conception", id: parts[1] };
  if (parts[0] === "p" && parts[1] && parts[2] === "concevoir") return { page: "conceive", project: parts[1] };
  if (parts[0] === "p" && parts[1]) {
    if (parts[2] === "decisions" || parts[2] === "vision") return { page: "project", slug: parts[1], view: parts[2] };
    if (parts[2] === "tasks") return { page: "project", slug: parts[1], view: "tasks", task: parts[3] };
    return { page: "project", slug: parts[1], thread: parts[2] === "t" ? parts[3] : undefined, view: "discussion" };
  }
  return { page: "dashboard" };
}

export function href(route: Route): string {
  if (route.page === "import") return "#/import";
  if (route.page === "quality") return "#/qualite";
  if (route.page === "conceive") return route.project ? `#/p/${encodeURIComponent(route.project)}/concevoir` : "#/concevoir";
  if (route.page === "conception") return `#/c/${route.id}`;
  if (route.page === "project") {
    const base = `#/p/${encodeURIComponent(route.slug)}`;
    if (route.view === "decisions" || route.view === "vision") return `${base}/${route.view}`;
    if (route.view === "tasks") return `${base}/tasks${route.task ? `/${route.task}` : ""}`;
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
        <div className="card narrow">
          <h1>Game Studio Hub</h1>
          {authError === "session" ? (
            <p>
              Aucune session active. Ouvrez le <strong>lien de connexion</strong> affiché dans le terminal où le hub a été lancé
              (il n'est valable qu'une fois ; relancez le hub pour en obtenir un nouveau).
            </p>
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
      <div className="app">
        <Sidebar route={route} session={session} />
        <div className="main">
          {route.page === "dashboard" && <StudioHome />}
          {route.page === "import" && <ImportFlow gamesRoot={session.gamesRoot} />}
          {route.page === "quality" && <QualityView />}
          {route.page === "conceive" && <ConceptionStart project={route.project} />}
          {route.page === "conception" && <ConceptionView key={route.id} id={route.id} />}
          {route.page === "project" && <ProjectShell slug={route.slug} view={route.view ?? "discussion"} threadId={route.thread} taskId={route.task} />}
        </div>
      </div>
    </StudioProvider>
  );
}
