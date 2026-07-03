// Telegram in-app approvals. Pure-logic units for the callback_data codec /
// keyboard / decision mapping, plus full durable round-trips driven by the REAL
// engine against the real fixture Bot API server: post prompt → park on the
// button press → signal a callback_query → resume → answer + edit + decision.
// No mocks.
import { afterAll, describe, expect, test } from "bun:test";
import React from "react";
import { Effect } from "effect";
import { createSmithers, runWorkflow, signalRun } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import {
  TelegramApproval,
  approvalInlineKeyboard,
  parseTelegramApprovalCallbackData,
  telegramApprovalCallbackData,
  telegramApprovalDecision,
  telegramApprovalDecisionSchema,
  telegramApprovalSchemas,
  telegramApprovalSelectionSchema,
  webAppButton,
} from "../src/telegram.js";
import { makeTelegramClient } from "../src/telegram/TelegramClient.js";
import { TELEGRAM_CALLBACK_QUERY_EVENT } from "../src/telegram/TelegramSource.js";
import { startTelegramFixture } from "./telegram-fixture.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = startTelegramFixture();
afterAll(() => fixture.stop());
const telegramConfig = { botToken: fixture.token, apiBaseUrl: fixture.apiBaseUrl };

function makeApi() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-tg-approval-"));
  return createSmithers({
    ...telegramApprovalSchemas,
    decision: telegramApprovalDecisionSchema,
    selection: telegramApprovalSelectionSchema,
  }, { dbPath: join(dir, "db.sqlite") });
}

/** A delivered callback_query payload as the source would fan it out. */
function callbackQuery(data) {
  return {
    id: "cbq-1",
    from: { id: 7, username: "will" },
    data,
    message: { message_id: 700, date: 1_700_000_000, chat: { id: 777, type: "private" } },
  };
}

describe("callback_data codec", () => {
  test("round-trips approve / reject / select", () => {
    expect(parseTelegramApprovalCallbackData(telegramApprovalCallbackData({ kind: "approve" }))).toEqual({ kind: "approve" });
    expect(parseTelegramApprovalCallbackData(telegramApprovalCallbackData({ kind: "reject" }))).toEqual({ kind: "reject" });
    expect(parseTelegramApprovalCallbackData(telegramApprovalCallbackData({ kind: "select", key: "opt-1" }))).toEqual({ kind: "select", key: "opt-1" });
  });
  test("ignores stray / malformed callback data", () => {
    expect(parseTelegramApprovalCallbackData("something:else")).toBeNull();
    expect(parseTelegramApprovalCallbackData(undefined)).toBeNull();
    expect(parseTelegramApprovalCallbackData("sap:z")).toBeNull();
  });
  test("rejects option keys that would exceed the 64-byte callback_data limit", () => {
    expect(() => telegramApprovalCallbackData({ kind: "select", key: "x".repeat(70) })).toThrow(/64-byte/);
    expect(() => telegramApprovalCallbackData({ kind: "select", key: "a:b" })).toThrow(/no ":"/);
  });
});

describe("approvalInlineKeyboard / webAppButton", () => {
  test("approve mode yields an Approve/Reject row", () => {
    const keyboard = approvalInlineKeyboard({ mode: "approve" });
    expect(keyboard[0].map((b) => b.callback_data)).toEqual(["sap:a", "sap:d"]);
  });
  test("select mode yields one button per option; miniApp adds a web_app row", () => {
    const keyboard = approvalInlineKeyboard({
      mode: "select",
      options: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
      miniAppUrl: "https://approve.example.com",
      miniAppText: "Open",
    });
    expect(keyboard).toHaveLength(3);
    expect(keyboard[0][0]).toMatchObject({ text: "A", callback_data: "sap:s:a" });
    expect(keyboard[2][0]).toMatchObject({ text: "Open", web_app: { url: "https://approve.example.com" } });
  });
  test("web_app buttons require https", () => {
    expect(() => webAppButton("x", "http://insecure.example.com")).toThrow(/https/);
  });
});

describe("telegramApprovalDecision mapping", () => {
  test("approve press → { approved: true, decidedBy, decidedAt }", () => {
    const decision = telegramApprovalDecision(callbackQuery("sap:a"), { mode: "approve" });
    expect(decision).toEqual({
      approved: true,
      note: null,
      decidedBy: "@will",
      decidedAt: new Date(1_700_000_000 * 1000).toISOString(),
    });
  });
  test("reject press → { approved: false }", () => {
    expect(telegramApprovalDecision(callbackQuery("sap:d"), { mode: "approve" }).approved).toBe(false);
  });
  test("select press → { selected }", () => {
    expect(telegramApprovalDecision(callbackQuery("sap:s:b"), { mode: "select" })).toEqual({ selected: "b", notes: null });
  });
  test("stray press in approve mode is a safe non-approval", () => {
    const decision = telegramApprovalDecision(callbackQuery("garbage"), { mode: "approve" });
    expect(decision.approved).toBe(false);
    expect(decision.note).toBe("unrecognized response");
  });
});

describe("TelegramApproval threadId validation", () => {
  const baseProps = { id: "gate", chatId: 777, request: { title: "Deploy?" }, config: telegramConfig };
  test("rejects a non-numeric threadId instead of sending NaN", () => {
    expect(() => TelegramApproval({ ...baseProps, threadId: "general" })).toThrow(/threadId must be numeric/);
  });
  test("accepts a numeric threadId (number or numeric string) and no threadId", () => {
    expect(() => TelegramApproval({ ...baseProps, threadId: 42 })).not.toThrow();
    expect(() => TelegramApproval({ ...baseProps, threadId: "42" })).not.toThrow();
    expect(() => TelegramApproval(baseProps)).not.toThrow();
  });
});

describe("TelegramApproval end-to-end through the real engine", () => {
  async function runApproval({ mode, outputKey, data, options }) {
    const api = makeApi();
    const workflow = api.smithers(() => React.createElement(api.Workflow, { name: "tg-approval" },
      React.createElement(TelegramApproval, {
        id: "gate",
        chatId: 777,
        config: telegramConfig,
        request: { title: "Deploy to prod?", summary: "Ship release 0.27" },
        mode,
        options,
        output: api.outputs[outputKey],
      }),
    ));
    const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(first.status).toBe("waiting-event");

    // The prompt was posted with the inline keyboard on it.
    const send = fixture.calls("sendMessage").at(-1);
    expect(send?.body.reply_markup?.inline_keyboard).toBeTruthy();

    const adapter = new SmithersDb(api.db);
    await Effect.runPromise(signalRun(adapter, first.runId, TELEGRAM_CALLBACK_QUERY_EVENT, callbackQuery(data), {
      correlationId: "chat:777",
      receivedBy: "integration:telegram",
    }));

    const resumed = await Effect.runPromise(runWorkflow(workflow, { runId: first.runId, resume: true, input: {} }));
    expect(resumed.status).toBe("finished");
    return { api };
  }

  test("approve: posts keyboard, waits, answers, edits, yields approved decision", async () => {
    const beforeAnswer = fixture.calls("answerCallbackQuery").length;
    const beforeEdit = fixture.calls("editMessageText").length;
    const { api } = await runApproval({ mode: "approve", outputKey: "decision", data: "sap:a" });
    // The press was acknowledged and the message stamped with the outcome.
    expect(fixture.calls("answerCallbackQuery").length).toBe(beforeAnswer + 1);
    const edit = fixture.calls("editMessageText").slice(beforeEdit).at(-1);
    expect(edit?.body.text).toMatch(/Approved/);
    const rows = api.db.select().from(api.tables.decision).all();
    expect(rows).toHaveLength(1);
    expect(Boolean(rows[0].approved)).toBe(true);
    expect(rows[0].decidedBy).toBe("@will");
  }, 20_000);

  test("reject: yields a rejected decision", async () => {
    const { api } = await runApproval({ mode: "approve", outputKey: "decision", data: "sap:d" });
    const rows = api.db.select().from(api.tables.decision).all();
    expect(Boolean(rows[0].approved)).toBe(false);
  }, 20_000);

  test("select: yields the chosen option key", async () => {
    const { api } = await runApproval({
      mode: "select",
      options: [{ key: "a", label: "Roll forward" }, { key: "b", label: "Roll back" }],
      outputKey: "selection",
      data: "sap:s:b",
    });
    const rows = api.db.select().from(api.tables.selection).all();
    expect(rows[0].selected).toBe("b");
  }, 20_000);
});

describe("answerWebAppQuery", () => {
  test("posts a Mini App inline result and returns the SentWebAppMessage", async () => {
    const client = makeTelegramClient(telegramConfig);
    const before = fixture.calls("answerWebAppQuery").length;
    const result = await Effect.runPromise(client.answerWebAppQuery("wq-1", {
      type: "article",
      id: "1",
      title: "Approved",
      input_message_content: { message_text: "Approved via Mini App" },
    }));
    const calls = fixture.calls("answerWebAppQuery").slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.web_app_query_id).toBe("wq-1");
    expect(result).toMatchObject({ inline_message_id: "iq-wq-1" });
  });
});
