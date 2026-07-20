/**
 * The command palette / quick-open surface: one input that fuzzy-searches files,
 * workspaces, commands, and slash actions, with the leading sigil selecting the
 * mode (`@` files, `>` commands, `/` slash, `?` ask-AI, `#` work items, none =
 * open-anything). Ported from the Swift CommandPaletteView + the file-mention
 * fuzzy ranker; seeded with real paths from this repo so it reads true (apps/
 * smithers has no real file index yet).
 *
 * Everything below the seed data is pure — the query parser, the fuzzy scorer,
 * the rankers, and the section grouper — so they are unit-tested without a DOM
 * (see paletteDomain.test.ts). The fuzzy scorer is the load-bearing ranking.
 */

/** The mode the leading sigil selects. */
export type PaletteMode = "open" | "files" | "commands" | "slash" | "ask" | "work";

/** A parsed query: the mode its sigil selected and the remaining search text. */
export type ParsedQuery = {
  mode: PaletteMode;
  /** The query minus its sigil, trimmed. */
  searchText: string;
  /** The active sigil char, or "" in open-anything mode. */
  sigil: string;
};

/** The section a result belongs to; drives the uppercase section headers. */
export type PaletteSection = "recent" | "files" | "workspaces" | "commands" | "slash" | "ai";

/** The kind of a result row, which picks its icon and its execute behavior. */
export type PaletteItemKind = "file" | "workspace" | "command" | "slash" | "ask";

/** A seeded workspace file: its full repo-relative path is the search target. */
export type FileEntry = {
  path: string;
};

/** A seeded workspace/project, mirroring ComposerBar's PROJECTS. */
export type Workspace = {
  name: string;
  /** Whether this workspace is the active project (rendered disabled). */
  active: boolean;
};

/** One palette command in the fixed catalog (New Run, Refresh, …). */
export type PaletteCommand = {
  id: string;
  title: string;
  subtitle: string;
  /** A monospace shortcut chip, e.g. "Cmd+N". */
  shortcut?: string;
};

/** One known feature slash command, mirroring what runSlash already owns. */
export type SlashCommand = {
  name: string;
  summary: string;
};

/**
 * A resolved result row. Every section flattens to this so the canvas renders one
 * list and the section grouper only needs each row's `section`.
 */
export type PaletteItem = {
  id: string;
  kind: PaletteItemKind;
  section: PaletteSection;
  /** The bold row title (filename last-component for files). */
  title: string;
  /** The dim subtitle (full path for files). */
  subtitle: string;
  /** An optional right-aligned monospace shortcut/badge chip. */
  shortcut?: string;
  /** Disabled rows render dimmed and are non-selectable / non-executable. */
  disabled: boolean;
  /** The raw value the item carries (file path, workspace name, slash name…). */
  value: string;
  /** Match positions into `title` from the fuzzy pass, for <mark> highlighting. */
  titleMatches: number[];
  /** Match positions into `subtitle` (the path) from the fuzzy pass. */
  subtitleMatches: number[];
};

/* ----------------------------------------------------------------------------
 * Seed data — deterministic, drawn from this very repo.
 * ------------------------------------------------------------------------- */

/** ~36 real repo paths so the picker reads true. Seed order is git/tree order. */
export const WORKSPACE_FILES: FileEntry[] = [
  { path: "apps/smithers/src/app/ComposerBar.tsx" },
  { path: "apps/smithers/src/app/runSlash.ts" },
  { path: "apps/smithers/src/app/navigation.ts" },
  { path: "apps/smithers/src/app/router.ts" },
  { path: "apps/smithers/src/app/Surface.ts" },
  { path: "apps/smithers/src/app/AppShell.tsx" },
  { path: "apps/smithers/src/chat/chatStore.ts" },
  { path: "apps/smithers/src/vcs/VcsCanvas.tsx" },
  { path: "apps/smithers/src/vcs/vcsStore.ts" },
  { path: "apps/smithers/src/vcs/vcs.ts" },
  { path: "apps/smithers/src/issues/IssuesCanvas.tsx" },
  { path: "apps/smithers/src/issues/issuesStore.ts" },
  { path: "apps/smithers/src/cards/Card.ts" },
  { path: "apps/smithers/src/cards/CardView.tsx" },
  { path: "apps/smithers/src/cards/featureCards.css" },
  { path: "apps/smithers/src/cards/cardUiStore.ts" },
  { path: "apps/smithers/src/palette/palette.ts" },
  { path: "apps/smithers/src/palette/paletteStore.ts" },
  { path: "apps/smithers/src/palette/PaletteCanvas.tsx" },
  { path: "apps/smithers/src/runs/RunCard.tsx" },
  { path: "apps/smithers/src/runs/RunsCard.tsx" },
  { path: "apps/smithers/src/runs/runsStore.ts" },
  { path: "apps/smithers/src/runs/NodeInspector.tsx" },
  { path: "apps/smithers/src/diff/DiffCanvas.tsx" },
  { path: "apps/smithers/src/diff/DiffCard.tsx" },
  { path: "apps/smithers/src/approvals/ApprovalCard.tsx" },
  { path: "apps/smithers/src/crons/CronsCard.tsx" },
  { path: "apps/smithers/src/prompts/PromptsCard.tsx" },
  { path: "apps/smithers/src/human/HumanCard.tsx" },
  { path: "apps/cli/src/workflow-pack.js" },
  { path: "packages/core/src/engine.ts" },
  { path: "packages/core/src/workflow.ts" },
  { path: ".smithers/workflows/vcs.tsx" },
  { path: ".smithers/ui/vcs.tsx" },
  { path: "README.md" },
  { path: "CLAUDE.md" },
  { path: "package.json" },
];

/** A fixed recency order for empty-query Files mode (most-recent first, seeded). */
export const RECENT_PATHS: string[] = [
  "apps/smithers/src/palette/palette.ts",
  "apps/smithers/src/app/runSlash.ts",
  "apps/smithers/src/vcs/VcsCanvas.tsx",
  "CLAUDE.md",
];

/** The seeded workspaces, mirroring ComposerBar's PROJECTS; first is active. */
export const PROJECTS: Workspace[] = [
  { name: "Smithers Web", active: true },
  { name: "Personal", active: false },
  { name: "Sandbox", active: false },
  { name: "Marketing Site", active: false },
];

/** The fixed command catalog the palette exposes (ported from the Swift list). */
export const PALETTE_COMMANDS: PaletteCommand[] = [
  { id: "new-run", title: "New Run", subtitle: "Launch a fresh workflow run", shortcut: "Cmd+N" },
  { id: "close-surface", title: "Close Surface", subtitle: "Return to the chat", shortcut: "Esc" },
  { id: "refresh", title: "Refresh", subtitle: "Re-fetch the active view", shortcut: "Cmd+R" },
  { id: "global-search", title: "Global Search", subtitle: "Search everything", shortcut: "Cmd+Shift+F" },
  { id: "shortcuts", title: "Keyboard Shortcuts", subtitle: "Show the key map", shortcut: "Cmd+/" },
];

/** The known feature slash commands runSlash owns, with one-line descriptions. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "run", summary: "Launch a new run" },
  { name: "diff", summary: "Show the latest diff" },
  { name: "vcs", summary: "Open the working tree" },
  { name: "files", summary: "Browse the repo file tree" },
  { name: "terminal", summary: "Open a terminal in the sandbox" },
  { name: "issues", summary: "Browse the issue tracker" },
  { name: "tickets", summary: "Browse support tickets" },
  { name: "landings", summary: "Browse landing pages" },
  { name: "logs", summary: "Tail the run log" },
  { name: "timeline", summary: "Scrub the run timeline" },
  { name: "approvals", summary: "Review pending approvals" },
  { name: "agents", summary: "Inspect the agent registry" },
  { name: "memory", summary: "Query cross-run memory" },
  { name: "scores", summary: "View scorer results" },
  { name: "crons", summary: "Manage schedule triggers" },
  { name: "prompts", summary: "Edit prompt templates" },
  { name: "human", summary: "Resolve human tasks" },
  { name: "signal", summary: "Deliver a run signal" },
];

/* ----------------------------------------------------------------------------
 * Pure query parsing.
 * ------------------------------------------------------------------------- */

/** Map a leading sigil char to a palette mode (no sigil ⇒ open-anything). */
function modeForSigil(sigil: string): PaletteMode {
  switch (sigil) {
    case "@":
      return "files";
    case ">":
      return "commands";
    case "/":
      return "slash";
    case "?":
      return "ask";
    case "#":
      return "work";
    default:
      return "open";
  }
}

/** The sigil a mode prepends when its tab is clicked ("" for open-anything). */
export function sigilForMode(mode: PaletteMode): string {
  switch (mode) {
    case "files":
      return "@";
    case "commands":
      return ">";
    case "slash":
      return "/";
    case "ask":
      return "?";
    case "work":
      return "#";
    default:
      return "";
  }
}

/** A human title for the mode, shown as the sub-label under the input. */
export function modeLabel(mode: PaletteMode): string {
  switch (mode) {
    case "files":
      return "Files";
    case "commands":
      return "Command Mode";
    case "slash":
      return "Slash Commands";
    case "ask":
      return "Ask AI";
    case "work":
      return "Work Items";
    default:
      return "Open Anything";
  }
}

/**
 * Parse the leading sigil out of a query (Swift CommandPaletteQueryParser.parse):
 * strip leading whitespace, read the first char; if it is a known sigil the rest
 * (trimmed) is the search text, otherwise the whole thing is open-anything text.
 */
export function parseQuery(raw: string): ParsedQuery {
  const trimmedLeading = raw.replace(/^\s+/, "");
  const first = trimmedLeading.charAt(0);
  const sigils = new Set(["@", ">", "/", "?", "#"]);
  if (sigils.has(first)) {
    return {
      mode: modeForSigil(first),
      sigil: first,
      searchText: trimmedLeading.slice(1).trim(),
    };
  }
  return { mode: "open", sigil: "", searchText: trimmedLeading.trim() };
}

/* ----------------------------------------------------------------------------
 * Fuzzy matching — the load-bearing ranking, ported from the Go fuzzyScore in
 * the file-mention prompt.
 * ------------------------------------------------------------------------- */

/** True when a char follows a path word boundary (`/`, `_`, `.`, `-`). */
function isBoundary(ch: string): boolean {
  return ch === "/" || ch === "_" || ch === "." || ch === "-";
}

/**
 * Subsequence fuzzy match. Walk the query over the (lowercased) target; every
 * query char must appear in order or the match fails. Reward consecutive runs
 * (+3), word-boundary hits (+2), plain hits (+1), and shorter targets. Returns
 * the score and the matched target indices (for highlighting), or -1 / [] when
 * not every query char matched. Empty query is a trivial match at score 0.
 */
export function fuzzyMatch(query: string, target: string): { score: number; matches: number[] } {
  if (query === "") return { score: 0, matches: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  const matches: number[] = [];
  for (let qi = 0; qi < q.length; qi += 1) {
    const qc = q[qi];
    let found = -1;
    for (let i = ti; i < t.length; i += 1) {
      if (t[i] === qc) {
        found = i;
        break;
      }
    }
    if (found === -1) return { score: -1, matches: [] };
    if (found === prevMatch + 1) {
      score += 3; // consecutive run
    } else if (found === 0 || isBoundary(t[found - 1])) {
      score += 2; // word boundary
    } else {
      score += 1; // plain in-order hit
    }
    matches.push(found);
    prevMatch = found;
    ti = found + 1;
  }
  // Shorter targets are better: a small bonus that never outweighs the matches.
  score += Math.max(0, 24 - target.length) / 24;
  return { score, matches };
}

/** Just the score from fuzzyMatch, for unit tests and ranking. */
export function fuzzyScore(query: string, target: string): number {
  return fuzzyMatch(query, target).score;
}

/* ----------------------------------------------------------------------------
 * Ranking + grouping.
 * ------------------------------------------------------------------------- */

/** The filename last-path-component, the bold file row title. */
export function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/**
 * Rank files against a query, descending by score. Ties break by shorter path
 * then lexicographic, mirroring the prompt's tie-break. Files whose query chars
 * don't all match (score -1) are excluded. With an empty query, every file
 * passes (score 0) and the input order is preserved.
 */
export function rankFiles(query: string, files: FileEntry[], limit: number): PaletteItem[] {
  const scored = files
    .map((file) => {
      const onName = fuzzyMatch(query, fileName(file.path));
      const onPath = fuzzyMatch(query, file.path);
      // Score against the full path so deeply-nested matches still rank; keep the
      // best of name/path so a filename hit isn't buried by a long prefix.
      const score = Math.max(onName.score, onPath.score);
      return { file, score, onPath };
    })
    .filter((row) => row.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.file.path.length !== b.file.path.length) {
        return a.file.path.length - b.file.path.length;
      }
      return a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0;
    })
    .slice(0, limit);

  return scored.map((row) => {
    const name = fileName(row.file.path);
    const nameMatch = fuzzyMatch(query, name);
    return {
      id: `file:${row.file.path}`,
      kind: "file" as const,
      section: "files" as const,
      title: name,
      subtitle: row.file.path,
      disabled: false,
      value: row.file.path,
      titleMatches: nameMatch.matches,
      subtitleMatches: row.onPath.matches,
    };
  });
}

/** Build the recency-ordered, empty-query file list for @/Files mode. */
export function recentFiles(recentPaths: string[], files: FileEntry[]): PaletteItem[] {
  const known = new Set(files.map((file) => file.path));
  return recentPaths
    .filter((path) => known.has(path))
    .map((path) => ({
      id: `recent:${path}`,
      kind: "file" as const,
      section: "recent" as const,
      title: fileName(path),
      subtitle: path,
      disabled: false,
      value: path,
      titleMatches: [],
      subtitleMatches: [],
    }));
}

/** Substring case-insensitive contains, the cheap filter for non-file sections. */
function contains(text: string, query: string): boolean {
  if (query === "") return true;
  return text.toLowerCase().includes(query.toLowerCase());
}

/** Map a workspace to a (possibly disabled) result row. */
function workspaceItem(workspace: Workspace): PaletteItem {
  return {
    id: `ws:${workspace.name}`,
    kind: "workspace",
    section: "workspaces",
    title: workspace.name,
    subtitle: workspace.active ? "Active workspace" : "Switch project",
    disabled: workspace.active,
    value: workspace.name,
    titleMatches: [],
    subtitleMatches: [],
  };
}

/** Map a command to a result row. */
function commandItem(command: PaletteCommand): PaletteItem {
  return {
    id: `cmd:${command.id}`,
    kind: "command",
    section: "commands",
    title: command.title,
    subtitle: command.subtitle,
    shortcut: command.shortcut,
    disabled: false,
    value: command.id,
    titleMatches: [],
    subtitleMatches: [],
  };
}

/** Map a slash command to a result row. */
function slashItem(slash: SlashCommand): PaletteItem {
  return {
    id: `slash:${slash.name}`,
    kind: "slash",
    section: "slash",
    title: `/${slash.name}`,
    subtitle: slash.summary,
    disabled: false,
    value: slash.name,
    titleMatches: [],
    subtitleMatches: [],
  };
}

/** The Ask-AI affordance row, shown in `?` mode with a non-empty query. */
function askItem(searchText: string): PaletteItem {
  return {
    id: "ask:ai",
    kind: "ask",
    section: "ai",
    title: `Ask AI: ${searchText}`,
    subtitle: "Send this to chat",
    disabled: searchText === "",
    value: searchText,
    titleMatches: [],
    subtitleMatches: [],
  };
}

/** The inputs the result builder reads, all seeded in the store. */
export type ResultInputs = {
  files: FileEntry[];
  recentPaths: string[];
  workspaces: Workspace[];
  commands: PaletteCommand[];
  slashCommands: SlashCommand[];
};

const FILE_LIMIT = 20;
const WIDE_LIMIT = 80;

/**
 * Build the flat, ordered result list for a parsed query. The mode picks which
 * sections appear; open-anything blends files + workspaces + commands. This is
 * the single source the canvas renders and the store indexes for selection.
 */
export function buildResults(parsed: ParsedQuery, inputs: ResultInputs): PaletteItem[] {
  const { mode, searchText } = parsed;

  if (mode === "files") {
    if (searchText === "") return recentFiles(inputs.recentPaths, inputs.files);
    return rankFiles(searchText, inputs.files, FILE_LIMIT);
  }

  if (mode === "commands") {
    return inputs.commands
      .filter((command) => contains(command.title, searchText) || contains(command.subtitle, searchText))
      .map(commandItem)
      .slice(0, WIDE_LIMIT);
  }

  if (mode === "slash") {
    return inputs.slashCommands
      .map((slash) => ({ slash, score: fuzzyScore(searchText, slash.name) }))
      .filter((row) => row.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((row) => slashItem(row.slash))
      .slice(0, WIDE_LIMIT);
  }

  if (mode === "ask") {
    return [askItem(searchText)];
  }

  if (mode === "work") {
    // Work items are out of scope for the mock; surface an Ask-AI fallback so the
    // mode is still discoverable rather than dead.
    return searchText === "" ? [] : [askItem(searchText)];
  }

  // open-anything: ranked files, then matching workspaces, then matching commands.
  const fileRows =
    searchText === ""
      ? inputs.files.slice(0, FILE_LIMIT).map((file) => ({
          id: `file:${file.path}`,
          kind: "file" as const,
          section: "files" as const,
          title: fileName(file.path),
          subtitle: file.path,
          disabled: false,
          value: file.path,
          titleMatches: [] as number[],
          subtitleMatches: [] as number[],
        }))
      : rankFiles(searchText, inputs.files, FILE_LIMIT)
          // open-anything keeps the file section; mark it 'files' not 'recent'.
          .map((item) => ({ ...item, section: "files" as const }));

  const workspaceRows = inputs.workspaces
    .filter((workspace) => contains(workspace.name, searchText))
    .map(workspaceItem);

  const commandRows = inputs.commands
    .filter((command) => contains(command.title, searchText))
    .map(commandItem);

  return [...fileRows, ...workspaceRows, ...commandRows].slice(0, WIDE_LIMIT);
}

/** The uppercase header label for a section. */
export function sectionLabel(section: PaletteSection): string {
  switch (section) {
    case "recent":
      return "RECENT";
    case "files":
      return "FILES";
    case "workspaces":
      return "WORKSPACES";
    case "commands":
      return "COMMANDS";
    case "slash":
      return "SLASH COMMANDS";
    case "ai":
      return "AI";
  }
}

/** One rendered group: its section header plus the items under it, in order. */
export type ResultSection = {
  section: PaletteSection;
  label: string;
  /** Items paired with their flat index, so the row can key off selectedIndex. */
  items: { item: PaletteItem; index: number }[];
};

/**
 * Group a flat result list into sections, emitting a header only when an item's
 * section differs from the previous item's (Swift shouldShowSectionHeader). The
 * flat index is preserved on each item so the canvas can match selectedIndex.
 */
export function sections(items: PaletteItem[]): ResultSection[] {
  const groups: ResultSection[] = [];
  let current: ResultSection | null = null;
  items.forEach((item, index) => {
    if (!current || current.section !== item.section) {
      current = { section: item.section, label: sectionLabel(item.section), items: [] };
      groups.push(current);
    }
    current.items.push({ item, index });
  });
  return groups;
}
