import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { z } from "zod";
import { Task, Workflow, createSmithers, type AgentLike } from "smithers-orchestrator";

export const CHECKPOINT_CODEC = "e2e.generic-agent-state";
export const CHECKPOINT = {
  codec: CHECKPOINT_CODEC,
  version: 1,
  payload: {
    cursor: "after-invalid-structured-output",
    state: { step: 17, tokens: ["alpha", "beta"] },
  },
} as const;
export const NODE_ID = "checkpoint-agent";
export const OUTPUT_VALUE = 42;
export const WORKFLOW_NAME = "generic-agent-checkpoint-kill-resume";

export const CHECKPOINT_MARKERS = {
  retryReady: "retry-ready",
  initialReceived: "initial-received.json",
  resumedReceived: "resumed-received.json",
  calls: "calls.log",
} as const;

export type GenericCheckpointMode = "initial" | "resume";

export interface BuildGenericCheckpointWorkflowOptions {
  readonly dbPath: string;
  readonly markerDir: string;
  readonly mode: GenericCheckpointMode;
  readonly blockMs?: number;
}

function receivedValue(args: { checkpointMode?: unknown; resumeCheckpoint?: unknown }) {
  return {
    checkpointMode: args.checkpointMode,
    resumeCheckpoint: args.resumeCheckpoint,
  };
}

function assertExactResume(args: { checkpointMode?: unknown; resumeCheckpoint?: unknown }): void {
  if (args.checkpointMode !== "resume") {
    throw new Error(`expected checkpointMode=resume, got ${String(args.checkpointMode)}`);
  }
  if (JSON.stringify(args.resumeCheckpoint) !== JSON.stringify(CHECKPOINT)) {
    throw new Error(`checkpoint mismatch: ${JSON.stringify(args.resumeCheckpoint)} !== ${JSON.stringify(CHECKPOINT)}`);
  }
}

/** Production createSmithers workflow shared by both engine processes and the parent DB verifier. */
export function buildGenericAgentCheckpointWorkflow(opts: BuildGenericCheckpointWorkflowOptions) {
  const blockMs = opts.blockMs ?? 60_000;
  const api = createSmithers({ result: z.object({ value: z.number() }) }, { dbPath: opts.dbPath });
  const { smithers, outputs, db, tables } = api;

  const agent: AgentLike = {
    id: "e2e-generic-checkpoint-agent",
    checkpointCapabilities: [{ codec: CHECKPOINT_CODEC, versions: [1] as const, modes: ["resume"] as const }],
    checkpointFormats: [{ codec: CHECKPOINT_CODEC, versions: [1] as const }],
    async generate(args) {
      const callArgs = args ?? {};
      const hasCheckpoint = callArgs.resumeCheckpoint !== undefined;
      appendFileSync(
        join(opts.markerDir, CHECKPOINT_MARKERS.calls),
        `${opts.mode}:${hasCheckpoint ? "resume" : "fresh"}\n`,
      );

      if (!hasCheckpoint) {
        if (opts.mode !== "initial") {
          throw new Error("fresh resume process did not receive the durable checkpoint");
        }
        return {
          text: '{"wrong":true}',
          checkpoint: CHECKPOINT,
        };
      }

      assertExactResume(callArgs);
      const receivedMarker =
        opts.mode === "initial" ? CHECKPOINT_MARKERS.initialReceived : CHECKPOINT_MARKERS.resumedReceived;
      writeFileSync(join(opts.markerDir, receivedMarker), JSON.stringify(receivedValue(callArgs)));

      if (opts.mode === "initial") {
        // This marker is written only after the retry has received the exact
        // checkpoint. The parent uses it as a deterministic SIGKILL cutpoint.
        writeFileSync(join(opts.markerDir, CHECKPOINT_MARKERS.retryReady), "ready");
        await new Promise((resolve) => setTimeout(resolve, blockMs));
      }

      return { text: JSON.stringify({ value: OUTPUT_VALUE }) };
    },
  };

  const workflow = smithers(() =>
    React.createElement(
      Workflow,
      { name: WORKFLOW_NAME },
      React.createElement(
        Task,
        {
          id: NODE_ID,
          output: outputs.result,
          agent,
          retries: 1,
          maxSchemaRetries: 0,
        },
        "Return the result value.",
      ),
    ),
  );

  return { workflow, db, tables };
}
