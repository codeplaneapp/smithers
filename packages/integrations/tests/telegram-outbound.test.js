// Outbound components as durable compute Tasks, executed by the REAL engine
// (runWorkflow) against the real fixture Bot API server — no agent CLIs, so
// CI-safe.
//
// Also proves the deps ↔ Task interaction this package relies on: Task's own
// `deps` + function-children path defers callback execution to the durable
// compute bridge, matching the outbound components' execution semantics.
import { afterAll, describe, expect, test } from "bun:test";
import React from "react";
import { z } from "zod";
import { Effect } from "effect";
import { createSmithers, renderFrame, runWorkflow } from "smthrs";
import { SmithersCtx } from "@smthrs/react-reconciler/context";
import { Task } from "@smthrs/components";
import { SendMessage, TelegramSendResultSchema } from "../src/telegram/components/SendMessage.js";
import { configureTelegram } from "../src/telegram/config.js";
import { startTelegramFixture } from "./telegram-fixture.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempDirPath } from "../../testing/src/cleanup/tempDir.ts";

const fixture = startTelegramFixture();
afterAll(() => {
  fixture.stop();
  configureTelegram(null);
});
const telegramConfig = { botToken: fixture.token, apiBaseUrl: fixture.apiBaseUrl };

// Allocated once, at module scope. `makeTempDirPath` re-arms its `bun:test`
// drain hook whenever the registry is empty, so a per-test allocation
// registers a hook from inside every test — the mid-test registration that
// intermittently stalls a test for the full 5s timeout. See the longer note
// in github-components.test.jsx.
const apiRoot = makeTempDirPath("smithers-telegram-");
let apiCount = 0;

function makeApi() {
  const dir = join(apiRoot, `api-${(apiCount += 1)}`);
  mkdirSync(dir, { recursive: true });
  return createSmithers(
    {
      note: z.object({ text: z.string() }),
      sent: TelegramSendResultSchema,
    },
    { dbPath: join(dir, "db.sqlite") },
  );
}

describe("Task deps interaction (the reason SendMessage resolves deps itself)", () => {
  test("raw Task with deps + function children defers callback execution to compute", async () => {
    const api = makeApi();
    let calls = 0;
    const workflow = api.smithers(() =>
      React.createElement(
        api.Workflow,
        { name: "kind-proof" },
        React.createElement(Task, {
          id: "probe",
          smithersContext: undefined,
          output: api.outputs.note,
          deps: { note: api.outputs.note },
          children: (deps) => {
            calls += 1;
            return { text: deps.note.text };
          },
        }),
      ),
    );
    const frame = await Effect.runPromise(
      renderFrame(
        workflow,
        new SmithersCtx({
          runId: "kind-proof",
          iteration: 0,
          input: {},
          outputs: { note: [{ runId: "kind-proof", nodeId: "note", iteration: 0, text: "ready" }] },
          zodToKeyName: workflow.zodToKeyName,
        }),
      ),
    );
    const probe = frame.tasks.find((task) => task.nodeId === "probe");
    expect(probe).toBeDefined();
    expect(probe?.kind).toBe("compute");
    expect(probe?.staticPayload).toBeUndefined();
    expect(calls).toBe(0);
    expect(probe?.computeFn()).toEqual({ text: "ready" });
    expect(calls).toBe(1);
  });
  test("SendMessage defers while deps are missing, then renders a compute task", async () => {
    const api = makeApi();
    const workflow = api.smithers(() =>
      React.createElement(
        api.Workflow,
        { name: "send-kind" },
        React.createElement(SendMessage, {
          id: "send",
          chatId: 777,
          config: telegramConfig,
          deps: { note: api.outputs.note },
          output: api.outputs.sent,
          children: (deps) => `Reply: ${/** @type {any} */ (deps.note).text}`,
        }),
      ),
    );
    const before = await Effect.runPromise(
      renderFrame(
        workflow,
        new SmithersCtx({
          runId: "send-kind-before",
          iteration: 0,
          input: {},
          outputs: {},
          zodToKeyName: workflow.zodToKeyName,
        }),
      ),
    );
    expect(before.tasks.find((task) => task.nodeId === "send")).toBeUndefined();
    const after = await Effect.runPromise(
      renderFrame(
        workflow,
        new SmithersCtx({
          runId: "send-kind-after",
          iteration: 0,
          input: {},
          outputs: { note: [{ runId: "send-kind-after", nodeId: "note", iteration: 0, text: "ready" }] },
          zodToKeyName: workflow.zodToKeyName,
        }),
      ),
    );
    const send = after.tasks.find((task) => task.nodeId === "send");
    expect(send).toBeDefined();
    expect(send?.kind).toBe("compute");
    expect(typeof send?.computeFn).toBe("function");
    expect(send?.dependsOn).toEqual(["note"]);
  });
});

describe("SendMessage through the real engine against the fixture", () => {
  test("builds text from deps, sends typing then chunked messages in order", async () => {
    const api = makeApi();
    // Two paragraphs whose sum exceeds 4096 → exactly two chunks.
    const paragraphA = `alpha ${"a".repeat(2400)}`;
    const paragraphB = `omega ${"b".repeat(2400)}`;
    const workflow = api.smithers(() =>
      React.createElement(
        api.Workflow,
        { name: "telegram-send" },
        React.createElement(api.Task, {
          id: "note",
          output: api.outputs.note,
          children: { text: `${paragraphA}\n\n${paragraphB}` },
        }),
        React.createElement(SendMessage, {
          id: "send",
          chatId: 777,
          config: telegramConfig,
          parseMode: "none",
          replyToMessageId: 12,
          deps: { note: api.outputs.note },
          output: api.outputs.sent,
          children: (deps) => /** @type {any} */ (deps.note).text,
        }),
      ),
    );
    const before = fixture.requests.length;
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    const sequence = fixture.requests.slice(before);
    expect(sequence.map((entry) => entry.method)).toEqual(["sendChatAction", "sendMessage", "sendMessage"]);
    expect(sequence[0].body).toMatchObject({ chat_id: 777, action: "typing" });
    expect(sequence[1].body.text.startsWith("alpha ")).toBe(true);
    expect(sequence[1].body.reply_to_message_id).toBe(12);
    expect(sequence[2].body.text.startsWith("omega ")).toBe(true);
    expect(sequence[2].body.reply_to_message_id).toBeUndefined();
    // The compute result landed as the task's validated output row.
    const rows = api.db.select().from(api.tables.sent).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].chunkCount).toBe(2);
    expect(rows[0].chatId).toBe("777");
  }, 20_000);
  test("uses configureTelegram registry when no config prop is given", async () => {
    configureTelegram(telegramConfig);
    try {
      const api = makeApi();
      const workflow = api.smithers(() =>
        React.createElement(
          api.Workflow,
          { name: "telegram-registry" },
          React.createElement(SendMessage, {
            id: "send",
            chatId: 42,
            text: "from the registry",
            parseMode: "none",
            typing: false,
            output: api.outputs.sent,
          }),
        ),
      );
      const before = fixture.calls("sendMessage").length;
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      const sends = fixture.calls("sendMessage").slice(before);
      expect(sends).toHaveLength(1);
      expect(sends[0].body).toMatchObject({ chat_id: 42, text: "from the registry" });
    } finally {
      configureTelegram(null);
    }
  }, 20_000);
});
