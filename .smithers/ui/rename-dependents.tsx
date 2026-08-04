/** @jsxImportSource react */
import { createGatewayReactRoot, useGatewayNodeOutput, useGatewayRun } from "smthrs/gateway-react";
import { RunEventLog, RunTree, WorkflowUiShell } from "smthrs/gateway-ui";
import { Card, EmptyState, StatusPill, Tabs, TabsContent, TabsList, TabsTrigger } from "smthrs/ui";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function laneId(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
}
function reposFromRun(runData: unknown): string[] {
  const run = isRecord(runData) ? runData : {};
  const input = isRecord(run.input) ? run.input : isRecord(run.inputs) ? run.inputs : {};
  return Array.isArray(input.repos) ? input.repos.filter((r): r is string => typeof r === "string") : [];
}

function RepoLane({ runId, repo }: { runId: string; repo: string }) {
  const id = laneId(repo);
  const rename = useGatewayNodeOutput(runId, `rename-${id}`);
  const review = useGatewayNodeOutput(runId, `review-${id}`);
  const pr = useGatewayNodeOutput(runId, `pr-${id}`);
  const r = isRecord(rename) ? rename : undefined;
  const v = isRecord(review) ? review : undefined;
  const p = isRecord(pr) ? pr : undefined;

  const stage = p ? "pr" : v ? "reviewed" : r ? "renamed" : "running";
  const tone =
    r?.status === "blocked" || v?.approved === false || p?.skipped === true
      ? ("danger" as const)
      : p?.prUrl
        ? ("success" as const)
        : r?.status === "no-hits"
          ? ("neutral" as const)
          : ("warning" as const);

  return (
    <Card title={repo}>
      <StatusPill tone={tone} label={r?.status === "no-hits" ? "no hits" : stage} />
      {r ? (
        <p>
          grep clean: {r.grepClean === true ? "yes" : "NO"} · files changed: {String(r.filesChanged ?? "?")} ·{" "}
          {asString(r.notes)}
        </p>
      ) : (
        <p>Renaming…</p>
      )}
      {v ? (
        <p>
          Sol review: {v.approved === true ? "approved" : "REJECTED"} — {asString(v.feedback)}
        </p>
      ) : null}
      {p ? (
        p.prUrl ? (
          <p>
            Draft PR: <a href={asString(p.prUrl)}>{asString(p.prUrl)}</a>
          </p>
        ) : (
          <p>PR skipped: {asString(p.summary)}</p>
        )
      ) : null}
    </Card>
  );
}

function App() {
  const runId = runIdFromUrl();
  const run = useGatewayRun(runId);
  if (!runId) {
    return <EmptyState title="No run selected" description="Open with ?runId=<id>." />;
  }
  const repos = reposFromRun(run);
  return (
    <WorkflowUiShell title="Rename dependents" subtitle={`draft PRs renaming to smthrs · run ${runId}`}>
      <Tabs defaultValue="repos">
        <TabsList>
          <TabsTrigger value="repos">Repos</TabsTrigger>
          <TabsTrigger value="tree">Run tree</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="repos">
          {repos.length === 0 ? (
            <EmptyState title="Waiting for run input" />
          ) : (
            repos.map((repo) => <RepoLane key={repo} runId={runId} repo={repo} />)
          )}
        </TabsContent>
        <TabsContent value="tree">{run ? <RunTree run={run} /> : <EmptyState title="Loading run…" />}</TabsContent>
        <TabsContent value="events">
          <RunEventLog runId={runId} />
        </TabsContent>
      </Tabs>
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
