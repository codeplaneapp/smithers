/** @jsxImportSource smithers-orchestrator */
import { ContinueAsNew, Parallel, Sequence } from "smithers-orchestrator";
import { Task, outputs } from "./ferricSmithers";
import { CampaignGate, gateRow } from "./CampaignGate";
import { FuzzTask } from "./FuzzTask";
import { PortCampaign } from "./PortCampaign";
import { PublishPipeline } from "./PublishPipeline";
import { SuiteTask } from "./SuiteTask";
import { fable } from "./ferricAgents";
import type { FerricConfig, SliceDef } from "./ferricConfig";
import { frontier } from "./ferricLedger";
import M9ApiDesignPrompt from "../../prompts/ferric-m9-api-design.mdx";

const M9_SLICES: SliceDef[] = [
  { id: "m9-macro-hooks", kind: "phase", modules: ["#[component]", "typed hooks", "rsx!"], gate: "compile ledger + macro proptests" },
  { id: "m9-mixed-trees", kind: "phase", modules: ["mixed TS/Rust trees"], gate: "twin matrix cohort" },
  { id: "m9-axum-ssr", kind: "phase", modules: ["pure-Rust axum SSR"], gate: "SSR twin matrix + perf" },
];

/** M9 — write React in Rust: the native authoring API, behind a design freeze. */
export function PhaseM9({ ctx, c }: { ctx: any; c: FerricConfig }) {
  const freeze = gateRow(ctx, "gate-m9-freeze");
  const f = frontier(ctx, c.repo, M9_SLICES, outputs);
  const evidenceReady = f.done || f.blocked.length > 0;
  const published = ctx.outputMaybe(outputs.frcPublishAct, { nodeId: "m9:publish:act" });

  return (
    <Sequence label="M9 — Rust-native API">
      <Task id="m9:api-design" output={outputs.frcPlan} agent={fable} timeoutMs={7_200_000}>
        <M9ApiDesignPrompt repo={c.repo} />
      </Task>

      <CampaignGate
        id="gate-m9-freeze"
        summary={`Freeze the M9 Rust authoring API surface before implementation begins. Evidence: the m9:api-design plan row. Budget envelope is $40k P50 / $62k cap on top of the attested $${(c.spentCents / 100).toFixed(0)} already spent.`}
      />

      {freeze?.approved ? (
        <Sequence>
          <PortCampaign ctx={ctx} c={c} phase="M9" slices={M9_SLICES} />
          {evidenceReady ? (
            <Parallel label="M9 twin evidence">
              <SuiteTask
                id="m9:twin-matrix"
                leg="twin matrix wasm+native (~300 twins)"
                args={["--leg", "twins"]}
                repo={c.repo}
              />
              <FuzzTask id="m9:fuzz" mode="three-leg" cases={10_000_000} repo={c.repo} />
              <SuiteTask
                id="m9:build-regression"
                leg="the four --build runs stay green"
                args={["--all"]}
                repo={c.repo}
              />
            </Parallel>
          ) : null}
          {evidenceReady ? (
            <PublishPipeline
              ctx={ctx}
              c={c}
              artifact="ferric-react* (cargo) + M9 release"
              idPrefix="m9:publish"
              gateId="gate-publish-m9"
              instructions="Publish the Rust-native authoring crates to crates.io plus the M9 release post. The four build-mode oracle runs must be green in the evidence. If twin conformance stayed below 90% after two full fix cycles, the only publishable claim is the narrowed server-rendering mode."
            />
          ) : null}
          {published?.published ? (
            <ContinueAsNew
              state={{ milestone: "DONE", spentCents: c.spentCents, lineage: [...c.lineage, ctx.runId] }}
            />
          ) : null}
        </Sequence>
      ) : null}
    </Sequence>
  );
}
