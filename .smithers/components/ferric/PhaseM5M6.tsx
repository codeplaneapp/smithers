/** @jsxImportSource smithers-orchestrator */
import { Parallel } from "smithers-orchestrator";
import { outputs } from "./ferricSmithers";
import { BenchTask } from "./BenchTask";
import { SuiteTask } from "./SuiteTask";
import { TrialPhase } from "./TrialPhase";
import type { FerricConfig, SliceDef } from "./ferricConfig";
import { frontier } from "./ferricLedger";

const M5M6_SLICES: SliceDef[] = [
  {
    id: "m5-dom-client",
    kind: "phase",
    modules: ["react-dom-bindings", "react-dom client"],
    gate: "react-dom client suites",
  },
  { id: "m5-hydration", kind: "phase", modules: ["hydration + event replay"], gate: "hydration suites" },
  { id: "m6-fizz-core", kind: "phase", modules: ["react-server Fizz"], gate: "Fizz suites + chunk ordering" },
  {
    id: "m6-fizz-hosts",
    kind: "phase",
    modules: ["Fizz Node/Bun/edge entries + napi Host"],
    gate: "dual-target byte-equal HTML",
  },
];

/** M5 and M6 run in parallel: the DOM client and streaming SSR. */
export function PhaseM5M6({ ctx, c }: { ctx: any; c: FerricConfig }) {
  const f = frontier(ctx, c.repo, M5M6_SLICES, outputs);
  const gateReady = f.done || f.blocked.length > 0;

  return (
    <TrialPhase
      ctx={ctx}
      c={c}
      milestone="M5M6"
      slices={M5M6_SLICES}
      gateId="gate-m5m6-exit"
      summary="M5 does not close unless krausest update operations land within 10% of stock React; SSR has a 0.95x floor and a 1.3x target. GA-posture work (packaging fixtures, CSP cells, the version train, soak baselines) starts alongside from here."
      evidence={
        gateReady ? (
          <Parallel label="M5/M6 exit evidence">
            <SuiteTask id="m5:suite" leg="react-dom client+hydration" args={["--leg", "dom"]} repo={c.repo} />
            <SuiteTask id="m6:suite" leg="fizz + chunk-ordering" args={["--leg", "fizz"]} repo={c.repo} />
            <BenchTask id="m5:bench" bench="krausest-update" pass={(r) => r > 0 && r <= 1100} repo={c.repo} />
            <BenchTask id="m6:bench" bench="ssr-throughput" pass={(r) => r >= 950} repo={c.repo} />
          </Parallel>
        ) : null
      }
    />
  );
}
