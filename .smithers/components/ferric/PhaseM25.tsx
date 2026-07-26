/** @jsxImportSource smithers-orchestrator */
import { ContinueAsNew, Sequence } from "smithers-orchestrator";
import { Task, outputs } from "./ferricSmithers";
import { CampaignGate, gateRow } from "./CampaignGate";
import { Closeout } from "./Closeout";
import type { FerricConfig, SliceDef } from "./ferricConfig";
import { frontier } from "./ferricLedger";
import { PortCampaign } from "./PortCampaign";
import { SuiteTask } from "./SuiteTask";

const M25_SLICES: SliceDef[] = [
  {
    id: "m25-rust-dom-vertical",
    kind: "phase",
    modules: [
      "spike/element",
      "spike/fiber",
      "spike/work_loop",
      "spike/complete",
      "spike/commit",
      "FerricSpikeHostConfig",
    ],
    gate:
      "scripts/ferric/oracle.sh --leg m25-vertical-spike; exact PASSING=4/4, TEST_FILES=1/1, REACT_RUST_ASSERT_BACKEND=1",
  },
];

/**
 * M2.5 — one non-throwaway end-to-end Rust mount before the boundary benchmark
 * and the reconciler campaign. A deterministic red cannot mount the gate.
 */
export function PhaseM25({ ctx, c }: { ctx: any; c: FerricConfig }) {
  const f = frontier(ctx, c.repo, M25_SLICES, outputs);
  const suite = ctx.outputMaybe(outputs.frcSuite, {
    nodeId: "m25:vertical-spike-suite",
  });
  const decision = gateRow(ctx, "gate-m25-exit");
  const exactGreen =
    suite?.green === true &&
    suite.passingCount === 4 &&
    suite.totalCount === 4 &&
    suite.xfailBucketC === 0;

  return (
    <Sequence label="M2.5 — first element-to-DOM Rust vertical">
      <PortCampaign ctx={ctx} c={c} phase="M2.5" slices={M25_SLICES} />

      {f.done ? (
        <SuiteTask
          id="m25:vertical-spike-suite"
          leg="one component: element → Rust fibers → render → commit → DOM"
          args={["--leg", "m25-vertical-spike"]}
          repo={c.repo}
        />
      ) : null}

      {suite != null && !exactGreen ? (
        <Task id="m25:vertical-spike-veto" output={outputs.frcFoundation}>
          {() => {
            throw new Error(
              `M25_VERTICAL_SPIKE_RED: required exact 4/4 with xfail C=0, got ${suite.passingCount}/${suite.totalCount}, green=${suite.green}, xfailC=${suite.xfailBucketC}`,
            );
          }}
        </Task>
      ) : null}

      {exactGreen ? (
        <CampaignGate
          id="gate-m25-exit"
          summary="M2.5 machine predicate is exact 4/4 with zero xfail C: the public createRoot path consumed one function element, Rust allocated and traversed HostRoot/FunctionComponent/HostComponent fibers, the JS render trampoline returned the host child, complete work created the detached DOM node, mutation commit attached it, root.current flipped between mutation and layout, DOM bytes matched stock, and ASSERT_BACKEND found no reconciler implementation import or fallback. Approve proceeds to the measured M3 boundary spike."
        />
      ) : null}

      {decision?.approved ? (
        <ContinueAsNew
          state={{
            milestone: "M3",
            spentCents: c.spentCents,
            lineage: [...c.lineage, ctx.runId],
          }}
        />
      ) : decision?.approved === false ? (
        <Closeout
          ctx={ctx}
          c={c}
          reason="M2.5 exit denied after the first end-to-end Rust DOM vertical passed."
        />
      ) : null}
    </Sequence>
  );
}
