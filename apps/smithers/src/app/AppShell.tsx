import { Link, Outlet } from "@tanstack/react-router";
import { ConnectionBadge } from "@smithers-orchestrator/gateway-ui";
import { useUiStore } from "./uiStore";
import { CornerLogo } from "./CornerLogo";
import { SmithersMark } from "./SmithersMark";
import { Toasts } from "../notifications/Toasts";
import { ControlRing } from "../control/ControlRing";
import { ControlRequestDialog } from "../control/ControlRequestDialog";

/** The primary navigation entries — every local-capable surface. */
const NAV: ReadonlyArray<{ to: string; label: string }> = [
  { to: "/", label: "Workflows" },
  { to: "/runs", label: "Runs" },
  { to: "/approvals", label: "Approvals" },
  { to: "/agents", label: "Agents" },
  { to: "/memory", label: "Memory" },
  { to: "/scores", label: "Scores" },
  { to: "/crons", label: "Triggers" },
  { to: "/prompts", label: "Prompts" },
  { to: "/tickets", label: "Tickets" },
  { to: "/palette", label: "Palette" },
];

/**
 * The application shell. The cloud `multi` app is chat-first (a composer rail +
 * transcript); this LOCAL UI is navigation-first. The left rail is a fixed list
 * of every gateway-backed surface plus a live connection indicator; the main
 * canvas renders the active page through <Outlet/>.
 */
export function AppShell() {
  const navDir = useUiStore((state) => state.navDir);

  return (
    <main className="app-shell" data-mode="sidebar">
      <Toasts />
      <CornerLogo />
      <ControlRing />
      <ControlRequestDialog />

      <aside className="nav-rail">
        <header className="nav-head">
          <SmithersMark part="nav-brand" aria-hidden="true" />
          <span className="nav-brand-text">Smithers</span>
        </header>
        <nav className="nav-links">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="nav-link"
              activeProps={{ className: "nav-link is-active" }}
              activeOptions={{ exact: item.to === "/" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <footer className="nav-foot">
          <ConnectionBadge />
        </footer>
      </aside>

      <section className="main-canvas" data-dir={navDir}>
        <Outlet />
      </section>
    </main>
  );
}
