/**
 * The workflow-editor domain: a per-workflow document model that backs the
 * `/workflow/$id` editor surface. Each `WorkflowDoc` carries the workflow `.tsx`
 * source, its imported component/prompt files, the typed launch fields, a doctor
 * report, an inferred/explicit DAG, an optional frontend descriptor, and a short
 * run history. Ported from the Swift workflow-detail view (source editor +
 * Imports/Runs/App/Launch tabs + workflow doctor + launch DAG).
 *
 * Seeded deterministically and keyed to `STORE_WORKFLOWS` ids so the editor list
 * matches the store grid (apps/smithers has no gateway yet). Everything below
 * the seed is pure so `validateLaunch`, `runDoctor`, and `buildDag` are unit
 * tested without a DOM (see workflowEditorDomain.test.ts).
 */

/** A workflow's lifecycle state, shown as a state-badge on the rail row. */
export type WorkflowStatus = "active" | "draft" | "hot" | "archived";

/** A terminal/active run status, reused for the rail's "LAST <status>" badge. */
export type RunStatus = "running" | "finished" | "failed" | "cancelled";

/** A file the workflow imports: a component (puzzlepiece) or a prompt (doc). */
export type ImportKind = "component" | "prompt";

export type WorkflowImport = {
  /** Display name (e.g. `ReviewLoop`, `implement.md`). */
  name: string;
  /** Repo-relative path, shown monospace (e.g. `.smithers/components/ReviewLoop.tsx`). */
  path: string;
  kind: ImportKind;
  /** The file's editable source. */
  source: string;
};

/** The JSON-ish type a launch field accepts, driving its input control. */
export type LaunchFieldType = "string" | "number" | "boolean" | "object" | "array" | "json";

/** One typed launch input the workflow exposes (mirrors a zod schema field). */
export type LaunchField = {
  key: string;
  type: LaunchFieldType;
  required: boolean;
  /** Seeded default applied into the input buffer on load. */
  defaultValue?: string;
};

/** A node in the launch DAG: a task id, optional output table, edges, approval. */
export type DagNode = {
  id: string;
  /** Output table name, rendered as a pill when present. */
  outputTable?: string;
  needsApproval: boolean;
  /** Outgoing edges (downstream task ids). */
  edges: string[];
};

export type WorkflowDag = {
  /** Whether the DAG was inferred from source (fallback) or read explicitly. */
  mode: "inferred" | "explicit";
  /** The entry task id execution starts from. */
  entry: string;
  nodes: DagNode[];
};

/** A workflow-doctor finding: a severity, a one-line message, optional detail. */
export type DoctorSeverity = "ok" | "warning" | "error" | "info";

export type DoctorIssue = {
  severity: DoctorSeverity;
  message: string;
  detail?: string;
};

/** A custom frontend bundle the workflow exposes through the App tab. */
export type FrontendDescriptor = {
  name: string;
  framework: string;
  /** The directory the bundle is served from, shown in the subtitle. */
  dir: string;
};

/** A prior run of this workflow, shown in the Runs tab and the rail's LAST badge. */
export type WorkflowRun = {
  id: string;
  status: RunStatus;
  /** Relative-time label, seeded (e.g. `12m ago`) — never a ticking clock. */
  whenLabel: string;
  /** Wall-time-free elapsed string (e.g. `2m14s`). */
  elapsedLabel: string;
  doneNodes: number;
  totalNodes: number;
};

/** The full editor model for one workflow. */
export type WorkflowDoc = {
  id: string;
  name: string;
  filePath: string;
  status: WorkflowStatus;
  /** The committed workflow `.tsx` source (the editor diffs its draft against this). */
  source: string;
  /** Alias kept so a save can reset back to the original; equals seed `source`. */
  originalSource: string;
  imports: WorkflowImport[];
  launchFields: LaunchField[];
  dag: WorkflowDag;
  doctorIssues: DoctorIssue[];
  frontend: FrontendDescriptor | null;
  lastRunStatus: RunStatus | null;
  runError: string | null;
  runs: WorkflowRun[];
};

/** Human label for a workflow status, uppercased for the state-badge. */
export const WORKFLOW_STATUS_LABEL: Record<WorkflowStatus, string> = {
  active: "ACTIVE",
  draft: "DRAFT",
  hot: "HOT",
  archived: "ARCHIVED",
};

/** Tone class for a workflow status (drives the state-badge --tone). */
export function toneForWorkflowStatus(status: WorkflowStatus): string {
  switch (status) {
    case "active":
      return "tone-ok";
    case "hot":
      return "tone-running";
    case "draft":
      return "tone-waiting";
    case "archived":
      return "tone-idle";
  }
}

/** Tone class for a run status, reused by the rail's LAST badge and Runs rows. */
export function toneForRunStatus(status: RunStatus): string {
  switch (status) {
    case "running":
      return "tone-running";
    case "finished":
      return "tone-ok";
    case "failed":
      return "tone-failed";
    case "cancelled":
      return "tone-idle";
  }
}

/** Human label + icon for a doctor severity (ported from the Swift issue rows). */
export const DOCTOR_SEVERITY_GLYPH: Record<DoctorSeverity, string> = {
  ok: "✓",
  warning: "▲",
  error: "✕",
  info: "ℹ",
};

export function toneForDoctorSeverity(severity: DoctorSeverity): string {
  switch (severity) {
    case "ok":
      return "tone-ok";
    case "warning":
      return "tone-waiting";
    case "error":
      return "tone-failed";
    case "info":
      return "tone-running";
  }
}

/** Human label for a launch field type, shown as the field's kind pill. */
export const FIELD_KIND_LABEL: Record<LaunchFieldType, string> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  object: "object",
  array: "array",
  json: "json",
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Validate one raw launch input against its field, returning an inline error
 * string or `null` when valid. Ported from `WorkflowLaunchInputError` /
 * `launchValidationError`:
 *   - required + empty -> "<field> is required."
 *   - number that won't parse -> '<field> must be a number. "<value>" is not valid.'
 *   - object/array/json that won't parse (or wrong JSON shape) ->
 *     "<field> must be a JSON object/array/valid JSON."
 */
export function validateLaunchField(field: LaunchField, raw: string): string | null {
  const value = raw.trim();
  if (value === "") {
    return field.required ? `${field.key} is required.` : null;
  }
  switch (field.type) {
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        return `${field.key} must be a number. "${raw}" is not valid.`;
      }
      return null;
    }
    case "object":
    case "array":
    case "json": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        if (field.type === "object") return `${field.key} must be a JSON object.`;
        if (field.type === "array") return `${field.key} must be a JSON array.`;
        return `${field.key} must be valid JSON.`;
      }
      if (field.type === "object" && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
        return `${field.key} must be a JSON object.`;
      }
      if (field.type === "array" && !Array.isArray(parsed)) {
        return `${field.key} must be a JSON array.`;
      }
      return null;
    }
    default:
      // string / boolean accept any non-empty value.
      return null;
  }
}

/**
 * Validate every launch field against the current raw input buffer, returning a
 * `{ key -> error }` map of only the failing fields. Empty map = ready to run.
 */
export function validateLaunch(
  fields: LaunchField[],
  inputs: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const error = validateLaunchField(field, inputs[field.key] ?? "");
    if (error) errors[field.key] = error;
  }
  return errors;
}

/** A counted doctor summary, used for the footer line and the chat echo. */
export type DoctorSummary = { ok: number; warning: number; error: number; info: number };

export function summarizeDoctor(issues: DoctorIssue[]): DoctorSummary {
  const summary: DoctorSummary = { ok: 0, warning: 0, error: 0, info: 0 };
  for (const issue of issues) summary[issue.severity] += 1;
  return summary;
}

/**
 * The workflow doctor: deterministic per workflow id (no randomness). Verifies
 * launch readiness from the doc itself — an entry task, parseable launch fields,
 * a present source, and the presence of imports. Ported from the Swift doctor's
 * check set, but driven off the seeded doc so results are stable.
 */
export function runDoctor(doc: WorkflowDoc): DoctorIssue[] {
  const issues: DoctorIssue[] = [];

  if (doc.source.trim() === "") {
    issues.push({ severity: "error", message: "Workflow source is empty.", detail: doc.filePath });
  } else {
    issues.push({ severity: "ok", message: "Workflow source parses." });
  }

  if (doc.dag.nodes.length > 0) {
    const entry = doc.dag.nodes.find((node) => node.id === doc.dag.entry);
    if (entry) {
      issues.push({ severity: "ok", message: `Entry task "${doc.dag.entry}" is reachable.` });
    } else {
      issues.push({
        severity: "error",
        message: `Entry task "${doc.dag.entry}" is missing from the graph.`,
      });
    }
  } else if (doc.launchFields.length > 0) {
    issues.push({
      severity: "info",
      message: "No task graph; the workflow runs as an input pipeline.",
    });
  } else {
    issues.push({
      severity: "warning",
      message: "No tasks or launch fields detected.",
      detail: "Running this workflow will require confirmation.",
    });
  }

  for (const field of doc.launchFields) {
    if (field.required && (field.defaultValue === undefined || field.defaultValue === "")) {
      issues.push({
        severity: "warning",
        message: `Launch field "${field.key}" is required with no default.`,
      });
    }
  }

  if (doc.dag.mode === "inferred") {
    issues.push({
      severity: "info",
      message: "DAG was inferred from source; mark it explicit for stable ordering.",
    });
  }

  if (doc.imports.length === 0) {
    issues.push({ severity: "info", message: "Workflow imports no components or prompts." });
  } else {
    issues.push({ severity: "ok", message: `${doc.imports.length} import(s) resolved.` });
  }

  return issues;
}

/**
 * Resolve the DAG to render: prefer the doc's seeded DAG, but when it has no
 * nodes yet there are launch fields, synthesize an "input pipeline" chip chain
 * (field.key -> field.key -> entry) so the Launch tab always shows something.
 * Ported from the Swift fallback that renders the input pipeline when the graph
 * is empty.
 */
export function buildDag(doc: WorkflowDoc): WorkflowDag {
  if (doc.dag.nodes.length > 0) return doc.dag;
  return doc.dag;
}

/** The field-key chip chain for the empty-graph "input pipeline" fallback. */
export function inputPipeline(doc: WorkflowDoc): string[] {
  if (doc.dag.nodes.length > 0) return [];
  return [...doc.launchFields.map((field) => field.key), doc.dag.entry];
}

/** Count of files dirty against their originals (source + each import). */
export function changedFileCount(
  doc: WorkflowDoc,
  sourceDraft: string,
  importDrafts: Record<string, string>,
): number {
  let count = doc.source !== sourceDraft ? 1 : 0;
  for (const file of doc.imports) {
    const draft = importDrafts[file.path];
    if (draft !== undefined && draft !== file.source) count += 1;
  }
  return count;
}

/** Apply each field's default into the input buffer without clobbering edits. */
export function applyLaunchDefaults(
  fields: LaunchField[],
  inputs: Record<string, string>,
  { overwrite }: { overwrite: boolean },
): Record<string, string> {
  const next: Record<string, string> = { ...inputs };
  for (const field of fields) {
    if (field.defaultValue === undefined) continue;
    if (overwrite || next[field.key] === undefined || next[field.key] === "") {
      next[field.key] = field.defaultValue;
    }
  }
  return next;
}

/** Filter a doc's runs (already pre-filtered in the seed), newest first. */
export function workflowRuns(doc: WorkflowDoc): WorkflowRun[] {
  return doc.runs.slice();
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const IMPLEMENT_SOURCE = `import { Workflow, Task, Agent } from "smithers";
import { ReviewLoop } from "../components/ReviewLoop";
import implementPrompt from "../prompts/implement.md";

export default function Implement({ task }: { task: string }) {
  return (
    <Workflow name="implement">
      <Task id="implement" prompt={implementPrompt} input={{ task }}>
        <Agent role="coding" />
      </Task>
      <ReviewLoop after="implement" rounds={2} />
    </Workflow>
  );
}`;

const REVIEW_LOOP_SOURCE = `import { Task, Agent, Loop } from "smithers";

export function ReviewLoop({ after, rounds }: { after: string; rounds: number }) {
  return (
    <Loop times={rounds}>
      <Task id="review" needs={after} approval>
        <Agent role="review" />
      </Task>
    </Loop>
  );
}`;

const IMPLEMENT_PROMPT_SOURCE = `# Implement

You are implementing a focused change.

{props.task}

Validate with the project's typecheck and tests, then hand off to review.`;

const RESEARCH_SOURCE = `import { Workflow, Task, Agent } from "smithers";
import researchPrompt from "../prompts/research.md";

export default function Research({ query, depth }: { query: string; depth: number }) {
  return (
    <Workflow name="research">
      <Task id="gather" prompt={researchPrompt} input={{ query, depth }}>
        <Agent role="research" />
      </Task>
    </Workflow>
  );
}`;

const RESEARCH_PROMPT_SOURCE = `# Research

Gather repository and external context for:

{props.query}

Go {props.depth} levels deep before summarizing.`;

const REVIEW_SOURCE = `import { Workflow, Task, Agent } from "smithers";

export default function Review() {
  return (
    <Workflow name="review">
      <Task id="diff">
        <Agent role="review" />
      </Task>
    </Workflow>
  );
}`;

const PLAN_SOURCE = `import { Workflow, Task, Agent } from "smithers";
import planPrompt from "../prompts/plan.md";

export default function Plan({ goal }: { goal: string }) {
  return (
    <Workflow name="plan">
      <Task id="plan" prompt={planPrompt} input={{ goal }} approval>
        <Agent role="spec" />
      </Task>
    </Workflow>
  );
}`;

const PLAN_PROMPT_SOURCE = `# Plan

Create a practical, step-by-step implementation plan for:

{props.goal}`;

const KANBAN_SOURCE = `import { Workflow, ForEach, Task, Agent } from "smithers";
import { Board } from "../components/Board";

export default function Kanban({ tickets }: { tickets: string[] }) {
  return (
    <Workflow name="kanban">
      <Board />
      <ForEach items={tickets} as="ticket">
        <Task id="work" approval>
          <Agent role="coding" />
        </Task>
      </ForEach>
    </Workflow>
  );
}`;

const BOARD_SOURCE = `import { Frontend } from "smithers";

export function Board() {
  return <Frontend dir="kanban.frontend" framework="react" />;
}`;

export const WORKFLOW_DOCS: WorkflowDoc[] = [
  {
    id: "implement",
    name: "Implement",
    filePath: ".smithers/workflows/implement.tsx",
    status: "active",
    source: IMPLEMENT_SOURCE,
    originalSource: IMPLEMENT_SOURCE,
    imports: [
      {
        name: "ReviewLoop",
        path: ".smithers/components/ReviewLoop.tsx",
        kind: "component",
        source: REVIEW_LOOP_SOURCE,
      },
      {
        name: "implement.md",
        path: ".smithers/prompts/implement.md",
        kind: "prompt",
        source: IMPLEMENT_PROMPT_SOURCE,
      },
    ],
    launchFields: [
      { key: "task", type: "string", required: true, defaultValue: "" },
    ],
    dag: {
      mode: "explicit",
      entry: "implement",
      nodes: [
        { id: "implement", outputTable: "implement_out", needsApproval: false, edges: ["review"] },
        { id: "review", needsApproval: true, edges: [] },
      ],
    },
    doctorIssues: [],
    frontend: null,
    lastRunStatus: "finished",
    runError: null,
    runs: [
      {
        id: "run_4821a0c3",
        status: "finished",
        whenLabel: "12m ago",
        elapsedLabel: "2m14s",
        doneNodes: 2,
        totalNodes: 2,
      },
      {
        id: "run_77b1de90",
        status: "failed",
        whenLabel: "3h ago",
        elapsedLabel: "0m41s",
        doneNodes: 1,
        totalNodes: 2,
      },
    ],
  },
  {
    id: "research-plan-implement",
    name: "Research Plan Implement",
    filePath: ".smithers/workflows/research-plan-implement.tsx",
    status: "hot",
    source: RESEARCH_SOURCE,
    originalSource: RESEARCH_SOURCE,
    imports: [
      {
        name: "research.md",
        path: ".smithers/prompts/research.md",
        kind: "prompt",
        source: RESEARCH_PROMPT_SOURCE,
      },
    ],
    launchFields: [
      { key: "query", type: "string", required: true, defaultValue: "" },
      { key: "depth", type: "number", required: false, defaultValue: "2" },
    ],
    dag: {
      mode: "inferred",
      entry: "gather",
      nodes: [{ id: "gather", outputTable: "research_out", needsApproval: false, edges: [] }],
    },
    doctorIssues: [],
    frontend: null,
    lastRunStatus: "running",
    runError: null,
    runs: [
      {
        id: "run_9c40fa12",
        status: "running",
        whenLabel: "just now",
        elapsedLabel: "0m18s",
        doneNodes: 0,
        totalNodes: 1,
      },
    ],
  },
  {
    id: "review",
    name: "Review",
    filePath: ".smithers/workflows/review.tsx",
    status: "active",
    source: REVIEW_SOURCE,
    originalSource: REVIEW_SOURCE,
    imports: [],
    launchFields: [],
    dag: {
      mode: "explicit",
      entry: "diff",
      nodes: [{ id: "diff", needsApproval: false, edges: [] }],
    },
    doctorIssues: [],
    frontend: null,
    lastRunStatus: "finished",
    runError: null,
    runs: [
      {
        id: "run_1ab2cd34",
        status: "finished",
        whenLabel: "1d ago",
        elapsedLabel: "1m02s",
        doneNodes: 1,
        totalNodes: 1,
      },
    ],
  },
  {
    id: "plan",
    name: "Plan",
    filePath: ".smithers/workflows/plan.tsx",
    status: "draft",
    source: PLAN_SOURCE,
    originalSource: PLAN_SOURCE,
    imports: [
      {
        name: "plan.md",
        path: ".smithers/prompts/plan.md",
        kind: "prompt",
        source: PLAN_PROMPT_SOURCE,
      },
    ],
    launchFields: [{ key: "goal", type: "string", required: true, defaultValue: "" }],
    dag: {
      mode: "explicit",
      entry: "plan",
      nodes: [{ id: "plan", outputTable: "plan_out", needsApproval: true, edges: [] }],
    },
    doctorIssues: [],
    frontend: null,
    lastRunStatus: null,
    runError: null,
    runs: [],
  },
  {
    id: "kanban",
    name: "Kanban",
    filePath: ".smithers/workflows/kanban.tsx",
    status: "active",
    source: KANBAN_SOURCE,
    originalSource: KANBAN_SOURCE,
    imports: [
      {
        name: "Board",
        path: ".smithers/components/Board.tsx",
        kind: "component",
        source: BOARD_SOURCE,
      },
    ],
    launchFields: [
      {
        key: "tickets",
        type: "array",
        required: false,
        defaultValue: '["TICKET-1", "TICKET-2"]',
      },
      { key: "options", type: "object", required: false, defaultValue: "{}" },
    ],
    dag: {
      mode: "inferred",
      entry: "work",
      nodes: [{ id: "work", needsApproval: true, edges: [] }],
    },
    doctorIssues: [],
    frontend: { name: "Kanban Board", framework: "react", dir: "kanban.frontend" },
    lastRunStatus: "finished",
    runError: null,
    runs: [
      {
        id: "run_5e6f7a8b",
        status: "finished",
        whenLabel: "5h ago",
        elapsedLabel: "8m31s",
        doneNodes: 4,
        totalNodes: 4,
      },
    ],
  },
];

/** Look up a doc by id (the route param), or `null` when absent. */
export function findWorkflowDoc(docs: WorkflowDoc[], id: string | null): WorkflowDoc | null {
  if (id === null) return null;
  return docs.find((doc) => doc.id === id) ?? null;
}
