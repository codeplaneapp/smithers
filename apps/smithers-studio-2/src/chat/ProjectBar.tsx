import { useState } from "react";
import { useProjects } from "./projects/useProjects";
import { ProjectSwitcher } from "./projects/ProjectSwitcher";
import { TagFilterBar } from "./tags/TagFilterBar";
import { ViewsMenu } from "./ViewsMenu";
import { useOverlayStore } from "./overlay/overlayStore";
import type { Tag } from "./tags/Tag";

/**
 * The TopBar — the only persistent chrome in the chat shell (Product spec §3,
 * Design spec §2). Left: project chip (click to switch). Center: tag filter bar
 * (display + filter only). Right: Views ▾ dropdown, History (past workflows),
 * and the Settings gear. No tabbed-shell chrome lives here.
 */
export function ProjectBar({ tags }: { tags: Tag[] }) {
  const { current } = useProjects();
  const openOverlay = useOverlayStore((s) => s.open);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  return (
    <header className="project-bar" data-testid="project-bar">
      <div className="project-bar-left">
        <button
          aria-expanded={switcherOpen}
          className="project-chip"
          data-testid="project-chip"
          onClick={() => setSwitcherOpen((open) => !open)}
          style={{ ["--project-color" as string]: current.color }}
          type="button"
        >
          <span className="project-dot" style={{ background: current.color }} />
          <span className="project-name">{current.name}</span>
          <span className="project-caret">▾</span>
        </button>
        {switcherOpen && <ProjectSwitcher onClose={() => setSwitcherOpen(false)} />}
      </div>

      <TagFilterBar tags={tags} />

      <div className="project-bar-right">
        <ViewsMenu />
        <button
          className="topbar-btn"
          data-testid="history-button"
          onClick={() => openOverlay({ kind: "dashboard", title: "History", dashboard: "workflows" }, "split")}
          title="Past workflows"
          type="button"
        >
          History
        </button>
        <button
          className="project-bar-gear"
          data-testid="settings-gear"
          onClick={() => openOverlay({ kind: "settings", title: "Settings" }, "split")}
          title="Settings"
          type="button"
        >
          ⚙
        </button>
      </div>
    </header>
  );
}
