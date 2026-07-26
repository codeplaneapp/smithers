/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { buildMemoryPromptBlock, createTaskMemoryTools } from "../src/memory-runtime.js";
import { z } from "zod";

const outputSchema = z.object({ value: z.number() });

afterEach(() => {
  delete process.env.SMITHERS_MEMORY_TIMEOUT_MS;
});

describe("task memory runtime", () => {
  test("remember enforces stable tags, user-bank isolation, and derived branch scope", async () => {
    const retains = [];
    const service = {
      recallMemory: async () => [],
      getPrimers: async () => [],
      retainMemory: async (input) => retains.push(input),
    };
    const context = {
      runId: "tag-run",
      nodeId: "tag-task",
      iteration: 0,
      taskSignal: new AbortController().signal,
    };
    const userTools = createTaskMemoryTools(
      service,
      {
        banks: ["user-1", "project-1"],
        tags: ["branch:feature", "stream:checkout"],
      },
      context,
    );

    await expect(
      userTools.remember.execute(
        {
          bank: "user-1",
          content: "volatile",
          tags: ["run:tag-run"],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      userTools.remember.execute(
        {
          bank: "user-1",
          content: "project scoped",
          tags: ["branch:feature"],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      userTools.remember.execute(
        {
          bank: "user-1",
          content: "project identity",
          tags: ["project:checkout"],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await userTools.remember.execute(
      {
        bank: "project-1",
        content: "branch finding",
        tags: ["source:reflection"],
      },
      {},
    );
    expect(retains[0].tags).toEqual(["branch:feature", "stream:checkout", "source:reflection", "scope:branch"]);

    const conflicting = createTaskMemoryTools(
      service,
      {
        bank: "project-1",
        tags: ["branch:feature", "scope:main"],
      },
      context,
    );
    await expect(conflicting.remember.execute({ content: "unsafe" }, {})).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    const boundary = createTaskMemoryTools(
      service,
      {
        bank: "project-1",
        tags: Array.from({ length: 14 }, (_, index) => `stream:boundary-${index}`),
      },
      context,
    );
    await boundary.remember.execute(
      {
        content: "exactly sixteen final tags",
        tags: ["source:reflection"],
      },
      {},
    );
    expect(retains.at(-1).tags).toHaveLength(16);
    expect(retains.at(-1).tags).toContain("scope:main");

    const configuredOverflow = createTaskMemoryTools(
      service,
      {
        bank: "project-1",
        tags: Array.from({ length: 16 }, (_, index) => `stream:overflow-${index}`),
      },
      context,
    );
    await expect(configuredOverflow.remember.execute({ content: "derived scope overflows" }, {})).rejects.toMatchObject(
      { code: "INVALID_INPUT" },
    );

    const mergedOverflow = createTaskMemoryTools(
      service,
      {
        bank: "project-1",
        tags: Array.from({ length: 15 }, (_, index) => `stream:merged-${index}`),
      },
      context,
    );
    await expect(
      mergedOverflow.remember.execute(
        {
          content: "tool source and scope overflow",
          tags: ["source:reflection"],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("caps high-token-density prompt blocks and recall tool results", async () => {
    const dense = "🔥".repeat(500);
    const service = {
      recallMemory: async () => [{ bank: "project-1", text: dense }],
      getPrimers: async () => [{ bank: "project-1", id: "primer", content: dense }],
      retainMemory: async () => {},
    };
    const context = {
      runId: "dense-run",
      nodeId: "dense-task",
      iteration: 0,
      taskSignal: new AbortController().signal,
    };
    const block = await buildMemoryPromptBlock(
      service,
      {
        bank: "project-1",
        recall: "auto",
        primers: ["primer"],
        maxTokens: 128,
      },
      "dense context",
      context,
    );
    expect(block).toStartWith("<smithers_memory_context>");
    expect(block).toEndWith("</smithers_memory_context>");
    expect(new TextEncoder().encode(block).byteLength).toBeLessThanOrEqual(128);

    const tools = createTaskMemoryTools(
      service,
      {
        bank: "project-1",
        maxTokens: 96,
      },
      context,
    );
    const toolResult = await tools.recall.execute({ query: "dense" }, {});
    expect(new TextEncoder().encode(JSON.stringify(toolResult)).byteLength).toBeLessThanOrEqual(96);
  });

  test("defensively caps non-finite descriptor limits", async () => {
    const dense = "x".repeat(12_000);
    const service = {
      recallMemory: async () => [{ bank: "project-1", text: dense }],
      getPrimers: async () => [],
      retainMemory: async () => {},
    };
    const context = {
      runId: "invalid-limit-run",
      nodeId: "invalid-limit-task",
      iteration: 0,
      taskSignal: new AbortController().signal,
    };
    for (const maxTokens of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const block = await buildMemoryPromptBlock(
        service,
        {
          bank: "project-1",
          recall: "auto",
          maxTokens,
        },
        "dense context",
        context,
      );
      expect(new TextEncoder().encode(block).byteLength).toBeLessThanOrEqual(2048);
    }
  });

  test("prepends a fenced snapshot, registers tools, and retains successful output", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({ answer: outputSchema });
    const recalls = [];
    const retains = [];
    const memoryService = {
      recallMemory: async (input) => {
        recalls.push(input);
        return [{ bank: "project-7", text: "Use the blue deployment lane." }];
      },
      getPrimers: async () => [
        {
          bank: "project-7",
          id: "project-primer",
          content: "# Project primer\nPostgres is canonical.",
        },
      ],
      retainMemory: async (input) => {
        retains.push(input);
      },
    };
    let call;
    const agent = {
      id: "memory-agent",
      supportsNativeStructuredOutput: true,
      tools: { existing: { description: "existing" } },
      generate: async (args) => {
        call = args;
        await args.tools.remember.execute({ content: "The rollback lane is green." }, {});
        await args.tools.recall.execute({ query: "rollback lane" }, {});
        return {
          output: { value: 7 },
          text: JSON.stringify({ value: 7 }),
          response: { messages: [] },
        };
      },
    };
    const workflow = smithers(() => (
      <Workflow name="memory-runtime">
        <Task
          id="answer"
          output={outputs.answer}
          agent={agent}
          memory={{
            bank: "project-7",
            tags: ["scope:main", "branch:main"],
            recall: "auto",
            budget: "high",
            maxTokens: 512,
            primers: ["project-primer"],
            retain: "on-complete",
            tools: true,
          }}
        >
          Plan the deployment.
        </Task>
      </Workflow>
    ));
    workflow.memoryService = memoryService;

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "memory-run-1" }));
    expect(result.status).toBe("finished");
    expect(call.prompt).toStartWith("<smithers_memory_context>");
    expect(call.prompt).toContain("# Project primer\nPostgres is canonical.");
    expect(call.prompt).toContain("Use the blue deployment lane.");
    expect(call.prompt.indexOf("</smithers_memory_context>")).toBeLessThan(call.prompt.indexOf("Plan the deployment."));
    expect(Object.keys(call.tools).sort()).toEqual(["existing", "recall", "remember"]);
    expect(recalls).toHaveLength(2);
    expect(recalls[0]).toMatchObject({
      banks: ["project-7"],
      query: "Plan the deployment.",
      budget: "high",
      maxTokens: 512,
      tagGroupsByBank: {
        "project-7": [
          {
            or: [
              { tags: ["scope:main"], match: "all_strict" },
              { tags: ["branch:main"], match: "all_strict" },
            ],
          },
        ],
      },
    });

    await Bun.sleep(0);
    expect(retains).toHaveLength(2);
    expect(retains[0]).toMatchObject({
      bank: "project-7",
      content: "The rollback lane is green.",
      tags: ["scope:main", "branch:main"],
      metadata: {
        session: "memory-run-1",
        run: "memory-run-1",
        node: "answer",
        iteration: "0",
      },
      documentId: "smithers-run-memory-run-1",
      updateMode: "append",
      async: false,
    });
    expect(retains[1]).toMatchObject({
      bank: "project-7",
      tags: ["scope:main", "branch:main", "source:run"],
      metadata: {
        session: "memory-run-1",
        run: "memory-run-1",
        node: "answer",
        iteration: "0",
      },
      documentId: "smithers-run-memory-run-1",
      updateMode: "append",
      async: true,
    });
    expect(retains[1].content).toContain('"value": 7');
    cleanup();
  }, 15_000);

  test("scopes multi-bank recall independently and preserves base scope in tools", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({ answer: outputSchema });
    const recalls = [];
    const retains = [];
    const memoryService = {
      recallMemory: async (input) => {
        recalls.push(input);
        return [];
      },
      getPrimers: async () => [
        { bank: "user-3", id: "user-primer", content: "Prefer terse reports." },
        { bank: "project-7", id: "project-primer", content: "Main is deployable." },
      ],
      retainMemory: async (input) => {
        retains.push(input);
      },
    };
    let prompt = "";
    const agent = {
      id: "multi-bank-memory-agent",
      supportsNativeStructuredOutput: true,
      generate: async (args) => {
        prompt = args.prompt;
        await args.tools.recall.execute(
          {
            query: "deployment evidence",
            tags: ["source:run"],
          },
          {},
        );
        await args.tools.remember.execute(
          {
            bank: "user-3",
            content: "The user prefers terse reports.",
          },
          {},
        );
        return {
          output: { value: 8 },
          text: '{"value":8}',
          response: { messages: [] },
        };
      },
    };
    const workflow = smithers(() => (
      <Workflow name="multi-bank-memory-runtime">
        <Task
          id="answer"
          output={outputs.answer}
          agent={agent}
          memory={{
            banks: ["user-3", "project-7"],
            tags: ["branch:feature", "stream:checkout"],
            recall: "auto",
            primers: ["user-primer", "project-primer"],
            tools: true,
          }}
        >
          Plan the feature deployment.
        </Task>
      </Workflow>
    ));
    workflow.memoryService = memoryService;

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "memory-run-2" }));
    expect(result.status).toBe("finished");
    expect(prompt).toContain("Prefer terse reports.");
    expect(prompt).toContain("Main is deployable.");
    expect(recalls).toHaveLength(2);
    expect(recalls[0].tagGroupsByBank).toEqual({
      "project-7": [
        {
          or: [
            { tags: ["scope:main"], match: "all_strict" },
            { tags: ["branch:feature"], match: "all_strict" },
          ],
        },
        { tags: ["stream:checkout"], match: "all_strict" },
      ],
    });
    expect(recalls[1].tagGroupsByBank).toEqual({
      "user-3": [{ tags: ["source:run"], match: "all_strict" }],
      "project-7": [
        {
          or: [
            { tags: ["scope:main"], match: "all_strict" },
            { tags: ["branch:feature"], match: "all_strict" },
          ],
        },
        { tags: ["stream:checkout"], match: "all_strict" },
        { tags: ["source:run"], match: "all_strict" },
      ],
    });
    expect(retains).toHaveLength(1);
    expect(retains[0]).toMatchObject({
      bank: "user-3",
      content: "The user prefers terse reports.",
      tags: [],
      metadata: {
        session: "memory-run-2",
        run: "memory-run-2",
        node: "answer",
      },
    });
    cleanup();
  }, 15_000);

  test("a memory timeout logs and runs with the original prompt", async () => {
    process.env.SMITHERS_MEMORY_TIMEOUT_MS = "10";
    const { smithers, outputs, cleanup } = createTestSmithers({ answer: outputSchema });
    const memoryService = {
      recallMemory: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      getPrimers: async () => [],
      retainMemory: async () => {},
    };
    let prompt = "";
    const agent = {
      id: "memory-timeout-agent",
      supportsNativeStructuredOutput: true,
      generate: async (args) => {
        prompt = args.prompt;
        return { output: { value: 9 }, text: '{"value":9}', response: { messages: [] } };
      },
    };
    const workflow = smithers(() => (
      <Workflow name="memory-timeout">
        <Task
          id="answer"
          output={outputs.answer}
          agent={agent}
          memory={{ bank: "project-7", recall: "auto", maxTokens: 256 }}
        >
          Continue without memory.
        </Task>
      </Workflow>
    ));
    workflow.memoryService = memoryService;

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    expect(prompt).toContain("Continue without memory.");
    expect(prompt).not.toContain("<smithers_memory_context>");
    cleanup();
  }, 15_000);

  test("a synchronous retention failure cannot fail task completion", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({ answer: outputSchema });
    const memoryService = {
      recallMemory: async () => [],
      getPrimers: async () => [],
      retainMemory: () => {
        throw new Error("retention unavailable");
      },
    };
    const agent = {
      id: "memory-retain-failure-agent",
      supportsNativeStructuredOutput: true,
      generate: async () => ({
        output: { value: 11 },
        text: '{"value":11}',
        response: { messages: [] },
      }),
    };
    const workflow = smithers(() => (
      <Workflow name="memory-retain-failure">
        <Task
          id="answer"
          output={outputs.answer}
          agent={agent}
          memory={{ bank: "project-7", recall: false, retain: "on-complete" }}
        >
          Finish even when retention is down.
        </Task>
      </Workflow>
    ));
    workflow.memoryService = memoryService;

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    await Bun.sleep(0);
    cleanup();
  }, 15_000);

  test("memory-configured tasks bypass stale task-output cache entries", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({ answer: outputSchema });
    let agentCalls = 0;
    const recalls = [];
    const retains = [];
    const memoryService = {
      recallMemory: async (input) => {
        recalls.push(input);
        return [{ bank: "project-7", text: `memory snapshot ${recalls.length}` }];
      },
      getPrimers: async () => [],
      retainMemory: async (input) => retains.push(input),
    };
    const agent = {
      id: "memory-cache-agent",
      supportsNativeStructuredOutput: true,
      generate: async () => {
        agentCalls += 1;
        return {
          output: { value: agentCalls },
          text: JSON.stringify({ value: agentCalls }),
          response: { messages: [] },
        };
      },
    };
    const workflow = smithers(() => (
      <Workflow name="memory-cache-freshness">
        <Task
          id="answer"
          output={outputs.answer}
          agent={agent}
          cache={{ scope: "workflow", key: "memory-cache" }}
          memory={{
            bank: "project-7",
            recall: "auto",
            retain: "on-complete",
          }}
        >
          Use the latest project memory.
        </Task>
      </Workflow>
    ));
    workflow.memoryService = memoryService;

    await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "memory-cache-run-1" }));
    await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "memory-cache-run-2" }));
    await Bun.sleep(0);

    expect(agentCalls).toBe(2);
    expect(recalls).toHaveLength(2);
    expect(retains).toHaveLength(2);
    cleanup();
  }, 15_000);

  test("legacy-only memory metadata preserves task-output cache semantics", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({ answer: outputSchema });
    let agentCalls = 0;
    const agent = {
      id: "legacy-memory-cache-agent",
      supportsNativeStructuredOutput: true,
      generate: async () => {
        agentCalls += 1;
        return {
          output: { value: agentCalls },
          text: JSON.stringify({ value: agentCalls }),
          response: { messages: [] },
        };
      },
    };
    const namespace = { kind: "workflow", id: "legacy-memory-cache" };
    const workflow = smithers(() => (
      <Workflow name="legacy-memory-cache-semantics">
        <Task
          id="answer"
          output={outputs.answer}
          agent={agent}
          cache={{ scope: "workflow", key: "legacy-memory-cache" }}
          memory={{
            namespace,
            recall: { namespace, query: "ignored legacy recall", topK: 3 },
            remember: { namespace, key: "ignored-legacy-output" },
            threadId: "ignored-legacy-thread",
          }}
        >
          Preserve the existing cache contract.
        </Task>
      </Workflow>
    ));

    await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "legacy-memory-cache-run-1" }));
    await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "legacy-memory-cache-run-2" }));

    expect(agentCalls).toBe(1);
    cleanup();
  }, 15_000);
});
