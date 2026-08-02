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

function RepoLane({ runId, repo }: { runId: string; repo: string }) {
  const id = laneId(repo);
  const upgrade = useGatewayNodeOutput(runId, `upgrade-${id}`);
  const review = useGatewayNodeOutput(runId, `review-${id}`);
  const pr = useGatewayNodeOutput(runId, `pr-${id}`);
  const improve = useGatewayNodeOutput(runId, `improve-${id}`);
  const u = isRecord(upgrade) ? upgrade : undefined;
  const v = isRecord(review) ? review : undefined;
  const p = isRecord(pr) ? pr : undefined;
  const m = isRecord(improve) ? improve : undefined;
  const ideas = Array.isArray(u?.improvementIdeas) ? (u?.improvementIdeas as unknown[]) : [];

  const stage = m ? "improved" : p ? "pr" : v ? "reviewed" : u ? "upgraded" : "running";
  const tone =
    u?.status === "blocked" || v?.approved === false || p?.skipped === true
      ? ("danger" as const)
      : p?.prUrl
        ? ("success" as const)
        : u?.status === "no-hits"
          ? ("neutral" as const)
          : ("warning" as const);

  return (
    <Card title={repo}>
      <StatusPill tone={tone} label={u?.status === "no-hits" ? "no hits" : stage} />
      {u ? (
        <p>
          {asString(u.oldVersion) || "?"} → {asString(u.newVersion) || "?"} · grep clean:{" "}
          {u.grepClean === true ? "yes" : "NO"} · files: {String(u.filesChanged ?? "?")} · ideas: {ideas.length}{" "}
          {asString(u.breakingApplied) ? `· breaking: ${asString(u.breakingApplied)}` : ""} {asString(u.notes)}
        </p>
      ) : (
        <p>Upgrading…</p>
      )}
      {v ? <p>Sol review: {v.approved === true ? "approved" : "REJECTED"} — {asString(v.feedback)}</p> : null}
      {p ? (
        p.prUrl ? (
          <p>
            Upgrade PR: <a href={asString(p.prUrl)}>{asString(p.prUrl)}</a> (fork {asString(p.forkRepo)})
          </p>
        ) : (
          <p>PR skipped: {asString(p.summary)}</p>
        )
      ) : null}
      {m ? (
        m.prUrl ? (
          <p>
            Improvements PR: <a href={asString(m.prUrl)}>{asString(m.prUrl)}</a>
            {m.issueUrl ? (
              <>
                {" "}· issue <a href={asString(m.issueUrl)}>{asString(m.issueUrl)}</a>
              </>
            ) : null}
          </p>
        ) : (
          <p>Improvements skipped: {asString(m.summary)}</p>
        )
      ) : ideas.length > 0 && p?.prUrl ? (
        <p>Improvements pending…</p>
      ) : null}
    </Card>
  );
}

function App() {
  const runId = runIdFromUrl();
  const run = useGatewayRun(runId);
  const discover = useGatewayNodeOutput(runId ?? "", "discover");
  if (!runId) {
    return <EmptyState title="No run selected" description="Open with ?runId=<id>." />;
  }
  const d = isRecord(discover) ? discover : undefined;
  const repos = Array.isArray(d?.repos) ? (d?.repos as unknown[]).filter((r): r is string => typeof r === "string") : [];
  return (
    <WorkflowUiShell title="Upgrade dependents to smthrs" subtitle={`discover → upgrade → review → PRs · run ${runId}`}>
      <Tabs defaultValue="repos">
        <TabsList>
          <TabsTrigger value="repos">Repos</TabsTrigger>
          <TabsTrigger value="tree">Run tree</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="repos">
          {!d ? (
            <EmptyState title="Discovering repos…" description="Scanning awesome-smithers and GitHub code search." />
          ) : repos.length === 0 ? (
            <EmptyState title="No repos discovered" description={asString(d.notes)} />
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
