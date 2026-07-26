import { useCallback, useEffect, useState } from "react";
import { EmptyState, SmithersUiStyles, Spinner } from "smithers-orchestrator/ui";
import { fetchArchive, fetchIssueByDate, fetchLatestIssue } from "./api";
import { ArchivePage } from "./components/ArchivePage";
import { IssueView } from "./components/IssueView";
import { Masthead } from "./components/Masthead";
import type { PublicIssue } from "./types";

type Route = { page: "issue"; date: "latest" | string } | { page: "archive" };

function routeFromLocation(): Route {
  const path = window.location.pathname;
  if (path === "/archive") return { page: "archive" };
  const match = path.match(/^\/issue\/(\d{4}-\d{2}-\d{2})$/);
  if (match) return { page: "issue", date: match[1]! };
  return { page: "issue", date: "latest" };
}

function pathFor(route: Route): string {
  if (route.page === "archive") return "/archive";
  return route.date === "latest" ? "/" : `/issue/${route.date}`;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => routeFromLocation());
  const [issue, setIssue] = useState<PublicIssue | null | undefined>(undefined);
  const [dates, setDates] = useState<string[]>([]);

  const navigate = useCallback((next: Route) => {
    window.history.pushState(null, "", pathFor(next));
    setRoute(next);
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (route.page === "issue") {
      setIssue(undefined);
      const load = route.date === "latest" ? fetchLatestIssue() : fetchIssueByDate(route.date);
      load.then((result) => {
        if (!cancelled) setIssue(result);
      });
    } else {
      fetchArchive().then((result) => {
        if (!cancelled) setDates(result);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [route]);

  return (
    <div className="signal-app">
      <SmithersUiStyles />
      <Masthead
        date={issue?.date}
        degraded={issue?.degraded}
        onNavigateHome={() => navigate({ page: "issue", date: "latest" })}
        onNavigateArchive={() => navigate({ page: "archive" })}
      />
      <main className="signal-main">
        {route.page === "archive" ? (
          <ArchivePage dates={dates} onOpen={(date) => navigate({ page: "issue", date })} />
        ) : issue === undefined ? (
          <div className="signal-loading">
            <Spinner /> Loading the day's issue…
          </div>
        ) : issue === null ? (
          <EmptyState
            title="No issue published yet"
            description="The Smithers Signal publishes daily by 7am ET. Check back soon, or browse the archive."
          />
        ) : (
          <IssueView issue={issue} />
        )}
      </main>
      <footer className="signal-footer">
        <p>
          The Smithers Signal — a daily, deterministic-first intelligence brief generated and published by a durable
          Smithers workflow.
        </p>
      </footer>
    </div>
  );
}
