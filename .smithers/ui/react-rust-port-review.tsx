/** @jsxImportSource react */
/**
 * Operation Ferric — slice code-review surface (companion to react-rust-port.tsx).
 *
 * A reviewer picks a slice node in the run tree and gets the whole review story
 * in one place: the implementer's report, both adversarial reviews, the
 * deterministic verifier's verdict, the landing/ratchet row, the node's LIVE
 * agent chat, and the pending human gates — every widget a shipped
 * smithers-orchestrator component over the gateway-react hooks.
 *
 * Diffs render through the house DiffHunks anatomy via parseUnifiedFile, fed
 * from the verify row (vcs.tsx reference-bundle pattern: diff text travels as a
 * node-output field). The Ferric verifier stores its `jj diff --stat` in
 * `reasons`; persist the full patch on the verify row (a `diffText` field) to
 * light the full hunk view up.
 *
 * Open it by pointing the workflow's <UI entry> here, or register it on a
 * gateway: gateway.register("react-rust-port", wf, { ui: { entry: ".smithers/ui/react-rust-port-review.tsx" } })
 */
import { useState } from "react";
import { createGatewayReactRoot, useGatewayNodeOutput } from "smithers-orchestrator/gateway-react";
import {
  ConnectionBadge,
  GatewayApprovalList,
  MonitorButton,
  NodeChatStream,
  RunList,
  RunMeta,
  RunTree,
  StatusPill,
  WorkflowUiShell,
} from "smithers-orchestrator/gateway-ui";
import { DiffHunks, EmptyState, KpiStat, parseUnifiedFile } from "smithers-orchestrator/ui";

const WORKFLOW = "react-rust-port";
const SLICE_NODE = /^(?<slice>.+?):(implement|review-claude|review-codex|verify|land.*)$/;

function initialRunId(): string | undefined {
  return new URLSearchParams(window.location.search).get("runId") ?? undefined;
}

/** One persisted row, unwrapped defensively (`data.row`, booleans as 0/1). */
function useRow(runId: string | undefined, nodeId: string | undefined) {
  const out = useGatewayNodeOutput({ runId, nodeId, iteration: 0 });
  const row = (out.data as any)?.row ?? null;
  return { row, status: String((out.data as any)?.status ?? "pending") };
}

function RowCard(props: { title: string; ok?: boolean | null; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 6 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>{props.title}</strong>
        {props.ok != null ? <StatusPill status={props.ok ? "ok" : "blocked"} /> : <StatusPill status="pending" />}
      </header>
      {props.children}
    </section>
  );
}

function SliceReview({ runId, sliceId }: { runId?: string; sliceId: string }) {
  const impl = useRow(runId, `${sliceId}:implement`);
  const revA = useRow(runId, `${sliceId}:review-claude`);
  const revB = useRow(runId, `${sliceId}:review-codex`);
  const verify = useRow(runId, `${sliceId}:verify`);
  const truthy = (v: unknown) => v === true || v === 1;
  const diffText: string = String(verify.row?.diffText ?? "");
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        <KpiStat label="Slice" value={sliceId} />
        <KpiStat
          label="Verifier"
          value={verify.row ? (truthy(verify.row.ok) ? "green" : "VETO") : "pending"}
          hint={verify.row ? `${verify.row.testsPassed}/${verify.row.testsTotal} tests` : "deterministic, in-lane"}
        />
        <KpiStat
          label="Reviews"
          value={`${[revA, revB].filter((r) => truthy(r.row?.approved)).length}/2 approved`}
          hint="opus + opposite-codex, diff-only"
        />
      </div>

      {diffText ? (
        <DiffHunks file={parseUnifiedFile(diffText)} />
      ) : (
        <EmptyState
          title="No patch text on the verify row"
          description={`The verifier stored: ${String(verify.row?.reasons ?? "…nothing yet")}. Persist the lane patch as frcVerify.diffText to render full hunks here.`}
        />
      )}

      <RowCard
        title="Implementer report"
        ok={impl.row ? truthy(impl.row.cargoCheckOk) && truthy(impl.row.testsOk) : null}
      >
        <p style={{ margin: 0, fontSize: 13 }}>{String(impl.row?.summary ?? "not yet reported")}</p>
      </RowCard>
      <RowCard title="Adversarial review — claude-opus" ok={revA.row ? truthy(revA.row.approved) : null}>
        <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap" }}>{String(revA.row?.findings ?? "…")}</p>
      </RowCard>
      <RowCard title="Adversarial review — codex (opposite tier)" ok={revB.row ? truthy(revB.row.approved) : null}>
        <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap" }}>{String(revB.row?.findings ?? "…")}</p>
      </RowCard>
      <RowCard title="Deterministic verifier (the veto)" ok={verify.row ? truthy(verify.row.ok) : null}>
        <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap" }}>{String(verify.row?.reasons ?? "…")}</p>
      </RowCard>

      {/* Live agent feedback for the seat under review. */}
      <NodeChatStream
        runId={runId}
        nodeId={`${sliceId}:implement`}
        title={`${sliceId} — implementer, live`}
        height={320}
      />
    </div>
  );
}

function App() {
  const [runId, setRunId] = useState<string | undefined>(initialRunId());
  const [sliceId, setSliceId] = useState<string | undefined>(undefined);

  return (
    <WorkflowUiShell
      title="Ferric slice review"
      meta={<RunMeta runId={runId} showConnection={false} />}
      actions={
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <ConnectionBadge />
          <MonitorButton runId={runId} />
        </div>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "240px 300px 1fr", gap: 12, padding: 16 }}>
        <RunList
          filter={{ workflow: WORKFLOW, limit: 20 }}
          activeRunId={runId}
          onSelect={(id: string) => {
            setRunId(id);
            setSliceId(undefined);
          }}
        />
        <RunTree
          runId={runId}
          onSelectNode={(node: { id: string }) => {
            const m = SLICE_NODE.exec(node.id);
            if (m?.groups?.slice) setSliceId(m.groups.slice);
          }}
        />
        <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
          {/* The human gates this reviewer can clear, right where the evidence is. */}
          <GatewayApprovalList filter={{ workflow: WORKFLOW }} note="resolved from the slice-review surface" />
          {sliceId ? (
            <SliceReview runId={runId} sliceId={sliceId} />
          ) : (
            <EmptyState
              title="Pick a slice"
              description="Select any slice node (implement / review / verify / land) in the run tree to open its full review story."
            />
          )}
        </div>
      </div>
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
