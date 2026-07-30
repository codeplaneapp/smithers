/** @jsxImportSource smithers-orchestrator */
import { expect, test } from "bun:test";
import React from "react";
import { createSmithers } from "smithers-orchestrator";
import { fakeAgent, renderWorkflow, runTask } from "smithers-orchestrator/testing";
import { z } from "zod/v4";
import { CommandProbe, commandProbeOutputSchema } from "../components/CommandProbe";
import { GrillMe, grillOutputSchema } from "../components/GrillMe";

const agent = fakeAgent(grillOutputSchema, {
  output: { question: "Ship?", recommendedAnswer: "yes", branch: "release", resolved: true, questionsAsked: 1, sharedUnderstanding: "ready" },
});

function wf(element: React.ReactNode) {
  const { Workflow, smithers } = createSmithers({ command: commandProbeOutputSchema, grill: grillOutputSchema });
  return smithers(() => <Workflow name={`g-${process.pid}`}>{element}</Workflow>);
}

test("one grill + draft", async () => {
  const frame = await renderWorkflow(
    wf(
      <GrillMe idPrefix="default" context="release goal" currentDraft={{ status: "draft" }} agent={agent} output={grillOutputSchema}>
        <CommandProbe id="default:child" command="true" />
      </GrillMe>,
    ),
    {},
  );
  const child = frame.tasks.find((c: any) => c.nodeId === "default:child")!;
  console.log("STATIC1", JSON.stringify(child.staticPayload));
});

test("two grills", async () => {
  const frame = await renderWorkflow(
    wf(
      <>
        <GrillMe idPrefix="default" context="release goal" agent={agent} output={grillOutputSchema}>
          <CommandProbe id="default:child" command="true" />
        </GrillMe>
        <GrillMe idPrefix="override" context="goal" agent={agent} output={grillOutputSchema} maxIterations={3} until />
      </>,
    ),
    {},
  );
  const child = frame.tasks.find((c: any) => c.nodeId === "default:child")!;
  console.log("STATIC2", JSON.stringify(child.staticPayload));
});
