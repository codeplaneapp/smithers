/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRunTree,
  useGatewayRuns,
  useGatewayTickets,
} from "smithers-orchestrator/gateway-react";
import { WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";
import { docsContent } from "./ddd-docsContent.generated";
import { crepeThemeCss } from "./crepeTheme.generated";
import { ticketsBacklog } from "./ddd-ticketsBacklog.generated";
import {
  ErrorBanner,
  FeatureDetail,
  asArray,
  asString,
  assetBaseFromUrl,
  changedFilesFromMetaTicket,
  errorMessage,
  features,
  formatStatus,
  shortRunId,
  statusClass,
  isRecord,
  isFailedTerminalRunStatus,
  makeAssetUrl,
  loadSpecDrafts,
  isTerminalRunStatus,
  normalizeMarkdownForDirty,
  reconcileDraftsAfterRun,
  resolveDocLink,
  rowOf,
  saveSpecDrafts,
  runIdFromUrl,
  strings,
  styles,
  updatedDocPathsFromSpec,
  type EventFrame,
  type AuditRow,
  type DraftRunNotice,
  type Feature,
  type RunSummaryRow,
  type TabKey,
  type TicketRow,
} from "./ddd-shared";
import { SpecsTab } from "./ddd-SpecsTab";
import { AuditTab } from "./ddd-AuditTab";
import { LiveTab } from "./ddd-LiveTab";
import { TicketsTab } from "./ddd-TicketsTab";
import { FeaturesTab } from "./ddd-FeaturesTab";
import { NewEntryMenu, StartPane, type LaunchState } from "./ddd-StartPane";
import { Tutorial, shouldShowTutorial } from "./ddd-Tutorial";

export type TriageItem = {
  slot: number;
  featureId: string;
  title: string;
  agent: string;
  reason: string;
  taskType: string;
  files: string[];
  tests: string[];
  acceptance: string[];
};

export function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function extractTriage(value: unknown): TriageItem[] {
  const row = rowOf(value);
  return parseArray(row?.selected)
    .filter(isRecord)
    .map((item) => ({
      slot: Number(item.slot ?? 0),
      featureId: asString(item.featureId ?? item.feature_id),
      title: asString(item.title),
      agent: asString(item.agent),
      reason: asString(item.reason),
      taskType: asString(item.taskType ?? item.task_type),
      files: strings(item.files),
      tests: strings(item.tests),
      acceptance: strings(item.acceptance),
    }))
    .filter((item) => item.slot > 0);
}

export function extractMaterializedTickets(value: unknown): TicketRow[] {
  const row = rowOf(value);
  return parseArray(row?.tickets)
    .filter(isRecord)
    .map((ticket): TicketRow => {
      const row = {
        ...ticket,
        path: asString(ticket.path),
        kind: asString(ticket.kind) || "ticket",
        content: asString(ticket.content),
        status: asString(ticket.status) || "todo",
        updatedAtMs: Number(ticket.updatedAtMs ?? ticket.updated_at_ms ?? 0),
      };
      return row;
    })
    .filter((ticket) => ticket.path.length > 0);
}

export function mergeTickets(...groups: TicketRow[][]): TicketRow[] {
  const byPath = new Map<string, TicketRow>();
  for (const group of groups) {
    for (const ticket of group) {
      const key = normalizedTicketPathKey(ticket.path);
      if (!key || byPath.has(key)) continue;
      byPath.set(key, ticket);
    }
  }
  return [...byPath.values()];
}

export function normalizedTicketPathKey(path: unknown): string {
  let value = asString(path).trim().replace(/\\/g, "/");
  if (value.startsWith(".smithers/tickets/")) value = value.slice(".smithers/tickets/".length);
  value = value.replace(/^\.?\/*/, "");
  if (value.startsWith("tickets/")) value = value.slice("tickets/".length);
  value = value.replace(/\/+/g, "/");
  if (value.toLowerCase().endsWith(".md")) value = value.slice(0, -3);
  return value;
}

export function launchResultRunId(result: unknown): string {
  return isRecord(result) ? asString(result.runId) : "";
}

export function toRunRows(data: unknown): RunSummaryRow[] {
  const raw = Array.isArray(data) ? data : isRecord(data) ? asArray(data.runs) : [];
  return raw
    .filter(isRecord)
    .map((row) => ({ ...row, runId: asString(row.runId ?? row.id) }))
    .filter((row): row is RunSummaryRow => row.runId.length > 0);
}

const DDD_WORKFLOW_KEYS = new Set(["docs-driven-development"]);

function isDocsDrivenRun(run: RunSummaryRow, activeRunId: string | undefined): boolean {
  const workflowKey = asString(run.workflowKey ?? run.workflowName ?? run.workflow);
  return DDD_WORKFLOW_KEYS.has(workflowKey) || (!!activeRunId && run.runId === activeRunId);
}

const TABS: { key: TabKey; label: string }[] = [
  { key: "features", label: "Features" },
  { key: "specs", label: "Docs" },
  { key: "audit", label: "Audit" },
  { key: "live", label: "Live" },
  { key: "tickets", label: "Tickets" },
];

/**
 * Resolve a feature `links`/`endpoints` href (e.g. "features/runs.md#outputs")
 * to a bundled docsContent path so clicking a cross-link opens the shared doc in
 * the Docs tab. Content lives under .smithers/spec/content.
 */
function docPathForHref(href: string, specDocs = docsContent): string | undefined {
  // Feature links are authored relative to the content root; resolveDocLink also
  // handles ../ traversal and #anchors via the shared resolver.
  const target = resolveDocLink("", href, (path) => specDocs.some((doc) => doc.path === path));
  return target?.kind === "doc" ? target.path : undefined;
}

/**
 * The spec is a stub when it is empty or only carries the seeded
 * docs-driven-development record: nothing real to render yet, so the Start
 * pane becomes the landing view.
 */
export function specIsStub(specFeatures: ReadonlyArray<{ id: string }>): boolean {
  if (specFeatures.length === 0) return true;
  return specFeatures.length === 1 && specFeatures[0]!.id === "docs-driven-development";
}

/** Same-origin href to a sibling workflow's run UI (served by the same gateway). */
export function workflowUiHref(
  workflowKey: string,
  runId: string,
  pathname: string = window.location.pathname,
): string {
  const base = pathname.replace(/\/workflows\/[^/]*$/, "");
  return `${base}/workflows/${encodeURIComponent(workflowKey)}?runId=${encodeURIComponent(runId)}`;
}

export function workflowKeyFromPathname(
  pathname: string = typeof window === "undefined" ? "" : window.location.pathname,
): string {
  const match = pathname.match(/\/workflows\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]!) : "";
}

function slugForWorkflowName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "workflow"
  );
}

export function builderWorkflowName(description: string): string {
  return `build-${slugForWorkflowName(description)}`;
}

export function createWorkflowPrompt(description: string): string {
  const workflowName = builderWorkflowName(description);
  return (
    `Create a workflow named ${workflowName} for this durable process: ${description}\n` +
    `The workflow id and file slug must be exactly ${workflowName}. Include suitable verification and a companion skill.`
  );
}

export type AppProps = {
  specFeatures?: Feature[];
  specDocs?: typeof docsContent;
  ticketsBacklogData?: TicketRow[];
};

export function App({
  specFeatures = features,
  specDocs = docsContent,
  ticketsBacklogData = ticketsBacklog as unknown as TicketRow[],
}: AppProps = {}) {
  const runId = runIdFromUrl();
  const assetBase = assetBaseFromUrl();
  const assetUrl = makeAssetUrl(assetBase);
  const stub = specIsStub(specFeatures);
  const firstProductDoc = specDocs.find((doc) => doc.level === "product") ?? specDocs[0];
  const pageWorkflowKey = workflowKeyFromPathname();

  const [activeTab, setActiveTab] = useState<TabKey>("features");
  const [selectedPath, setSelectedPath] = useState(firstProductDoc?.path ?? "");
  const initialDraftsRef = useRef<Record<string, string> | null>(null);
  if (initialDraftsRef.current === null) initialDraftsRef.current = loadSpecDrafts(specDocs);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => initialDraftsRef.current ?? {});
  const [editorResetVersions, setEditorResetVersions] = useState<Record<string, number>>({});
  const [recoveredDraftPaths, setRecoveredDraftPaths] = useState<string[]>(() =>
    Object.keys(initialDraftsRef.current ?? {}),
  );
  const [launchedRunId, setLaunchedRunId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchPending, setLaunchPending] = useState(false);
  const [pickedRunId, setPickedRunId] = useState<string | undefined>(undefined);
  const [activeFeature, setActiveFeature] = useState<{ feature: Feature; note?: string } | null>(null);
  const [showStart, setShowStart] = useState(stub);
  const [showTutorial, setShowTutorial] = useState(shouldShowTutorial());
  const [createRun, setCreateRun] = useState<LaunchState>({ runId: null, error: null });
  const [generateRun, setGenerateRun] = useState<LaunchState>({ runId: null, error: null });
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [draftRunNotice, setDraftRunNotice] = useState<DraftRunNotice | null>(null);
  const [observedMaterializedTickets, setObservedMaterializedTickets] = useState<TicketRow[]>([]);
  const dispatchLaunchInFlight = useRef(false);
  const createLaunchInFlight = useRef(false);
  const generateLaunchInFlight = useRef(false);
  const reconciledDraftRunRef = useRef("");

  // ---- every gateway hook is called unconditionally, at the top, never behind
  //      a ??/&&/ternary/loop (short-circuiting a hook crashes React). ----
  const actions = useGatewayActions();

  // The Audit + Live tabs follow the run the user is actually watching: a run
  // dispatched from Specs (pickedRunId/launchedRunId), else the URL ?runId.
  // Bind every node-output hook to liveRunId so a dispatched run populates Audit.
  const liveRunId = pickedRunId ?? launchedRunId ?? runId;

  // Only product docs are editable; technical docs are derived and read-only.
  const changedFiles = specDocs
    .filter((doc) => doc.level === "product")
    .map((doc) => ({ path: doc.path, beforeMarkdown: doc.content, afterMarkdown: drafts[doc.path] ?? doc.content }))
    .filter((doc) => normalizeMarkdownForDirty(doc.beforeMarkdown) !== normalizeMarkdownForDirty(doc.afterMarkdown));
  const changedPaths = changedFiles.map((doc) => doc.path);

  const bootstrapOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "bootstrap", iteration: 0 });
  const metaTicketOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "metaTicket", iteration: 0 });
  const auditOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "audit", iteration: 0 });
  const specOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "spec-update", iteration: 0 });
  const triageOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "triage", iteration: 0 });
  const materializedTicketsOut = useGatewayNodeOutput({
    runId: liveRunId,
    nodeId: "materialize-tickets",
    iteration: 0,
  });
  const roundSummaryOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "round-summary", iteration: 0 });
  const runsState = useGatewayRuns({ filter: { limit: 100 } });
  const runDetail = useGatewayRun(liveRunId);
  const createRunDetail = useGatewayRun(createRun.runId ?? undefined);
  const generateRunDetail = useGatewayRun(generateRun.runId ?? undefined);
  const runTree = useGatewayRunTree(liveRunId);
  const runEvents = useGatewayRunEvents(liveRunId, { maxEvents: 500 });
  const ticketsState = useGatewayTickets({});
  const refetchRuns = runsState.refetch;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = window.setInterval(() => {
      void refetchRuns();
    }, 10_000);
    return () => window.clearInterval(id);
  }, [refetchRuns]);

  useEffect(() => {
    saveSpecDrafts(drafts);
  }, [drafts]);

  useEffect(() => {
    if (typeof window === "undefined" || changedPaths.length === 0) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [changedPaths.length]);

  const bootstrap = rowOf(bootstrapOut.data);
  const metaTicket = rowOf(metaTicketOut.data);
  const audit = rowOf(auditOut.data) as AuditRow | null;
  const spec = rowOf(specOut.data);
  const summary = rowOf(roundSummaryOut.data);
  const triage = extractTriage(triageOut.data);
  const materializedTickets = extractMaterializedTickets(materializedTicketsOut.data);

  const runDetailRow = rowOf(runDetail.data);
  const createRunRow = rowOf(createRunDetail.data);
  const generateRunRow = rowOf(generateRunDetail.data);
  const listedRuns = toRunRows(runsState.data).filter((run) => isDocsDrivenRun(run, liveRunId));
  const activeRunWorkflowKey =
    asString(runDetailRow?.workflowKey ?? runDetailRow?.workflowName ?? runDetailRow?.workflow) ||
    (generateRun.runId && liveRunId === generateRun.runId ? "docs-driven-development" : "") ||
    (DDD_WORKFLOW_KEYS.has(pageWorkflowKey) ? pageWorkflowKey : "") ||
    "docs-driven-development";
  const runs =
    liveRunId && !listedRuns.some((run) => run.runId === liveRunId)
      ? [
          {
            ...(runDetailRow ?? {}),
            runId: liveRunId,
            workflowKey: activeRunWorkflowKey,
            status: asString(runDetailRow?.status) || "queued",
            createdAtMs: Number(runDetailRow?.createdAtMs ?? runDetailRow?.created_at_ms ?? Date.now()),
          } as RunSummaryRow,
          ...listedRuns,
        ]
      : listedRuns;
  const selectedRun = runs.find((run) => run.runId === liveRunId);
  const selectedWorkflowKey =
    asString(selectedRun?.workflowKey ?? selectedRun?.workflowName ?? selectedRun?.workflow) || activeRunWorkflowKey;
  const expectsDddNodeOutputs = selectedWorkflowKey === "docs-driven-development";
  const runStatus = asString(runDetailRow?.status) || asString(selectedRun?.status) || undefined;
  const refetchDddNodeOutputs = useCallback(() => {
    return Promise.all([
      bootstrapOut.refetch(),
      metaTicketOut.refetch(),
      auditOut.refetch(),
      specOut.refetch(),
      triageOut.refetch(),
      materializedTicketsOut.refetch(),
      roundSummaryOut.refetch(),
    ]);
  }, [
    bootstrapOut.refetch,
    metaTicketOut.refetch,
    auditOut.refetch,
    specOut.refetch,
    triageOut.refetch,
    materializedTicketsOut.refetch,
    roundSummaryOut.refetch,
  ]);
  useEffect(() => {
    if (!liveRunId || !isTerminalRunStatus(runStatus)) return;
    void refetchDddNodeOutputs();
  }, [liveRunId, runStatus, refetchDddNodeOutputs]);
  const bootstrapReady = Boolean(asString(bootstrap?.summary));
  const roundSummaryReady = Boolean(asString(summary?.summary));
  useEffect(() => {
    if (!liveRunId || !roundSummaryReady) return;
    void refetchDddNodeOutputs();
  }, [liveRunId, roundSummaryReady, refetchDddNodeOutputs]);
  useEffect(() => {
    if (typeof window === "undefined" || !liveRunId || !expectsDddNodeOutputs) return;
    if (bootstrapReady && roundSummaryReady) return;
    void refetchDddNodeOutputs();
    const id = window.setInterval(() => {
      void refetchDddNodeOutputs();
    }, 1_000);
    return () => window.clearInterval(id);
  }, [liveRunId, expectsDddNodeOutputs, bootstrapReady, roundSummaryReady, refetchDddNodeOutputs]);
  const createRunStatus = asString(createRunRow?.status) || (createRun.runId ? "running" : undefined);
  const generateRunStatus = asString(generateRunRow?.status) || (generateRun.runId ? "running" : undefined);
  const createRunLiveState: LaunchState = {
    ...createRun,
    status: createRunStatus,
    statusLoading: createRunDetail.loading,
    statusError: errorMessage(createRunDetail.error),
  };
  const generateRunLiveState: LaunchState = {
    ...generateRun,
    status: generateRunStatus,
    statusLoading: generateRunDetail.loading,
    statusError: errorMessage(generateRunDetail.error),
  };
  const gatewayTickets = (ticketsState.data ?? []) as unknown as TicketRow[];
  // The full backlog (one ticket per gap, derived from features.json) is the
  // baseline; live gateway tickets + this round's materialized tickets overlay
  // on top (mergeTickets keeps the first occurrence per path). Tickets the run
  // actually materialized are the only run-time source: synthesizing tickets
  // client-side from triage output duplicated them with a second shape.
  const backlogTickets = ticketsBacklogData;
  const materializedTicketsKey = materializedTickets
    .map((ticket) => {
      const content = asString(ticket.content ?? "");
      return `${normalizedTicketPathKey(ticket.path)}:${ticket.updatedAtMs ?? 0}:${content.length}`;
    })
    .join("|");
  useEffect(() => {
    if (materializedTickets.length === 0) return;
    setObservedMaterializedTickets((current) => {
      const next = mergeTickets(materializedTickets, current);
      const unchanged =
        next.length === current.length &&
        next.every((ticket, index) => {
          const previous = current[index];
          return (
            previous &&
            normalizedTicketPathKey(previous.path) === normalizedTicketPathKey(ticket.path) &&
            asString(previous.content) === asString(ticket.content) &&
            previous.updatedAtMs === ticket.updatedAtMs
          );
        });
      return unchanged ? current : next;
    });
  }, [materializedTicketsKey]);
  const tickets = mergeTickets(gatewayTickets, materializedTickets, observedMaterializedTickets, backlogTickets);
  const events = (runEvents.events ?? []) as unknown as EventFrame[];
  const latestRunEventSeq = events.reduce((latest, frame) => {
    const seq = Number(frame.seq ?? 0);
    return Number.isFinite(seq) ? Math.max(latest, seq) : latest;
  }, 0);
  useEffect(() => {
    if (typeof window === "undefined" || !liveRunId || latestRunEventSeq <= 0) return;
    const timeout = window.setTimeout(() => {
      void refetchDddNodeOutputs();
      void runDetail.refetch();
      void refetchRuns();
    }, 100);
    return () => window.clearTimeout(timeout);
  }, [liveRunId, latestRunEventSeq, refetchDddNodeOutputs, runDetail.refetch, refetchRuns]);

  const dispatchedDraftFiles = changedFilesFromMetaTicket(metaTicket);
  const specUpdatedPaths = updatedDocPathsFromSpec(spec);
  const dispatchedDddRun =
    !!launchedRunId && liveRunId === launchedRunId && selectedWorkflowKey === "docs-driven-development";
  const canReconcileDispatchedDraftRun = dispatchedDddRun && (Boolean(spec) || isTerminalRunStatus(runStatus));
  const draftReconciliationSignature = [
    launchedRunId,
    runStatus,
    asString(spec?.status),
    dispatchedDraftFiles.map((file) => `${file.path}:${file.afterMarkdown.length}`).join("|"),
    specUpdatedPaths.join("|"),
  ].join("::");
  useEffect(() => {
    if (!canReconcileDispatchedDraftRun || !launchedRunId || dispatchedDraftFiles.length === 0) return;
    if (!spec && !isFailedTerminalRunStatus(runStatus)) return;
    if (reconciledDraftRunRef.current === draftReconciliationSignature) return;
    reconciledDraftRunRef.current = draftReconciliationSignature;

    const reconciliation = reconcileDraftsAfterRun(drafts, dispatchedDraftFiles, specUpdatedPaths);
    if (reconciliation.clearedPaths.length > 0) {
      setDrafts(reconciliation.nextDrafts);
      setEditorResetVersions((current) => {
        const next = { ...current };
        for (const path of reconciliation.clearedPaths) next[path] = (next[path] ?? 0) + 1;
        return next;
      });
      setRecoveredDraftPaths((current) => current.filter((path) => !reconciliation.clearedPaths.includes(path)));
    }

    const failed = isFailedTerminalRunStatus(runStatus);
    const state: DraftRunNotice["state"] = failed
      ? "failed"
      : reconciliation.retainedPaths.length > 0
        ? "retained"
        : reconciliation.appliedPaths.length > 0
          ? "applied"
          : "not-applied";
    const summary = failed
      ? "finished before the docs update could be confirmed. Local drafts were kept."
      : reconciliation.clearedPaths.length > 0
        ? `reported ${reconciliation.clearedPaths.length} applied draft${reconciliation.clearedPaths.length === 1 ? "" : "s"} and cleared matching local state. Reload to load regenerated docs.`
        : reconciliation.retainedPaths.length > 0
          ? "reported an update, but newer local draft text was kept. Reload after saving or discarding local edits."
          : reconciliation.appliedPaths.length > 0
            ? "reported the docs update. Reload to load regenerated docs."
            : "finished without reporting an update to the dispatched doc. Local drafts were kept.";
    setDraftRunNotice({
      runId: launchedRunId,
      state,
      clearedPaths: reconciliation.clearedPaths,
      retainedPaths: reconciliation.retainedPaths,
      updatedPaths: reconciliation.updatedPaths,
      summary,
    });
  }, [
    canReconcileDispatchedDraftRun,
    launchedRunId,
    runStatus,
    spec,
    drafts,
    dispatchedDraftFiles,
    specUpdatedPaths,
    draftReconciliationSignature,
  ]);

  // ---- derived values below this point must not call hooks. ----

  function updateDraft(path: string, markdown: string) {
    const original = specDocs.find((doc) => doc.path === path)?.content ?? "";
    setDrafts((current) => {
      if (normalizeMarkdownForDirty(markdown) === normalizeMarkdownForDirty(original)) {
        const next = { ...current };
        delete next[path];
        return next;
      }
      return { ...current, [path]: markdown };
    });
    setRecoveredDraftPaths((current) => current.filter((draftPath) => draftPath !== path));
  }

  function discardDrafts(paths: string[]) {
    const discard = new Set(paths);
    setDrafts((current) => {
      const next = { ...current };
      for (const path of discard) delete next[path];
      return next;
    });
    setEditorResetVersions((current) => {
      const next = { ...current };
      for (const path of discard) next[path] = (next[path] ?? 0) + 1;
      return next;
    });
    setRecoveredDraftPaths((current) => current.filter((path) => !discard.has(path)));
  }

  function openDoc(href: string) {
    const path = docPathForHref(href, specDocs);
    if (!path) return;
    setSelectedPath(path);
    setActiveTab("specs");
    setActiveFeature(null);
  }

  function dispatchAgents(paths: string[]) {
    if (dispatchLaunchInFlight.current) return;
    const files = changedFiles.filter((file) => paths.includes(file.path));
    if (files.length === 0) return;
    dispatchLaunchInFlight.current = true;
    setLaunchError(null);
    setDraftRunNotice(null);
    setLaunchPending(true);
    const primary = specDocs.find((doc) => doc.path === files[0]!.path);
    const payload = {
      title: files.length === 1 ? `Docs change: ${files[0]!.path}` : `Docs change: ${files.length} markdown files`,
      source: "smithers-ui-milkdown-editor",
      docPath: files[0]!.path,
      featureIds: [] as string[],
      changedFiles: files,
      beforeMarkdown: primary?.content ?? "",
      afterMarkdown: drafts[files[0]!.path] ?? primary?.content ?? "",
      changedAtIso: new Date().toISOString(),
    };
    void actions
      .launchRun({
        workflow: "docs-driven-development",
        input: {
          maxAgents: 1,
          maxRounds: 1,
          runImplementation: false,
          implementationApproved: false,
          metaTicket: payload,
        },
      })
      .then((result: unknown) => {
        const nextRunId = launchResultRunId(result);
        if (!nextRunId) {
          setLaunchError("The gateway accepted the request but did not return a run id. Try dispatching again.");
          return;
        }
        setLaunchedRunId(nextRunId);
        if (nextRunId) {
          setPickedRunId(nextRunId);
          setActiveTab("live");
        }
      })
      .catch((error: unknown) => {
        setLaunchError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        dispatchLaunchInFlight.current = false;
        setLaunchPending(false);
      });
  }

  function launchCreateWorkflow(description: string) {
    if (createLaunchInFlight.current) return;
    createLaunchInFlight.current = true;
    setCreateRun({ runId: null, error: null, pending: true });
    void actions
      .launchRun({
        workflow: "create-workflow",
        input: {
          prompt: createWorkflowPrompt(description),
        },
      })
      .then((result: unknown) => {
        const nextRunId = launchResultRunId(result);
        setCreateRun(
          nextRunId
            ? { runId: nextRunId, error: null, pending: false }
            : {
                runId: null,
                error: "The gateway accepted the request but did not return a run id. Try again.",
                pending: false,
              },
        );
      })
      .catch((error: unknown) => {
        setCreateRun({ runId: null, error: error instanceof Error ? error.message : String(error), pending: false });
      })
      .finally(() => {
        createLaunchInFlight.current = false;
      });
  }

  function reloadDocsUi() {
    if (typeof window !== "undefined") window.location.reload();
  }

  function launchGenerateDocs() {
    if (generateLaunchInFlight.current) return;
    generateLaunchInFlight.current = true;
    setGenerateRun({ runId: null, error: null, pending: true });
    void actions
      .launchRun({
        workflow: "docs-driven-development",
        input: { maxAgents: 1, maxRounds: 1, runImplementation: false },
      })
      .then((result: unknown) => {
        const nextRunId = launchResultRunId(result);
        setGenerateRun(
          nextRunId
            ? { runId: nextRunId, error: null, pending: false }
            : {
                runId: null,
                error: "The gateway accepted the request but did not return a run id. Try again.",
                pending: false,
              },
        );
        if (nextRunId) setPickedRunId(nextRunId);
      })
      .catch((error: unknown) => {
        setGenerateRun({ runId: null, error: error instanceof Error ? error.message : String(error), pending: false });
      })
      .finally(() => {
        generateLaunchInFlight.current = false;
      });
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const key = event.key;
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(key)) return;
    event.preventDefault();
    const nextIndex =
      key === "Home"
        ? 0
        : key === "End"
          ? TABS.length - 1
          : key === "ArrowRight"
            ? (index + 1) % TABS.length
            : (index - 1 + TABS.length) % TABS.length;
    const next = TABS[nextIndex]!;
    setActiveTab(next.key);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-testid="ddd-tab-${next.key}"]`)?.focus();
    });
  }

  // Phase-progress stepper: the docs-driven run pipeline made visible in the
  // shell so you don't have to open Live to see where a run is. Readiness comes
  // from node outputs already in scope; only shown for a live DDD run.
  const runPhases = [
    { key: "audit", label: "Audit", done: Boolean(audit) },
    { key: "docs", label: "Docs", done: Boolean(spec) },
    { key: "triage", label: "Triage", done: triage.length > 0 },
    { key: "work", label: "Work", done: materializedTickets.length > 0 },
    { key: "summary", label: "Summary", done: roundSummaryReady },
  ];
  const activePhaseIndex = runPhases.findIndex((phase) => !phase.done);
  const showPhasebar = Boolean(liveRunId) && expectsDddNodeOutputs && !showStart;

  return (
    <main className="shell" data-testid="docs-driven-development-ui">
      <style>{crepeThemeCss}</style>
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="top">
        <div className="title">
          <h1>Docs Driven Development</h1>
          {liveRunId ? (
            <>
              <span className={`badge ${statusClass(runStatus)}`} data-testid="ddd-run-status">
                {formatStatus(runStatus) || "Run"}
              </span>
              <span className="pill" data-testid="ddd-run-id" title={liveRunId}>
                {shortRunId(liveRunId)}
              </span>
            </>
          ) : (
            <span className="pill muted" data-testid="ddd-run-id">
              No run
            </span>
          )}
        </div>
        <div className="actions">
          {/* v1 ships no asset server; the Assets link only appears with ?assetBaseUrl. */}
          {assetBase ? (
            <a className="button" href={assetBase} target="_blank" rel="noreferrer">
              Assets
            </a>
          ) : null}
          {stub ? (
            <button type="button" className="button" data-testid="ddd-open-start" onClick={() => setShowStart(true)}>
              + New
            </button>
          ) : (
            <NewEntryMenu
              open={newMenuOpen}
              onOpenChange={setNewMenuOpen}
              onCreateWorkflow={launchCreateWorkflow}
              onGenerateDocs={launchGenerateDocs}
              createState={createRunLiveState}
              generateState={generateRunLiveState}
              workflowUiHref={workflowUiHref}
            />
          )}
          <button
            type="button"
            className="icon-button"
            data-testid="ddd-open-tutorial"
            aria-label="Open the guided tutorial"
            title="Guided tutorial"
            onClick={() => setShowTutorial(true)}
          >
            ?
          </button>
        </div>
      </header>

      <div className="subhead" data-testid="ddd-subhead" hidden={showStart}>
        <nav className="tabbar" role="tablist" aria-label="Docs-driven development sections" data-testid="ddd-tabbar">
          {TABS.map((tab) => {
            const count =
              tab.key === "specs"
                ? changedPaths.length
                : tab.key === "live"
                  ? runs.length
                  : tab.key === "tickets"
                    ? tickets.length
                    : 0;
            const countTitle =
              tab.key === "specs"
                ? `${count} unsaved doc${count === 1 ? "" : "s"}`
                : tab.key === "live"
                  ? `${count} run${count === 1 ? "" : "s"}`
                  : tab.key === "tickets"
                    ? `${count} ticket${count === 1 ? "" : "s"}`
                    : "";
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                id={`ddd-tabbtn-${tab.key}`}
                aria-controls={`ddd-tabpanel-${tab.key}`}
                aria-selected={activeTab === tab.key}
                tabIndex={activeTab === tab.key ? 0 : -1}
                className={activeTab === tab.key ? "tab is-active" : "tab"}
                data-testid={`ddd-tab-${tab.key}`}
                onClick={() => setActiveTab(tab.key)}
                onKeyDown={(event) =>
                  onTabKeyDown(
                    event,
                    TABS.findIndex((item) => item.key === tab.key),
                  )
                }
              >
                {tab.label}
                {count ? (
                  <span className="count" title={countTitle} aria-label={countTitle}>
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>
        {showPhasebar ? (
          <ol className="phasebar" data-testid="ddd-phasebar" aria-label="Run progress">
            {runPhases.map((phase, index) => (
              <li
                key={phase.key}
                className={`phase ${phase.done ? "is-done" : index === activePhaseIndex ? "is-active" : ""}`}
                data-testid={`ddd-phase-${phase.key}`}
                aria-current={index === activePhaseIndex ? "step" : undefined}
              >
                <span className="phase-dot" aria-hidden="true" />
                <span className="phase-label">{phase.label}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      <div className="content">
        <ErrorBanner
          title="Gateway data issue"
          errors={[runsState.error, runDetail.error, runTree.error, ticketsState.error]}
        />

        {showStart ? (
          <StartPane
            stub={stub}
            onClose={stub ? null : () => setShowStart(false)}
            onCreateWorkflow={launchCreateWorkflow}
            onGenerateDocs={launchGenerateDocs}
            createState={createRunLiveState}
            generateState={generateRunLiveState}
            workflowUiHref={workflowUiHref}
            onReload={reloadDocsUi}
          />
        ) : null}

        <div
          className="pane"
          role="tabpanel"
          id="ddd-tabpanel-features"
          aria-labelledby="ddd-tabbtn-features"
          tabIndex={0}
          hidden={showStart || activeTab !== "features"}
        >
          <FeaturesTab onOpenFeature={(feature) => setActiveFeature({ feature })} />
        </div>

        {/* Specs owns layout-measuring components (Crepe); mount only when active. */}
        <div
          className="pane"
          role="tabpanel"
          id="ddd-tabpanel-specs"
          aria-labelledby="ddd-tabbtn-specs"
          tabIndex={0}
          hidden={showStart || activeTab !== "specs"}
        >
          {!showStart && activeTab === "specs" ? (
            <SpecsTab
              docs={specDocs}
              drafts={drafts}
              selectedPath={selectedPath}
              assetBase={assetBase}
              changedPaths={changedPaths}
              launchPending={launchPending}
              launchedRunId={launchedRunId}
              launchError={launchError}
              recoveredPaths={recoveredDraftPaths.filter((path) => changedPaths.includes(path))}
              editorResetKey={editorResetVersions[selectedPath] ?? 0}
              draftRunNotice={draftRunNotice}
              onSelectPath={setSelectedPath}
              onDraftChange={updateDraft}
              onDiscardDrafts={discardDrafts}
              onDispatch={dispatchAgents}
              onReload={reloadDocsUi}
            />
          ) : null}
        </div>

        <div
          className="pane"
          role="tabpanel"
          id="ddd-tabpanel-audit"
          aria-labelledby="ddd-tabbtn-audit"
          tabIndex={0}
          hidden={showStart || activeTab !== "audit"}
        >
          <AuditTab
            audit={audit}
            bootstrap={bootstrap}
            spec={spec}
            metaTicket={metaTicket}
            summary={summary}
            triage={triage}
            onOpenFeature={(feature, note) => setActiveFeature({ feature, note })}
          />
        </div>

        <div
          className="pane"
          role="tabpanel"
          id="ddd-tabpanel-live"
          aria-labelledby="ddd-tabbtn-live"
          tabIndex={0}
          hidden={showStart || activeTab !== "live"}
        >
          <LiveTab
            runs={runs}
            runsLoading={runsState.loading}
            selectedRunId={liveRunId}
            selectedWorkflowKey={selectedWorkflowKey}
            onSelectRun={setPickedRunId}
            runStatus={runStatus}
            runTree={runTree}
            events={events}
            eventsError={runEvents.error}
            streaming={runEvents.streaming}
            assetBase={assetBase}
          />
        </div>

        <div
          className="pane"
          role="tabpanel"
          id="ddd-tabpanel-tickets"
          aria-labelledby="ddd-tabbtn-tickets"
          tabIndex={0}
          hidden={showStart || activeTab !== "tickets"}
        >
          <TicketsTab tickets={tickets} loading={ticketsState.loading} />
        </div>
      </div>

      {activeFeature ? (
        <FeatureDetail
          feature={activeFeature.feature}
          note={activeFeature.note}
          assetUrl={assetUrl}
          onClose={() => setActiveFeature(null)}
          onOpenDoc={openDoc}
        />
      ) : null}

      <Tutorial open={showTutorial} onClose={() => setShowTutorial(false)} />
    </main>
  );
}

if (typeof document !== "undefined" && document.getElementById("root")) {
  createGatewayReactRoot(<App />);
}
