import type { ReactNode } from "react";
import type { ViewId } from "../../useStudioStore";
import { Runs } from "../../runs/Runs";
import { Workflows } from "../../workflows/Workflows";
import { IssuesPanel } from "../../issues/IssuesPanel";
import { LandingsPanel } from "../../landings/LandingsPanel";
import { WorkspacesPanel } from "../../workspaces/WorkspacesPanel";
import { Memory } from "../../memory/Memory";
import { Scores } from "../../scores/Scores";
import { Search } from "../../search/Search";
import { DevTools } from "../../developer/DevTools";

/**
 * Renders an existing Studio surface verbatim inside an overlay — "the default
 * UI is just displayed" rather than navigated to. Reuses the real, fully-wired
 * surface components, so anything they show (real runs, workflows, memory) shows
 * here too.
 */
export function SurfaceOverlay({ surface }: { surface: ViewId }) {
  return <div className="overlay-surface" data-testid="overlay-surface">{renderSurface(surface)}</div>;
}

function renderSurface(surface: ViewId): ReactNode {
  switch (surface) {
    case "runs":
      return <Runs />;
    case "workflows":
      return <Workflows />;
    case "issues":
      return <IssuesPanel />;
    case "landings":
      return <LandingsPanel />;
    case "workspaces":
      return <WorkspacesPanel />;
    case "memory":
      return <Memory />;
    case "scores":
      return <Scores />;
    case "search":
      return <Search />;
    case "devtools":
      return <DevTools />;
    default:
      return <div className="overlay-surface-empty">No default view for “{surface}”.</div>;
  }
}
