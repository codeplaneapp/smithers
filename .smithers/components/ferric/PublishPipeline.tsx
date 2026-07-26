/** @jsxImportSource smithers-orchestrator */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Sequence } from "smithers-orchestrator";
import { Task, outputs } from "./ferricSmithers";
import { CampaignGate, gateRow } from "./CampaignGate";
import { planner } from "./ferricAgents";
import type { FerricConfig } from "./ferricConfig";
import type { FerricGateId } from "./ferricGates";
import { sh } from "./ferricShell";
import PublishDecisionPrompt from "../../prompts/ferric-publish-decision.mdx";

/**
 * Decide, gate, then act exactly once.
 *
 * Publishing is the campaign's only irreversible act, so the agent that decides
 * never performs it: the decision stays reviewable and replayable, the act is
 * isolated behind a human gate and keyed so a retry is a no-op. Callers mount
 * this LAST — it is mutually exclusive with the milestone hand-off.
 */
export function PublishPipeline(props: {
  ctx: any;
  c: FerricConfig;
  artifact: string;
  idPrefix: string;
  gateId: FerricGateId;
  instructions: string;
}) {
  const { ctx, c } = props;
  const decision = ctx.outputMaybe(outputs.frcPublishDecision, {
    nodeId: `${props.idPrefix}:decide`,
  });
  const approved = gateRow(ctx, props.gateId)?.approved === true;

  return (
    <Sequence label={`publish ${props.artifact}`}>
      <Task
        id={`${props.idPrefix}:decide`}
        output={outputs.frcPublishDecision}
        agent={planner}
        timeoutMs={3_600_000}
      >
        <PublishDecisionPrompt artifact={props.artifact} instructions={props.instructions} />
      </Task>

      {decision?.shouldPublish ? (
        <CampaignGate
          id={props.gateId}
          summary={`${decision.reason}\n\nIdempotency key: ${decision.idempotencyKey}`}
        />
      ) : null}

      {decision?.shouldPublish && approved ? (
        <Task id={`${props.idPrefix}:act`} output={outputs.frcPublishAct} noRetry>
          {async () => {
            const dir = join(c.repo, ".ferric-published");
            const marker = join(dir, `${decision.idempotencyKey}.done`);
            if (existsSync(marker)) {
              return {
                artifact: props.artifact,
                published: true,
                receipt: `idempotent-skip:${decision.idempotencyKey}`,
              };
            }
            const r = await sh(
              ["bash", "scripts/ferric/publish.sh", props.artifact, decision.idempotencyKey],
              c.repo,
            );
            if (!r.ok) throw new Error(`publish act failed:\n${(r.err || r.out).slice(-2000)}`);
            mkdirSync(dir, { recursive: true });
            writeFileSync(marker, r.out.slice(-2000));
            return { artifact: props.artifact, published: true, receipt: r.out.slice(-500) };
          }}
        </Task>
      ) : null}
    </Sequence>
  );
}
