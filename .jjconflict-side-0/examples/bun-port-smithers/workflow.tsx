/** @jsxImportSource smithers-orchestrator */
import { ApprovalGate, HumanTask, Subflow, type SmithersWorkflow } from "@smithers-orchestrator/components";
import { createSmithers } from "smithers-orchestrator";
import type { z } from "zod";

import {
  approvalSchema,
  bunPortFinalSchema,
  bunPortInputSchema,
  childRunResultSchema,
  operatorPlanSchema,
} from "./components/schemas";
import OperatorPlanPrompt from "./prompts/operator-plan.mdx";
import auditSweepsWorkflow from "./workflows/audit-sweeps";
import compileWorkflow from "./workflows/crate-compile-bringup";
import lifetimeWorkflow from "./workflows/lifetime-classify";
import probeWorkflow from "./workflows/panic-probe-swarm";
import phaseAWorkflow from "./workflows/phase-a-port";
import testSwarmWorkflow from "./workflows/test-swarm";
import ungateWorkflow from "./workflows/ungate-proper-port";

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers(
  {
    input: bunPortInputSchema,
    operatorPlan: operatorPlanSchema,
    childRunResult: childRunResultSchema,
    approval: approvalSchema,
    bunPortFinal: bunPortFinalSchema,
    output: bunPortFinalSchema,
  },
  { dbPath: process.env.BUN_PORT_SMITHERS_DB ?? "examples/bun-port-smithers/.tmp/smithers.db" },
);

type ChildRunResult = z.infer<typeof childRunResultSchema>;

/** The lifetime subflow merges these summary fields onto its child-run result. */
type LifetimeChildResult = ChildRunResult & {
  unknownRate?: number;
  totalFields?: number;
  refutedKeys?: string[];
  summary?: string;
};

/** The compile subflow merges these report fields onto its child-run result. */
type CompileChildResult = ChildRunResult & {
  gatedModules?: number;
  failingCrates?: string[];
  summary?: string;
};

const phaseToFlag = {
  lifetimes: "runLifetimes",
  phaseA: "runPhaseA",
  compile: "runCompile",
  ungate: "runUngate",
  probes: "runProbes",
  tests: "runTests",
  sweeps: "runSweeps",
} as const;

export default smithers((ctx) => {
  const operatorPlan = ctx.outputMaybe(outputs.operatorPlan, { nodeId: "operator:plan" });
  const operatorDenied = ctx.input.requireOperatorPlan && operatorPlan?.approved === false;
  const canRun = !ctx.input.requireOperatorPlan || operatorPlan?.approved === true;
  const phaseEnabled = (phase: keyof typeof phaseToFlag): boolean => {
    if (!ctx.input.phases.includes(phase)) return false;
    if (!operatorPlan) return true;
    return operatorPlan[phaseToFlag[phase]] !== false;
  };
  const requestedPhases = (Object.keys(phaseToFlag) as Array<keyof typeof phaseToFlag>)
    .filter((phase) => canRun && phaseEnabled(phase));
  const subflowIds = requestedPhases.map((phase) => `main:${phase}`);
  const subflowRows = subflowIds
    .map((nodeId) => ctx.outputMaybe(outputs.childRunResult, { nodeId }))
    .filter(Boolean);
  const lifetimeResult = ctx.outputMaybe(outputs.childRunResult, { nodeId: "main:lifetimes" }) as
    | LifetimeChildResult
    | undefined;
  const compileResult = ctx.outputMaybe(outputs.childRunResult, { nodeId: "main:compile" }) as
    | CompileChildResult
    | undefined;
  const lifetimeGate = ctx.outputMaybe(outputs.approval, { nodeId: "main:lifetimes:approval" });
  const compileGate = ctx.outputMaybe(outputs.approval, { nodeId: "main:compile:approval" });
  const allSubflowsDone = canRun && subflowRows.length >= requestedPhases.length;

  return (
    <Workflow name="bun-port-smithers">
      <Sequence>
        {ctx.input.requireOperatorPlan && !operatorPlan ? (
          <HumanTask
            id="operator:plan"
            output={outputs.operatorPlan}
            outputSchema={operatorPlanSchema}
            maxAttempts={5}
            timeoutMs={7 * 24 * 60 * 60_000}
            prompt={(
              <OperatorPlanPrompt
                repo={ctx.input.repo}
                input={ctx.input}
                schema={operatorPlanSchema}
              />
            )}
          />
        ) : null}

        {operatorDenied ? (
          <Task id="main:cancelled" output={outputs.output}>
            {{
              status: "cancelled",
              phasesRun: [],
              summary: `Operator did not approve the Bun port run. ${operatorPlan?.comments ?? ""}`.trim(),
              nextActions: ["Revise input scope and start a new run."],
            }}
          </Task>
        ) : null}

        {canRun && phaseEnabled("lifetimes") ? (
          <Subflow
            id="main:lifetimes"
            output={outputs.childRunResult}
            // Subflow accepts SmithersWorkflow<unknown>; each child workflow has a
            // specific input schema in a contravariant position, so it must be widened
            // through `unknown` rather than narrowed with `as any`.
            workflow={lifetimeWorkflow as unknown as SmithersWorkflow<unknown>}
            retries={0}
            input={{
              repo: ctx.input.repo,
              files: ctx.input.files,
              unknownApprovalThreshold: ctx.input.unknownApprovalThreshold,
            }}
          />
        ) : null}

        {lifetimeResult && !lifetimeGate ? (
          <ApprovalGate
            id="main:lifetimes:approval"
            output={outputs.approval}
            when={(lifetimeResult.unknownRate ?? 0) > ctx.input.unknownApprovalThreshold}
            request={{
              title: "Approve lifetime classification quality?",
              summary: lifetimeResult.summary,
              metadata: {
                unknownRate: lifetimeResult.unknownRate,
                totalFields: lifetimeResult.totalFields,
                refutedKeys: lifetimeResult.refutedKeys,
              },
            }}
            onDeny="fail"
          />
        ) : null}

        {canRun && phaseEnabled("phaseA") ? (
          <Subflow
            id="main:phaseA"
            output={outputs.childRunResult}
            workflow={phaseAWorkflow as unknown as SmithersWorkflow<unknown>}
            retries={0}
            input={{ repo: ctx.input.repo, files: ctx.input.files, maxConcurrency: ctx.input.maxConcurrency }}
          />
        ) : null}

        {canRun && phaseEnabled("compile") ? (
          <Subflow
            id="main:compile"
            output={outputs.childRunResult}
            workflow={compileWorkflow as unknown as SmithersWorkflow<unknown>}
            retries={0}
            input={{ repo: ctx.input.repo, crates: ctx.input.crates }}
          />
        ) : null}

        {compileResult && !compileGate ? (
          <ApprovalGate
            id="main:compile:approval"
            output={outputs.approval}
            when={(compileResult.gatedModules ?? 0) > ctx.input.broadGateApprovalThreshold}
            request={{
              title: "Approve compile gate/stub debt?",
              summary: compileResult.summary,
              metadata: {
                gatedModules: compileResult.gatedModules,
                failingCrates: compileResult.failingCrates,
              },
            }}
            onDeny="fail"
          />
        ) : null}

        {canRun && phaseEnabled("ungate") ? (
          <Subflow
            id="main:ungate"
            output={outputs.childRunResult}
            workflow={ungateWorkflow as unknown as SmithersWorkflow<unknown>}
            retries={0}
            input={{ repo: ctx.input.repo, targets: ctx.input.targets }}
          />
        ) : null}

        {canRun && phaseEnabled("probes") ? (
          <Subflow
            id="main:probes"
            output={outputs.childRunResult}
            workflow={probeWorkflow as unknown as SmithersWorkflow<unknown>}
            retries={0}
            input={{ repo: ctx.input.repo, probes: ctx.input.probes }}
          />
        ) : null}

        {canRun && phaseEnabled("tests") ? (
          <Subflow
            id="main:tests"
            output={outputs.childRunResult}
            workflow={testSwarmWorkflow as unknown as SmithersWorkflow<unknown>}
            retries={0}
            input={{
              repo: ctx.input.repo,
              baseBranch: ctx.input.baseBranch,
              useWorktrees: ctx.input.useWorktrees,
              maxConcurrency: ctx.input.maxConcurrency,
              areas: ctx.input.areas,
              awaitExternalCiSignal: ctx.input.awaitExternalCiSignal,
            }}
          />
        ) : null}

        {canRun && phaseEnabled("sweeps") ? (
          <Subflow
            id="main:sweeps"
            output={outputs.childRunResult}
            workflow={auditSweepsWorkflow as unknown as SmithersWorkflow<unknown>}
            retries={0}
            input={{ repo: ctx.input.repo, sweeps: ctx.input.sweeps }}
          />
        ) : null}

        {allSubflowsDone ? (
          <Task id="main:final" output={outputs.output}>
            {{
              status: "completed",
              phasesRun: requestedPhases,
              summary: `Bun port Smithers workflow completed ${requestedPhases.length} phase(s).`,
              nextActions: [
                "Inspect child run reports and Smithers scores.",
                "Use timeline/fork/replay for any failed or low-confidence node.",
              ],
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
