/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRunTree,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import { WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  KpiStat,
  SectionHeader,
  SmithersUiStyles,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "smithers-orchestrator/ui";

const WORKFLOW_KEY = "daily-ceo-intel";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
/** Node-output hooks return either the row directly or `{ row, schema, status }`. */
function rowOf(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.row)) return value.row;
  if ("row" in value || "schema" in value || "status" in value) return null;
  return value;
}
function shortId(id: string | undefined): string {
  return id ? id.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function nodeStatusOf(node: { status?: unknown } | undefined): string {
  return asString(node?.status) ?? "queued";
}

const PIPELINE_STAGES: Array<{ id: string; label: string }> = [
  { id: "compute-window", label: "Compute window" },
  { id: "load-config-and-state", label: "Load config & state" },
  { id: "fetch-rss", label: "Fetch RSS" },
  { id: "fetch-github-releases", label: "Fetch GitHub releases" },
  { id: "fetch-hn", label: "Fetch HN" },
  { id: "fetch-lobsters", label: "Fetch Lobsters" },
  { id: "fetch-reddit", label: "Fetch Reddit" },
  { id: "fetch-bluesky", label: "Fetch Bluesky" },
  { id: "normalize", label: "Normalize" },
  { id: "strict-24h-filter", label: "24h filter" },
  { id: "canonicalize-dedupe", label: "Canonicalize & dedupe" },
  { id: "remove-previously-seen", label: "Remove previously seen" },
  { id: "cluster-events", label: "Cluster events" },
  { id: "merge-assessments", label: "Merge assessments" },
  { id: "rank-and-select", label: "Rank & select" },
  { id: "curate-lighter-side", label: "Curate Lighter Side" },
  { id: "compose-editorial", label: "Compose editorial" },
  { id: "verify", label: "Verify" },
  { id: "render", label: "Render" },
  { id: "archive", label: "Archive" },
  { id: "publish", label: "Publish" },
  { id: "commit-seen-state", label: "Commit seen-state" },
  { id: "finalize", label: "Finalize" },
  { id: "assert-verified", label: "Assert verified" },
];

type CoverageRow = {
  sourceId: string;
  kind: string;
  ok: boolean;
  error: string | null;
  itemCount: number;
  retried: boolean;
};

function coverageRowsOf(value: unknown): CoverageRow[] {
  return asArray(value)
    .filter(isRecord)
    .map((row) => ({
      sourceId: asString(row.sourceId) ?? "?",
      kind: asString(row.kind) ?? "?",
      ok: asBool(row.ok),
      error: asString(row.error) ?? null,
      itemCount: asNumber(row.itemCount),
      retried: asBool(row.retried),
    }));
}

function useNode(runId: string | undefined, nodeId: string, iteration = 0) {
  const query = useGatewayNodeOutput({ runId, nodeId, iteration });
  return rowOf(query.data);
}

function Dashboard({ runId }: { runId: string }) {
  const tree = useGatewayRunTree(runId);
  const assessBatchIds = useMemo(
    () =>
      tree.nodes
        .map((node) => asString((node as { id?: unknown }).id))
        .filter((id): id is string => id !== undefined && /^assess-relevance-b\d+$/.test(id))
        .sort((a, b) => Number(a.replace("assess-relevance-b", "")) - Number(b.replace("assess-relevance-b", ""))),
    [tree.nodes],
  );
  const nodeStatusById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of tree.nodes) {
      const id = asString((node as { id?: unknown }).id);
      if (id) map.set(id, nodeStatusOf(node as { status?: unknown }));
    }
    return map;
  }, [tree.nodes]);

  const window_ = useNode(runId, "compute-window");
  const fetchRss = useNode(runId, "fetch-rss");
  const fetchGithub = useNode(runId, "fetch-github-releases");
  const fetchHn = useNode(runId, "fetch-hn");
  const fetchLobsters = useNode(runId, "fetch-lobsters");
  const fetchReddit = useNode(runId, "fetch-reddit");
  const fetchBluesky = useNode(runId, "fetch-bluesky");
  const normalize = useNode(runId, "normalize");
  const windowFilter = useNode(runId, "strict-24h-filter");
  const dedupe = useNode(runId, "canonicalize-dedupe");
  const seen = useNode(runId, "remove-previously-seen");
  const clusters = useNode(runId, "cluster-events");
  const merged = useNode(runId, "merge-assessments");
  const selection = useNode(runId, "rank-and-select");
  const render0 = useNode(runId, "render");
  const archive = useNode(runId, "archive");
  const publish = useNode(runId, "publish");
  const finalize = useNode(runId, "finalize");
  const verifyIter0 = useNode(runId, "verify", 0);
  const verifyIter1 = useNode(runId, "verify", 1);
  const verify = verifyIter1 ?? verifyIter0;

  const fetched =
    asNumber(fetchRss?.itemCount) +
    asNumber(fetchGithub?.itemCount) +
    asNumber(fetchHn?.itemCount) +
    asNumber(fetchLobsters?.itemCount) +
    asNumber(fetchReddit?.itemCount) +
    asNumber(fetchBluesky?.itemCount);

  const funnel = [
    { label: "Fetched", value: fetched },
    { label: "Normalized", value: asNumber(normalize?.itemCount) },
    { label: "In window", value: asNumber(windowFilter?.inWindowCount) },
    { label: "After dedupe", value: asNumber(dedupe?.uniqueCount) },
    { label: "Fresh", value: asNumber(seen?.freshCount) },
    { label: "Clusters", value: asNumber(clusters?.clusterCount) },
    { label: "Assessed", value: asNumber(merged?.assessedCount) },
    { label: "Selected", value: asNumber(selection?.selectedCount) },
  ];

  const coverage = coverageRowsOf(normalize?.coverage);
  const degraded = asBool(normalize?.degraded);
  const criticalFailed = asBool(normalize?.criticalFailed);
  const dateUncertainCount = asNumber(normalize?.dateUncertainCount);

  const verifyErrors = asArray(verify?.errors).map((e) => String(e));
  const verifyPassed = asBool(verify?.passed);
  const verifyAttempt = asNumber(verify?.attempt);

  const markdown = asString(render0?.markdown) ?? "";
  const issueJson = asString(render0?.issueJson) ?? "";
  let issue: Record<string, unknown> | null = null;
  try {
    issue = issueJson ? (JSON.parse(issueJson) as Record<string, unknown>) : null;
  } catch {
    issue = null;
  }

  const status = asString(finalize?.status);
  const published = asBool(publish?.published);
  const idempotentSkip = asBool(publish?.idempotentSkip);
  const archiveMode = asString(archive?.mode);

  return (
    <div className="dci-stack">
      <SectionHeader
        eyebrow={window_ ? `Issue date ${asString(window_.issueDateEt) ?? "?"} ET` : "Waiting for window"}
        title="Pipeline funnel"
        actions={
          <>
            {status ? (
              <StatusPill
                status={
                  status === "published" || status === "archived" ? "ok" : status === "empty-day" ? "waiting" : "warn"
                }
                label={status}
              />
            ) : null}
            {degraded ? <Badge variant="warning">degraded</Badge> : null}
            {criticalFailed ? <Badge variant="destructive">critical source failed</Badge> : null}
          </>
        }
      />
      <div className="dci-kpi-row">
        {funnel.map((stat) => (
          <KpiStat key={stat.label} label={stat.label} value={stat.value} />
        ))}
      </div>

      <SectionHeader title="Stage status" />
      <div className="dci-stage-grid">
        {PIPELINE_STAGES.map((stage) => (
          <div className="dci-stage" key={stage.id}>
            <StatusPill status={nodeStatusById.get(stage.id)} withDot />
            <span>{stage.label}</span>
          </div>
        ))}
      </div>
      {assessBatchIds.length ? (
        <div className="dci-stage-grid">
          {assessBatchIds.map((id) => (
            <div className="dci-stage" key={id}>
              <StatusPill status={nodeStatusById.get(id)} withDot />
              <span>{id}</span>
            </div>
          ))}
        </div>
      ) : null}
      {verify ? (
        <p className="dci-muted">
          Editorial repair loop: attempt {verifyAttempt || 1}, {verifyPassed ? "verified" : "not yet verified"}.
        </p>
      ) : null}

      <SectionHeader
        title="Latest issue"
        actions={
          <>
            {published ? <Badge variant="success">published</Badge> : null}
            {idempotentSkip ? <Badge variant="secondary">idempotent skip</Badge> : null}
            {archiveMode ? <Badge variant="outline">{archiveMode}</Badge> : null}
          </>
        }
      />
      {issue ? (
        <Card>
          <CardHeader>
            <CardTitle>{asString(issue.headline) ?? "Untitled issue"}</CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="brief">
              <TabsList>
                <TabsTrigger value="brief">Brief</TabsTrigger>
                <TabsTrigger value="top" count={asArray(issue.topStories).length}>
                  Top Stories
                </TabsTrigger>
                <TabsTrigger value="lighter" count={asArray(issue.lighterSide).length}>
                  Lighter Side
                </TabsTrigger>
                <TabsTrigger value="raw">Raw</TabsTrigger>
              </TabsList>
              <TabsContent value="brief">
                <p>{asString(issue.intro) ?? ""}</p>
                <p className="dci-muted">{asString(issue.coverageStatement) ?? ""}</p>
              </TabsContent>
              <TabsContent value="top">
                {asArray(issue.topStories)
                  .filter(isRecord)
                  .map((story, index) => (
                    <div className="dci-story" key={String(story.srcId ?? index)}>
                      <strong>{asString(story.headline) ?? "(untitled)"}</strong>
                      <span className="dci-muted"> — {asString(story.srcId)}</span>
                      <p>{asString(story.body) ?? ""}</p>
                    </div>
                  ))}
                {asArray(issue.topStories).length === 0 ? (
                  <EmptyState title="No top stories" description="Quiet day, or not composed yet." />
                ) : null}
              </TabsContent>
              <TabsContent value="lighter">
                {asArray(issue.lighterSide)
                  .filter(isRecord)
                  .map((item, index) => (
                    <div className="dci-story" key={String(item.srcId ?? index)}>
                      {asString(item.text) ?? ""} <span className="dci-muted">({asString(item.srcId)})</span>
                    </div>
                  ))}
                {asArray(issue.lighterSide).length === 0 ? <EmptyState title="No Lighter Side picks yet" /> : null}
              </TabsContent>
              <TabsContent value="raw">
                <pre className="dci-pre">{markdown || issueJson}</pre>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          title="No issue composed yet"
          description="The editorial repair loop hasn't produced a draft yet."
        />
      )}

      <SectionHeader title="Coverage & failures" />
      <div className="dci-coverage-meta">
        <Badge variant="outline">{dateUncertainCount} date-uncertain item(s)</Badge>
        {archive ? <Badge variant="outline">{asString(archive.mode)} archive</Badge> : null}
      </div>
      {coverage.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Items</TableHead>
              <TableHead>Retried</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {coverage.map((row) => (
              <TableRow key={row.sourceId}>
                <TableCell>{row.sourceId}</TableCell>
                <TableCell>{row.kind}</TableCell>
                <TableCell>
                  <StatusPill status={row.ok ? "ok" : "failed"} />
                </TableCell>
                <TableCell>{row.itemCount}</TableCell>
                <TableCell>{row.retried ? "yes" : "no"}</TableCell>
                <TableCell>{row.error ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyState title="No coverage yet" description="Waiting on the fetch-sources fan-out." />
      )}

      {!verifyPassed && verifyErrors.length ? (
        <>
          <SectionHeader title="Verify errors" />
          <ul className="dci-errors">
            {verifyErrors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function App() {
  const runsQuery = useGatewayRuns({ filter: { limit: 30 } });
  const actions = useGatewayActions();
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [busy, setBusy] = useState(false);

  const runs = useMemo(
    () =>
      (asArray(runsQuery.data) as Array<{ runId: string; workflowKey?: string; status?: string }>).filter(
        (run) => !run.workflowKey || run.workflowKey === WORKFLOW_KEY,
      ),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? runs[0]?.runId;

  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input: {} });
      setSelectedRunId(run.runId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="dci-shell">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <SmithersUiStyles />
      <header className="dci-topbar">
        <div>
          <h1>The Smithers Signal</h1>
          <p className="dci-muted">Daily CEO Intel · {activeRunId ? shortId(activeRunId) : "no run selected"}</p>
        </div>
        <div className="dci-toolbar">
          <select
            className="dci-select"
            value={activeRunId ?? ""}
            onChange={(event) => setSelectedRunId(event.currentTarget.value || undefined)}
          >
            <option value="">latest run</option>
            {runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {shortId(run.runId)} · {run.status ?? "?"}
              </option>
            ))}
          </select>
          <Button onClick={() => void launch()} disabled={busy}>
            Start run
          </Button>
        </div>
      </header>
      {activeRunId ? (
        <Dashboard key={activeRunId} runId={activeRunId} />
      ) : (
        <EmptyState
          title="No daily-ceo-intel runs yet"
          description="Start one with zero inputs — it fetches the last 24h, composes The Smithers Signal, and archives or publishes it."
          action={
            <Button onClick={() => void launch()} disabled={busy}>
              Start run
            </Button>
          }
        />
      )}
    </main>
  );
}

const styles = `
  .dci-shell { min-height: 100vh; padding: 20px; max-width: 1200px; margin: 0 auto; }
  .dci-topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  .dci-topbar h1 { margin: 0; font-size: 20px; }
  .dci-toolbar { display: flex; gap: 8px; align-items: center; }
  .dci-select { height: 32px; border-radius: 6px; padding: 0 8px; }
  .dci-muted { color: var(--sui-muted-foreground, #8a8a8e); font-size: 12px; }
  .dci-stack > * + * { margin-top: 10px; }
  .dci-kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .dci-stage-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px; margin-bottom: 8px; }
  .dci-stage { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .dci-story { padding: 8px 0; border-top: 1px solid rgba(128,128,128,0.2); }
  .dci-story:first-child { border-top: none; }
  .dci-pre { max-height: 420px; overflow: auto; white-space: pre-wrap; font-size: 12px; }
  .dci-coverage-meta { display: flex; gap: 8px; margin-bottom: 8px; }
  .dci-errors { color: #f87171; font-size: 13px; }
`;

createGatewayReactRoot(<App />);
