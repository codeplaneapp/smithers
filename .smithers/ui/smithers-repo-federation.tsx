/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import { ApprovalPanel, RunEventLog, RunTree, StatusPill, WorkflowUiShell } from "smithers-orchestrator/gateway-ui";
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
} from "smithers-orchestrator/ui";

const WORKFLOW_KEY = "smithers-repo-federation";

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

/** Reads a single-occurrence node output row for `nodeId` via the standard hook. */
function useNodeRow(runId: string | undefined, nodeId: string) {
  const out = useGatewayNodeOutput({ runId, nodeId, iteration: 0 });
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
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });

  const inventory = useNodeRow(activeRunId, "inventory");
  const manifestReview = useNodeRow(activeRunId, "manifestReview");
  const createRepos = useNodeRow(activeRunId, "createRepos");
  const updateSmithers = useNodeRow(activeRunId, "updateSmithers");
  const releaseDryRun = useNodeRow(activeRunId, "releaseDryRun");
  const executeReleases = useNodeRow(activeRunId, "executeReleases");
  const removalPrs = useNodeRow(activeRunId, "removalPrs");
  const mergeRemovalPrs = useNodeRow(activeRunId, "mergeRemovalPrs");
  const finalVerify = useNodeRow(activeRunId, "finalVerify");
  const landedVerify = useNodeRow(activeRunId, "landedVerify");
  const report = useNodeRow(activeRunId, "report");

  // One node-output hook per lane per stage (13 lanes x 5 stages = 65 hooks) —
  // small, bounded, and each hook already dedupes/polls via gateway-react.
  const laneRows: Record<string, Partial<Record<LaneStage, Record<string, unknown> | null>>> = {};
  for (const lane of ALL_LANES) {
    laneRows[lane] = {
      extract: useNodeRow(activeRunId, `extract-${lane}`),
      decouple: useNodeRow(activeRunId, `decouple-${lane}`),
      docs: useNodeRow(activeRunId, `docs-${lane}`),
      verify: useNodeRow(activeRunId, `laneVerify-${lane}`),
      push: useNodeRow(activeRunId, `push-${lane}`),
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
      <SmithersUiStyles />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: 16 }}>
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
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
                      <p style={{ opacity: 0.7 }}>
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
                    <div style={{ marginTop: 16 }}>
                      <SectionHeader title="Manifest review" />
                      <p>{asString(manifestReview.summary)}</p>
                      <p style={{ opacity: 0.7 }}>
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
                  <p style={{ opacity: 0.7, marginTop: 8 }}>Gates: gate-manifest → gate-publish → gate-merge.</p>
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
                      <p style={{ opacity: 0.7 }}>
                        Removed packages: {asArray(updateSmithers.removedPackages).length} · Stale-link gate:{" "}
                        {String(asBool(updateSmithers.staleLinkGateWired))} · Integration gate:{" "}
                        {String(asBool(updateSmithers.integrationGateWired))}
                      </p>
                    </>
                  ) : (
                    <EmptyState title="Not run yet" description="The kernel-strip step hasn't produced output." />
                  )}
                  {removalPrs ? (
                    <div style={{ marginTop: 16 }}>
                      <SectionHeader title="Removal PRs" />
                      <p>{asString(removalPrs.summary)}</p>
                    </div>
                  ) : null}
                  {mergeRemovalPrs ? (
                    <div style={{ marginTop: 16 }}>
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
                  {createRepos ? <p style={{ opacity: 0.7 }}>{asString(createRepos.summary)}</p> : null}
                  {releaseDryRun ? (
                    <>
                      <p>{asString(releaseDryRun.summary)}</p>
                      <p style={{ opacity: 0.7 }}>ok: {String(asBool(releaseDryRun.ok))}</p>
                    </>
                  ) : (
                    <EmptyState title="No release dry-run yet" description="Waiting for all lanes to push." />
                  )}
                  {executeReleases ? (
                    <div style={{ marginTop: 16 }}>
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
                      <p style={{ opacity: 0.7 }}>approvable: {String(asBool(finalVerify.approvable))}</p>
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
                    <div style={{ marginTop: 16 }}>
                      <SectionHeader title="Landed verification (post-publish, post-merge)" />
                      <p>{asString(landedVerify.summary)}</p>
                      <p style={{ opacity: 0.7 }}>approvable: {String(asBool(landedVerify.approvable))}</p>
                    </div>
                  ) : null}
                  {report ? (
                    <div style={{ marginTop: 16 }}>
                      <SectionHeader title="Report" />
                      <p>{asString(report.summary)}</p>
                      <p style={{ opacity: 0.7 }}>{asString(report.reportPath)}</p>
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
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={`federation-run-${r.runId}`}
              onClick={() => setSelectedRunId(r.runId)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                width: "100%",
                padding: "8px 10px",
                marginBottom: 4,
                border: "1px solid var(--border, #262629)",
                borderRadius: 6,
                background: r.runId === activeRunId ? "var(--card, #1c1c1f)" : "transparent",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              <span style={{ fontFamily: "ui-monospace,monospace" }}>{shortRunId(r.runId)}</span>
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
