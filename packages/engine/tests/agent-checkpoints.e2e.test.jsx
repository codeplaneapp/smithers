/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { Parallel, Sequence, Task, Workflow, runWorkflow } from "smthrs";
import { approveNode } from "../src/approvals.js";
import { SmithersDb } from "@smthrs/db/adapter";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { replayFromCheckpoint } from "@smthrs/time-travel/replay";
import { loadLatestSnapshot } from "@smthrs/time-travel/snapshot";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

const CODEC = "test.agent-snapshot";
const TIMEOUT_MS = 30_000;
const checkpoint = (cursor) => ({ codec: CODEC, version: 1, payload: { cursor } });
const CHECKPOINT_FORMATS = [{ codec: CODEC, versions: [1] }];

describe("durable agent checkpoints", () => {
  test(
    "completed task checkpoints remain visible to later snapshots and forks",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      const runId = "checkpoint-completed-provenance";
      const workflow = smithers(() => (
        <Workflow name="checkpoint-completed-provenance">
          <Sequence>
            <Task
              id="source"
              output={outputs.outputA}
              agent={{
                id: "checkpoint-completed-source",
                checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }],
                checkpointFormats: CHECKPOINT_FORMATS,
                async generate() {
                  return { text: '{"value":1}', checkpoint: checkpoint("completed-source") };
                },
              }}
            >
              source
            </Task>
            <Task id="later" output={outputs.outputB}>
              {{ value: 2 }}
            </Task>
          </Sequence>
        </Workflow>
      ));

      try {
        const first = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        expect(first.status).toBe("finished");
        let sourceNode = await Effect.runPromise(adapter.getNode(runId, "source", 0));
        expect(sourceNode?.lastAttempt).toBe(1);

        // Simulate a legacy row (or a row already erased by the old fast path),
        // then make a completed-run resume render the durable output again.
        await Effect.runPromise(adapter.insertNode({ ...sourceNode, lastAttempt: null }));
        const resumed = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, resume: true }));
        expect(resumed.status).toBe("finished");
        sourceNode = await Effect.runPromise(adapter.getNode(runId, "source", 0));
        expect(sourceNode?.lastAttempt).toBe(1);

        const latest = await loadLatestSnapshot(adapter, runId);
        expect(latest).toBeDefined();
        const snapshotOutputs = JSON.parse(latest.outputsJson);
        expect(snapshotOutputs.__smithersAgentCheckpointProvenance.checkpoints).toContainEqual(
          expect.arrayContaining(["source", 0, 1, 0]),
        );

        const fork = await replayFromCheckpoint(adapter, {
          parentRunId: runId,
          frameNo: latest.frameNo,
        });
        const forkRefs = await adapter.listAgentCheckpointRefs(fork.runId, { nodeId: "source" });
        expect(forkRefs.map((ref) => [ref.attempt, ref.sequence, ref.purpose])).toEqual([[1, 0, "turn"]]);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "persists a failed attempt checkpoint and supplies it to the next task attempt",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const calls = [];
      const agent = {
        id: "checkpoint-retry",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }],
        checkpointFormats: CHECKPOINT_FORMATS,
        async generate(args) {
          calls.push(args);
          if (calls.length === 1) {
            return { text: '{"wrong":true}', checkpoint: checkpoint("attempt-1") };
          }
          // Omitting checkpoint preserves the resumed state.
          return { text: '{"value":7}' };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="checkpoint-retry">
          <Task id="work" output={outputs.outputA} agent={agent} retries={1} maxSchemaRetries={0}>
            work
          </Task>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      expect(calls).toHaveLength(2);
      expect(calls[0].resumeCheckpoint).toBeUndefined();
      expect(calls[1].resumeCheckpoint).toEqual(checkpoint("attempt-1"));
      expect(calls[1].checkpointMode).toBe("resume");

      const adapter = new SmithersDb(db);
      const refs = await adapter.listAgentCheckpointRefs(result.runId, { nodeId: "work" });
      expect(refs.map((ref) => [ref.attempt, ref.sequence, ref.purpose])).toEqual([[1, 0, "turn"]]);
      const attempts = await adapter.listAttempts(result.runId, "work", 0);
      expect(JSON.parse(attempts[0].metaJson).resumedFromCheckpoint).toMatchObject({
        codec: CODEC,
        version: 1,
        mode: "resume",
      });
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "schema-correction turns receive isolated checkpoint clones",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const calls = [];
      const receivedCursors = [];
      const agent = {
        id: "checkpoint-schema-correction",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }],
        checkpointFormats: CHECKPOINT_FORMATS,
        async generate(args) {
          calls.push(args);
          if (calls.length === 1) return { text: '{"wrong":1}', checkpoint: checkpoint("c1") };
          receivedCursors.push(args.resumeCheckpoint.payload.cursor);
          args.resumeCheckpoint.payload.cursor = `mutated-${calls.length}`;
          if (calls.length === 2) return { text: '{"value":"wrong"}' };
          return { text: '{"value":42}' };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="checkpoint-schema-correction">
          <Task id="work" output={outputs.outputA} agent={agent} noRetry>
            work
          </Task>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      expect(calls).toHaveLength(3);
      expect(receivedCursors).toEqual(["c1", "c1"]);
      expect(calls[1].resumeCheckpoint).not.toBe(calls[2].resumeCheckpoint);
      const adapter = new SmithersDb(db);
      const refs = await adapter.listAgentCheckpointRefs(result.runId, { nodeId: "work" });
      expect(refs.map((ref) => ref.purpose)).toEqual(["turn"]);
      const finalContent = await adapter.getAgentCheckpoint(refs.at(-1).contentHash);
      expect(JSON.parse(finalContent.checkpointJson)).toEqual(checkpoint("c1"));
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "JSON-format checkpoint corrections omit the legacy resumeSession property",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
      const calls = [];
      const agent = {
        id: "checkpoint-json-format-correction",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume"] }],
        checkpointFormats: CHECKPOINT_FORMATS,
        async generate(args) {
          calls.push(args);
          if (calls.length === 1) {
            return { text: "completed without JSON", checkpoint: checkpoint("format-c1") };
          }
          return { text: '{"value":42}' };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="checkpoint-json-format-correction">
          <Task id="work" output={outputs.outputA} agent={agent} noRetry>
            work
          </Task>
        </Workflow>
      ));

      try {
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(calls).toHaveLength(2);
        expect(calls[1].resumeCheckpoint).toEqual(checkpoint("format-c1"));
        expect(calls[1].checkpointMode).toBe("resume");
        expect(Object.hasOwn(calls[1], "resumeSession")).toBe(false);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a checkpoint-only task fork survives a stopped run and uses isolated fork mode",
    async () => {
      const fixture = createTestSmithers(outputSchemas);
      const sourceCalls = [];
      const forkCalls = [];
      const buildWorkflow = () =>
        fixture.smithers(() => (
          <Workflow name="checkpoint-fork-resume">
            <Sequence>
              <Task
                id="source"
                output={fixture.outputs.outputA}
                agent={{
                  id: "checkpoint-source",
                  checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }],
                  checkpointFormats: CHECKPOINT_FORMATS,
                  async generate(args) {
                    sourceCalls.push(args);
                    return { text: '{"value":1}', checkpoint: checkpoint("source") };
                  },
                }}
              >
                source
              </Task>
              <Task id="gate" output={fixture.outputs.outputC} needsApproval>
                {{ value: 0 }}
              </Task>
              <Task
                id="fork"
                output={fixture.outputs.outputB}
                fork="source"
                agent={{
                  id: "checkpoint-fork",
                  checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }],
                  checkpointFormats: CHECKPOINT_FORMATS,
                  async generate(args) {
                    forkCalls.push(args);
                    // Mutating the received value must not affect durable source bytes.
                    args.resumeCheckpoint.payload.cursor = "fork-mutated";
                    return { text: '{"value":2}', checkpoint: checkpoint("fork") };
                  },
                }}
              >
                fork
              </Task>
            </Sequence>
          </Workflow>
        ));

      const first = await Effect.runPromise(runWorkflow(buildWorkflow(), { input: {} }));
      expect(first.status).toBe("waiting-approval");
      const adapter = new SmithersDb(fixture.db);
      await Effect.runPromise(approveNode(adapter, first.runId, "gate", 0, "ok", "test"));
      const resumed = await Effect.runPromise(
        runWorkflow(buildWorkflow(), { input: {}, runId: first.runId, resume: true }),
      );
      expect(resumed.status).toBe("finished");
      expect(sourceCalls).toHaveLength(1);
      expect(forkCalls).toHaveLength(1);
      expect(forkCalls[0].checkpointMode).toBe("fork");
      expect(forkCalls[0].messages).toBeUndefined();
      expect(forkCalls[0].resumeCheckpoint.payload.cursor).toBe("fork-mutated");
      const sourceRefs = await adapter.listAgentCheckpointRefs(first.runId, { nodeId: "source" });
      const sourceContent = await adapter.getAgentCheckpoint(sourceRefs[0].contentHash);
      expect(JSON.parse(sourceContent.checkpointJson)).toEqual(checkpoint("source"));
      fixture.cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "parallel retries never cross-contaminate checkpoints",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
      const calls = { left: [], right: [] };
      const makeAgent = (side, value) => ({
        id: `checkpoint-${side}`,
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }],
        checkpointFormats: CHECKPOINT_FORMATS,
        async generate(args) {
          calls[side].push(args);
          if (calls[side].length === 1) {
            return { text: '{"wrong":true}', checkpoint: checkpoint(side) };
          }
          return { text: JSON.stringify({ value }) };
        },
      });
      const workflow = smithers(() => (
        <Workflow name="checkpoint-parallel">
          <Parallel>
            <Task id="left" output={outputs.outputA} agent={makeAgent("left", 1)} retries={1} maxSchemaRetries={0}>
              left
            </Task>
            <Task id="right" output={outputs.outputB} agent={makeAgent("right", 2)} retries={1} maxSchemaRetries={0}>
              right
            </Task>
          </Parallel>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));
      expect(result.status).toBe("finished");
      expect(calls.left[1].resumeCheckpoint).toEqual(checkpoint("left"));
      expect(calls.right[1].resumeCheckpoint).toEqual(checkpoint("right"));
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "rejects malformed or undeclared checkpoints without persisting them",
    async () => {
      for (const [name, agent] of [
        [
          "malformed",
          {
            id: "checkpoint-malformed",
            checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }],
            checkpointFormats: CHECKPOINT_FORMATS,
            async generate() {
              return { text: '{"value":1}', checkpoint: { codec: CODEC, version: 1, payload: { bad: NaN } } };
            },
          },
        ],
        [
          "undeclared",
          {
            id: "checkpoint-undeclared",
            checkpointCapabilities: [{ codec: "other.codec", versions: [1], modes: ["resume", "fork"] }],
            checkpointFormats: [{ codec: "other.codec", versions: [1] }],
            async generate() {
              return { text: '{"value":1}', checkpoint: checkpoint("undeclared") };
            },
          },
        ],
      ]) {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const workflow = smithers(() => (
          <Workflow name={`checkpoint-${name}`}>
            <Task id="work" output={outputs.outputA} agent={agent} noRetry>
              work
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("failed");
        const adapter = new SmithersDb(db);
        expect(await adapter.listAgentCheckpointRefs(result.runId, { nodeId: "work" })).toEqual([]);
        const attempts = await adapter.listAttempts(result.runId, "work", 0);
        const error = JSON.parse(attempts[0].errorJson);
        expect(error.code).toBe(
          name === "malformed" ? "AGENT_CHECKPOINT_INVALID" : "AGENT_CHECKPOINT_CAPABILITY_UNDECLARED",
        );
        if (name === "undeclared") {
          expect(error.details.checkpointFormats).toEqual([{ codec: "other.codec", versions: [1] }]);
          expect(error.details.checkpointCapabilities).toBeUndefined();
        }
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test("fails explicitly instead of starting fresh beyond the incompatible checkpoint history cap", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    let calls = 0;
    const agent = {
      id: "checkpoint-history-cap",
      checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume"] }],
      checkpointFormats: [{ codec: "test.incompatible", versions: [1] }],
      async generate(args) {
        calls += 1;
        for (let sequence = 0; sequence < 1_001; sequence += 1) {
          await args.onCheckpoint({
            codec: "test.incompatible",
            version: 1,
            payload: { sequence },
          });
        }
        return { text: '{"wrong":true}' };
      },
    };
    const workflow = smithers(() => (
      <Workflow name="checkpoint-history-cap">
        <Task id="work" output={outputs.outputA} agent={agent} retries={1} maxSchemaRetries={0}>
          work
        </Task>
      </Workflow>
    ));

    try {
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      expect(calls).toBe(1);
      const attempts = await new SmithersDb(db).listAttempts(result.runId, "work", 0);
      const error = JSON.parse(attempts.find((attempt) => attempt.attempt === 2).errorJson);
      expect(error.code).toBe("AGENT_CHECKPOINT_HISTORY_EXHAUSTED");
      expect(error.details).toMatchObject({ nodeId: "work", iteration: 0, scanned: 1_000 });
    } finally {
      cleanup();
    }
  }, 60_000);

  test(
    "an incompatible fork falls back to a copied conversation when available",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
      const targetCalls = [];
      const workflow = smithers(() => (
        <Workflow name="checkpoint-fork-fallback">
          <Task
            id="source"
            output={outputs.outputA}
            agent={{
              id: "checkpoint-source-with-messages",
              checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }],
              checkpointFormats: CHECKPOINT_FORMATS,
              async generate() {
                return {
                  text: '{"value":1}',
                  checkpoint: checkpoint("source"),
                  response: { messages: [{ role: "assistant", content: "source context" }] },
                };
              },
            }}
          >
            source
          </Task>
          <Task
            id="target"
            output={outputs.outputB}
            fork="source"
            agent={{
              id: "conversation-only-target",
              checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume"] }],
              async generate(args) {
                targetCalls.push(args);
                return { text: '{"value":2}' };
              },
            }}
          >
            target
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      expect(targetCalls[0].resumeCheckpoint).toBeUndefined();
      expect(JSON.stringify(targetCalls[0].messages)).toContain("source context");
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "a checkpoint-only incompatible fork fails before invoking its agent",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      let targetCalls = 0;
      const workflow = smithers(() => (
        <Workflow name="checkpoint-fork-incompatible">
          <Sequence>
            <Task
              id="source"
              output={outputs.outputA}
              agent={{
                id: "checkpoint-only-source",
                checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }],
                checkpointFormats: CHECKPOINT_FORMATS,
                async generate() {
                  return { text: '{"value":1}', checkpoint: checkpoint("source-only") };
                },
              }}
            >
              source
            </Task>
            <Task
              id="target"
              output={outputs.outputB}
              fork="source"
              agent={{
                id: "checkpoint-incompatible-target",
                checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume"] }],
                async generate() {
                  targetCalls += 1;
                  return { text: '{"value":2}' };
                },
              }}
            >
              target
            </Task>
          </Sequence>
        </Workflow>
      ));

      try {
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("failed");
        expect(targetCalls).toBe(0);
        const attempts = await new SmithersDb(db).listAttempts(result.runId, "target", 0);
        const error = JSON.parse(attempts[0].errorJson);
        expect(error.code).toBe("TASK_FORK_CHECKPOINT_INCOMPATIBLE");
        expect(error.details).toMatchObject({ codec: CODEC, version: 1, mode: "fork" });
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a resumed source that emits no checkpoint forks from its completed conversation",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const sourceCalls = [];
      const targetCalls = [];
      const source = {
        id: "checkpoint-resumed-source",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }],
        checkpointFormats: CHECKPOINT_FORMATS,
        async generate(args) {
          sourceCalls.push(args);
          if (sourceCalls.length === 1) {
            return { text: '{"wrong":true}', checkpoint: checkpoint("pre-success") };
          }
          return {
            text: '{"value":1}',
            response: { messages: [{ role: "assistant", content: "post-success context" }] },
          };
        },
      };
      const target = {
        id: "checkpoint-resumed-fork-target",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }],
        async generate(args) {
          targetCalls.push(args);
          return { text: '{"value":2}' };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="checkpoint-resumed-source-fork">
          <Sequence>
            <Task id="source" output={outputs.outputA} agent={source} retries={1} maxSchemaRetries={0}>
              source
            </Task>
            <Task id="target" output={outputs.outputB} fork="source" agent={target}>
              target
            </Task>
          </Sequence>
        </Workflow>
      ));

      try {
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(sourceCalls[1].resumeCheckpoint).toEqual(checkpoint("pre-success"));
        expect(targetCalls).toHaveLength(1);
        expect(targetCalls[0].resumeCheckpoint).toBeUndefined();
        expect(JSON.stringify(targetCalls[0].messages)).toContain("post-success context");

        const attempts = await new SmithersDb(db).listAttempts(result.runId, "source", 0);
        const successfulMeta = JSON.parse(attempts.find((attempt) => attempt.state === "finished").metaJson);
        expect(successfulMeta.agentCheckpoint).toBeNull();
        expect(successfulMeta.resumedFromCheckpoint).toMatchObject({
          codec: CODEC,
          version: 1,
          mode: "resume",
        });
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "an agent can discard a poisoned native checkpoint before task retry",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
      const calls = [];
      const agent = {
        id: "checkpoint-discard",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }],
        checkpointFormats: CHECKPOINT_FORMATS,
        async generate(args) {
          calls.push(args);
          if (calls.length === 1) return { text: '{"wrong":true}', checkpoint: checkpoint("poisoned") };
          if (calls.length === 2) {
            throw new SmithersError("AGENT_SESSION_LOST", "checkpoint is unusable", {
              discardAgentCheckpoint: true,
            });
          }
          if (calls.length === 3) throw new Error("fresh retry failed before producing a checkpoint");
          return { text: '{"value":9}' };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="checkpoint-discard">
          <Task id="work" output={outputs.outputA} agent={agent} retries={2}>
            work
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      expect(calls).toHaveLength(4);
      expect(calls[1].resumeCheckpoint).toEqual(checkpoint("poisoned"));
      expect(calls[2].resumeCheckpoint).toBeUndefined();
      expect(calls[3].resumeCheckpoint).toBeUndefined();
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "generic checkpoint continuation excludes a simultaneously captured native session",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
      const calls = [];
      const agent = {
        id: "hybrid-checkpoint-agent",
        cliEngine: "hybrid",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }],
        checkpointFormats: CHECKPOINT_FORMATS,
        async generate(args) {
          calls.push(args);
          if (calls.length === 1) {
            args.onEvent?.({ type: "started", engine: "hybrid", title: "Hybrid", resume: "native-session" });
            return { text: '{"wrong":true}', checkpoint: checkpoint("generic") };
          }
          return { text: '{"value":10}', checkpoint: checkpoint("done") };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="checkpoint-native-precedence">
          <Task id="work" output={outputs.outputA} agent={agent} retries={1} maxSchemaRetries={0}>
            work
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      expect(calls[1].resumeCheckpoint).toEqual(checkpoint("generic"));
      expect(calls[1].checkpointMode).toBe("resume");
      expect(calls[1].resumeSession).toBeUndefined();
      expect(calls[1].continueSession).toBeFalsy();
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "returning an unchanged checkpoint creates a ref owned by the successful retry",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      let calls = 0;
      const agent = {
        id: "unchanged-checkpoint-agent",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume"] }],
        checkpointFormats: CHECKPOINT_FORMATS,
        async generate() {
          calls += 1;
          return {
            text: calls === 1 ? '{"wrong":true}' : '{"value":11}',
            checkpoint: checkpoint("same"),
          };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="checkpoint-unchanged-ref">
          <Task id="work" output={outputs.outputA} agent={agent} retries={1} maxSchemaRetries={0}>
            work
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      const refs = await new SmithersDb(db).listAgentCheckpointRefs(result.runId, { nodeId: "work" });
      expect(refs.map((ref) => ref.attempt)).toEqual([1, 2]);
      expect(new Set(refs.map((ref) => ref.contentHash)).size).toBe(1);
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "run checkpoint byte limits apply before persistence",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const agent = {
        id: "checkpoint-size-limit",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume"] }],
        checkpointFormats: CHECKPOINT_FORMATS,
        async generate() {
          return { text: '{"value":13}', checkpoint: checkpoint("x".repeat(200)) };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="checkpoint-size-limit">
          <Task id="work" output={outputs.outputA} agent={agent} noRetry>
            work
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxAgentCheckpointBytes: 64 }));
      expect(result.status).toBe("failed");
      expect(await new SmithersDb(db).listAgentCheckpointRefs(result.runId, { nodeId: "work" })).toEqual([]);
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "CLI checkpoint persistence failure does not swallow the completed event answer",
    async () => {
      const originalPut = SmithersDb.prototype.putAgentCheckpoint;
      let resolveWriteAttempted;
      const writeAttempted = new Promise((resolve) => {
        resolveWriteAttempted = resolve;
      });
      SmithersDb.prototype.putAgentCheckpoint = function (row) {
        if (row.purpose === "session") {
          resolveWriteAttempted();
          return Effect.fail(new SmithersError("DB_WRITE_FAILED", "injected session checkpoint failure"));
        }
        return originalPut.call(this, row);
      };
      const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
      try {
        const agent = {
          id: "checkpoint-event-failure",
          cliEngine: "fake-cli",
          async generate(args) {
            args.onEvent?.({
              type: "completed",
              engine: "fake-cli",
              ok: true,
              answer: '{"value":12}',
              resume: "session-12",
            });
            await writeAttempted;
            return { text: "" };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="checkpoint-event-failure">
            <Task id="work" output={outputs.outputA} agent={agent} noRetry>
              work
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
      } finally {
        SmithersDb.prototype.putAgentCheckpoint = originalPut;
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a stale runtime cannot persist a result checkpoint after ownership takeover",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      let release;
      let started;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      const generationStarted = new Promise((resolve) => {
        started = resolve;
      });
      const agent = {
        id: "checkpoint-stale-owner",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume"] }],
        checkpointFormats: CHECKPOINT_FORMATS,
        async generate() {
          started();
          await blocked;
          return { text: '{"value":14}', checkpoint: checkpoint("stale") };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="checkpoint-stale-owner">
          <Task id="work" output={outputs.outputA} agent={agent} noRetry>
            work
          </Task>
        </Workflow>
      ));
      const runId = "run-checkpoint-stale-owner";
      try {
        const running = Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        await generationStarted;
        await Effect.runPromise(adapter.updateRun(runId, { runtimeOwnerId: "replacement-runtime" }));
        release();
        const result = await running;
        expect(result.status).toBe("running");
        expect(await adapter.listAgentCheckpointRefs(runId, { nodeId: "work" })).toEqual([]);
      } finally {
        release?.();
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "identical checkpoint republish is fenced after the attempt becomes terminal",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      let republish;
      const agent = {
        id: "checkpoint-identical-post-terminal",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume"] }],
        checkpointFormats: CHECKPOINT_FORMATS,
        async generate(args) {
          republish = () => args.onCheckpoint(checkpoint("same"));
          await republish();
          return { text: '{"value":31}' };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="checkpoint-identical-post-terminal">
          <Task id="work" output={outputs.outputA} agent={agent} noRetry>
            work
          </Task>
        </Workflow>
      ));
      try {
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        await expect(republish()).rejects.toMatchObject({ code: "HEARTBEAT_FENCE_LOST" });
        expect(await new SmithersDb(db).listAgentCheckpointRefs(result.runId, { nodeId: "work" })).toHaveLength(1);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "identical checkpoint republish is fenced after durable cancellation is requested",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      let republish;
      let release;
      let published;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      const firstPublished = new Promise((resolve) => {
        published = resolve;
      });
      const agent = {
        id: "checkpoint-identical-cancel-requested",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume"] }],
        checkpointFormats: CHECKPOINT_FORMATS,
        async generate(args) {
          republish = () => args.onCheckpoint(checkpoint("same"));
          await republish();
          published();
          await blocked;
          return { text: '{"value":32}' };
        },
      };
      const runId = "checkpoint-identical-cancel-requested";
      const workflow = smithers(() => (
        <Workflow name="checkpoint-identical-cancel-requested">
          <Task id="work" output={outputs.outputA} agent={agent} noRetry>
            work
          </Task>
        </Workflow>
      ));
      try {
        const running = Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        await firstPublished;
        await adapter.requestRunCancel(runId, Date.now());
        await expect(republish()).rejects.toMatchObject({ code: "HEARTBEAT_FENCE_LOST" });
        expect((await running).status).toBe("cancelled");
        release();
        expect(await adapter.listAgentCheckpointRefs(runId, { nodeId: "work" })).toHaveLength(1);
      } finally {
        release?.();
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "identical checkpoint republish is fenced after runtime ownership changes",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      let republish;
      let release;
      let published;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      const firstPublished = new Promise((resolve) => {
        published = resolve;
      });
      const agent = {
        id: "checkpoint-identical-stale-owner",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume"] }],
        checkpointFormats: CHECKPOINT_FORMATS,
        async generate(args) {
          republish = () => args.onCheckpoint(checkpoint("same"));
          await republish();
          published();
          await blocked;
          return { text: '{"value":33}' };
        },
      };
      const runId = "checkpoint-identical-stale-owner";
      const workflow = smithers(() => (
        <Workflow name="checkpoint-identical-stale-owner">
          <Task id="work" output={outputs.outputA} agent={agent} noRetry>
            work
          </Task>
        </Workflow>
      ));
      try {
        const running = Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        await firstPublished;
        await Effect.runPromise(adapter.updateRun(runId, { runtimeOwnerId: "replacement-runtime" }));
        await expect(republish()).rejects.toMatchObject({ code: "HEARTBEAT_FENCE_LOST" });
        release();
        expect((await running).status).toBe("running");
        expect(await adapter.listAgentCheckpointRefs(runId, { nodeId: "work" })).toHaveLength(1);
      } finally {
        release?.();
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  // #1610: the retry used to resume the failed attempt's own native session.
  // That pointer names a conversation the CLI has usually already dropped, so
  // the retry died instantly with AGENT_SESSION_LOST. A fresh session reseeded
  // from the fork source costs conversation context, never work.
  test(
    "a forked hybrid retry reseeds the source checkpoint instead of resuming the failed attempt's session",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
      const targetCalls = [];
      const capabilities = [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }];
      const formats = [{ codec: CODEC, versions: [1] }];
      const workflow = smithers(() => (
        <Workflow name="checkpoint-fork-hybrid-retry">
          <Sequence>
            <Task
              id="source"
              output={outputs.outputA}
              agent={{
                id: "checkpoint-fork-hybrid-source",
                checkpointCapabilities: capabilities,
                checkpointFormats: formats,
                async generate() {
                  return { text: '{"value":1}', checkpoint: checkpoint("source") };
                },
              }}
            >
              source
            </Task>
            <Task
              id="target"
              output={outputs.outputB}
              fork="source"
              retries={1}
              maxSchemaRetries={0}
              agent={{
                id: "checkpoint-fork-hybrid-target",
                cliEngine: "hybrid",
                checkpointCapabilities: capabilities,
                async generate(args) {
                  targetCalls.push(args);
                  if (targetCalls.length === 1) {
                    args.onEvent?.({ type: "started", engine: "hybrid", title: "Hybrid", resume: "target-session" });
                    return { text: '{"wrong":true}' };
                  }
                  return { text: '{"value":2}' };
                },
              }}
            >
              target
            </Task>
          </Sequence>
        </Workflow>
      ));

      try {
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(targetCalls).toHaveLength(2);
        expect(targetCalls[0].resumeCheckpoint).toEqual(checkpoint("source"));
        expect(targetCalls[0].checkpointMode).toBe("fork");
        expect(targetCalls[0].resumeSession).toBeUndefined();
        expect(targetCalls[1].resumeSession).toBeUndefined();
        expect(targetCalls[1].resumeCheckpoint).toEqual(checkpoint("source"));
        expect(targetCalls[1].checkpointMode).toBe("fork");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a checkpoint-free schema correction forks its post-correction conversation",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
      const sourceCalls = [];
      const targetCalls = [];
      const capabilities = [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }];
      const formats = [{ codec: CODEC, versions: [1] }];
      const workflow = smithers(() => (
        <Workflow name="checkpoint-schema-correction-fork">
          <Sequence>
            <Task
              id="source"
              output={outputs.outputA}
              noRetry
              agent={{
                id: "checkpoint-corrected-source",
                checkpointCapabilities: capabilities,
                checkpointFormats: formats,
                async generate(args) {
                  sourceCalls.push(args);
                  if (sourceCalls.length === 1) {
                    return {
                      text: '{"value":"wrong"}',
                      checkpoint: checkpoint("pre-correction"),
                      response: { messages: [{ role: "assistant", content: "pre-correction response" }] },
                    };
                  }
                  return {
                    text: '{"value":21}',
                    response: { messages: [{ role: "assistant", content: "post-correction response" }] },
                  };
                },
              }}
            >
              source
            </Task>
            <Task
              id="target"
              output={outputs.outputB}
              fork="source"
              agent={{
                id: "checkpoint-corrected-target",
                checkpointCapabilities: capabilities,
                async generate(args) {
                  targetCalls.push(args);
                  return { text: '{"value":22}' };
                },
              }}
            >
              target
            </Task>
          </Sequence>
        </Workflow>
      ));

      try {
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(sourceCalls).toHaveLength(2);
        expect(targetCalls).toHaveLength(1);
        expect(targetCalls[0].resumeCheckpoint).toBeUndefined();
        expect(JSON.stringify(targetCalls[0].messages)).toContain("post-correction response");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a checkpoint-only compatible fork with an empty prompt reaches generate and resumes on retry",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
      const targetCalls = [];
      const capabilities = [{ codec: CODEC, versions: [1], modes: ["resume", "fork"] }];
      const formats = [{ codec: CODEC, versions: [1] }];
      const workflow = smithers(() => (
        <Workflow name="checkpoint-empty-prompt-fork-resume">
          <Sequence>
            <Task
              id="source"
              output={outputs.outputA}
              agent={{
                id: "checkpoint-empty-prompt-source",
                checkpointCapabilities: capabilities,
                checkpointFormats: formats,
                async generate() {
                  return { text: '{"value":1}', checkpoint: checkpoint("source") };
                },
              }}
            >
              source
            </Task>
            <Task
              id="target"
              output={outputs.outputB}
              fork="source"
              retries={1}
              maxSchemaRetries={0}
              agent={{
                id: "checkpoint-empty-prompt-target",
                checkpointCapabilities: capabilities,
                checkpointFormats: formats,
                async generate(args) {
                  targetCalls.push(args);
                  if (targetCalls.length === 1) {
                    return { text: '{"wrong":true}', checkpoint: checkpoint("target") };
                  }
                  return { text: '{"value":2}' };
                },
              }}
            >
              {""}
            </Task>
          </Sequence>
        </Workflow>
      ));

      try {
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(targetCalls).toHaveLength(2);
        expect(targetCalls[0].resumeCheckpoint).toEqual(checkpoint("source"));
        expect(targetCalls[0].checkpointMode).toBe("fork");
        expect(targetCalls[1].resumeCheckpoint).toEqual(checkpoint("target"));
        expect(targetCalls[1].checkpointMode).toBe("resume");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "awaited progress checkpoint publication is durable before a thrown attempt retries",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
      const calls = [];
      const agent = {
        id: "checkpoint-awaited-progress",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume"] }],
        checkpointFormats: [{ codec: CODEC, versions: [1] }],
        async generate(args) {
          calls.push(args);
          if (calls.length === 1) {
            await args.onCheckpoint(checkpoint("published-before-throw"));
            throw new Error("fail after published checkpoint");
          }
          return { text: '{"value":23}' };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="checkpoint-awaited-progress">
          <Task id="work" output={outputs.outputA} agent={agent} retries={1} maxSchemaRetries={0}>
            work
          </Task>
        </Workflow>
      ));

      try {
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(calls).toHaveLength(2);
        expect(calls[1].resumeCheckpoint).toEqual(checkpoint("published-before-throw"));
        expect(calls[1].checkpointMode).toBe("resume");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a newer incompatible checkpoint does not hide an older compatible checkpoint in the same attempt",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
      const calls = [];
      const compatible = checkpoint("compatible-progress");
      const incompatible = { codec: "test.other-checkpoint", version: 1, payload: { cursor: "newer" } };
      const agent = {
        id: "checkpoint-compatible-history-scan",
        checkpointCapabilities: [{ codec: CODEC, versions: [1], modes: ["resume"] }],
        checkpointFormats: [
          { codec: CODEC, versions: [1] },
          { codec: incompatible.codec, versions: [1] },
        ],
        async generate(args) {
          calls.push(args);
          if (calls.length === 1) {
            await args.onCheckpoint(compatible);
            return { text: '{"wrong":true}', checkpoint: incompatible };
          }
          return { text: '{"value":24}' };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="checkpoint-compatible-history-scan">
          <Task id="work" output={outputs.outputA} agent={agent} retries={1} maxSchemaRetries={0}>
            work
          </Task>
        </Workflow>
      ));

      try {
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(calls).toHaveLength(2);
        expect(calls[1].resumeCheckpoint).toEqual(compatible);
        expect(calls[1].checkpointMode).toBe("resume");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
