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
  approvalToken,
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

const TOK = "t0";

describe("callback_data codec", () => {
  test("round-trips approve / reject / select with a token", () => {
    expect(parseTelegramApprovalCallbackData(telegramApprovalCallbackData({ kind: "approve" }, TOK))).toEqual({ token: TOK, kind: "approve" });
    expect(parseTelegramApprovalCallbackData(telegramApprovalCallbackData({ kind: "reject" }, TOK))).toEqual({ token: TOK, kind: "reject" });
    expect(parseTelegramApprovalCallbackData(telegramApprovalCallbackData({ kind: "select", key: "opt-1" }, TOK))).toEqual({ token: TOK, kind: "select", key: "opt-1" });
  });
  test("ignores stray / malformed callback data", () => {
    expect(parseTelegramApprovalCallbackData("something:else")).toBeNull();
    expect(parseTelegramApprovalCallbackData(undefined)).toBeNull();
    expect(parseTelegramApprovalCallbackData(`sap:${TOK}:z`)).toBeNull();
  });
  test("rejects option keys that would exceed the 64-byte callback_data limit", () => {
    expect(() => telegramApprovalCallbackData({ kind: "select", key: "x".repeat(70) }, TOK)).toThrow(/64-byte/);
    expect(() => telegramApprovalCallbackData({ kind: "select", key: "a:b" }, TOK)).toThrow(/no ":"/);
  });
  test("approvalToken is deterministic, colon-free, and differs by id", () => {
    expect(approvalToken("gate")).toBe(approvalToken("gate"));
    expect(approvalToken("gate")).not.toContain(":");
    expect(approvalToken("gate")).not.toBe(approvalToken("other"));
  });
});

describe("approvalInlineKeyboard / webAppButton", () => {
  test("approve mode yields an Approve/Reject row", () => {
    const keyboard = approvalInlineKeyboard({ mode: "approve", token: TOK });
    expect(keyboard[0].map((b) => b.callback_data)).toEqual([`sap:${TOK}:a`, `sap:${TOK}:d`]);
  });
  test("select mode yields one button per option; miniApp adds a web_app row", () => {
    const keyboard = approvalInlineKeyboard({
      mode: "select",
      token: TOK,
      options: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
      miniAppUrl: "https://approve.example.com",
      miniAppText: "Open",
    });
    expect(keyboard).toHaveLength(3);
    expect(keyboard[0][0]).toMatchObject({ text: "A", callback_data: `sap:${TOK}:s:a` });
    expect(keyboard[2][0]).toMatchObject({ text: "Open", web_app: { url: "https://approve.example.com" } });
  });
  test("web_app buttons require https", () => {
    expect(() => webAppButton("x", "http://insecure.example.com")).toThrow(/https/);
  });
});

describe("telegramApprovalDecision mapping", () => {
  test("approve press uses resolution time instead of the prompt's message date", () => {
    const realNow = Date.now;
    Date.now = () => 1_700_003_600_000;
    try {
      const decision = telegramApprovalDecision(callbackQuery(`sap:${TOK}:a`), { mode: "approve", token: TOK });
      expect(decision).toEqual({
        approved: true,
        note: null,
        decidedBy: "@will",
        decidedAt: new Date(1_700_003_600_000).toISOString(),
      });

      const inaccessibleMessage = callbackQuery(`sap:${TOK}:a`);
      inaccessibleMessage.message.date = 0;
      expect(telegramApprovalDecision(inaccessibleMessage, { mode: "approve", token: TOK }).decidedAt).toBe(
        new Date(1_700_003_600_000).toISOString(),
      );
    } finally {
      Date.now = realNow;
    }
  });
  test("reject press → { approved: false }", () => {
    expect(telegramApprovalDecision(callbackQuery(`sap:${TOK}:d`), { mode: "approve", token: TOK }).approved).toBe(false);
  });
  test("select press → { selected }", () => {
    expect(telegramApprovalDecision(callbackQuery(`sap:${TOK}:s:b`), { mode: "select", token: TOK, options: [{ key: "b", label: "B" }] })).toEqual({ selected: "b", notes: null });
  });
  test("foreign-token approve press fails safe (never approves)", () => {
    const decision = telegramApprovalDecision(callbackQuery("sap:OTHER:a"), { mode: "approve", token: TOK });
    expect(decision.approved).toBe(false);
    expect(decision.note).toMatch(/did not match/);
  });
  test("select press with an unoffered key → empty selection", () => {
    expect(telegramApprovalDecision(callbackQuery(`sap:${TOK}:s:zzz`), { mode: "select", token: TOK, options: [{ key: "b", label: "B" }] }).selected).toBe("");
  });
  test("stray press in approve mode is a safe non-approval", () => {
    const decision = telegramApprovalDecision(callbackQuery("garbage"), { mode: "approve", token: TOK });
    expect(decision.approved).toBe(false);
    expect(decision.note).toMatch(/did not match/);
  });
});

describe("TelegramApproval end-to-end through the real engine", () => {
  // Build callback_data with the gate node's own token so the press is treated
  // as this approval's own; pass `rawData` to simulate a foreign/stale press.
  const gateData = (choice) => telegramApprovalCallbackData(choice, approvalToken("gate"));

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
    const { api } = await runApproval({ mode: "approve", outputKey: "decision", data: gateData({ kind: "approve" }) });
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
    const { api } = await runApproval({ mode: "approve", outputKey: "decision", data: gateData({ kind: "reject" }) });
    const rows = api.db.select().from(api.tables.decision).all();
    expect(Boolean(rows[0].approved)).toBe(false);
  }, 20_000);

  test("select: yields the chosen option key", async () => {
    const { api } = await runApproval({
      mode: "select",
      options: [{ key: "a", label: "Roll forward" }, { key: "b", label: "Roll back" }],
      outputKey: "selection",
      data: gateData({ kind: "select", key: "b" }),
    });
    const rows = api.db.select().from(api.tables.selection).all();
    expect(rows[0].selected).toBe("b");
  }, 20_000);

  test("a foreign-token press never approves and never answers/edits", async () => {
    const beforeAnswer = fixture.calls("answerCallbackQuery").length;
    const beforeEdit = fixture.calls("editMessageText").length;
    // A stale press from a DIFFERENT prompt in the same chat (wrong token).
    const { api } = await runApproval({ mode: "approve", outputKey: "decision", data: "sap:OTHER:a" });
    const rows = api.db.select().from(api.tables.decision).all();
    expect(Boolean(rows[0].approved)).toBe(false);
    expect(rows[0].note).toMatch(/did not match/);
    // The foreign callback query was neither acknowledged nor its message edited.
    expect(fixture.calls("answerCallbackQuery").length).toBe(beforeAnswer);
    expect(fixture.calls("editMessageText").length).toBe(beforeEdit);
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
