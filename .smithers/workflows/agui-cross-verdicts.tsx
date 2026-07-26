// smithers-display-name: Agentic UI Cross-Seat Verdicts
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, Parallel, Sequence, Task, UI, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";
import { MULTI_ROOT, reviewSchema } from "./build-agentic-ui-library";

// Last step of the agentic UI program: the two cross-seat verdicts the
// converge run failed to mount (its closure laneId fell outside the shared
// implSchema enum, so the gating state never settled — see
// project_agentic_ui_program memory). Everything else is landed and green:
// this run only reviews the ALREADY-LANDED Multi adoption lanes from the
// missing seat each, then emits the program's final report row.

const inputSchema = z.object({
  note: z.string().default(""),
});

const reportSchema = z.object({
  success: z.boolean(),
  gatewayFableApproved: z.boolean(),
  productSolApproved: z.boolean(),
  summary: z.string().min(20),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  aguiReview: reviewSchema,
  aguiCrossReport: reportSchema,
});

const fableChainMulti = [new ClaudeCodeAgent({ model: "claude-fable-5", cwd: MULTI_ROOT })];
const solChainMulti = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true, cwd: MULTI_ROOT },
  [new ClaudeCodeAgent({ model: "claude-fable-5", cwd: MULTI_ROOT })],
);

const PRIOR_RUN = "run-1784673778698";

function crossSeatPrompt(target: "adopt-gateway" | "adopt-product", seat: "fable" | "sol"): string {
  const scope =
    target === "adopt-gateway"
      ? "Multi's gateway/run structured-output adoption (GatewayNodeDetail/GatewayRunInspector/NodeInspector/RunInspector rendering through shared AgentOutput/ActivityTimeline/Plan/Queue/Artifact/TestResults/StackTrace/CodeBlock/SchemaDisplay/Confirmation/Checkpoint/ContextUsage, raw fallbacks retained)"
      : "Multi's product-surface adoption (AgentCard/ModelSelector/ProviderBadge in the agent registry, Confirmation/ApprovalCard in approvals, Checkpoint actions in timeline, Commit/ChangeSummary/Artifact/OpenInChat in VCS/files, TestResults in evals, EnvironmentVariables/SecretField in BYOK, Sandbox anatomy, canvas anatomy in the flow editor)";
  return [
    `Missing cross-seat verdict: independent ${seat}-seat review of the ALREADY-LANDED ${target} lane in ${MULTI_ROOT}. Do NOT edit files. Return laneId=${target}, seat=${seat}, reviewer=<the model identity you actually are>.`,
    `Scope reviewed: ${scope}. The lane was implemented and approved by the other seat in run ${PRIOR_RUN}; find its commits via \`jj log\` in the Multi repo (adoption commits from 2026-07-22, e.g. \`git log --grep="${target}"\`).`,
    "Review the landed commits at full strictness for: shared-component consumption without duplicate wrappers or new heavy deps, preserved store/imperative/persistence/streaming behavior, honest pending/error states and raw fallbacks retained, accessibility of the adopted surfaces, and untouched unrelated work. Approve if production-ready; if not, itemize blocking issues.",
  ].join("\n\n");
}

export default smithers((ctx) => {
  const reviews = Array.isArray(ctx.outputs?.aguiReview) ? (ctx.outputs.aguiReview as Record<string, unknown>[]) : [];
  const gatewayFable = reviews.filter((row) => row.laneId === "adopt-gateway" && row.seat === "fable").at(-1);
  const productSol = reviews.filter((row) => row.laneId === "adopt-product" && row.seat === "sol").at(-1);

  return (
    <Workflow name="agui-cross-verdicts">
      <UI entry="../ui/agui-cross-verdicts.tsx" title="Agentic UI Cross-Seat Verdicts" />
      <Sequence>
        <Parallel>
          <Task
            id="cross-adopt-gateway-fable"
            output={outputs.aguiReview}
            agent={fableChainMulti}
            retries={2}
            timeoutMs={45 * 60_000}
            heartbeatTimeoutMs={10 * 60_000}
          >
            {crossSeatPrompt("adopt-gateway", "fable")}
          </Task>
          <Task
            id="cross-adopt-product-sol"
            output={outputs.aguiReview}
            agent={solChainMulti}
            retries={2}
            timeoutMs={45 * 60_000}
            heartbeatTimeoutMs={10 * 60_000}
          >
            {crossSeatPrompt("adopt-product", "sol")}
          </Task>
        </Parallel>
        {gatewayFable !== undefined && productSol !== undefined ? (
          <Task id="agui-cross-report" output={outputs.aguiCrossReport}>
            {{
              success: gatewayFable.approved === true && productSol.approved === true,
              gatewayFableApproved: gatewayFable.approved === true,
              productSolApproved: productSol.approved === true,
              summary:
                gatewayFable.approved === true && productSol.approved === true
                  ? "Cross-seat verdicts complete: adopt-gateway approved by Fable, adopt-product approved by Sol. Every program lane now carries its full required review coverage."
                  : `Cross-seat verdicts settled: adopt-gateway fable=${gatewayFable.approved === true}, adopt-product sol=${productSol.approved === true}. See review feedback for blocking issues.`,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
