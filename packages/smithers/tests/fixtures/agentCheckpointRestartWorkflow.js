import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { z } from "zod";
import { Task, Workflow } from "../../src/index.js";
import { createSmithersPostgres } from "../../src/create.js";

export const CHECKPOINT_CODEC = "smithers.test.generic-agent-state";
export const CHECKPOINT = {
  codec: CHECKPOINT_CODEC,
  version: 1,
  payload: {
    cursor: "after-invalid-output",
    state: { step: 17, tokens: ["alpha", "beta"] },
  },
};
export const NODE_ID = "checkpoint-agent";
export const OUTPUT_VALUE = 42;
export const MARKERS = {
  calls: "calls.log",
  initialReceived: "initial-received.json",
  resumedReceived: "resumed-received.json",
  retryReady: "retry-ready",
};

function assertExactCheckpoint(args) {
  if (args.checkpointMode !== "resume") {
    throw new Error(`expected checkpointMode=resume, got ${String(args.checkpointMode)}`);
  }
  if (JSON.stringify(args.resumeCheckpoint) !== JSON.stringify(CHECKPOINT)) {
    throw new Error(`checkpoint mismatch: ${JSON.stringify(args.resumeCheckpoint)}`);
  }
}

export async function buildAgentCheckpointRestartWorkflow({ connectionString, markerDir, mode }) {
  const api = await createSmithersPostgres(
    { result: z.object({ value: z.number() }) },
    { provider: "postgres", connectionString },
  );
  const { smithers, outputs } = api;
  const agent = {
    id: "postgres-checkpoint-restart-agent",
    checkpointCapabilities: [{ codec: CHECKPOINT_CODEC, versions: [1], modes: ["resume"] }],
    checkpointFormats: [{ codec: CHECKPOINT_CODEC, versions: [1] }],
    async generate(args = {}) {
      const resumed = args.resumeCheckpoint !== undefined;
      appendFileSync(join(markerDir, MARKERS.calls), `${mode}:${resumed ? "resume" : "fresh"}\n`);

      if (!resumed) {
        if (mode !== "initial") throw new Error("fresh resume process did not receive the committed checkpoint");
        return { text: '{"wrong":true}', checkpoint: CHECKPOINT };
      }

      assertExactCheckpoint(args);
      writeFileSync(
        join(markerDir, mode === "initial" ? MARKERS.initialReceived : MARKERS.resumedReceived),
        JSON.stringify({ checkpointMode: args.checkpointMode, resumeCheckpoint: args.resumeCheckpoint }),
      );
      if (mode === "initial") {
        writeFileSync(join(markerDir, MARKERS.retryReady), "ready");
        // This process is the deliberate SIGKILL cutpoint. Keep an event-loop
        // handle alive until the parent kills the process; a fixed timer races
        // the verifier on slow CI and can turn the expected signal into a
        // normal exit.
        await new Promise(() => {
          setInterval(() => {}, 60_000);
        });
      }
      return { text: JSON.stringify({ value: OUTPUT_VALUE }) };
    },
  };

  const workflow = smithers(() =>
    React.createElement(
      Workflow,
      { name: "postgres-generic-agent-checkpoint-restart" },
      React.createElement(
        Task,
        { id: NODE_ID, output: outputs.result, agent, retries: 1, maxSchemaRetries: 0 },
        "Return the result value.",
      ),
    ),
  );
  return { api, workflow };
}
