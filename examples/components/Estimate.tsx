// smithers-source: seeded
/** @jsxImportSource smthrs */
import { Sequence, Task, estimateCostUsd, type AgentLike } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";
import EstimatePrompt from "../prompts/estimate.mdx";

/**
 * The cheap model's raw forecast: per agent-task token counts and how many
 * times each runs. Tokens only — never seconds (throughput is measured live,
 * see the guide). `model` is optional; when omitted the task is priced at
 * `defaultModel`.
 */
export const estimateForecastSchema = z.object({
  perTask: z
    .array(
      z.object({
        nodeId: z.string().describe("the task's id in the workflow"),
        tokens: z.number().describe("tokens for ONE execution, input + output combined"),
        iterations: z.number().min(1).default(1).describe("how many times this task runs (loop/retry count)"),
        model: z.string().optional().describe("the model id the task uses, if known"),
      }),
    )
    .default([]),
  confidence: z.enum(["low", "medium", "high"]).default("low"),
  assumptions: z.array(z.string()).default([]).describe("what you assumed about loop counts and input scope"),
});
export type EstimateForecast = z.infer<typeof estimateForecastSchema>;

/**
 * The priced, iteration-folded estimate the UIs read. `minutes` is deliberately
 * absent: wall-clock is derived downstream from live throughput, not authored
 * here.
 */
export const workflowEstimateSchema = z.object({
  totalTokens: z.number(),
  costUsd: z.number(),
  confidence: z.enum(["low", "medium", "high"]),
  assumptions: z.array(z.string()).default([]),
  perTask: z
    .array(
      z.object({
        nodeId: z.string(),
        tokens: z.number().describe("tokens across ALL iterations of this task"),
        iterations: z.number(),
        model: z.string(),
        costUsd: z.number(),
      }),
    )
    .default([]),
});
export type WorkflowEstimate = z.infer<typeof workflowEstimateSchema>;

/**
 * Fold a cheap model's forecast into a priced whole-workflow estimate. The
 * model authors token counts and iteration counts; the money is computed here
 * with the shared price table so no model ever does the arithmetic. Tasks
 * whose `model` the forecaster left blank are priced at `defaultModel`.
 */
export function priceEstimate(
  forecast: EstimateForecast | null | undefined,
  defaultModel = "gpt-5.6-luna",
): WorkflowEstimate {
  const perTask = (forecast?.perTask ?? []).map((task) => {
    const iterations = Math.max(1, Math.round(Number(task.iterations) || 1));
    const tokens = Math.max(0, Number(task.tokens) || 0) * iterations;
    const model = task.model || defaultModel;
    return { nodeId: task.nodeId, tokens, iterations, model, costUsd: estimateCostUsd({ model, tokens }) };
  });
  return {
    totalTokens: perTask.reduce((sum, t) => sum + t.tokens, 0),
    costUsd: perTask.reduce((sum, t) => sum + t.costUsd, 0),
    confidence: forecast?.confidence ?? "low",
    assumptions: forecast?.assumptions ?? [],
    perTask,
  };
}

// A concise example the prompt shows the model so it returns the right shape.
const SCHEMA_HINT = JSON.stringify(
  {
    perTask: [{ nodeId: "plan", tokens: 8000, iterations: 1, model: "gpt-5.6-sol" }],
    confidence: "medium",
    assumptions: ["the implement loop converges in ~2 iterations"],
  },
  null,
  2,
);

// The shared cheap pool is Luna when Codex is available and falls back to the
// configured non-Codex cheap providers only on no-Codex installs.
const defaultEstimator: AgentLike[] = agents.cheapFast;

export type EstimateProps = {
  /** Namespaces the two node ids. Read the priced result at `${idPrefix}:priced`. */
  idPrefix?: string;
  /** The run input, so the estimator can size the work to real scope. */
  input: unknown;
  /** Which workflow this is — the estimator reads `.smithers/workflows/<key>.tsx`. */
  workflowKey: string;
  /** The estimator pool; defaults to the Codex-first cheap chain. */
  estimator?: AgentLike[];
  /** Model to price tasks whose model the forecaster left blank. */
  defaultModel?: string;
  /**
   * The forecast, read by the host via `readEstimateForecast(ctx, idPrefix)`.
   * The pricing step renders only once it lands (mirrors the conditional
   * output-task idiom in `hello.tsx`).
   */
  forecast?: EstimateForecast | null;
};

/**
 * `<Estimate>` — a drop-in, non-blocking pre-run estimate. Wrap it in a
 * `<Parallel>` alongside the real work so the run never waits on it. A cheap
 * model forecasts per-task tokens + iterations, then a compute step prices it.
 *
 * Adoption (3 lines): register both schemas in `createSmithers`
 * (`estimateForecast: estimateForecastSchema, estimate: workflowEstimateSchema`),
 * read `const forecast = readEstimateForecast(ctx)`, and pass `forecast` in.
 */
export function Estimate({
  idPrefix = "estimate",
  input,
  workflowKey,
  estimator = defaultEstimator,
  defaultModel = "gpt-5.6-luna",
  forecast = null,
}: EstimateProps) {
  const inputText = JSON.stringify(input ?? null, null, 2);
  return (
    <Sequence>
      <Task
        id={idPrefix}
        output={estimateForecastSchema}
        agent={estimator}
        continueOnFail
        timeoutMs={300_000}
        heartbeatTimeoutMs={120_000}
      >
        <EstimatePrompt workflowKey={workflowKey} input={inputText} schema={SCHEMA_HINT} />
      </Task>
      {forecast ? (
        <Task id={`${idPrefix}:priced`} output={workflowEstimateSchema}>
          {() => priceEstimate(forecast, defaultModel)}
        </Task>
      ) : null}
    </Sequence>
  );
}

/** Read the estimator's forecast from ctx (host helper for the `forecast` prop). */
export function readEstimateForecast(
  ctx: { outputMaybe: (channel: string, opts: { nodeId: string }) => unknown },
  idPrefix = "estimate",
): EstimateForecast | null {
  return (ctx.outputMaybe("estimateForecast", { nodeId: idPrefix }) as EstimateForecast | undefined) ?? null;
}
