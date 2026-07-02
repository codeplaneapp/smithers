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
  errorMessage,
  features,
  isRecord,
  makeAssetUrl,
  loadSpecDrafts,
  isTerminalRunStatus,
  normalizeMarkdownForDirty,
  resolveDocLink,
  rowOf,
  saveSpecDrafts,
  runIdFromUrl,
  strings,
  styles,
  type EventFrame,
  type AuditRow,
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
import { StartPane, type LaunchState } from "./ddd-StartPane";
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

const DDD_WORKFLOW_KEYS = new Set(["docs-driven-development", "ddd-generate-docs", "ddd-bug-scan"]);

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
function docPathForHref(href: string): string | undefined {
  // Feature links are authored relative to the content root; resolveDocLink also
  // handles ../ traversal and #anchors via the shared resolver.
  const target = resolveDocLink("", href, (path) => docsContent.some((doc) => doc.path === path));
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
export function workflowUiHref(workflowKey: string, runId: string, pathname: string = window.location.pathname): string {
  const base = pathname.replace(/\/workflows\/[^/]*$/, "");
  return `${base}/workflows/${encodeURIComponent(workflowKey)}?runId=${encodeURIComponent(runId)}`;
}

export function workflowKeyFromPathname(pathname: string = typeof window === "undefined" ? "" : window.location.pathname): string {
  const match = pathname.match(/\/workflows\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]!) : "";
}

export function App() {
  const runId = runIdFromUrl();
  const assetBase = assetBaseFromUrl();
  const assetUrl = makeAssetUrl(assetBase);
  const stub = specIsStub(features);
  const firstProductDoc = docsContent.find((doc) => doc.level === "product") ?? docsContent[0];
  const pageWorkflowKey = workflowKeyFromPathname();

  const [activeTab, setActiveTab] = useState<TabKey>("features");
  const [selectedPath, setSelectedPath] = useState(firstProductDoc?.path ?? "");
  const initialDraftsRef = useRef<Record<string, string> | null>(null);
  if (initialDraftsRef.current === null) initialDraftsRef.current = loadSpecDrafts(docsContent);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => initialDraftsRef.current ?? {});
  const [editorResetVersions, setEditorResetVersions] = useState<Record<string, number>>({});
  const [recoveredDraftPaths, setRecoveredDraftPaths] = useState<string[]>(() => Object.keys(initialDraftsRef.current ?? {}));
  const [launchedRunId, setLaunchedRunId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchPending, setLaunchPending] = useState(false);
  const [pickedRunId, setPickedRunId] = useState<string | undefined>(undefined);
  const [activeFeature, setActiveFeature] = useState<{ feature: Feature; note?: string } | null>(null);
  const [showStart, setShowStart] = useState(stub);
  const [showTutorial, setShowTutorial] = useState(shouldShowTutorial());
  const [createRun, setCreateRun] = useState<LaunchState>({ runId: null, error: null });
  const [generateRun, setGenerateRun] = useState<LaunchState>({ runId: null, error: null });
  const [observedMaterializedTickets, setObservedMaterializedTickets] = useState<TicketRow[]>([]);
  const dispatchLaunchInFlight = useRef(false);
  const createLaunchInFlight = useRef(false);
  const generateLaunchInFlight = useRef(false);

  // ---- every gateway hook is called unconditionally, at the top, never behind
  //      a ??/&&/ternary/loop (short-circuiting a hook crashes React). ----
  const actions = useGatewayActions();

  // The Audit + Live tabs follow the run the user is actually watching: a run
  // dispatched from Specs (pickedRunId/launchedRunId), else the URL ?runId.
  // Bind every node-output hook to liveRunId so a dispatched run populates Audit.
  const liveRunId = pickedRunId ?? launchedRunId ?? runId;

  // Only product docs are editable; technical docs are derived and read-only.
  const changedFiles = docsContent
    .filter((doc) => doc.level === "product")
    .map((doc) => ({ path: doc.path, beforeMarkdown: doc.content, afterMarkdown: drafts[doc.path] ?? doc.content }))
    .filter((doc) => normalizeMarkdownForDirty(doc.beforeMarkdown) !== normalizeMarkdownForDirty(doc.afterMarkdown));
  const changedPaths = changedFiles.map((doc) => doc.path);

  const bootstrapOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "bootstrap", iteration: 0 });
  const metaTicketOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "metaTicket", iteration: 0 });
  const auditOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "audit", iteration: 0 });
  const specOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "spec-update", iteration: 0 });
  const triageOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "triage", iteration: 0 });
  const materializedTicketsOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "materialize-tickets", iteration: 0 });
  const roundSummaryOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "round-summary", iteration: 0 });
  // Follows the Start pane's generate-docs run: its kickoff node reports the
  // detached bug-scan run id.
  const kickoffOut = useGatewayNodeOutput({ runId: generateRun.runId ?? undefined, nodeId: "kickoff-bug-scan", iteration: 0 });

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

  const kickoffRow = rowOf(kickoffOut.data);
  const bugScanRunId = asString(kickoffRow?.bugScanRunId ?? kickoffRow?.bug_scan_run_id);

  useEffect(() => {
    if (typeof window === "undefined" || !generateRun.runId || bugScanRunId) return;
    const id = window.setInterval(() => {
      void kickoffOut.refetch();
    }, 1_000);
    return () => window.clearInterval(id);
  }, [generateRun.runId, bugScanRunId, kickoffOut.refetch]);

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
  const bugScanSummary = bugScanRunId ? "" : asString(kickoffRow?.summary);

  const runDetailRow = rowOf(runDetail.data);
  const createRunRow = rowOf(createRunDetail.data);
  const generateRunRow = rowOf(generateRunDetail.data);
  const listedRuns = toRunRows(runsState.data).filter((run) => isDocsDrivenRun(run, liveRunId));
  const activeRunWorkflowKey =
    asString(runDetailRow?.workflowKey ?? runDetailRow?.workflowName ?? runDetailRow?.workflow) ||
    (generateRun.runId && liveRunId === generateRun.runId ? "ddd-generate-docs" : "") ||
    (bugScanRunId && liveRunId === bugScanRunId ? "ddd-bug-scan" : "") ||
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
    asString(selectedRun?.workflowKey ?? selectedRun?.workflowName ?? selectedRun?.workflow) ||
    activeRunWorkflowKey;
  const expectsDddNodeOutputs = selectedWorkflowKey === "docs-driven-development";
  const runStatus = asString(runDetailRow?.status) || undefined;
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
  const backlogTickets = ticketsBacklog as unknown as TicketRow[];
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

  // ---- derived values below this point must not call hooks. ----

  function updateDraft(path: string, markdown: string) {
    const original = docsContent.find((doc) => doc.path === path)?.content ?? "";
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
    const path = docPathForHref(href);
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
    setLaunchPending(true);
    const primary = docsContent.find((doc) => doc.path === files[0]!.path);
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
        input: { maxAgents: 1, maxRounds: 1, runImplementation: false, implementationApproved: false, metaTicket: payload },
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

  function launchCreateApp(description: string) {
    if (createLaunchInFlight.current) return;
    createLaunchInFlight.current = true;
    setCreateRun({ runId: null, error: null, pending: true });
    void actions
      .launchRun({
        workflow: "create-workflow",
        input: {
          prompt:
            `Create a workflow that scaffolds and iteratively builds this new app, docs-first: ${description}\n` +
            "The workflow must maintain .smithers/spec/features.json for the new app as it builds (honest statuses, " +
            "gaps recorded in missing[]), so docs-driven-development can run over it from day one.",
        },
      })
      .then((result: unknown) => {
        const nextRunId = launchResultRunId(result);
        setCreateRun(
          nextRunId
            ? { runId: nextRunId, error: null, pending: false }
            : { runId: null, error: "The gateway accepted the request but did not return a run id. Try again.", pending: false },
        );
      })
      .catch((error: unknown) => {
        setCreateRun({ runId: null, error: error instanceof Error ? error.message : String(error), pending: false });
      })
      .finally(() => {
        createLaunchInFlight.current = false;
      });
  }

  function launchGenerateDocs() {
    if (generateLaunchInFlight.current) return;
    generateLaunchInFlight.current = true;
    setGenerateRun({ runId: null, error: null, pending: true });
    void actions
      .launchRun({ workflow: "ddd-generate-docs", input: {} })
      .then((result: unknown) => {
        const nextRunId = launchResultRunId(result);
        setGenerateRun(
          nextRunId
            ? { runId: nextRunId, error: null, pending: false }
            : { runId: null, error: "The gateway accepted the request but did not return a run id. Try again.", pending: false },
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
      key === "Home" ? 0 :
      key === "End" ? TABS.length - 1 :
      key === "ArrowRight" ? (index + 1) % TABS.length :
      (index - 1 + TABS.length) % TABS.length;
    const next = TABS[nextIndex]!;
    setActiveTab(next.key);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-testid="ddd-tab-${next.key}"]`)?.focus();
    });
  }

  return (
    <main className="shell" data-testid="docs-driven-development-ui">
      <style>{crepeThemeCss}</style>
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="top">
        <div className="title">
          <h1>Docs Driven Development</h1>
          <span className="pill" data-testid="ddd-run-id">{runId ?? "workflow"}</span>
          <span className="badge ok">Milkdown</span>
        </div>
        <div className="actions">
          {/* v1 ships no asset server; the Assets link only appears with ?assetBaseUrl. */}
          {assetBase ? (
            <a className="button" href={assetBase} target="_blank" rel="noreferrer">Assets</a>
          ) : null}
          <button type="button" className="button" data-testid="ddd-open-start" onClick={() => setShowStart(true)}>
            + New
          </button>
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

      <nav className="tabbar" role="tablist" data-testid="ddd-tabbar" hidden={showStart}>
        {TABS.map((tab) => {
          const count =
            tab.key === "specs" ? changedPaths.length :
            tab.key === "live" ? runs.length :
            tab.key === "tickets" ? tickets.length : 0;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              tabIndex={activeTab === tab.key ? 0 : -1}
              className={activeTab === tab.key ? "tab is-active" : "tab"}
              data-testid={`ddd-tab-${tab.key}`}
              onClick={() => setActiveTab(tab.key)}
              onKeyDown={(event) => onTabKeyDown(event, TABS.findIndex((item) => item.key === tab.key))}
            >
              {tab.label}
              {count ? <span className="count">{count}</span> : null}
            </button>
          );
        })}
      </nav>

      <div className="content">
        <ErrorBanner
          title="Gateway data issue"
          errors={[
            runsState.error,
            runDetail.error,
            runTree.error,
            ticketsState.error,
          ]}
        />

        {showStart ? (
          <StartPane
            stub={stub}
            onClose={stub ? null : () => setShowStart(false)}
            onCreateApp={launchCreateApp}
            onGenerateDocs={launchGenerateDocs}
            createState={createRunLiveState}
            generateState={generateRunLiveState}
            bugScanRunId={bugScanRunId}
            bugScanSummary={bugScanSummary}
            workflowUiHref={workflowUiHref}
          />
        ) : null}

        <div hidden={showStart || activeTab !== "features"} className="pane">
          <FeaturesTab onOpenFeature={(feature) => setActiveFeature({ feature })} />
        </div>

        {/* Specs owns layout-measuring components (Crepe); mount only when active. */}
        {!showStart && activeTab === "specs" ? (
          <SpecsTab
            docs={docsContent}
            drafts={drafts}
            selectedPath={selectedPath}
            assetBase={assetBase}
            changedPaths={changedPaths}
            launchPending={launchPending}
            launchedRunId={launchedRunId}
            launchError={launchError}
            recoveredPaths={recoveredDraftPaths.filter((path) => changedPaths.includes(path))}
            editorResetKey={editorResetVersions[selectedPath] ?? 0}
            onSelectPath={setSelectedPath}
            onDraftChange={updateDraft}
            onDiscardDrafts={discardDrafts}
            onDispatch={dispatchAgents}
          />
        ) : null}

        <div hidden={showStart || activeTab !== "audit"} className="pane">
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

        <div hidden={showStart || activeTab !== "live"} className="pane">
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

        <div hidden={showStart || activeTab !== "tickets"} className="pane">
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
