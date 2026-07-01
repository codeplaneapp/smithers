/** @jsxImportSource react */
// Custom UI for the `create-workflow` meta-workflow. Multi design tokens (Inter,
// brand purple, light/OS-dark), an n8n-style ReactFlow graph, Milkdown Crepe
// WYSIWYG editors for the run's markdown assets, real-time via gateway-react,
// and a tabbed wizard — one tab per workflow task that you step through.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayApprovals,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import { themeCss } from "./cw-theme";
import { crepeThemeCss } from "./crepeTheme.generated";
import { xyflowThemeCss } from "./xyflowTheme.generated";
import { WorkflowGraph, type NodeKind, type WorkflowSpecNode } from "./cw-graph";
import { MarkdownEditor } from "./cw-editor";

const WORKFLOW_KEY = "create-workflow";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };
type ApprovalSummary = { runId: string; nodeId: string; iteration: number; requestTitle?: string; requestSummary?: string };
type EventFrame = { seq: number; event?: string; payload?: unknown; stateVersion?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function textOf(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}
function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === "string" && value.trim() ? [value] : [];
  return value.map((item) => textOf(item)).filter(Boolean);
}
function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
function rowOf(value: unknown): Record<string, unknown> {
  let current = isRecord(value) ? value : {};
  for (let i = 0; i < 4; i += 1) {
    if (isRecord(current.row)) return current.row;
    if (isRecord(current.data)) {
      current = current.data;
      continue;
    }
    break;
  }
  return current;
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function shortRunId(runId: string | undefined): string {
  return runId ? runId.slice(0, 8) : "no run";
}
function toRunRows(data: unknown): RunSummary[] {
  const raw = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.runs) ? data.runs : [];
  return raw
    .filter(isRecord)
    .map((row) => ({
      ...row,
      runId: textOf(row.runId ?? row.id),
      workflowKey: asString(row.workflowKey),
      status: asString(row.status),
      createdAtMs: asNumber(row.createdAtMs),
    }))
    .filter((row): row is RunSummary => row.runId.length > 0);
}
function statusClass(status: string | undefined): string {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "finished" || normalized === "success" || normalized === "built") return "ok";
  if (normalized === "failed" || normalized === "cancelled" || normalized === "denied" || normalized === "verify-failed") return "bad";
  if (normalized === "waiting-approval" || normalized === "waiting-event") return "warn";
  if (normalized === "running" || normalized === "continued" || normalized === "queued" || normalized === "pending") return "run";
  return "";
}

const NOISE_EVENTS = new Set(["TaskHeartbeat", "FrameCommitted", "SnapshotCaptured", "AgentTraceEvent", "AgentTraceSummary", "TokenUsageReported", "NodePending"]);

function eventPayload(frame: EventFrame): Record<string, unknown> {
  return isRecord(frame.payload) ? frame.payload : {};
}
function describeEvent(frame: EventFrame): { seq: number; label: string; node?: string; detail?: string; tone: string } | null {
  const payload = eventPayload(frame);
  const type = asString(payload.type) ?? asString(frame.event) ?? "event";
  if (NOISE_EVENTS.has(type)) return null;
  const node = asString(payload.nodeId);
  switch (type) {
    case "RunStarted":
      return { seq: frame.seq, label: "run started", tone: "info" };
    case "RunStatusChanged":
      return { seq: frame.seq, label: `status -> ${textOf(payload.status, "?")}`, tone: "info" };
    case "RunFinished":
    case "RunCompleted":
      return { seq: frame.seq, label: "run finished", tone: "ok" };
    case "RunFailed":
      return { seq: frame.seq, label: "run failed", tone: "bad" };
    case "NodeStarted":
      return { seq: frame.seq, label: "started", node, tone: "info" };
    case "NodeOutput":
      return { seq: frame.seq, label: "output", node, detail: textOf(payload.output ?? payload.text), tone: "warn" };
    case "NodeFinished":
      return { seq: frame.seq, label: "finished", node, tone: "ok" };
    case "NodeFailed":
      return { seq: frame.seq, label: "failed", node, detail: textOf(payload.error), tone: "bad" };
    case "NodeWaitingApproval":
    case "ApprovalRequested":
      return { seq: frame.seq, label: "approval requested", node, tone: "warn" };
    case "ApprovalGranted":
      return { seq: frame.seq, label: "approved", node, tone: "ok" };
    case "ApprovalDenied":
      return { seq: frame.seq, label: "denied", node, tone: "bad" };
    case "AgentEvent": {
      const ev = isRecord(payload.event) ? payload.event : {};
      const evType = asString(ev.type) ?? "event";
      const engine = asString(payload.engine) ?? "agent";
      return { seq: frame.seq, label: `${engine}: ${evType}`, node, detail: textOf(ev.title ?? ev.message), tone: "muted" };
    }
    default:
      if (type === "run.event") return null;
      return { seq: frame.seq, label: type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(), node, tone: "muted" };
  }
}

type ClarifyOutput = { name: string; goal: string; trigger: string; stages: string[]; loops: string[]; humanGates: string[]; successCriteria: string[]; openQuestions: string[] };
function extractClarify(value: unknown): ClarifyOutput | null {
  const row = rowOf(value);
  const goal = asString(row.goal);
  if (goal === undefined) return null;
  return {
    name: asString(row.name) ?? "new-workflow",
    goal,
    trigger: asString(row.trigger) ?? "manual",
    stages: asStringArray(row.stages),
    loops: asStringArray(row.loops),
    humanGates: asStringArray(row.humanGates),
    successCriteria: asStringArray(row.successCriteria),
    openQuestions: asStringArray(row.openQuestions),
  };
}

type NamedReason = { name: string; reason: string };
type SkillProvision = { name: string; action: string; reason: string };
type ProvisionOutput = { docsFragments: NamedReason[]; examples: NamedReason[]; components: NamedReason[]; skills: SkillProvision[]; agents: string[]; notes: string };
function namedReasons(value: unknown): NamedReason[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => isRecord(item) ? { name: textOf(item.name, "?"), reason: textOf(item.reason) } : { name: textOf(item, "?"), reason: "" })
    .filter((item) => item.name !== "?");
}
function extractProvision(value: unknown): ProvisionOutput | null {
  const row = rowOf(value);
  if (row.docsFragments === undefined && row.examples === undefined && row.skills === undefined && row.notes === undefined) return null;
  return {
    docsFragments: namedReasons(row.docsFragments),
    examples: namedReasons(row.examples),
    components: namedReasons(row.components),
    skills: asRecordArray(row.skills).map((skill) => ({ name: textOf(skill.name, "?"), action: textOf(skill.action, "use"), reason: textOf(skill.reason) })),
    agents: asStringArray(row.agents),
    notes: textOf(row.notes),
  };
}

type DesignTask = { id: string; purpose: string; agent: string; outputs: string[] };
type DesignOutput = { workflowName: string; summary: string; graphShape: string; tasks: DesignTask[]; prompts: string[]; humanGates: string[]; rationale: string };
function extractDesign(value: unknown): DesignOutput | null {
  const row = rowOf(value);
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return {
    workflowName: asString(row.workflowName) ?? "new-workflow",
    summary,
    graphShape: textOf(row.graphShape),
    tasks: asRecordArray(row.tasks).map((task) => ({ id: textOf(task.id, "?"), purpose: textOf(task.purpose), agent: textOf(task.agent), outputs: asStringArray(task.outputs) })),
    prompts: asStringArray(row.prompts),
    humanGates: asStringArray(row.humanGates),
    rationale: textOf(row.rationale),
  };
}

type ScaffoldFile = { path: string; kind: string };
function asFileList(value: unknown): ScaffoldFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => isRecord(item) ? { path: textOf(item.path, "?"), kind: textOf(item.kind, "file") } : { path: textOf(item, "?"), kind: "file" })
    .filter((file) => file.path !== "?");
}
type ScaffoldOutput = { summary: string; workflowName: string; filesWritten: ScaffoldFile[] };
function extractScaffold(value: unknown): ScaffoldOutput | null {
  const row = rowOf(value);
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return { summary, workflowName: asString(row.workflowName) ?? "new-workflow", filesWritten: asFileList(row.filesWritten) };
}

type VerifyOutput = { passed: boolean; command: string; errors: string[]; notes: string };
function extractVerify(value: unknown): VerifyOutput | null {
  const row = rowOf(value);
  const passed = asBool(row.passed);
  if (passed === undefined) return null;
  return { passed, command: textOf(row.command), errors: asStringArray(row.errors), notes: textOf(row.notes) };
}

type DocumentOutput = { summary: string; skillPath: string | null };
function extractDocument(value: unknown): DocumentOutput | null {
  const row = rowOf(value);
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return { summary, skillPath: asString(row.skillPath) ?? null };
}

type FinalOutput = { workflow: string; workflowFile: string; status: string; summary: string; filesWritten: ScaffoldFile[]; fileCount: number; verified: boolean; skillPath: string | null };
function extractFinal(value: unknown): FinalOutput | null {
  const row = rowOf(value);
  const status = asString(row.status);
  if (status === undefined) return null;
  const filesWritten = asFileList(row.filesWritten);
  return {
    workflow: asString(row.workflow) ?? "new-workflow",
    workflowFile: textOf(row.workflowFile),
    status,
    summary: textOf(row.summary),
    filesWritten,
    fileCount: asNumber(row.fileCount) ?? filesWritten.length,
    verified: asBool(row.verified) ?? false,
    skillPath: asString(row.skillPath) ?? null,
  };
}

function inferKind(task: DesignTask): NodeKind {
  const id = task.id.toLowerCase();
  const agent = task.agent.toLowerCase();
  if (id.includes("approve") || id.includes("approval") || id.includes("gate")) return "approval";
  if (id.includes("human") || id.includes("ask")) return "human";
  if (id.includes("loop") || id.includes("retry") || id.includes("until")) return "loop";
  if (id.includes("branch") || id.includes("route")) return "branch";
  if (id.includes("merge")) return "merge";
  if (id.includes("signal") || id.includes("wait")) return "signal";
  if (!agent || agent.includes("none")) return "compute";
  return "agent";
}
function designToSpec(design: DesignOutput): WorkflowSpecNode[] {
  return design.tasks.map((task, index) => ({ id: task.id, label: task.id, kind: inferKind(task), output: task.purpose || task.outputs[0] || task.agent, dependsOn: index > 0 ? [design.tasks[index - 1].id] : [] }));
}
function listBlock(title: string, values: string[]): string[] {
  return values.length ? ["", `### ${title}`, ...values.map((value) => `- ${value}`)] : [];
}
function clarifyMarkdown(clarify: ClarifyOutput): string {
  return [`## ${clarify.name}`, "", clarify.goal, "", `**Trigger:** \`${clarify.trigger}\``, ...listBlock("Stages", clarify.stages), ...listBlock("Success criteria", clarify.successCriteria), ...listBlock("Loops", clarify.loops), ...listBlock("Human gates", clarify.humanGates), ...listBlock("Open questions", clarify.openQuestions)].join("\n");
}
function designMarkdown(design: DesignOutput): string {
  return [design.summary, design.graphShape ? `\n**Graph shape:** ${design.graphShape}` : "", ...listBlock("Prompts", design.prompts.map((prompt) => `\`${prompt}\``)), ...listBlock("Human gates", design.humanGates), design.rationale ? `\n### Rationale\n${design.rationale}` : ""].filter(Boolean).join("\n");
}
function documentMarkdown(documentation: DocumentOutput): string {
  return [documentation.summary, documentation.skillPath ? `\n**Skill:** \`${documentation.skillPath}\`` : ""].filter(Boolean).join("\n");
}
function openQuestionsSeed(clarify: ClarifyOutput | null): string {
  if (!clarify?.openQuestions.length) return "";
  return ["Approval notes", "", ...clarify.openQuestions.map((question) => `- **${question}**\n  `)].join("\n");
}

type TabId = "clarify" | "provision" | "design" | "approve" | "scaffold" | "verify" | "document" | "result";
type StepStatus = "pending" | "active" | "done" | "failed";
type StepDef = { id: TabId; label: string; status: StepStatus; nodeIds: string[] };
const TAB_LABELS: { id: TabId; label: string; nodeIds: string[] }[] = [
  { id: "clarify", label: "Clarify", nodeIds: ["clarify"] },
  { id: "provision", label: "Provision", nodeIds: ["provision"] },
  { id: "design", label: "Design", nodeIds: ["design"] },
  { id: "approve", label: "Approve", nodeIds: ["approve-design"] },
  { id: "scaffold", label: "Scaffold", nodeIds: ["scaffold"] },
  { id: "verify", label: "Verify", nodeIds: ["verify:loop:verify", "verify"] },
  { id: "document", label: "Document", nodeIds: ["document"] },
  { id: "result", label: "Result", nodeIds: ["output"] },
];
function eventStatusFor(events: EventFrame[], nodeIds: string[]): StepStatus | undefined {
  let status: StepStatus | undefined;
  for (const frame of events) {
    const payload = eventPayload(frame);
    const nodeId = asString(payload.nodeId);
    if (!nodeId || !nodeIds.includes(nodeId)) continue;
    const type = asString(payload.type);
    if (type === "NodeStarted" || type === "NodeWaitingApproval" || type === "ApprovalRequested") status = "active";
    if (type === "ApprovalGranted" || type === "NodeFinished") status = "done";
    if (type === "ApprovalDenied" || type === "NodeFailed") status = "failed";
  }
  return status;
}
function tabGlyph(status: StepStatus): { text: string; className: string } {
  if (status === "done") return { text: "✓", className: "tab-glyph is-done" };
  if (status === "active") return { text: "●", className: "tab-glyph is-active" };
  if (status === "failed") return { text: "✕", className: "tab-glyph is-failed" };
  return { text: "○", className: "tab-glyph is-pending" };
}

function Pending({ text }: { text: string }) {
  return <div className="pending-hint">{text}</div>;
}
function PaneHeader({ eyebrow, title, summary, aside }: { eyebrow: string; title: string; summary?: string; aside?: React.ReactNode }) {
  return (
    <div className="pane-head">
      <div className="pane-title">
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        {summary ? <p>{summary}</p> : null}
      </div>
      {aside ? <div className="chips">{aside}</div> : null}
    </div>
  );
}
function ResourceSection({ title, items }: { title: string; items: NamedReason[] }) {
  if (items.length === 0) return null;
  return (
    <section className="stack">
      <div className="card-head">
        <h3>{title}</h3>
        <span className="badge">{items.length}</span>
      </div>
      <div className="soft-grid">
        {items.map((item, index) => (
          <article className="resource" key={`${title}-${item.name}-${index}`}>
            <strong>{item.name}</strong>
            {item.reason ? <p>{item.reason}</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}
function FileList({ files }: { files: ScaffoldFile[] }) {
  if (files.length === 0) return <p>No files recorded yet.</p>;
  return (
    <ul className="files">
      {files.map((file, index) => (
        <li key={`${file.path}-${index}`}>
          <span className="path">{file.path}</span>
          <span className="kind">{file.kind}</span>
        </li>
      ))}
    </ul>
  );
}
function ActivityStrip({ items, eventCount, streaming, open, onToggle }: { items: { seq: number; label: string; node?: string; detail?: string; tone: string }[]; eventCount: number; streaming: boolean; open: boolean; onToggle: () => void }) {
  const latest = items[items.length - 1];
  return (
    <section className="activity" data-testid="create-workflow-activity">
      <button className="activity-head" type="button" onClick={onToggle}>
        <span className={"live" + (streaming ? " on" : "")}><span className="live-dot" /></span>
        <span className="grow">Live activity · {eventCount}{latest ? ` · ${latest.node ? `${latest.node} ` : ""}${latest.label}` : ""}</span>
        <span>{open ? "Hide" : "Show"}</span>
      </button>
      {open ? (
        <div className="livelog" data-testid="create-workflow-feed">
          {items.length ? items.slice(-80).reverse().map((item) => (
            <div className="livelog-line" key={item.seq}>
              <span className="livelog-seq">{item.seq}</span>
              <span className={"livelog-event " + item.tone}>{item.label}</span>
              {item.node ? <span className="livelog-node">{item.node}</span> : null}
              {item.detail ? <span className="livelog-detail">{item.detail}</span> : null}
            </div>
          )) : <div className="empty">No events yet.</div>}
        </div>
      ) : null}
    </section>
  );
}
function LaunchState({ prompt, name, review, busy, launchError, onPrompt, onName, onReview, onLaunch }: { prompt: string; name: string; review: boolean; busy: boolean; launchError: string | null; onPrompt: (value: string) => void; onName: (value: string) => void; onReview: (value: boolean) => void; onLaunch: () => void }) {
  return (
    <div className="launch">
      <section className="launch-card" data-testid="create-workflow-empty">
        <div className="pane-title">
          <span className="eyebrow">New workflow</span>
          <h2>Build a Smithers workflow from a plain-English ask</h2>
          <p>Smithers clarifies the spec, provisions context, designs the graph, pauses for approval, writes files, verifies, and documents the result.</p>
        </div>
        <textarea className="input" data-testid="create-workflow-prompt-empty" value={prompt} onChange={(event) => onPrompt(event.currentTarget.value)} placeholder="Build a workflow that triages flaky tests, opens focused implementation tasks, and verifies the fix." />
        <input className="input mono" value={name} onChange={(event) => onName(event.currentTarget.value)} placeholder="workflow-id (optional)" />
        <div className="launch-row">
          <label className="check"><input type="checkbox" checked={review} onChange={(event) => onReview(event.currentTarget.checked)} /> Pause for design approval before writing files</label>
          <button className="button primary" data-testid="create-workflow-launch-empty" onClick={onLaunch} disabled={busy || !prompt.trim()}>{busy ? "Building..." : "Build Workflow"}</button>
        </div>
        {launchError ? <span className="badge bad">{launchError}</span> : null}
      </section>
    </div>
  );
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [activeTab, setActiveTab] = useState<TabId>("clarify");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [review, setReview] = useState(true);
  const [note, setNote] = useState("");
  const [noteTouched, setNoteTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [decision, setDecision] = useState<"idle" | "submitting" | "approved" | "denied" | "error">("idle");
  const [activityOpen, setActivityOpen] = useState(false);

  const actions = useGatewayActions();
  const runsQuery = useGatewayRuns({ filter: { limit: 30 } });
  const runs = useMemo(() => toRunRows(runsQuery.data).filter((run) => !run.workflowKey || run.workflowKey === WORKFLOW_KEY).slice(0, 30), [runsQuery.data]);
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? runs[0]?.runId;
  const runQuery = useGatewayRun(activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0, maxEvents: 1000 });
  const approvalsQuery = useGatewayApprovals({ filter: { runId: activeRunId ?? "" } });

  const clarifyOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "clarify", iteration: 0 });
  const provisionOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "provision", iteration: 0 });
  const designOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "design", iteration: 0 });
  const scaffoldOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "scaffold", iteration: 0 });
  const verifyOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "verify:loop:verify", iteration: 0 });
  const documentOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "document", iteration: 0 });
  const outputOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "output", iteration: 0 });

  const runRow = rowOf(runQuery.data);
  const runStatus = asString(runRow.status) ?? runs.find((run) => run.runId === activeRunId)?.status;
  const running = ["running", "continued", "queued", "pending", "waiting-approval", "waiting-event"].includes((runStatus ?? "").toLowerCase());
  const events = (stream.events ?? []) as EventFrame[];
  const eventCount = events.length;
  const activityItems = useMemo(() => events.map(describeEvent).filter((item): item is NonNullable<typeof item> => Boolean(item)), [events]);

  const clarify = useMemo(() => extractClarify(clarifyOut.data), [clarifyOut.data]);
  const provision = useMemo(() => extractProvision(provisionOut.data), [provisionOut.data]);
  const design = useMemo(() => extractDesign(designOut.data), [designOut.data]);
  const scaffold = useMemo(() => extractScaffold(scaffoldOut.data), [scaffoldOut.data]);
  const verify = useMemo(() => extractVerify(verifyOut.data), [verifyOut.data]);
  const documentation = useMemo(() => extractDocument(documentOut.data), [documentOut.data]);
  const final = useMemo(() => extractFinal(outputOut.data), [outputOut.data]);
  const pendingApproval = useMemo(() => {
    const approvals = Array.isArray(approvalsQuery.data) ? (approvalsQuery.data as ApprovalSummary[]) : [];
    return approvals.find((approval) => approval.runId === activeRunId && approval.nodeId === "approve-design");
  }, [approvalsQuery.data, activeRunId]);

  const workflowName = final?.workflow ?? scaffold?.workflowName ?? design?.workflowName ?? clarify?.name;
  const verifyPassed = verify?.passed ?? final?.verified;
  const designedSpec = useMemo(() => (design ? designToSpec(design) : []), [design]);
  const noteSeed = useMemo(() => openQuestionsSeed(clarify), [clarify]);
  const approvalKey = pendingApproval ? `${pendingApproval.runId}:${pendingApproval.nodeId}:${pendingApproval.iteration}` : "";

  const outputQueries = [clarifyOut, provisionOut, designOut, scaffoldOut, verifyOut, documentOut, outputOut];
  const outputRef = useRef(outputQueries);
  const runsRef = useRef(runsQuery);
  const approvalsRef = useRef(approvalsQuery);
  outputRef.current = outputQueries;
  runsRef.current = runsQuery;
  approvalsRef.current = approvalsQuery;

  useEffect(() => {
    if (!activeRunId) return;
    for (const query of outputRef.current) void query.refetch();
    void approvalsRef.current.refetch();
    void runsRef.current.refetch();
  }, [activeRunId, eventCount, runStatus]);
  useEffect(() => {
    setDecision("idle");
    setNote("");
    setNoteTouched(false);
    setActiveTab("clarify");
    setActivityOpen(false);
  }, [activeRunId]);
  const approvalAutoFocusRef = useRef("");
  useEffect(() => {
    if (!pendingApproval || !approvalKey || approvalAutoFocusRef.current === approvalKey) return;
    approvalAutoFocusRef.current = approvalKey;
    setDecision("idle");
    setNote(noteSeed);
    setNoteTouched(false);
    setActiveTab("approve");
  }, [pendingApproval, approvalKey, noteSeed]);

  const steps: StepDef[] = TAB_LABELS.map((tab) => {
    const eventStatus = eventStatusFor(events, tab.nodeIds);
    let status: StepStatus = eventStatus ?? "pending";
    if (tab.id === "clarify" && clarify) status = "done";
    if (tab.id === "provision" && provision) status = "done";
    if (tab.id === "design" && design) status = "done";
    if (tab.id === "approve") {
      status = pendingApproval ? "active" : decision === "denied" || final?.status === "denied" ? "failed" : scaffold || decision === "approved" || final ? "done" : eventStatus ?? "pending";
    }
    if (tab.id === "scaffold" && scaffold) status = "done";
    if (tab.id === "verify") status = verifyPassed === true ? "done" : verifyPassed === false ? "failed" : eventStatus ?? "pending";
    if (tab.id === "document" && documentation) status = "done";
    if (tab.id === "result" && final) status = final.status === "built" || final.status === "finished" ? "done" : final.status === "denied" || final.status === "verify-failed" ? "failed" : "active";
    return { ...tab, status };
  });
  if (running && !pendingApproval && !steps.some((step) => step.status === "active")) {
    const next = steps.find((step) => step.status === "pending");
    if (next) next.status = "active";
  }
  const runOptions = activeRunId && !runs.some((run) => run.runId === activeRunId) ? [{ runId: activeRunId, workflowKey: WORKFLOW_KEY, status: runStatus }, ...runs] : runs;

  async function refresh() {
    await Promise.all([runsRef.current.refetch(), approvalsRef.current.refetch(), ...outputRef.current.map((query) => query.refetch())]);
  }
  async function launch() {
    if (!prompt.trim()) return;
    setBusy(true);
    setLaunchError(null);
    try {
      const result = (await actions.launchRun({ workflow: WORKFLOW_KEY, input: { prompt: prompt.trim(), name: name.trim() || null, review } })) as unknown;
      const nextRunId = isRecord(result) ? asString(result.runId) : undefined;
      if (nextRunId) {
        setSelectedRunId(nextRunId);
        setActiveTab("clarify");
      }
      await refresh();
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!activeRunId) return;
    setBusy(true);
    try {
      await actions.cancelRun({ runId: activeRunId });
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function decide(approved: boolean) {
    if (!pendingApproval) return;
    setBusy(true);
    setDecision("submitting");
    try {
      const submittedNote = noteTouched ? note.trim() || undefined : note.trim() || noteSeed.trim() || undefined;
      await actions.submitApproval({ runId: pendingApproval.runId, nodeId: pendingApproval.nodeId, iteration: pendingApproval.iteration, decision: { approved, note: submittedNote } });
      setDecision(approved ? "approved" : "denied");
      await refresh();
    } catch {
      setDecision("error");
    } finally {
      setBusy(false);
    }
  }

  function renderTab(tab: TabId) {
    switch (tab) {
      case "clarify":
        return <>
          <PaneHeader eyebrow="Step 1" title="Clarified spec" summary="A compact, structured read of the workflow request before any files are written." aside={clarify ? <span className="badge info">{clarify.trigger}</span> : null} />
          {clarify ? <MarkdownEditor value={clarifyMarkdown(clarify)} readOnly /> : <Pending text="Waiting for Smithers to clarify the request." />}
        </>;
      case "provision":
        return <>
          <PaneHeader eyebrow="Step 2" title="Provisioned context" summary="Only the docs, examples, skills, components, and agents the build needs." />
          {provision ? <div className="stack">
            {provision.notes ? <section className="card subtle"><p>{provision.notes}</p></section> : null}
            <ResourceSection title="Docs" items={provision.docsFragments} />
            <ResourceSection title="Examples" items={provision.examples} />
            <ResourceSection title="Components" items={provision.components} />
            {provision.skills.length ? <section className="stack"><div className="card-head"><h3>Skills</h3><span className="badge">{provision.skills.length}</span></div><div className="soft-grid">{provision.skills.map((skill, index) => <article className="resource" key={`${skill.name}-${index}`}><strong>{skill.name}</strong><div className="chips"><span className="chip brand">{skill.action}</span></div>{skill.reason ? <p>{skill.reason}</p> : null}</article>)}</div></section> : null}
            {provision.agents.length ? <section className="card subtle"><div className="card-head"><h3>Agents</h3><span className="badge">{provision.agents.length}</span></div><div className="chips">{provision.agents.map((agent) => <span className="chip mono" key={agent}>{agent}</span>)}</div></section> : null}
          </div> : <Pending text="Gathering the context the workflow needs." />}
        </>;
      case "design":
        return <>
          <PaneHeader eyebrow="Step 3" title={design?.workflowName ?? "Designed workflow"} summary={design?.summary ?? "Smithers will render the proposed workflow graph here."} aside={design ? <span className="badge info">{design.tasks.length} tasks</span> : null} />
          <div className="design-pane">
            {designedSpec.length ? <div className="graph-wrap" data-testid="create-workflow-graph"><WorkflowGraph spec={designedSpec} /></div> : <Pending text="Designing the workflow graph." />}
            {design ? <MarkdownEditor value={designMarkdown(design)} readOnly compact /> : null}
          </div>
        </>;
      case "approve":
        return <>
          <PaneHeader eyebrow="Step 4" title="Design approval" summary="The human gate lives here: review the proposal, add notes, then approve or deny." aside={pendingApproval ? <span className="badge warn">waiting</span> : steps.find((step) => step.id === "approve")?.status === "done" ? <span className="badge ok">approved</span> : null} />
          {pendingApproval ? <section className="gate" data-testid="create-workflow-gate">
            <div className="pane-title"><h3>{pendingApproval.requestTitle ?? "Approve workflow design"}</h3><p>{pendingApproval.requestSummary ?? design?.summary ?? "Review the design before scaffolding."}</p></div>
            <div className="stack"><span className="eyebrow">Decision note</span><MarkdownEditor value={note || noteSeed} resetKey={`gate-note-${approvalKey}`} onChange={(markdown) => { setNote(markdown); setNoteTouched(true); }} compact /></div>
            <div className="gate-actions"><button className="button ok" data-testid="create-workflow-approve" onClick={() => void decide(true)} disabled={busy}>{decision === "submitting" ? "Submitting..." : "Approve"}</button><button className="button danger" data-testid="create-workflow-deny" onClick={() => void decide(false)} disabled={busy}>Deny</button>{decision === "submitting" ? <span className="badge warn">submitting</span> : null}{decision === "error" ? <span className="badge bad">submit failed</span> : null}</div>
          </section> : decision === "denied" || final?.status === "denied" ? <section className="gate denied" data-testid="create-workflow-denied-banner"><h3>Design denied</h3><p>No files were written for this run.</p></section> : scaffold || decision === "approved" || final ? <section className="gate done" data-testid="create-workflow-approved-banner"><h3>Design approved</h3><p>Smithers moved on to scaffolding and verification.</p></section> : <Pending text="The approval form will appear after the design step finishes." />}
        </>;
      case "scaffold":
        return <>
          <PaneHeader eyebrow="Step 5" title="Scaffolded files" summary="The workflow files Smithers wrote after design approval." aside={scaffold ? <span className="badge info">{scaffold.filesWritten.length} files</span> : null} />
          {scaffold ? <section className="card"><p>{scaffold.summary}</p><FileList files={scaffold.filesWritten} /></section> : <Pending text="Waiting for approval, then Smithers writes files here." />}
        </>;
      case "verify":
        return <>
          <PaneHeader eyebrow="Step 6" title="Verification" summary="The compile/render check for the generated workflow." aside={verifyPassed === true ? <span className="badge ok">passed</span> : verifyPassed === false ? <span className="badge bad">failed</span> : null} />
          {verify ? <section className="card">{verify.notes ? <p>{verify.notes}</p> : null}{verify.command ? <code className="code">$ {verify.command}</code> : null}{verify.errors.length ? <code className="code">{verify.errors.join("\n\n")}</code> : null}{!verify.errors.length && verify.passed ? <p>Verification passed.</p> : null}</section> : verifyPassed !== undefined ? <section className="card"><p>{verifyPassed ? "Verification passed." : "Verification failed. See the live activity for the failing node."}</p></section> : <Pending text="Verification has not run yet." />}
        </>;
      case "document":
        return <>
          <PaneHeader eyebrow="Step 7" title="Generated skill doc" summary="The documentation Smithers generated for future agents using this workflow." aside={documentation?.skillPath ? <span className="badge info">{documentation.skillPath}</span> : null} />
          {documentation ? <MarkdownEditor value={documentMarkdown(documentation)} readOnly /> : <Pending text="Waiting for documentation." />}
        </>;
      case "result":
        return <>
          <PaneHeader eyebrow="Step 8" title="Run result" summary="A small final receipt for what was built." aside={final ? <span className={"badge " + statusClass(final.status)}>{final.status}</span> : null} />
          {final ? <section className={"gate" + (final.status === "built" || final.status === "finished" ? " done" : final.status === "denied" || final.status === "verify-failed" ? " denied" : "")} data-testid="create-workflow-result"><h3>{final.summary || final.workflow}</h3><div className="result"><span className="label">Workflow</span><span className="val">{final.workflow}</span><span className="label">Workflow file</span><span className="val">{final.workflowFile || "-"}</span><span className="label">Files written</span><span className="val">{final.fileCount}</span><span className="label">Verified</span><span className="val">{final.verified ? "yes" : "no"}</span>{final.skillPath ? <><span className="label">Skill</span><span className="val">{final.skillPath}</span></> : null}</div>{final.filesWritten.length ? <FileList files={final.filesWritten} /> : null}</section> : <Pending text="The final summary appears when the run finishes." />}
        </>;
    }
  }

  return (
    <main className="shell" data-testid="create-workflow-ui">
      <style>{crepeThemeCss}</style>
      <style>{xyflowThemeCss}</style>
      <style>{themeCss}</style>
      <header className="top">
        <div className="title">
          <h1>Create Workflow</h1>
          <span className="pill" data-testid="create-workflow-runid">{shortRunId(activeRunId)}</span>
          {runStatus ? <span className={"badge " + statusClass(runStatus)}>{runStatus}</span> : null}
          {workflowName ? <span className="badge info" data-testid="create-workflow-name">{workflowName}</span> : null}
          {activeRunId ? <span className={"live" + (stream.streaming ? " on" : "")} data-testid="create-workflow-live"><span className="live-dot" />{stream.streaming ? "live" : "offline"} · {eventCount}</span> : null}
        </div>
        <div className="actions">
          {runOptions.length ? <select className="run-select" data-testid="create-workflow-run-select" value={activeRunId ?? ""} onChange={(event) => setSelectedRunId(event.currentTarget.value || undefined)}>{runOptions.map((run) => <option key={run.runId} value={run.runId}>{shortRunId(run.runId)} · {run.status ?? "unknown"}</option>)}</select> : null}
          <input className="input prompt-input" data-testid="create-workflow-prompt" value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} placeholder="Describe a workflow to build..." />
          {running ? <button className="button danger" data-testid="create-workflow-cancel" onClick={() => void cancel()} disabled={busy}>Cancel</button> : null}
          <button className="button primary" data-testid="create-workflow-launch" onClick={() => void launch()} disabled={busy || !prompt.trim()}>{busy ? "Building..." : "Build"}</button>
        </div>
      </header>
      <nav className="tabbar" role="tablist" data-testid="create-workflow-tabbar">
        {steps.map((step) => {
          const glyph = tabGlyph(step.status);
          return <button key={step.id} type="button" role="tab" aria-selected={activeTab === step.id} className={activeTab === step.id ? "tab is-active" : "tab"} data-testid={`create-workflow-tab-${step.id}`} onClick={() => setActiveTab(step.id)}><span className={glyph.className}>{glyph.text}</span>{step.label}</button>;
        })}
      </nav>
      {!activeRunId ? <div className="content"><LaunchState prompt={prompt} name={name} review={review} busy={busy} launchError={launchError} onPrompt={setPrompt} onName={setName} onReview={setReview} onLaunch={() => void launch()} /></div> : <div className="content">
        {steps.map((step) => <div key={step.id} hidden={activeTab !== step.id} className={step.id === "design" ? "pane pane-fill" : "pane"} data-testid={`create-workflow-pane-${step.id}`}>{activeTab === step.id ? renderTab(step.id) : null}</div>)}
        <ActivityStrip items={activityItems} eventCount={eventCount} streaming={Boolean(stream.streaming)} open={activityOpen} onToggle={() => setActivityOpen((open) => !open)} />
      </div>}
    </main>
  );
}

createGatewayReactRoot(<App />);
