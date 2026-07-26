import { useRouterState } from "@tanstack/react-router";
import { goToView } from "./navigation";

export function NotFoundPage() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <section aria-labelledby="app-not-found-title" className="not-found-shell" data-testid="app-shell-not-found">
      <div className="not-found-panel">
        <p className="not-found-kicker">Not found</p>
        <h1 id="app-not-found-title">This route is not connected</h1>
        <p>
          Smithers could not find <code>{pathname}</code>. No home state or workflow result was loaded for this URL.
        </p>
        <button type="button" className="btn-brand" onClick={() => goToView("home")}>
          Return home
        </button>
      </div>
    </section>
  );
}
