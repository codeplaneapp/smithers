/** @jsxImportSource smithers-orchestrator */
import { Parallel } from "smithers-orchestrator";
import { outputs } from "./ferricSmithers";
import { FuzzTask } from "./FuzzTask";
import { SuiteTask } from "./SuiteTask";
import { TrialPhase } from "./TrialPhase";
import type { FerricConfig, SliceDef } from "./ferricConfig";
import { frontier } from "./ferricLedger";

const M7_SLICES: SliceDef[] = [
  {
    id: "m7-flight-server",
    kind: "phase",
    modules: ["react-server Flight", "react-client"],
    gate: "Flight server/client suites",
  },
  {
    id: "m7-flight-webpack",
    kind: "phase",
    modules: ["react-server-dom-webpack"],
    gate: "webpack adapter full suite (14k test LOC)",
  },
];

/** M7 — the React Server Components wire protocol, webpack adapter only. */
export function PhaseM7({ ctx, c }: { ctx: any; c: FerricConfig }) {
  const f = frontier(ctx, c.repo, M7_SLICES, outputs);
  const gateReady = f.done || f.blocked.length > 0;

  return (
    <TrialPhase
      ctx={ctx}
      c={c}
      milestone="M7"
      slices={M7_SLICES}
      gateId="gate-m7-exit"
      summary="The Flight suite must be 100% with zero skips, and the round-trip fuzz must run a full million cases with zero divergence."
      evidence={
        gateReady ? (
          <Parallel label="M7 exit evidence">
            <SuiteTask id="m7:suite" leg="react-server-dom-webpack" args={["--leg", "flight"]} repo={c.repo} />
            <FuzzTask id="m7:fuzz" mode="flight-roundtrip" cases={1_000_000} repo={c.repo} />
          </Parallel>
        ) : null
      }
    />
  );
}
