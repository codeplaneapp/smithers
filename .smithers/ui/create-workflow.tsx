/** @jsxImportSource react */
// Custom UI for the `create-workflow` meta-workflow. Looks + works like the
// multi app / apps/smithers control surface: multi design tokens (Inter, brand
// purple, light/OS-dark), an n8n-style ReactFlow graph, Milkdown Crepe WYSIWYG
// editors for the run's markdown assets, real-time via gateway-react, and a
// step-by-step wizard — one step per workflow task that you tab through.
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
type ApprovalSummary = {
  runId: string;
  nodeId: string;
  iteration: number;
  requestTitle?: string;
  requestSummary?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function rowOf(value: unknown): Record<string, unknown> {
  const response = isRecord(value) ? value : {};
  const data = isRecord(response.data) ? response.data : response;
  const row = isRecord(data.row) ? data.row : isRecord(data) ? data : {};
  return row;
}

// The gateway surfaces every frame under the category `event: "run.event"`; the
// meaningful type/nodeId/detail live in `payload`. Drop the high-frequency noise
// and render node lifecycle + agent + approval events like multi's livelog.
const NOISE_EVENTS = new Set([
  "TaskHeartbeat",
  "FrameCommitted",
  "SnapshotCaptured",
  "AgentTraceEvent",
  "AgentTraceSummary",
  "TokenUsageReported",
  "NodePending",
]);
function describeEvent(frame: { event?: string; payload?: unknown }):
  | { label: string; node?: string; detail?: string; tone: string }
  | null {
  const p = isRecord(frame.payload) ? frame.payload : {};
  const type = asString(p.type) ?? asString(frame.event) ?? "event";
  if (NOISE_EVENTS.has(type)) return null;
  const node = asString(p.nodeId);
  switch (type) {
    case "RunStarted":
      return { label: "run started", tone: "info" };
    case "RunStatusChanged":
      return { label: `status → ${asString(p.status) ?? "?"}`, tone: "info" };
    case "NodeStarted":
      return { label: "started", node, tone: "info" };
    case "NodeOutput":
      return { label: "output", node, tone: "warn" };
    case "NodeFinished":
      return { label: "finished", node, tone: "ok" };
    case "NodeFailed":
      return { label: "failed", node, tone: "bad" };
    case "NodeWaitingApproval":
      return { label: "waiting approval", node, tone: "warn" };
    case "ApprovalRequested":
      return { label: "approval requested", node, tone: "warn" };
    case "ApprovalGranted":
      return { label: "approved", node, tone: "ok" };
    case "ApprovalDenied":
      return { label: "denied", node, tone: "bad" };
    case "AgentEvent": {
      const ev = isRecord(p.event) ? p.event : {};
      const evType = asString(ev.type) ?? "event";
      const engine = asString(p.engine) ?? "agent";
      return { label: `${engine}: ${evType}`, node, detail: asString(ev.title), tone: "muted" };
    }
    default:
      return { label: type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(), node, tone: "muted" };
  }
}

// ---- Output extractors (one per create-workflow node) ----
type ClarifyOutput = {
  name: string;
  goal: string;
  trigger: string;
  stages: string[];
  loops: string[];
  humanGates: string[];
  successCriteria: string[];
  openQuestions: string[];
};
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
type ProvisionOutput = {
  docsFragments: NamedReason[];
  examples: NamedReason[];
  components: NamedReason[];
  skills: SkillProvision[];
  agents: string[];
  notes: string;
};
function namedReasons(value: unknown): NamedReason[] {
  return asRecordArray(value).map((r) => ({ name: asString(r.name) ?? "?", reason: asString(r.reason) ?? "" }));
}
function extractProvision(value: unknown): ProvisionOutput | null {
  const row = rowOf(value);
  if (row.docsFragments === undefined && row.examples === undefined && row.skills === undefined && row.notes === undefined)
    return null;
  return {
    docsFragments: namedReasons(row.docsFragments),
    examples: namedReasons(row.examples),
    components: namedReasons(row.components),
    skills: asRecordArray(row.skills).map((r) => ({
      name: asString(r.name) ?? "?",
      action: asString(r.action) ?? "recommended",
      reason: asString(r.reason) ?? "",
    })),
    agents: asStringArray(row.agents),
    notes: asString(row.notes) ?? "",
  };
}

type DesignTask = { id: string; purpose: string; agent: string; outputs: string[] };
type DesignOutput = {
  workflowName: string;
  summary: string;
  graphShape: string;
  tasks: DesignTask[];
  prompts: string[];
  humanGates: string[];
  rationale: string;
};
function extractDesign(value: unknown): DesignOutput | null {
  const row = rowOf(value);
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return {
    workflowName: asString(row.workflowName) ?? "new-workflow",
    summary,
    graphShape: asString(row.graphShape) ?? "",
    tasks: asRecordArray(row.tasks).map((t) => ({
      id: asString(t.id) ?? "?",
      purpose: asString(t.purpose) ?? "",
      agent: asString(t.agent) ?? "",
      outputs: asStringArray(t.outputs),
    })),
    prompts: asStringArray(row.prompts),
    humanGates: asStringArray(row.humanGates),
    rationale: asString(row.rationale) ?? "",
  };
}

type ScaffoldFile = { path: string; kind: string };
type ScaffoldOutput = { summary: string; workflowName: string; filesWritten: ScaffoldFile[] };
function extractScaffold(value: unknown): ScaffoldOutput | null {
  const row = rowOf(value);
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return {
    summary,
    workflowName: asString(row.workflowName) ?? "new-workflow",
    filesWritten: asRecordArray(row.filesWritten).map((f) => ({
      path: asString(f.path) ?? "?",
      kind: asString(f.kind) ?? "other",
    })),
  };
}

type VerifyOutput = { passed: boolean; command: string; errors: string[]; notes: string };
function extractVerify(value: unknown): VerifyOutput | null {
  const row = rowOf(value);
  const passed = asBool(row.passed);
  if (passed === undefined) return null;
  return {
    passed,
    command: asString(row.command) ?? "",
    errors: asStringArray(row.errors),
    notes: asString(row.notes) ?? "",
  };
}

type DocumentOutput = { summary: string; skillPath: string | null };
function extractDocument(value: unknown): DocumentOutput | null {
  const row = rowOf(value);
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return { summary, skillPath: asString(row.skillPath) ?? null };
}

type FinalOutput = {
  workflow: string;
  workflowFile: string;
  status: string;
  summary: string;
  filesWritten: string[];
  fileCount: number;
  verified: boolean;
  skillPath: string | null;
};
function extractFinal(value: unknown): FinalOutput | null {
  const row = rowOf(value);
  const status = asString(row.status);
  if (status === undefined) return null;
  return {
    workflow: asString(row.workflow) ?? "new-workflow",
    workflowFile: asString(row.workflowFile) ?? "",
    status,
    summary: asString(row.summary) ?? "",
    filesWritten: asStringArray(row.filesWritten),
    fileCount: asNumber(row.fileCount) ?? 0,
    verified: asBool(row.verified) ?? false,
    skillPath: asString(row.skillPath) ?? null,
  };
}

// ---- Adapters ----
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
  return design.tasks.map((task, i) => ({
    id: task.id,
    label: task.id,
    kind: inferKind(task),
    output: task.outputs[0] ?? (task.agent && !task.agent.toLowerCase().includes("none") ? task.agent : ""),
    dependsOn: i > 0 ? [design.tasks[i - 1].id] : [],
  }));
}

function clarifyMarkdown(c: ClarifyOutput): string {
  const lines = [`## ${c.name}`, "", c.goal, "", `**Trigger:** \`${c.trigger}\``];
  if (c.stages.length) lines.push("", "### Stages", ...c.stages.map((s, i) => `${i + 1}. ${s}`));
  if (c.successCriteria.length) lines.push("", "### Success criteria", ...c.successCriteria.map((s) => `- ${s}`));
  if (c.loops.length) lines.push("", "### Loops", ...c.loops.map((s) => `- ${s}`));
  if (c.humanGates.length) lines.push("", "### Human gates", ...c.humanGates.map((s) => `- ${s}`));
  if (c.openQuestions.length) lines.push("", "### Open questions", ...c.openQuestions.map((s) => `- ${s}`));
  return lines.join("\n");
}
function designMarkdown(d: DesignOutput): string {
  const lines = [d.summary];
  if (d.rationale) lines.push("", "### Rationale", d.rationale);
  if (d.prompts.length) lines.push("", "### Prompts to author", ...d.prompts.map((p) => `- \`${p}\``));
  return lines.join("\n");
}
function documentMarkdown(d: DocumentOutput): string {
  const lines = [d.summary];
  if (d.skillPath) lines.push("", `**Skill:** \`${d.skillPath}\``);
  return lines.join("\n");
}
function openQuestionsSeed(c: ClarifyOutput | null): string {
  if (!c || c.openQuestions.length === 0) return "";
  return ["Answering the open questions:", "", ...c.openQuestions.map((q) => `- **${q}**\n  `)].join("\n");
}

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "run";
  if (status === "waiting-approval" || status === "waiting-event") return "warn";
  if (status === "finished") return "ok";
  if (status === "failed" || status === "cancelled") return "bad";
  return "";
}

type StepStatus = "pending" | "active" | "done" | "failed";
type StepDef = { id: string; label: string; status: StepStatus };

function Pending({ text }: { text: string }) {
  return <div className="pending-hint">{text}</div>;
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Describe the workflow you want Smithers to build, in plain English.");
  const [name, setName] = useState("");
  const [review, setReview] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<"idle" | "submitting" | "approved" | "denied" | "error">("idle");
  // Which step's detail modal is open (index into `steps`), or null for the canvas.
  const [modalStep, setModalStep] = useState<number | null>(null);
  const [dockOpen, setDockOpen] = useState(true);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const runs = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? runs[0]?.runId;
  const runQuery = useGatewayRun(activeRunId);
  const liveRun = (runQuery.data ?? undefined) as RunSummary | undefined;
  const activeRun = liveRun ?? runs.find((r) => r.runId === activeRunId);

  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0, maxEvents: 1000 });
  const approvalsQuery = useGatewayApprovals(activeRunId ? { filter: { runId: activeRunId } } : {});

  const clarifyOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "clarify", iteration: 0 });
  const provisionOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "provision", iteration: 0 });
  const designOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "design", iteration: 0 });
  const scaffoldOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "scaffold", iteration: 0 });
  const verifyOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "verify:loop:verify", iteration: 0 });
  const documentOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "document", iteration: 0 });
  const outputOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "output", iteration: 0 });

  const clarify = useMemo(() => extractClarify(clarifyOut.data), [clarifyOut.data]);
  const provision = useMemo(() => extractProvision(provisionOut.data), [provisionOut.data]);
  const design = useMemo(() => extractDesign(designOut.data), [designOut.data]);
  const scaffold = useMemo(() => extractScaffold(scaffoldOut.data), [scaffoldOut.data]);
  const verify = useMemo(() => extractVerify(verifyOut.data), [verifyOut.data]);
  const documentation = useMemo(() => extractDocument(documentOut.data), [documentOut.data]);
  const final = useMemo(() => extractFinal(outputOut.data), [outputOut.data]);

  const events = stream.events ?? [];
  const eventCount = events.length;
  const runStatus = activeRun?.status;

  const nodeRefetchers = [clarifyOut, provisionOut, designOut, scaffoldOut, verifyOut, documentOut, outputOut];
  const refetchRef = useRef(nodeRefetchers);
  refetchRef.current = nodeRefetchers;
  useEffect(() => {
    if (!activeRunId) return;
    for (const q of refetchRef.current) void q.refetch();
  }, [activeRunId, eventCount, runStatus]);
  useEffect(() => {
    setDecision("idle");
    setNote("");
    setModalStep(null);
    autoOpenedRef.current = undefined;
  }, [activeRunId]);
  const autoOpenedRef = useRef<string | undefined>(undefined);

  const pendingApproval = useMemo(() => {
    const list = (approvalsQuery.data ?? []) as ApprovalSummary[];
    return list.find((a) => a.runId === activeRunId && a.nodeId === "approve-design");
  }, [approvalsQuery.data, activeRunId]);

  const workflowName = scaffold?.workflowName ?? design?.workflowName ?? clarify?.name ?? final?.workflow;
  const running = statusClass(runStatus) === "run" || runStatus === "waiting-event" || runStatus === "waiting-approval";
  const verifyPassed = verify?.passed ?? (final ? final.verified : undefined);
  const spec = useMemo(() => (design ? designToSpec(design) : []), [design]);

  // ---- Wizard steps (one per workflow task) ----
  const steps: StepDef[] = [
    { id: "clarify", label: "Clarify", status: clarify ? "done" : "pending" },
    { id: "provision", label: "Provision", status: provision ? "done" : "pending" },
    { id: "design", label: "Design", status: design ? "done" : "pending" },
    {
      id: "approve",
      label: "Approve",
      status: pendingApproval
        ? "active"
        : decision === "denied" || final?.status === "denied"
          ? "failed"
          : scaffold || decision === "approved" || final
            ? "done"
            : "pending",
    },
    { id: "scaffold", label: "Scaffold", status: scaffold ? "done" : "pending" },
    { id: "verify", label: "Verify", status: verifyPassed === true ? "done" : verifyPassed === false ? "failed" : "pending" },
    { id: "document", label: "Document", status: documentation ? "done" : "pending" },
    {
      id: "result",
      label: "Result",
      status: final ? (final.status === "built" ? "done" : final.status === "denied" || final.status === "verify-failed" ? "failed" : "active") : "pending",
    },
  ];
  // The live step = the earliest not-yet-complete step (the run's current focus).
  const liveIndex = (() => {
    if (pendingApproval) return steps.findIndex((s) => s.id === "approve");
    let last = -1;
    steps.forEach((s, i) => {
      if (s.status === "done" || s.status === "failed") last = i;
    });
    return Math.min(last + 1, steps.length - 1);
  })();
  if (steps[liveIndex] && steps[liveIndex].status === "pending" && running) steps[liveIndex].status = "active";

  // The pipeline itself, as the n8n canvas graph — one node per step, live status.
  const STEP_DESC: Record<string, string> = {
    clarify: "structured spec",
    provision: "docs & skills",
    design: "workflow graph",
    approve: "human gate",
    scaffold: "write files",
    verify: "render graph",
    document: "skill doc",
    result: "summary",
  };
  const STEP_KIND: Record<string, NodeKind> = {
    clarify: "agent",
    provision: "agent",
    design: "agent",
    approve: "approval",
    scaffold: "agent",
    verify: "compute",
    document: "agent",
    result: "merge",
  };
  const pipelineSpec: WorkflowSpecNode[] = steps.map((s, i) => ({
    id: s.id,
    label: s.label,
    kind: STEP_KIND[s.id] ?? "compute",
    output: STEP_DESC[s.id] ?? "",
    status: s.status === "active" ? "running" : s.status === "done" ? "done" : s.status === "failed" ? "failed" : "pending",
    dependsOn: i > 0 ? [steps[i - 1].id] : [],
  }));

  // Surface the approval form automatically (once per run) when it's needed.
  useEffect(() => {
    if (pendingApproval && autoOpenedRef.current !== activeRunId) {
      autoOpenedRef.current = activeRunId;
      setModalStep(3);
    }
  }, [pendingApproval, activeRunId]);

  async function refresh() {
    await Promise.all([runsQuery.refetch(), ...refetchRef.current.map((q) => q.refetch()), approvalsQuery.refetch()]);
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input: { prompt, name: name.trim() || null, review } });
      setSelectedRunId(run.runId);
      setPinnedStep(null);
      await refresh();
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
      await actions.submitApproval({
        runId: pendingApproval.runId,
        nodeId: pendingApproval.nodeId,
        iteration: pendingApproval.iteration,
        decision: { approved, note: note.trim() || undefined },
      });
      setDecision(approved ? "approved" : "denied");
      await refresh();
    } catch {
      setDecision("error");
    } finally {
      setBusy(false);
    }
  }

  function stepBody(id: string) {
    switch (id) {
      case "clarify":
        return clarify ? (
          <MarkdownEditor value={clarifyMarkdown(clarify)} readOnly />
        ) : (
          <Pending text="Turning your request into a buildable spec…" />
        );
      case "provision":
        return provision ? (
          <div className="card">
            {provision.notes ? <p>{provision.notes}</p> : null}
            <div className="chips">
              {provision.examples.map((e, i) => <span className="chip mono" key={"ex" + i} title={e.reason}>example: {e.name}</span>)}
              {provision.docsFragments.map((d, i) => <span className="chip" key={"doc" + i} title={d.reason}>docs: {d.name}</span>)}
              {provision.skills.map((s, i) => <span className="chip" key={"sk" + i} title={s.reason}>skill: {s.name} · {s.action}</span>)}
              {provision.agents.map((a, i) => <span className="chip mono" key={"ag" + i}>agent: {a}</span>)}
            </div>
          </div>
        ) : (
          <Pending text="Gathering docs, examples & skills the new workflow needs…" />
        );
      case "design":
        return spec.length > 0 ? (
          <>
            <div className="graph-wrap" data-testid="create-workflow-graph"><WorkflowGraph spec={spec} /></div>
            {design ? <MarkdownEditor value={designMarkdown(design)} readOnly compact /> : null}
          </>
        ) : (
          <Pending text="Designing the workflow graph…" />
        );
      case "approve":
        if (pendingApproval) {
          return (
            <div className="gate" data-testid="create-workflow-gate">
              <p>{pendingApproval.requestSummary ?? design?.summary ?? "Review the design before scaffolding."}</p>
              <span className="eyebrow">Decision note{clarify && clarify.openQuestions.length ? " — answer the open questions here" : ""}</span>
              <MarkdownEditor value={openQuestionsSeed(clarify)} resetKey={"gate-note-" + activeRunId} onChange={setNote} compact />
              <div className="gate-actions">
                <button className="button ok" data-testid="create-workflow-approve" onClick={() => void decide(true)} disabled={busy}>{decision === "submitting" ? "Submitting…" : "Approve & scaffold"}</button>
                <button className="button danger" data-testid="create-workflow-deny" onClick={() => void decide(false)} disabled={busy}>Deny</button>
              </div>
              {decision === "submitting" ? <span className="muted" data-testid="create-workflow-decision-status">Sending decision to the run…</span> : null}
              {decision === "error" ? <span style={{ color: "var(--bad)" }} data-testid="create-workflow-decision-status">Failed to submit — retry.</span> : null}
            </div>
          );
        }
        if (decision === "denied" || final?.status === "denied")
          return <div className="gate denied" data-testid="create-workflow-denied-banner"><h3>Design denied — no files written.</h3></div>;
        if (scaffold || decision === "approved" || final)
          return <div className="gate done" data-testid="create-workflow-approved-banner"><h3>Design approved.</h3><p>Scaffolding proceeded to write the workflow files.</p></div>;
        return <Pending text="The design approval gate will appear here once the design is ready." />;
      case "scaffold":
        return scaffold ? (
          <div className="card">
            <p>{scaffold.summary}</p>
            {scaffold.filesWritten.length ? (
              <ul className="files">{scaffold.filesWritten.map((f, i) => <li key={i}><span>{f.path}</span><span className="kind">{f.kind}</span></li>)}</ul>
            ) : null}
          </div>
        ) : (
          <Pending text={decision === "approved" || (!pendingApproval && running) ? "Writing the workflow files…" : "Waiting for design approval, then files are written here."} />
        );
      case "verify":
        return verify ? (
          <div className="card">
            <p>{verify.notes}</p>
            {verify.command ? <code className="code">$ {verify.command}</code> : null}
            {verify.errors.length ? <code className="code">{verify.errors.join("\n\n")}</code> : null}
          </div>
        ) : verifyPassed !== undefined ? (
          <div className="card"><p>{verifyPassed ? "Graph renders cleanly." : "Graph failed to render — see run logs."}</p></div>
        ) : (
          <Pending text="Rendering the new workflow's graph to verify it compiles…" />
        );
      case "document":
        return documentation ? (
          <MarkdownEditor value={documentMarkdown(documentation)} readOnly compact />
        ) : (
          <Pending text="Writing the agent skill doc for the new workflow…" />
        );
      case "result":
        return final ? (
          <div className={"gate" + (final.status === "built" ? " done" : final.status === "denied" || final.status === "verify-failed" ? " denied" : "")} data-testid="create-workflow-result">
            <h3>{final.summary}</h3>
            <div className="result">
              <span className="label">Workflow</span><span className="val">{final.workflow}</span>
              <span className="label">File</span><span className="val">{final.workflowFile}</span>
              <span className="label">Files written</span><span className="val">{final.fileCount}</span>
              <span className="label">Verified</span><span className="val">{final.verified ? "yes" : "no"}</span>
              {final.skillPath ? (<><span className="label">Skill</span><span className="val">{final.skillPath}</span></>) : null}
            </div>
          </div>
        ) : (
          <Pending text="The run reports what it built here when it finishes." />
        );
      default:
        return null;
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
          <span className="pill" data-testid="create-workflow-runid">{activeRunId ? shortRunId(activeRunId) : "no run"}</span>
          {activeRun ? <span className={"badge " + statusClass(runStatus)}>{runStatus ?? "idle"}</span> : null}
          {workflowName ? <span className="badge info" data-testid="create-workflow-name">{workflowName}</span> : null}
          {activeRunId ? (
            <span className={"live" + (stream.streaming ? " on" : "")} data-testid="create-workflow-live" title="Real-time via gateway-react">
              <span className="live-dot" />{stream.streaming ? "live" : "offline"} · {eventCount}
            </span>
          ) : null}
        </div>
        <div className="actions">
          {runs.length ? (
            <select className="run-select" data-testid="create-workflow-run-select" value={activeRunId ?? ""} onChange={(e) => setSelectedRunId(e.currentTarget.value)}>
              {runs.map((r) => <option key={r.runId} value={r.runId}>{shortRunId(r.runId)} · {r.status ?? "?"}</option>)}
            </select>
          ) : null}
          <input className="input" data-testid="create-workflow-prompt" style={{ minWidth: 200, flex: 1, maxWidth: 380 }} value={prompt} onChange={(e) => setPrompt(e.currentTarget.value)} placeholder="Describe the workflow to build..." />
          <input className="input mono" data-testid="create-workflow-name-input" style={{ width: 150 }} value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="kebab-id (auto)" />
          <label className="check"><input type="checkbox" checked={review} onChange={(e) => setReview(e.currentTarget.checked)} /> Review</label>
          {running ? <button className="button danger" data-testid="create-workflow-cancel" onClick={() => void cancel()} disabled={busy}>Cancel</button> : null}
          <button className="button primary" data-testid="create-workflow-launch" onClick={() => void launch()} disabled={busy}>Build</button>
        </div>
      </header>

      {!activeRunId ? (
        <div className="main" style={{ gridTemplateColumns: "1fr" }}>
          <div className="content">
            <div className="launch">
              <section className="card" data-testid="create-workflow-empty">
                <div><span className="eyebrow">New workflow</span><h2>Build a Smithers workflow from a plain-English ask</h2></div>
                <p>It clarifies the spec, provisions docs &amp; skills, designs the graph, pauses for your approval, then scaffolds, verifies, and documents real files.</p>
                <span className="eyebrow">What should it do?</span>
                <textarea className="input" data-testid="create-workflow-prompt-empty" value={prompt} onChange={(e) => setPrompt(e.currentTarget.value)} placeholder="e.g. Build a workflow that hunts flaky tests..." />
                <span className="eyebrow">Workflow id (optional)</span>
                <input className="input mono" value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="kebab-case-id (auto if blank)" />
                <div className="row">
                  <label className="check"><input type="checkbox" checked={review} onChange={(e) => setReview(e.currentTarget.checked)} /> Pause for design approval before writing files</label>
                  <button className="button primary" data-testid="create-workflow-launch-empty" onClick={() => void launch()} disabled={busy}>Build Workflow</button>
                </div>
              </section>
            </div>
          </div>
        </div>
      ) : (
        <div className="canvas" data-testid="create-workflow-canvas">
          <div className="canvas-graph" data-testid="create-workflow-pipeline">
            <WorkflowGraph spec={pipelineSpec} onNodeClick={(id) => setModalStep(steps.findIndex((s) => s.id === id))} />
          </div>

          {pendingApproval && modalStep === null ? (
            <button className="canvas-hint" onClick={() => setModalStep(3)} data-testid="create-workflow-approval-hint">⏸ Approval needed — open the Approve step</button>
          ) : null}

          {/* Floating, collapsible live activity dock */}
          <div className={"dock" + (dockOpen ? "" : " collapsed")}>
            <div className="dock-head" onClick={() => setDockOpen((o) => !o)}>
              <span className={"live" + (stream.streaming ? " on" : "")}><span className="live-dot" /></span>
              <span className="grow">Live activity · {eventCount}</span>
              <span>{dockOpen ? "▾" : "▸"}</span>
            </div>
            {dockOpen ? (
              <div className="livelog" data-testid="create-workflow-feed">
                {events.map((f) => ({ seq: f.seq, d: describeEvent(f) })).filter((x) => x.d).slice(-80).reverse().map(({ seq, d }) => (
                  <div className="livelog-line" key={seq}>
                    <span className="livelog-seq">{seq}</span>
                    <span className={"livelog-event " + d!.tone}>{d!.label}</span>
                    {d!.node ? <span className="livelog-node">{d!.node}</span> : null}
                    {d!.detail ? <span className="livelog-detail">{d!.detail}</span> : null}
                  </div>
                ))}
                {events.length === 0 ? <div className="empty">No events yet.</div> : null}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Step detail modal (opened by clicking a node) */}
      {activeRunId && modalStep !== null && steps[modalStep] ? (
        <div className="modal-backdrop" onClick={() => setModalStep(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} data-testid={"create-workflow-modal-" + steps[modalStep].id}>
            <div className="modal-head">
              <div className="left">
                <span className={"badge " + (steps[modalStep].status === "done" ? "ok" : steps[modalStep].status === "failed" ? "bad" : steps[modalStep].status === "active" ? "run" : "")}>{modalStep + 1}/{steps.length}</span>
                <h2>{steps[modalStep].label}</h2>
                <span className="muted">{steps[modalStep].status}</span>
              </div>
              <div className="modal-nav">
                <button className="button" data-testid="create-workflow-back" onClick={() => setModalStep(Math.max(0, modalStep - 1))} disabled={modalStep === 0}>← Back</button>
                <button className="button" data-testid="create-workflow-next" onClick={() => setModalStep(Math.min(steps.length - 1, modalStep + 1))} disabled={modalStep === steps.length - 1}>Next →</button>
                <button className="icon-button" aria-label="Close" data-testid="create-workflow-modal-close" onClick={() => setModalStep(null)}>✕</button>
              </div>
            </div>
            <div className={"modal-body" + (steps[modalStep].id === "design" ? " graph-step" : "")} data-testid={"create-workflow-pane-" + steps[modalStep].id}>
              {stepBody(steps[modalStep].id)}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

createGatewayReactRoot(<App />);
