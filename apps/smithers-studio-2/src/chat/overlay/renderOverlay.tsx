import type { ReactNode } from "react";
import type { Overlay } from "./Overlay";
import { IframeOverlay } from "./IframeOverlay";
import { SandboxOverlay } from "./SandboxOverlay";
import { PrOverlay } from "./PrOverlay";
import { TerminalOverlay } from "./TerminalOverlay";
import { SurfaceOverlay } from "./SurfaceOverlay";
import { DashboardOverlay } from "./dashboard/DashboardOverlay";
import { dashboards } from "./dashboard/dashboards";
import { SettingsOverlay } from "../settings/SettingsOverlay";
import { HtmlContent } from "../feed/HtmlContent";

/** Switch an overlay descriptor onto its renderer. */
export function renderOverlay(overlay: Overlay): ReactNode {
  switch (overlay.kind) {
    case "iframe":
      return <IframeOverlay url={overlay.url} />;
    case "workflow-ui":
      return <IframeOverlay url={overlay.url} />;
    case "sandbox":
      return <SandboxOverlay url={overlay.url} />;
    case "pr":
      return <PrOverlay pr={overlay.pr} />;
    case "terminal":
      return <TerminalOverlay />;
    case "surface":
      return <SurfaceOverlay surface={overlay.surface} />;
    case "dashboard":
      return <DashboardOverlay dashboard={dashboards[overlay.dashboard]} />;
    case "settings":
      return <SettingsOverlay />;
    case "html":
      return <HtmlContent html={overlay.html} />;
  }
}
