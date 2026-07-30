/** @jsxImportSource smithers-orchestrator */
import { test } from "bun:test";
import React from "react";
import { createSmithers, Task } from "smithers-orchestrator";
import { fakeAgent, renderWorkflow } from "smithers-orchestrator/testing";
import { z } from "zod/v4";
import { spawnSync } from "node:child_process";
import { GrillMe, grillOutputSchema } from "../components/GrillMe";

const schema = z.looseObject({ command: z.string(), available: z.boolean() });

function probe(id: string, command: string) {
  const r = spawnSync("/usr/bin/which", [command], { stdio: "ignore" });
  console.error(
    `PROBE ${id} status=${r.status} error=${String(r.error)} pid=${process.pid} thread=${(require("node:worker_threads") as any).threadId}`,
  );
  return (
    <Task id={id} output={schema}>
      {{ command, available: r.status === 0 }}
    </Task>
  );
}

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

function wf(element: React.ReactNode) {
  const { Workflow, smithers } = createSmithers({ command: schema, grill: grillOutputSchema });
  return smithers(() => <Workflow name={`g-${process.pid}`}>{element}</Workflow>);
}

test("two grills instrumented", async () => {
  const frame = await renderWorkflow(
    wf(
      <>
        <GrillMe idPrefix="default" context="release goal" agent={agent} output={grillOutputSchema}>
          {probe("default:child", "true")}
        </GrillMe>
        <GrillMe idPrefix="override" context="goal" agent={agent} output={grillOutputSchema} maxIterations={3} until />
      </>,
    ),
    {},
  );
  const child = frame.tasks.find((c: any) => c.nodeId === "default:child")!;
  console.log("STATIC", JSON.stringify(child.staticPayload));
}, 30_000);
