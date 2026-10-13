import { useEffect, useState } from "react";
import { api, ApiError, type SessionInfo } from "./api.ts";
import { Dashboard } from "./pages/Dashboard.tsx";
import { ImportFlow } from "./pages/ImportFlow.tsx";
import { ProjectShell } from "./pages/ProjectShell.tsx";

export type Route =
  | { page: "dashboard" }
  | { page: "import" }
  | { page: "project"; slug: string; thread?: string; task?: string; view?: "discussion" | "decisions" | "vision" | "tasks" };

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "import") return { page: "import" };
  if (parts[0] === "p" && parts[1]) {
    if (parts[2] === "decisions" || parts[2] === "vision") return { page: "project", slug: parts[1], view: parts[2] };
    if (parts[2] === "tasks") return { page: "project", slug: parts[1], view: "tasks", task: parts[3] };
    return { page: "project", slug: parts[1], thread: parts[2] === "t" ? parts[3] : undefined, view: "discussion" };
  }
  return { page: "dashboard" };
}

export function href(route: Route): string {
  if (route.page === "import") return "#/import";
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
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">
          Game Studio Hub
        </a>
        <span className="muted small">
          orchestrateur : {session.orchestrator} · jeux : {session.gamesRoot}
        </span>
      </header>
      {route.page === "dashboard" && <Dashboard />}
      {route.page === "import" && <ImportFlow gamesRoot={session.gamesRoot} />}
      {route.page === "project" && <ProjectShell slug={route.slug} view={route.view ?? "discussion"} threadId={route.thread} taskId={route.task} />}
    </div>
  );
}
