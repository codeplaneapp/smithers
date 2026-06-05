import type { ViewId } from "../../useStudioStore";
import type { PrSummary } from "./PrSummary";
import type { DashboardKey } from "./dashboard/dashboards";

/**
 * Something rendered over — or split beside — the chat. The agent opens an
 * overlay (its "show me" tool), and slash commands open the default overlay for
 * their feature. `surface` reuses an existing Studio surface verbatim, so "the
 * default UI is just displayed" instead of being navigated to.
 */
export type Overlay =
  | { kind: "iframe"; title: string; url: string }
  | { kind: "pr"; title: string; pr: PrSummary }
  | { kind: "terminal"; title: string }
  | { kind: "sandbox"; title: string; url: string }
  | { kind: "surface"; title: string; surface: ViewId }
  | { kind: "dashboard"; title: string; dashboard: DashboardKey }
  | { kind: "workflow-ui"; title: string; url: string }
  | { kind: "settings"; title: string }
  | { kind: "html"; title: string; html: string };

/** Whether an overlay sits beside the chat (`split`) or covers it (`full`). */
export type OverlayPresentation = "split" | "full";
