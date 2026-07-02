/** @jsxImportSource react */
import { useEffect, useState } from "react";
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
import { docsContent } from "./ddd-docsContent.generated";
import { crepeThemeCss } from "./crepeTheme.generated";
import { ticketsBacklog } from "./ddd-ticketsBacklog.generated";
import {
  FeatureDetail,
  asArray,
  asString,
  assetBaseFromUrl,
  isRecord,
  makeAssetUrl,
  normalizeMarkdownForDirty,
  resolveDocLink,
  rowOf,
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

export function ticketSlug(value: unknown): string {
  return asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "ticket";
}

export function ticketMarkdownFor(runId: string | undefined, item: TriageItem): string {
  const list = (title: string, values: string[]) =>
    values.length ? `\n## ${title}\n\n${values.map((value) => `- ${value}`).join("\n")}\n` : "";

  return [
    `# ${item.title || item.featureId || `Triage slot ${item.slot}`}`,
    "",
    "Status: todo",
    `Run: ${runId ?? "current"}`,
    `Slot: ${item.slot}`,
    `Feature: ${item.featureId}`,
    `Agent: ${item.agent}`,
    `Task type: ${item.taskType}`,
    "",
    "## Reason",
    "",
    item.reason || "No reason recorded.",
    list("Files", item.files),
    list("Tests", item.tests),
    list("Acceptance", item.acceptance),
  ].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function ticketsFromTriage(runId: string | undefined, triage: TriageItem[]): TicketRow[] {
  return triage.map((item) => ({
    path: `docs-driven-development--${ticketSlug(runId ?? "current")}--${String(item.slot).padStart(2, "0")}-${ticketSlug(item.featureId || item.title)}`,
    kind: "ticket",
    status: "todo",
    updatedAtMs: Date.now(),
    content: ticketMarkdownFor(runId, item),
  }));
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
      if (!ticket.path || byPath.has(ticket.path)) continue;
      byPath.set(ticket.path, ticket);
    }
  }
  return [...byPath.values()];
}

export function toRunRows(data: unknown): RunSummaryRow[] {
  const raw = Array.isArray(data) ? data : isRecord(data) ? asArray(data.runs) : [];
  return raw
    .filter(isRecord)
    .map((row) => ({ ...row, runId: asString(row.runId ?? row.id) }))
    .filter((row): row is RunSummaryRow => row.runId.length > 0);
}

function isDocsDrivenRun(run: RunSummaryRow, activeRunId: string | undefined): boolean {
  const workflowKey = asString(run.workflowKey ?? run.workflowName ?? run.workflow);
  return workflowKey === "docs-driven-development" || (!!activeRunId && run.runId === activeRunId);
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

function App() {
  const runId = runIdFromUrl();
  const assetBase = assetBaseFromUrl();
  const assetUrl = makeAssetUrl(assetBase);

  const [activeTab, setActiveTab] = useState<TabKey>("features");
  const [selectedPath, setSelectedPath] = useState(docsContent[0]?.path ?? "");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [launchedRunId, setLaunchedRunId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [pickedRunId, setPickedRunId] = useState<string | undefined>(undefined);
  const [activeFeature, setActiveFeature] = useState<{ feature: Feature; note?: string } | null>(null);

  // ---- every gateway hook is called unconditionally, at the top, never behind
  //      a ??/&&/ternary/loop (short-circuiting a hook crashes React). ----
  const actions = useGatewayActions();

  // The Audit + Live tabs follow the run the user is actually watching: a run
  // dispatched from Specs (pickedRunId/launchedRunId), else the URL ?runId.
  // Bind every node-output hook to liveRunId so a dispatched run populates Audit.
  const liveRunId = pickedRunId ?? launchedRunId ?? runId;

  const bootstrapOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "bootstrap", iteration: 0 });
  const metaTicketOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "metaTicket", iteration: 0 });
  const auditOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "audit", iteration: 0 });
  const specOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "spec-update", iteration: 0 });
  const triageOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "triage", iteration: 0 });
  const materializedTicketsOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "materialize-tickets", iteration: 0 });
  const roundSummaryOut = useGatewayNodeOutput({ runId: liveRunId, nodeId: "round-summary", iteration: 0 });

  const runsState = useGatewayRuns({ filter: { limit: 100 } });
  const runDetail = useGatewayRun(liveRunId);
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

  // ---- derived (no hooks below this line) ----
  const bootstrap = rowOf(bootstrapOut.data);
  const metaTicket = rowOf(metaTicketOut.data);
  const audit = rowOf(auditOut.data) as AuditRow | null;
  const spec = rowOf(specOut.data);
  const summary = rowOf(roundSummaryOut.data);
  const triage = extractTriage(triageOut.data);
  const materializedTickets = extractMaterializedTickets(materializedTicketsOut.data);

  const runs = toRunRows(runsState.data).filter((run) => isDocsDrivenRun(run, liveRunId));
  const runStatus = asString(rowOf(runDetail.data)?.status) || undefined;
  const gatewayTickets = (ticketsState.data ?? []) as unknown as TicketRow[];
  // The full backlog (one ticket per gap, derived from features.json) is the
  // baseline; live gateway tickets + this round's materialized/triage tickets
  // overlay on top (mergeTickets keeps the first occurrence per path).
  const backlogTickets = ticketsBacklog as unknown as TicketRow[];
  const tickets = mergeTickets(gatewayTickets, materializedTickets, ticketsFromTriage(liveRunId, triage), backlogTickets);
  const events = (runEvents.events ?? []) as unknown as EventFrame[];

  const changedFiles = docsContent
    .map((doc) => ({ path: doc.path, beforeMarkdown: doc.content, afterMarkdown: drafts[doc.path] ?? doc.content }))
    .filter((doc) => normalizeMarkdownForDirty(doc.beforeMarkdown) !== normalizeMarkdownForDirty(doc.afterMarkdown));
  const changedPaths = changedFiles.map((doc) => doc.path);

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
  }

  function openDoc(href: string) {
    const path = docPathForHref(href);
    if (!path) return;
    setSelectedPath(path);
    setActiveTab("specs");
    setActiveFeature(null);
  }

  function dispatchAgents(paths: string[]) {
    const files = changedFiles.filter((file) => paths.includes(file.path));
    if (files.length === 0) return;
    setLaunchError(null);
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
        input: { maxAgents: 1, runImplementation: false, implementationApproved: false, metaTicket: payload },
      })
      .then((result: unknown) => {
        const nextRunId = isRecord(result) ? asString(result.runId) : "";
        setLaunchedRunId(nextRunId || "queued");
        if (nextRunId) {
          setPickedRunId(nextRunId);
          setActiveTab("live");
        }
      })
      .catch((error: unknown) => {
        setLaunchError(error instanceof Error ? error.message : String(error));
      });
  }

  return (
    <main className="shell" data-testid="docs-driven-development-ui">
      <style>{crepeThemeCss}</style>
      <style>{styles}</style>
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
        </div>
      </header>

      <nav className="tabbar" role="tablist" data-testid="ddd-tabbar">
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
              className={activeTab === tab.key ? "tab is-active" : "tab"}
              data-testid={`ddd-tab-${tab.key}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
              {count ? <span className="count">{count}</span> : null}
            </button>
          );
        })}
      </nav>

      <div className="content">
        <div hidden={activeTab !== "features"} className="pane">
          <FeaturesTab onOpenFeature={(feature) => setActiveFeature({ feature })} />
        </div>

        {/* Specs owns layout-measuring components (Crepe); mount only when active. */}
        {activeTab === "specs" ? (
          <SpecsTab
            docs={docsContent}
            drafts={drafts}
            selectedPath={selectedPath}
            assetBase={assetBase}
            changedPaths={changedPaths}
            launchedRunId={launchedRunId}
            launchError={launchError}
            onSelectPath={setSelectedPath}
            onDraftChange={updateDraft}
            onDispatch={dispatchAgents}
          />
        ) : null}

        <div hidden={activeTab !== "audit"} className="pane">
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

        <div hidden={activeTab !== "live"} className="pane">
          <LiveTab
            runs={runs}
            runsLoading={runsState.loading}
            selectedRunId={liveRunId}
            onSelectRun={setPickedRunId}
            runStatus={runStatus}
            runTree={runTree}
            events={events}
            streaming={runEvents.streaming}
            assetBase={assetBase}
          />
        </div>

        <div hidden={activeTab !== "tickets"} className="pane">
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
    </main>
  );
}

if (typeof document !== "undefined") {
  createGatewayReactRoot(<App />);
}
