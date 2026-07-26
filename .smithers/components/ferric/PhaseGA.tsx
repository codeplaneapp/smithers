/** @jsxImportSource smithers-orchestrator */
import { ContinueAsNew, Parallel, Sequence } from "smithers-orchestrator";
import { Task, outputs } from "./ferricSmithers";
import { CampaignGate, gateRow } from "./CampaignGate";
import { PublishPipeline } from "./PublishPipeline";
import { Closeout } from "./Closeout";
import { mechanical } from "./ferricAgents";
import type { FerricConfig } from "./ferricConfig";
import GaSoakPrompt from "../../prompts/ferric-ga-soak.mdx";

const SOAK_APPS = ["excalidraw", "cal.com", "mattermost", "grafana", "backstage"];

/** GA posture — real applications, run against a stock-React baseline first. */
export function PhaseGA({ ctx, c }: { ctx: any; c: FerricConfig }) {
  const soaksDone = SOAK_APPS.every((a) =>
    ctx.outputs.frcSoak.some((s: any) => s.app === a),
  );
  const ga = gateRow(ctx, "gate-ga");

  return (
    <Sequence label="GA posture">
      <Parallel label="soak matrix" maxConcurrency={2}>
        {SOAK_APPS.map((app) => (
          <Task
            key={app}
            id={`ga:soak-${app}`}
            output={outputs.frcSoak}
            agent={mechanical}
            continueOnFail
            timeoutMs={14_400_000}
          >
            <GaSoakPrompt app={app} repo={c.repo} />
          </Task>
        ))}
      </Parallel>

      {soaksDone ? (
        <Sequence>
          <CampaignGate
            id="gate-ga"
            summary={`GA exit. Soaks: ${SOAK_APPS.map((a) => `${a}=${String(ctx.outputs.frcSoak.find((s: any) => s.app === a)?.green ?? "?")}`).join(", ")}. Also required, and attested in the decision note: beta across at least 20 distinct apps and 200 app-days, at least 99.95% crash-free, zero unresolved P0/P1, security and support policy live, the version train rehearsed, and rollback proven under 15 minutes. Never cut: the oracle, the backend assertion, byte-identical errors, security response, the release train, rollback, or the owned GA fixtures — if they do not fit, deny this gate and ship the RC instead.`}
          />
          {ga?.approved ? (
            <Sequence>
              <PublishPipeline
                ctx={ctx}
                c={c}
                artifact="@ferric GA (npm latest) + campaign post"
                idPrefix="ga:publish"
                gateId="gate-publish-ga"
                instructions="General-availability publish: npm latest dist-tag, the signed compatibility manifest, benchmark publication per the frozen contract, the campaign post, and the courtesy note to the React team."
              />
              <ContinueAsNew
                state={{ milestone: "M9", spentCents: c.spentCents, lineage: [...c.lineage, ctx.runId] }}
              />
            </Sequence>
          ) : ga?.approved === false ? (
            <Closeout ctx={ctx} c={c} reason="GA gate denied: the operator judged the production posture insufficient; ship the RC claim instead." />
          ) : null}
        </Sequence>
      ) : null}
    </Sequence>
  );
}
