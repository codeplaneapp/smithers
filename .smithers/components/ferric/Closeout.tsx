/** @jsxImportSource smithers-orchestrator */
import { Sequence } from "smithers-orchestrator";
import { Task, outputs } from "./ferricSmithers";
import { planner } from "./ferricAgents";
import type { FerricConfig } from "./ferricConfig";
import { PublishPipeline } from "./PublishPipeline";
import CloseoutPrompt from "../../prompts/ferric-closeout.mdx";

/**
 * A killed campaign publishes a signed closeout — the honest failure is still
 * the durability demonstration. Terminal: nothing hands off after this.
 */
export function Closeout({ ctx, c, reason }: { ctx: any; c: FerricConfig; reason: string }) {
  return (
    <Sequence label="signed closeout">
      <Task id="closeout:write" output={outputs.frcCloseout} agent={planner} timeoutMs={3_600_000}>
        <CloseoutPrompt
          reason={reason}
          lineage={[...c.lineage, ctx.runId].join(" → ")}
          spend={`$${(c.spentCents / 100).toFixed(0)}`}
        />
      </Task>
      <PublishPipeline
        ctx={ctx}
        c={c}
        artifact="signed campaign closeout"
        idPrefix="closeout:publish"
        gateId="gate-publish-closeout"
        instructions="This is the kill-path publish of the signed closeout post. It still never auto-approves, and the honesty bar is the same as it would have been for a success."
      />
    </Sequence>
  );
}
