/**
 * A self-contained, prototype-owned surface the chat shell can show in an overlay
 * without a backend. SEAM: mirrors how `PrSummary` feeds the `pr` overlay — the
 * `surface` overlay kind reuses the real, backend-wired Studio surfaces (Runs,
 * Memory, …), which render empty in the chat prototype because no backend is
 * wired. A `Dashboard` is the prototype's populated stand-in: a titled list of
 * sections (stat tiles, status rows, tables) the agent "shows me" inline. Later
 * these are replaced by the real surfaces behind the same overlay host.
 */
export type Dashboard = {
  /** One-line lede under the overlay title. */
  caption: string;
  sections: DashboardSection[];
};

export type DashboardSection =
  | { kind: "stats"; heading: string; tiles: DashboardStat[] }
  | { kind: "status-list"; heading: string; rows: DashboardStatusRow[] }
  | { kind: "table"; heading: string; columns: string[]; rows: DashboardCell[][] };

/** Token name driving accent color; mapped to a CSS var by the renderer. */
export type DashboardTone = "neutral" | "running" | "success" | "warning" | "danger" | "accent";

export type DashboardStat = {
  label: string;
  value: string;
  /** Optional secondary line (delta, sublabel). */
  detail?: string;
  tone?: DashboardTone;
};

export type DashboardStatusRow = {
  title: string;
  detail: string;
  /** Short status word shown right-aligned (e.g. "pass", "500", "running"). */
  status: string;
  tone?: DashboardTone;
};

/** A table cell; `tone` colors the text using a run-state/severity token. */
export type DashboardCell = { text: string; tone?: DashboardTone; mono?: boolean };
