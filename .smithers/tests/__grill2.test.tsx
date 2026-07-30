/** @jsxImportSource smithers-orchestrator */
import { expect, test } from "bun:test";
import React from "react";
import { createSmithers } from "smithers-orchestrator";
import { fakeAgent, renderWorkflow, runTask } from "smithers-orchestrator/testing";
import type { SmithersCtx } from "@smithers-orchestrator/driver/SmithersCtx";
import { z } from "zod/v4";
import { CommandProbe, commandProbeOutputSchema } from "../components/CommandProbe";
import { GrillMe, grillOutputSchema } from "../components/GrillMe";

const panelSchema = z.object({ p: z.string() });
const synthesisSchema = z.object({ s: z.string() });
const scoreSchema = z.object({ score: z.number() });

function workflow(element: React.ReactNode) {
  const { Workflow, smithers, outputs } = createSmithers({
    command: commandProbeOutputSchema,
    grill: grillOutputSchema,
    panel: panelSchema,
    panelSynthesis: synthesisSchema,
    score: scoreSchema,
  });
  return smithers((ctx: SmithersCtx<any>) => (
    <Workflow name={`component-workflow-core-${process.pid}`}>{element}</Workflow>
  ));
}

test("grill child", async () => {
  const agent = fakeAgent(grillOutputSchema, {
    output: {
      question: "Ship?",
      recommendedAnswer: "yes",
      branch: "release",
      resolved: true,
      questionsAsked: 1,
      sharedUnderstanding: "ready",
    },
  });
  const defaults = await renderWorkflow(
    workflow(
      <>
        <GrillMe
          idPrefix="default"
          context="release goal"
          currentDraft={{ status: "draft" }}
          agent={agent}
          output={grillOutputSchema}
        >
          <CommandProbe id="default:child" command="true" />
        </GrillMe>
        <GrillMe idPrefix="override" context="goal" agent={agent} output={grillOutputSchema} maxIterations={3} until />
      </>,
    ),
    {},
  );
  const child = defaults.tasks.find((c: any) => c.nodeId === "default:child")!;
  console.log("STATIC", JSON.stringify(child.staticPayload), "PATH", process.env.PATH?.slice(0, 40));
  await expect(runTask(child)).resolves.toEqual({ command: "true", available: true });
});
