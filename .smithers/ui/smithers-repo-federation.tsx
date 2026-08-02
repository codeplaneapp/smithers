/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smthrs/gateway-react";
import { ApprovalPanel, RunEventLog, RunTree, StatusPill, WorkflowUiShell } from "smthrs/gateway-ui";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  KpiStat,
  SectionHeader,
  SmithersUiStyles,
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
} from "smthrs/ui";

const WORKFLOW_KEY = "smithers-repo-federation";
const federationStyles = [
  ".fed-layout { display:grid; grid-template-columns:minmax(0,1fr) 260px; gap:16px; }",
  ".fed-stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-bottom:16px; }",
  ".fed-muted { opacity:.7; }",
  ".fed-section { margin-top:16px; }",
  ".fed-gates { opacity:.7; margin-top:8px; }",
  ".fed-run-row { display:flex; justify-content:space-between; width:100%; padding:8px 10px; margin-bottom:4px; border:1px solid var(--border,#262629); border-radius:6px; background:transparent; color:inherit; cursor:pointer; }",
  ".fed-run-row.active { background:var(--card,#1c1c1f); }",
  ".fed-mono { font-family:ui-monospace,monospace; }",
  "@media (max-width:900px) { .fed-layout { grid-template-columns:1fr; } .fed-stats { grid-template-columns:repeat(2,minmax(0,1fr)); } }",
].join("\n");

const NEW_REPO_LANES = [
  "smithers-examples",
  "smithers-agents",
  "smithers-sandboxes",
  "smithers-integrations",
  "smithers-plugins",
  "smithers-packs",
  "smithers-observability",
  "smithers-review",
  "smithers-evals",
  "smithers-signal",
] as const;
const PR_ONLY_LANES = ["multi", "plue", "awesome-smithers"] as const;
const ALL_LANES = [...NEW_REPO_LANES, ...PR_ONLY_LANES] as const;
const LANE_STAGES = ["extract", "decouple", "docs", "verify", "push"] as const;
type LaneStage = (typeof LANE_STAGES)[number];

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}
function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
  return value;
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function latestNodeIterations(events: readonly unknown[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const event of events) {
    if (!isRecord(event)) continue;
    let eventName = asString(event.event);
    let payload = isRecord(event.payload) ? event.payload : {};
    for (let depth = 0; depth < 3 && eventName === "run.event"; depth += 1) {
      const nestedEvent = asString(payload.event);
      if (!nestedEvent) break;
      eventName = nestedEvent;
      payload = isRecord(payload.payload) ? payload.payload : payload;
    }
    const nodeId = asString(payload.nodeId);
    const iteration = asNumber(payload.iteration, -1);
    if (nodeId && iteration >= 0) latest.set(nodeId, Math.max(latest.get(nodeId) ?? 0, iteration));
  }
  return latest;
}

/** Reads the requested iteration of a node output row via the standard hook. */
function useNodeRow(runId: string | undefined, nodeId: string, iteration = 0) {
  const out = useGatewayNodeOutput({ runId, nodeId, iteration });
  return rowOf(out.data);
}

type LaneStatus = Record<LaneStage, "pending" | "running" | "done" | "failed">;

function laneStatusFromRows(rows: Partial<Record<LaneStage, Record<string, unknown> | null>>): LaneStatus {
  const status: LaneStatus = {
    extract: "pending",
    decouple: "pending",
    docs: "pending",
    verify: "pending",
    push: "pending",
  };
  if (rows.extract) status.extract = "done";
  if (rows.decouple) status.decouple = rows.extract ? "done" : "pending";
  if (rows.docs) status.docs = "done";
  if (rows.verify) status.verify = asBool(rows.verify.passed) ? "done" : "failed";
  if (rows.push) status.push = asBool(rows.push.pushed) ? "done" : "failed";
  return status;
}

/** Map a lane-stage status to a gateway run-status string so StatusPill's tinting applies. */
function laneStageToRunStatus(state: LaneStatus[LaneStage]): string {
  if (state === "done") return "finished";
  if (state === "failed") return "failed";
  if (state === "running") return "running";
  return "waiting";
}

function LaneStagePill({ state }: { state: LaneStatus[LaneStage] }) {
  return <StatusPill status={laneStageToRunStatus(state)} label={state} />;
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [tab, setTab] = useState("lanes");

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const runs = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? runs[0]?.runId;
  const activeRun = runs.find((r) => r.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: undefined, maxEvents: 6000 });
  const latestIterations = useMemo(() => latestNodeIterations(stream.events), [stream.events]);
  const iterationFor = (nodeId: string) => latestIterations.get(nodeId) ?? 0;

  const inventory = useNodeRow(activeRunId, "inventory", iterationFor("inventory"));
  const manifestReview = useNodeRow(
    activeRunId,
    "manifestReviewFinalApproved",
    iterationFor("manifestReviewFinalApproved"),
  );
  const createRepos = useNodeRow(activeRunId, "createRepos", iterationFor("createRepos"));
  const updateSmithers = useNodeRow(activeRunId, "updateSmithers", iterationFor("updateSmithers"));
  const initialReleaseDryRun = useNodeRow(activeRunId, "releaseDryRun", iterationFor("releaseDryRun"));
  const postFixReleaseDryRun = useNodeRow(activeRunId, "releaseDryRunPostFix", iterationFor("releaseDryRunPostFix"));
  const releaseDryRun = postFixReleaseDryRun ?? initialReleaseDryRun;
  const executeReleases = useNodeRow(activeRunId, "executeReleases", iterationFor("executeReleases"));
  const removalPrs = useNodeRow(activeRunId, "removalPrs", iterationFor("removalPrs"));
  const mergeRemovalPrs = useNodeRow(activeRunId, "mergeRemovalPrs", iterationFor("mergeRemovalPrs"));
  const finalVerify = useNodeRow(activeRunId, "finalVerify", iterationFor("finalVerify"));
  const landedVerify = useNodeRow(activeRunId, "landedVerify", iterationFor("landedVerify"));
  const report = useNodeRow(activeRunId, "report", iterationFor("report"));

  // One node-output hook per lane per stage (13 lanes x 5 stages = 65 hooks) —
  // small, bounded, and each hook already dedupes/polls via gateway-react.
  const laneRows: Record<string, Partial<Record<LaneStage, Record<string, unknown> | null>>> = {};
  for (const lane of ALL_LANES) {
    laneRows[lane] = {
      extract: useNodeRow(activeRunId, `extract-${lane}`, iterationFor(`extract-${lane}`)),
      decouple: useNodeRow(activeRunId, `decouple-${lane}`, iterationFor(`decouple-${lane}`)),
      docs: useNodeRow(activeRunId, `docs-${lane}`, iterationFor(`docs-${lane}`)),
      verify: useNodeRow(activeRunId, `laneVerify-${lane}`, iterationFor(`laneVerify-${lane}`)),
      push: useNodeRow(activeRunId, `push-${lane}`, iterationFor(`push-${lane}`)),
    };
  }

  const manifestDestinations = asArray(inventory?.destinationCounts).filter(isRecord);
  const finalFixList = asArray(finalVerify?.fixList).filter(isRecord);
  const lanesPushed = ALL_LANES.filter((lane) => asBool(laneRows[lane]?.push?.pushed)).length;

  return (
    <WorkflowUiShell
      title="Smithers Repo Federation"
      testId="federation-ui"
      meta={
        <>
          <span className="pill" data-testid="federation-runid">
            {activeRunId ? shortRunId(activeRunId) : "No run"}
          </span>
          {activeRun ? <StatusPill status={activeRun.status ?? "idle"} /> : null}
        </>
      }
    >
      <SmithersUiStyles extra={federationStyles} />

      <div className="fed-layout">
        <div>
          <div className="fed-stats">
            <KpiStat label="Lanes pushed" value={`${lanesPushed} / ${ALL_LANES.length}`} />
            <KpiStat
              label="Manifest approvable"
              value={manifestReview ? String(asBool(manifestReview.approvable)) : "—"}
            />
            <KpiStat label="Release dry-run" value={releaseDryRun ? String(asBool(releaseDryRun.ok)) : "—"} />
            <KpiStat label="Final approvable" value={finalVerify ? String(asBool(finalVerify.approvable)) : "—"} />
            <KpiStat label="Landed verified" value={landedVerify ? String(asBool(landedVerify.approvable)) : "—"} />
          </div>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="lanes">Lanes</TabsTrigger>
              <TabsTrigger value="manifest">Manifest &amp; DAG</TabsTrigger>
              <TabsTrigger value="approvals">Approvals</TabsTrigger>
              <TabsTrigger value="removal">Source removal</TabsTrigger>
              <TabsTrigger value="release">Release</TabsTrigger>
              <TabsTrigger value="final">Final verification</TabsTrigger>
              <TabsTrigger value="run">Run tree</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
            </TabsList>

            <TabsContent value="lanes">
              <Card>
                <CardHeader>
                  <CardTitle>13 destination lanes</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Lane</TableHead>
                        <TableHead>Kind</TableHead>
                        {LANE_STAGES.map((s) => (
                          <TableHead key={s}>{s}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ALL_LANES.map((lane) => {
                        const status = laneStatusFromRows(laneRows[lane]);
                        const isPrOnly = (PR_ONLY_LANES as readonly string[]).includes(lane);
                        return (
                          <TableRow key={lane} data-testid={`federation-lane-${lane}`}>
                            <TableCell>{lane}</TableCell>
                            <TableCell>
                              <Badge variant={isPrOnly ? "secondary" : "outline"}>
                                {isPrOnly ? "PR-only" : "extract"}
                              </Badge>
                            </TableCell>
                            {LANE_STAGES.map((stage) => (
                              <TableCell key={stage}>
                                <LaneStagePill state={status[stage]} />
                              </TableCell>
                            ))}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="manifest">
              <Card>
                <CardHeader>
                  <CardTitle>Manifest &amp; DAG</CardTitle>
                </CardHeader>
                <CardContent>
                  {inventory ? (
                    <>
                      <p>{asString(inventory.summary)}</p>
                      <p className="fed-muted">
                        Manifest: {asString(inventory.manifestPath) || "—"} · DAG: {asString(inventory.dagPath) || "—"}{" "}
                        · Release plan: {asString(inventory.releasePlanPath) || "—"}
                      </p>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Destination</TableHead>
                            <TableHead>Count</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {manifestDestinations.map((d, i) => (
                            <TableRow key={i}>
                              <TableCell>{asString(d.destination) ?? "—"}</TableCell>
                              <TableCell>{asNumber(d.count)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </>
                  ) : (
                    <EmptyState title="No inventory yet" description="Waiting for the inventory step to run." />
                  )}
                  {manifestReview ? (
                    <div className="fed-section">
                      <SectionHeader title="Manifest review" />
                      <p>{asString(manifestReview.summary)}</p>
                      <p className="fed-muted">
                        Boundary issues: {asArray(manifestReview.boundaryIssues).length} · Ambiguous utilities:{" "}
                        {asArray(manifestReview.ambiguousUtilities).length} · License gaps:{" "}
                        {asArray(manifestReview.licenseGaps).length}
                      </p>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="approvals">
              <Card>
                <CardHeader>
                  <CardTitle>Pending approvals</CardTitle>
                </CardHeader>
                <CardContent>
                  <ApprovalPanel filter={{ workflow: WORKFLOW_KEY, runId: activeRunId }} />
                  <p className="fed-gates">Gates: gate-manifest → gate-publish → gate-merge.</p>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="removal">
              <Card>
                <CardHeader>
                  <CardTitle>Source removal (kernel strip)</CardTitle>
                </CardHeader>
                <CardContent>
                  {updateSmithers ? (
                    <>
                      <p>{asString(updateSmithers.summary)}</p>
                      <p className="fed-muted">
                        Removed packages: {asArray(updateSmithers.removedPackages).length} · Stale-link gate:{" "}
                        {String(asBool(updateSmithers.staleLinkGateWired))} · Integration gate:{" "}
                        {String(asBool(updateSmithers.integrationGateWired))}
                      </p>
                    </>
                  ) : (
                    <EmptyState title="Not run yet" description="The kernel-strip step hasn't produced output." />
                  )}
                  {removalPrs ? (
                    <div className="fed-section">
                      <SectionHeader title="Removal PRs" />
                      <p>{asString(removalPrs.summary)}</p>
                    </div>
                  ) : null}
                  {mergeRemovalPrs ? (
                    <div className="fed-section">
                      <SectionHeader title="Merged removal PRs" />
                      <p>{asString(mergeRemovalPrs.summary)}</p>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="release">
              <Card>
                <CardHeader>
                  <CardTitle>Release</CardTitle>
                </CardHeader>
                <CardContent>
                  {createRepos ? <p className="fed-muted">{asString(createRepos.summary)}</p> : null}
                  {releaseDryRun ? (
                    <>
                      <p>{asString(releaseDryRun.summary)}</p>
                      <p className="fed-muted">ok: {String(asBool(releaseDryRun.ok))}</p>
                    </>
                  ) : (
                    <EmptyState title="No release dry-run yet" description="Waiting for all lanes to push." />
                  )}
                  {executeReleases ? (
                    <div className="fed-section">
                      <SectionHeader title="Executed releases" />
                      <p>{asString(executeReleases.summary)}</p>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="final">
              <Card>
                <CardHeader>
                  <CardTitle>Final verification (Ralph loop)</CardTitle>
                </CardHeader>
                <CardContent>
                  {finalVerify ? (
                    <>
                      <p>{asString(finalVerify.summary)}</p>
                      <p className="fed-muted">approvable: {String(asBool(finalVerify.approvable))}</p>
                      {finalFixList.length > 0 ? (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Target</TableHead>
                              <TableHead>Check</TableHead>
                              <TableHead>Detail</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {finalFixList.map((f, i) => (
                              <TableRow key={i}>
                                <TableCell>{asString(f.target) ?? "—"}</TableCell>
                                <TableCell>{asString(f.check) ?? "—"}</TableCell>
                                <TableCell>{asString(f.detail) ?? "—"}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      ) : null}
                    </>
                  ) : (
                    <EmptyState
                      title="Not run yet"
                      description="Final verification runs after the release dry-run, before the publish gate."
                    />
                  )}
                  {landedVerify ? (
                    <div className="fed-section">
                      <SectionHeader title="Landed verification (post-publish, post-merge)" />
                      <p>{asString(landedVerify.summary)}</p>
                      <p className="fed-muted">approvable: {String(asBool(landedVerify.approvable))}</p>
                    </div>
                  ) : null}
                  {report ? (
                    <div className="fed-section">
                      <SectionHeader title="Report" />
                      <p>{asString(report.summary)}</p>
                      <p className="fed-muted">{asString(report.reportPath)}</p>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="run">
              <Card>
                <CardHeader>
                  <CardTitle>Run tree</CardTitle>
                </CardHeader>
                <CardContent>
                  <RunTree runId={activeRunId} />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="events">
              <Card>
                <CardHeader>
                  <CardTitle>Event log ({(stream.events ?? []).length})</CardTitle>
                </CardHeader>
                <CardContent>
                  <RunEventLog runId={activeRunId} />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <aside>
          <SectionHeader title="Recent runs" />
          {runs.map((r) => (
            <button
              key={r.runId}
              className={"fed-run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={`federation-run-${r.runId}`}
              onClick={() => setSelectedRunId(r.runId)}
            >
              <span className="fed-mono">{shortRunId(r.runId)}</span>
              <StatusPill status={r.status ?? "?"} />
            </button>
          ))}
          {runs.length === 0 ? (
            <EmptyState title="No runs yet" description="Launch the workflow to see it here." />
          ) : null}
        </aside>
      </div>
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
