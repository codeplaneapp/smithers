import type { Surface } from "./app/Surface";

/**
 * The canvas surfaces the command menu jumps to, below the three modes. Pure data
 * like {@link COMMANDS} in `commands.ts` — a label and the {@link Surface} that
 * `openSurface` routes to — so the menu stays declarative and the list is
 * unit-testable without a DOM. Order matches the dropdown's "Go to" section.
 */
export type NavLink = {
  id: string;
  label: string;
  surface: Surface;
};

export const NAV_LINKS: NavLink[] = [
  { id: "runs", label: "Runs", surface: { kind: "runs" } },
  { id: "tickets", label: "Tickets", surface: { kind: "tickets" } },
  { id: "approvals", label: "Approvals", surface: { kind: "approvals" } },
  { id: "agents", label: "Agents", surface: { kind: "agents" } },
  { id: "memory", label: "Memory", surface: { kind: "memory" } },
  { id: "files", label: "Files", surface: { kind: "files" } },
  { id: "vcs", label: "VCS", surface: { kind: "vcs" } },
  { id: "prompts", label: "Prompts", surface: { kind: "prompts" } },
  { id: "scores", label: "Scores", surface: { kind: "scores" } },
  { id: "crons", label: "Crons", surface: { kind: "crons" } },
  { id: "gallery", label: "UI Gallery", surface: { kind: "gallery" } },
];
