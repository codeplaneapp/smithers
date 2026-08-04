/** @jsxImportSource react */
import { createGatewayReactRoot, useGatewayNodeOutput } from "smthrs/gateway-react";
import { RunEventLog, RunTree, WorkflowUiShell } from "smthrs/gateway-ui";
import {
  Card,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "smthrs/ui";

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
function rowOf(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined;
  return isRecord(data.row) ? data.row : data;
}
function laneId(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
}

function RepoLane({ runId, repo }: { runId: string; repo: string }) {
  const id = laneId(repo);
  const upgrade = useGatewayNodeOutput({ runId, nodeId: `upgrade-${id}` });
  const review = useGatewayNodeOutput({ runId, nodeId: `review-${id}` });
  const pr = useGatewayNodeOutput({ runId, nodeId: `pr-${id}` });
  const improve = useGatewayNodeOutput({ runId, nodeId: `improve-${id}` });
  const u = rowOf(upgrade.data);
  const v = rowOf(review.data);
  const p = rowOf(pr.data);
  const m = rowOf(improve.data);
  const ideas = Array.isArray(u?.improvementIdeas) ? (u?.improvementIdeas as unknown[]) : [];

  const stage = m ? "improved" : p ? "pr" : v ? "reviewed" : u ? "upgraded" : "running";
  const status =
    u?.status === "blocked" || v?.approved === false || p?.skipped === true
      ? "failed"
      : p?.prUrl
        ? "completed"
        : u?.status === "no-hits"
          ? "skipped"
          : "running";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{repo}</CardTitle>
        <StatusPill status={status} label={u?.status === "no-hits" ? "no hits" : stage} />
      </CardHeader>
      {u ? (
        <p>
          {asString(u.oldVersion) || "?"} → {asString(u.newVersion) || "?"} · grep clean:{" "}
          {u.grepClean === true ? "yes" : "NO"} · files: {String(u.filesChanged ?? "?")} · ideas: {ideas.length}{" "}
          {asString(u.breakingApplied) ? `· breaking: ${asString(u.breakingApplied)}` : ""} {asString(u.notes)}
        </p>
      ) : (
        <p>Upgrading…</p>
      )}
      {v ? (
        <p>
          Sol review: {v.approved === true ? "approved" : "REJECTED"} — {asString(v.feedback)}
        </p>
      ) : null}
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
                {" "}
                · issue <a href={asString(m.issueUrl)}>{asString(m.issueUrl)}</a>
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
  const discover = useGatewayNodeOutput({ runId, nodeId: "discover" });
  if (!runId) {
    return <EmptyState title="No run selected" description="Open with ?runId=<id>." />;
  }
  const d = rowOf(discover.data);
  const repos = Array.isArray(d?.repos)
    ? (d?.repos as unknown[]).filter((r): r is string => typeof r === "string")
    : [];
  return (
    <WorkflowUiShell
      title="Upgrade dependents to smthrs"
      meta={<span className="pill">{`discover, upgrade, review, PRs · run ${runId}`}</span>}
    >
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
        <TabsContent value="tree">
          <RunTree runId={runId} />
        </TabsContent>
        <TabsContent value="events">
          <RunEventLog runId={runId} />
        </TabsContent>
      </Tabs>
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
