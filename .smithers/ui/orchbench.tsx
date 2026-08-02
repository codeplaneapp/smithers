/** @jsxImportSource react */
import { createGatewayReactRoot, useGatewayNodeOutput, useGatewayRun, useGatewayRuns } from "smthrs/gateway-react";
import { ConnectionBadge, RunEventLog, RunTree, WorkflowUiShell } from "smthrs/gateway-ui";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  RowButton,
  SectionHeader,
  SmithersUiStyles,
  StatusPill,
} from "smthrs/ui";

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// useGatewayNodeOutput().data is wrapped: response.data.row -> data.row -> data.
function unwrapRow(value: unknown): Record<string, unknown> {
  const res = isRecord(value) ? value : {};
  const data = isRecord(res.data) ? res.data : res;
  return isRecord(data.row) ? data.row : isRecord(data) ? data : {};
}

function parseCell(runId: string | undefined): { pattern: string; slug: string } | undefined {
  // run ids look like orchb-r1-<pattern>-<slug>
  if (!runId?.startsWith("orchb-")) return undefined;
  const rest = runId.replace(/^orchb-r\d+-/, "");
  const patterns = ["solo-sol", "solo-luna", "plan-impl-review", "research-first", "panel-review"];
  for (const p of patterns) {
    if (rest.startsWith(`${p}-`)) return { pattern: p, slug: rest.slice(p.length + 1) };
  }
  return undefined;
}

function StageSummary({ runId, nodeId, title }: { runId: string; nodeId: string; title: string }) {
  const output = useGatewayNodeOutput({ runId, nodeId, iteration: 0 });
  const row = unwrapRow(output.data);
  const summary =
    typeof row.summary === "string"
      ? row.summary
      : typeof row.repoOverview === "string"
        ? row.repoOverview
        : typeof row.notes === "string" && row.notes
          ? row.notes
          : Array.isArray(row.targets)
            ? `${row.targets.length} target(s) planned`
            : "";
  const issues = Array.isArray(row.issues)
    ? row.issues.length
    : Array.isArray(row.issuesFound)
      ? row.issuesFound.length
      : undefined;
  if (!summary && issues === undefined) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {title}
          {issues !== undefined ? <Badge style={{ marginLeft: 8 }}>{issues} issue(s)</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12, maxHeight: 180, overflow: "auto" }}>
          {summary}
        </pre>
      </CardContent>
    </Card>
  );
}

const STAGE_NODES: { nodeId: string; title: string }[] = [
  { nodeId: "solo", title: "Solo (plan+implement+verify)" },
  { nodeId: "research", title: "Research (luna)" },
  { nodeId: "plan", title: "Plan" },
  { nodeId: "implement", title: "Implement" },
  { nodeId: "review", title: "Review + fix" },
  { nodeId: "panel-sol", title: "Panel — sol" },
  { nodeId: "panel-fable", title: "Panel — fable" },
  { nodeId: "panel-third", title: "Panel — third" },
  { nodeId: "fix", title: "Fix pass" },
];

function App() {
  const urlRunId = runIdFromUrl();
  const runs = useGatewayRuns({ filter: { limit: 100 } });
  const orchbRuns = (runs.data ?? []).filter((r) => String(r.runId).startsWith("orchb-"));
  const runId = urlRunId ?? (orchbRuns[0]?.runId as string | undefined);
  const run = useGatewayRun(runId);
  const cell = parseCell(runId);
  const status = (run.data as { status?: string } | undefined)?.status;

  return (
    <WorkflowUiShell
      title={cell ? `OrchBench — ${cell.pattern} on ${cell.slug}` : "OrchBench"}
      meta={<StatusPill status={status as never} />}
      actions={<ConnectionBadge />}
    >
      <SmithersUiStyles />
      {!runId ? (
        <EmptyState
          title="No OrchBench run yet"
          description="The driver launches cells as orchb-r1-<pattern>-<slug>; open with: smithers ui <runId>"
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 12, alignItems: "start" }}>
          <div style={{ display: "grid", gap: 12 }}>
            <Card>
              <CardHeader>
                <CardTitle>Benchmark cells</CardTitle>
              </CardHeader>
              <CardContent style={{ display: "grid", gap: 4, maxHeight: 320, overflow: "auto" }}>
                {orchbRuns.length === 0 ? (
                  <EmptyState title="No cells yet" />
                ) : (
                  orchbRuns.map((r) => {
                    const c = parseCell(String(r.runId));
                    return (
                      <RowButton
                        key={String(r.runId)}
                        onClick={() => {
                          location.search = `?runId=${encodeURIComponent(String(r.runId))}`;
                        }}
                      >
                        <span style={{ display: "flex", gap: 8, alignItems: "center", width: "100%" }}>
                          <StatusPill status={(r as { status?: string }).status as never} />
                          <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>
                            {c ? `${c.pattern} · ${c.slug}` : String(r.runId)}
                          </span>
                        </span>
                      </RowButton>
                    );
                  })
                )}
              </CardContent>
            </Card>
            <RunTree runId={runId} />
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            <SectionHeader title="Stage outputs" />
            {STAGE_NODES.map((s) => (
              <StageSummary key={s.nodeId} runId={runId} nodeId={s.nodeId} title={s.title} />
            ))}
            <SectionHeader title="Event log" />
            <RunEventLog runId={runId} style={{ height: 300 }} />
          </div>
        </div>
      )}
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
