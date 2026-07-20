import type { Run, RunNode } from "./Run";

/**
 * Pure helpers behind the node-inspector enrichment: the ancestry breadcrumb,
 * the props table, the tool-call side-effect badge, and prompt-key linking. Kept
 * out of the component (zero DOM, zero store) so the breadcrumb derivation, the
 * row builder, the value formatter, and the keyword tone map are unit-tested in
 * nodePropsDomain.test.ts. Ports NodeInspectorView / PropsTableView / PropValueView
 * and sideEffectStyle from the Swift LiveRun inspector.
 */

/** Container kinds that orchestrate children rather than run a task. Their
 *  inspector hides the task-only tabs (Output/Diff/Logs/Tools) and shows a
 *  one-line role description instead (ports nodeRoleDescription). */
const CONTAINER_KINDS = new Set([
  "merge",
  "loop",
  "branch",
  "signal",
]);

/** Prop keys that name a prompt; the props table links these to the prompts
 *  surface with an "open prompt ↗" affordance (ports PropsTableView.promptKeys). */
export const PROMPT_KEYS: string[] = [
  "prompt",
  "promptId",
  "prompt_id",
  "promptPath",
  "promptName",
  "promptKey",
  "prompt_key",
  "text",
];

/**
 * The path from the run root down to `id`, inclusive of both ends. Drives the
 * clickable ancestry breadcrumb (root › sequence › edit-files › auth/token.ts).
 * Returns just `[root]` when the id is the root or is missing, so the breadcrumb
 * always has at least one crumb. Depth-first, first match wins (ids are unique).
 */
export function pathToNode(root: RunNode, id: string): RunNode[] {
  if (root.id === id) {
    return [root];
  }
  for (const child of root.children ?? []) {
    const below = pathToNode(child, id);
    if (below.length && below[below.length - 1].id === id) {
      return [root, ...below];
    }
  }
  return [root];
}

/** True for orchestration containers (workflow/sequence/parallel/loop/…). The
 *  inspector renders a role description and the Props tab for these, hiding the
 *  task-only tabs. */
export function isContainerNode(node: RunNode): boolean {
  return CONTAINER_KINDS.has(node.kind);
}

/** One-line description of what a container node does, shown as the props
 *  footer (ports NodeInspectorView.nodeRoleDescription). Empty for task nodes. */
export function nodeRoleDescription(node: RunNode): string {
  switch (node.kind) {
    case "merge":
      return "Runs children in order, one after another.";
    case "loop":
      return "Repeats its body for each item until the collection is exhausted.";
    case "branch":
      return "Runs one of several paths based on a condition.";
    case "signal":
      return "Waits for an external signal before its children proceed.";
    default:
      return "";
  }
}

export type PropValue = string | number | boolean | null;

export type PropRow = {
  /** Display + state key for the expand toggle. */
  key: string;
  value: PropValue;
};

/**
 * The props table rows for a node, sorted by key (ports PropsTableView's sorted
 * keys). The set mirrors the previous flat Props kv plus the prompt linkage
 * surface and a few node facts, all deterministic — no clock, no derivation from
 * wall time. `run` supplies the frame counters the old Props tab showed.
 */
export function propRows(node: RunNode, run: Run): PropRow[] {
  const rows: PropRow[] = [
    { key: "id", value: node.id },
    { key: "kind", value: node.kind },
    { key: "status", value: node.status },
    { key: "name", value: node.name },
    { key: "agent", value: node.agent ?? null },
    { key: "frame", value: run.frame },
    { key: "frameCount", value: run.frameCount },
    { key: "toolCalls", value: node.toolCalls?.length ?? 0 },
  ];
  if (node.cardLabel !== undefined) {
    rows.push({ key: "cardLabel", value: node.cardLabel });
  }
  if (node.meta !== undefined) {
    rows.push({ key: "meta", value: node.meta });
  }
  if (node.output !== undefined) {
    // The prompt the node ran — keyed `prompt` so the table auto-links it.
    rows.push({ key: "prompt", value: node.output });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

/** True when a prop key names a prompt (case-sensitive, ported verbatim). */
export function isPromptKey(key: string): boolean {
  return PROMPT_KEYS.includes(key);
}

export type PropFormat = {
  /** The rendered text. */
  text: string;
  /** Tone class suffix for the value (string/num/bool/null). */
  tone: "string" | "num" | "bool" | "null";
  /** True when the raw string is long enough to clamp + offer [expand]. */
  expandable: boolean;
};

/** Threshold above which a string preview clamps and offers an expand toggle
 *  (ports PropValueView's 200-char boundary). */
export const PROP_EXPAND_THRESHOLD = 200;

/**
 * Pretty-print a single prop value for the table. Mirrors PropValueView: null →
 * "null", booleans → "true"/"false", numbers verbatim, strings as-is. Long
 * strings are flagged `expandable` so the row clamps to 3 lines with an
 * [expand]/[collapse] toggle keyed by prop path in the UI store.
 */
export function formatPropValue(value: PropValue): PropFormat {
  if (value === null) {
    return { text: "null", tone: "null", expandable: false };
  }
  if (typeof value === "boolean") {
    return { text: value ? "true" : "false", tone: "bool", expandable: false };
  }
  if (typeof value === "number") {
    return { text: String(value), tone: "num", expandable: false };
  }
  return {
    text: value,
    tone: "string",
    expandable: value.length > PROP_EXPAND_THRESHOLD,
  };
}

/** Raw, copyable text for a prop value (what the doc.on.doc copy button writes
 *  to navigator.clipboard). Strings copy verbatim; others stringify. */
export function copyablePropValue(value: PropValue): string {
  return value === null ? "null" : String(value);
}

export type SideEffectTone = "idle" | "waiting" | "info";

/** Keywords that mark a tool call as a mutating/side-effecting operation; the
 *  badge tones to "waiting" (caution) for these (ports sideEffectStyle's write set). */
const WRITE_KEYWORDS = [
  "write",
  "mutate",
  "network",
  "shell",
  "file",
  "delete",
  "create",
  "modify",
  "edit",
  "bash",
];

/** Keywords that mark a read-only call; the badge tones to "idle" (ports the
 *  read/none branch). */
const READ_KEYWORDS = ["read", "none", "grep", "list", "get"];

/**
 * Derive a tool call's side-effect badge tone from its name by keyword: read /
 * none → idle, write / mutate / network / shell / file / delete / create /
 * modify → waiting, anything else → info. Lowercased substring match, ported
 * from sideEffectStyle.
 */
export function sideEffectTone(name: string): SideEffectTone {
  const lower = name.toLowerCase();
  if (WRITE_KEYWORDS.some((kw) => lower.includes(kw))) {
    return "waiting";
  }
  if (READ_KEYWORDS.some((kw) => lower.includes(kw))) {
    return "idle";
  }
  return "info";
}

/** Short human label for a side-effect badge tone. */
export function sideEffectLabel(tone: SideEffectTone): string {
  switch (tone) {
    case "waiting":
      return "writes";
    case "idle":
      return "reads";
    default:
      return "effect";
  }
}

export type InspectorTabName = "Output" | "Logs" | "Diff" | "Props" | "Tools";

/**
 * The sensible default tab when the selected node changes (ports
 * updateDefaultTab / DefaultTabPicker): container nodes show Props (their only
 * meaningful tab); task nodes show Output when they have output, Tools when they
 * have tool calls and no output, Logs while running with neither, else Props.
 */
export function defaultTabFor(node: RunNode): InspectorTabName {
  if (isContainerNode(node)) {
    return "Props";
  }
  if (node.output) {
    return "Output";
  }
  if (node.toolCalls?.length) {
    return "Tools";
  }
  if (node.status === "running") {
    return "Logs";
  }
  return "Props";
}

/** The tabs a node exposes: container nodes hide the task-only tabs and show
 *  only Props (ports the NodeInspectorView tab-visibility branch). */
export function tabsFor(node: RunNode): InspectorTabName[] {
  if (isContainerNode(node)) {
    return ["Props"];
  }
  return ["Output", "Tools", "Logs", "Diff", "Props"];
}
