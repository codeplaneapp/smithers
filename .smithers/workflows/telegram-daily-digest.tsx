// smithers-source: authored
// smithers-metadata-version: 1
// smithers-display-name: Telegram Daily Digest
// smithers-description: Summarize a Telegram group transcript or bot update queue, write a daily digest, and optionally post it back to Telegram.
// smithers-tags: telegram, digest, cron, community
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const DEFAULT_STATE_PATH = ".smithers/state/telegram-daily-digest/state.json";
const DEFAULT_REPORT_PATH = ".smithers/state/telegram-daily-digest/latest.md";
const DEFAULT_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";
const DEFAULT_OUTPUT_CHAT_ENV = "TELEGRAM_DIGEST_OUTPUT_CHAT_ID";
const DEFAULT_SOURCE_CHAT_ENV = "TELEGRAM_DIGEST_SOURCE_CHAT_ID";
const DEFAULT_DRY_RUN_ENV = "TELEGRAM_DIGEST_DRY_RUN";
const DEFAULT_POST_ENV = "TELEGRAM_DIGEST_POST_TO_TELEGRAM";
const DEFAULT_KIMI_KEY_ENV = "MOONSHOT_API_KEY";
const DEFAULT_KIMI_MODEL_ENV = "KIMI_MODEL";
const DEFAULT_KIMI_MODEL = "kimi-k2.6";
const MOONSHOT_CHAT_COMPLETIONS_URL = "https://api.moonshot.ai/v1/chat/completions";
const TELEGRAM_SEND_LIMIT = 3800;

const sourceSchema = z.enum(["auto", "telegramBotApi", "jsonFile", "text"]);

const inputSchema = z.object({
  source: sourceSchema
    .nullable()
    .default(null)
    .describe("Where to read messages from. Null/auto prefers transcript, then messagesPath, then Telegram Bot API."),
  transcript: z
    .string()
    .nullable()
    .default(null)
    .describe("Pasted Telegram transcript text. Useful for manual runs and testing."),
  messagesPath: z
    .string()
    .nullable()
    .default(null)
    .describe("Path to a Telegram Desktop JSON export, Bot API updates JSON, plain text transcript, or JSONL message log."),
  sinceHours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .nullable()
    .default(null)
    .describe("Only include messages newer than this many hours when timestamps are available."),
  maxMessages: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .nullable()
    .default(null)
    .describe("Maximum messages to summarize after filtering."),
  maxPromptChars: z
    .number()
    .int()
    .min(4000)
    .max(200000)
    .nullable()
    .default(null)
    .describe("Maximum transcript characters sent to the summarizer."),
  topicHint: z
    .string()
    .nullable()
    .default(null)
    .describe("Optional context about what the group cares about."),
  kimiApiKeyEnv: z
    .string()
    .nullable()
    .default(null)
    .describe(`Environment variable containing the Kimi/Moonshot API key. Defaults to ${DEFAULT_KIMI_KEY_ENV}.`),
  kimiModel: z
    .string()
    .nullable()
    .default(null)
    .describe(`Kimi model id. Defaults to ${DEFAULT_KIMI_MODEL_ENV}, then ${DEFAULT_KIMI_MODEL}.`),
  sourceChatId: z
    .string()
    .nullable()
    .default(null)
    .describe(`Only summarize this Telegram chat id or @username. Defaults to ${DEFAULT_SOURCE_CHAT_ENV}.`),
  telegramBotTokenEnv: z
    .string()
    .nullable()
    .default(null)
    .describe(`Environment variable containing the Telegram bot token. Defaults to ${DEFAULT_TOKEN_ENV}.`),
  statePath: z
    .string()
    .nullable()
    .default(null)
    .describe("Ignored local JSON ledger used for Telegram update offsets."),
  reportPath: z
    .string()
    .nullable()
    .default(null)
    .describe("Where to write the latest markdown digest. Defaults under ignored .smithers/state."),
  dryRun: z
    .boolean()
    .nullable()
    .default(null)
    .describe(`Do not post or acknowledge updates. Defaults to ${DEFAULT_DRY_RUN_ENV}, then true.`),
  postToTelegram: z
    .boolean()
    .nullable()
    .default(null)
    .describe(`Post the digest with sendMessage when not dry-run. Defaults to ${DEFAULT_POST_ENV}, then false.`),
  outputChatId: z
    .string()
    .nullable()
    .default(null)
    .describe(`Chat id or @username that receives the digest. Defaults to ${DEFAULT_OUTPUT_CHAT_ENV}.`),
  outputMessageThreadId: z
    .number()
    .int()
    .nullable()
    .default(null)
    .describe("Optional Telegram forum topic/thread id for the digest message."),
  acknowledge: z
    .boolean()
    .nullable()
    .default(null)
    .describe("Advance the local Telegram offset after a successful run. Defaults to !dryRun."),
});

const messageSchema = z.object({
  id: z.string(),
  at: z.string().nullable().default(null),
  author: z.string(),
  text: z.string(),
  chatId: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
});

const collectSchema = z.object({
  source: z.enum(["telegramBotApi", "jsonFile", "text", "none"]),
  messageCount: z.number().int(),
  from: z.string().nullable().default(null),
  to: z.string().nullable().default(null),
  messages: z.array(messageSchema).default([]),
  nextUpdateId: z.number().int().nullable().default(null),
  warnings: z.array(z.string()).default([]),
});

const digestSchema = z.object({
  headline: z.string(),
  range: z.string(),
  summary: z.string(),
  topics: z
    .array(
      z.object({
        title: z.string(),
        summary: z.string(),
        whyItMatters: z.string().default(""),
        keyPoints: z.array(z.string()).default([]),
        representativeMessages: z.array(z.string()).default([]),
        participants: z.array(z.string()).default([]),
        followUps: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  notableLinks: z
    .array(z.object({ label: z.string(), url: z.string(), context: z.string().default("") }))
    .default([]),
  actionItems: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  caveats: z.array(z.string()).default([]),
});

const reportSchema = z.object({
  markdown: z.string(),
  telegramText: z.string(),
  reportPath: z.string().nullable().default(null),
  written: z.boolean(),
  bytes: z.number().int().default(0),
});

const publishSchema = z.object({
  attempted: z.boolean(),
  sent: z.boolean(),
  dryRun: z.boolean(),
  chatId: z.string().nullable().default(null),
  chunks: z.number().int().default(0),
  messageIds: z.array(z.number().int()).default([]),
  note: z.string(),
});

const ackSchema = z.object({
  acknowledged: z.boolean(),
  lastUpdateId: z.number().int().nullable().default(null),
  statePath: z.string(),
  note: z.string(),
});

const outputSchema = z.object({
  status: z.enum(["dry-run", "posted", "ready", "empty", "publish-failed"]),
  source: z.string(),
  messageCount: z.number().int(),
  range: z.string(),
  reportPath: z.string().nullable().default(null),
  posted: z.boolean(),
  acknowledged: z.boolean(),
  summary: z.string(),
  topics: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});

type Input = z.infer<typeof inputSchema>;
type DigestMessage = z.infer<typeof messageSchema>;
type CollectOutput = z.infer<typeof collectSchema>;
type DigestOutput = z.infer<typeof digestSchema>;
type ReportOutput = z.infer<typeof reportSchema>;
type PublishOutput = z.infer<typeof publishSchema>;

type NormalizedInput = {
  source: z.infer<typeof sourceSchema>;
  transcript: string | null;
  messagesPath: string | null;
  sinceHours: number;
  maxMessages: number;
  maxPromptChars: number;
  topicHint: string | null;
  kimiApiKeyEnv: string;
  kimiModel: string;
  sourceChatId: string | null;
  telegramBotTokenEnv: string;
  statePath: string;
  reportPath: string;
  dryRun: boolean;
  postToTelegram: boolean;
  outputChatId: string | null;
  outputMessageThreadId: number | null;
  acknowledge: boolean;
};

type TelegramState = {
  lastUpdateId?: number;
  lastRunAtMs?: number;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

type KimiChatResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: { message?: string };
};

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  collect: collectSchema,
  digest: digestSchema,
  report: reportSchema,
  publish: publishSchema,
  ack: ackSchema,
  output: outputSchema,
});

function envString(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function envBoolean(name: string): boolean | null {
  const value = envString(name)?.toLowerCase();
  if (!value) return null;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
}

function normalizeInput(input: Input): NormalizedInput {
  const dryRun = input.dryRun ?? envBoolean(DEFAULT_DRY_RUN_ENV) ?? true;
  const sourceChatId = input.sourceChatId ?? envString(DEFAULT_SOURCE_CHAT_ENV);
  return {
    source: input.source ?? "auto",
    transcript: input.transcript?.trim() ? input.transcript : null,
    messagesPath: input.messagesPath?.trim() ? input.messagesPath : envString("TELEGRAM_DIGEST_MESSAGES_PATH"),
    sinceHours: input.sinceHours ?? 24,
    maxMessages: input.maxMessages ?? 500,
    maxPromptChars: input.maxPromptChars ?? 60000,
    topicHint: input.topicHint?.trim() ? input.topicHint.trim() : null,
    kimiApiKeyEnv: input.kimiApiKeyEnv?.trim() || DEFAULT_KIMI_KEY_ENV,
    kimiModel: input.kimiModel?.trim() || envString(DEFAULT_KIMI_MODEL_ENV) || DEFAULT_KIMI_MODEL,
    sourceChatId,
    telegramBotTokenEnv: input.telegramBotTokenEnv?.trim() || DEFAULT_TOKEN_ENV,
    statePath: input.statePath?.trim() || DEFAULT_STATE_PATH,
    reportPath: input.reportPath?.trim() || DEFAULT_REPORT_PATH,
    dryRun,
    postToTelegram: input.postToTelegram ?? envBoolean(DEFAULT_POST_ENV) ?? false,
    outputChatId: input.outputChatId ?? envString(DEFAULT_OUTPUT_CHAT_ENV) ?? sourceChatId,
    outputMessageThreadId: input.outputMessageThreadId ?? null,
    acknowledge: input.acknowledge ?? !dryRun,
  };
}

function pendingPathFor(statePath: string): string {
  return statePath.endsWith(".json") ? statePath.replace(/\.json$/, ".pending.json") : `${statePath}.pending.json`;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readState(path: string): TelegramState {
  if (!existsSync(path)) return {};
  try {
    const parsed = readJsonFile(path);
    if (!isRecord(parsed)) return {};
    return {
      lastUpdateId: typeof parsed.lastUpdateId === "number" ? parsed.lastUpdateId : undefined,
      lastRunAtMs: typeof parsed.lastRunAtMs === "number" ? parsed.lastRunAtMs : undefined,
    };
  } catch {
    return {};
  }
}

function readPendingUpdates(path: string): unknown[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = readJsonFile(path);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function textFromTelegramRichText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part) && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  if (isRecord(value) && typeof value.text === "string") return value.text;
  return "";
}

function isoFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== "number") return null;
  return new Date(value * 1000).toISOString();
}

function isoFromExportDate(value: unknown): string | null {
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^\d+$/.test(value.trim())) return new Date(Number(value) * 1000).toISOString();
  const parsed = Date.parse(value.replace(/\s+at\s+/i, " ").replace(/\u202f/g, " "));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function authorFromMessage(message: Record<string, unknown>): string {
  const from = isRecord(message.from) ? message.from : null;
  const senderChat = isRecord(message.sender_chat) ? message.sender_chat : null;
  if (from) {
    if (typeof from.username === "string" && from.username) return `@${from.username}`;
    const first = typeof from.first_name === "string" ? from.first_name : "";
    const last = typeof from.last_name === "string" ? from.last_name : "";
    const name = `${first} ${last}`.trim();
    if (name) return name;
  }
  if (senderChat && typeof senderChat.title === "string") return senderChat.title;
  return "unknown";
}

function chatIdFromMessage(message: Record<string, unknown>): string | null {
  const chat = isRecord(message.chat) ? message.chat : null;
  if (!chat) return null;
  if (typeof chat.id === "number" || typeof chat.id === "string") return String(chat.id);
  if (typeof chat.username === "string") return `@${chat.username}`;
  return null;
}

function messageUrl(message: Record<string, unknown>): string | null {
  const chat = isRecord(message.chat) ? message.chat : null;
  const messageId = message.message_id;
  if (!chat || typeof chat.username !== "string" || typeof messageId !== "number") return null;
  return `https://t.me/${chat.username}/${messageId}`;
}

function messageMatchesChat(message: DigestMessage, sourceChatId: string | null): boolean {
  if (!sourceChatId) return true;
  const wanted = sourceChatId.trim();
  if (!wanted) return true;
  return message.chatId === wanted || message.chatId === wanted.replace(/^@/, "") || message.chatId === `@${wanted}`;
}

function digestMessageFromTelegramUpdate(update: unknown): DigestMessage | null {
  if (!isRecord(update)) return null;
  const message =
    (isRecord(update.message) && update.message) ||
    (isRecord(update.edited_message) && update.edited_message) ||
    (isRecord(update.channel_post) && update.channel_post) ||
    (isRecord(update.edited_channel_post) && update.edited_channel_post) ||
    null;
  if (!message) return null;
  const text = cleanText(textFromTelegramRichText(message.text) || textFromTelegramRichText(message.caption));
  if (!text) return null;
  const updateId = typeof update.update_id === "number" ? update.update_id : null;
  const messageId = typeof message.message_id === "number" ? message.message_id : updateId;
  return {
    id: String(updateId ?? messageId ?? `${Date.now()}-${text.slice(0, 16)}`),
    at: isoFromUnixSeconds(message.date),
    author: authorFromMessage(message),
    text,
    chatId: chatIdFromMessage(message),
    url: messageUrl(message),
  };
}

function digestMessageFromTelegramExport(item: unknown): DigestMessage | null {
  if (!isRecord(item)) return null;
  if (typeof item.type === "string" && item.type !== "message") return null;
  const text = cleanText(textFromTelegramRichText(item.text) || textFromTelegramRichText(item.caption));
  if (!text) return null;
  const from = typeof item.from === "string" ? item.from : typeof item.actor === "string" ? item.actor : "unknown";
  const at = isoFromExportDate(item.date_unixtime) ?? isoFromExportDate(item.date);
  return {
    id: String(item.id ?? `${at ?? "no-date"}-${text.slice(0, 16)}`),
    at,
    author: from,
    text,
    chatId: typeof item.chat_id === "string" || typeof item.chat_id === "number" ? String(item.chat_id) : null,
    url: typeof item.link === "string" ? item.link : null,
  };
}

function parsePlainTranscript(transcript: string): DigestMessage[] {
  const messages: DigestMessage[] = [];
  let current: { author: string; at: string | null; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const text = cleanText(current.lines.join("\n"));
    if (text) {
      messages.push({
        id: `${messages.length + 1}`,
        at: current.at,
        author: current.author,
        text,
        chatId: null,
        url: null,
      });
    }
  };

  for (const rawLine of transcript.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const telegramHeader = line.match(/^(.+?),\s*\[(.+?)\]:\s*$/);
    const bracketHeader = line.match(/^\[([^\]]+)\]\s+([^:]+):\s*(.*)$/);
    if (telegramHeader) {
      flush();
      current = {
        author: telegramHeader[1].trim(),
        at: isoFromExportDate(telegramHeader[2]),
        lines: [],
      };
    } else if (bracketHeader) {
      flush();
      current = {
        author: bracketHeader[2].trim(),
        at: isoFromExportDate(bracketHeader[1]),
        lines: bracketHeader[3] ? [bracketHeader[3]] : [],
      };
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      messages.push({
        id: `${messages.length + 1}`,
        at: null,
        author: "unknown",
        text: cleanText(line),
        chatId: null,
        url: null,
      });
    }
  }
  flush();
  return messages;
}

function parseJsonMessages(parsed: unknown): DigestMessage[] {
  const records = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.messages)
      ? parsed.messages
      : isRecord(parsed) && Array.isArray(parsed.result)
        ? parsed.result
        : [];
  return records
    .map((item) => digestMessageFromTelegramUpdate(item) ?? digestMessageFromTelegramExport(item))
    .filter((message): message is DigestMessage => message !== null);
}

function parseMessagesFile(path: string): DigestMessage[] {
  const body = readFileSync(path, "utf8");
  if (path.endsWith(".jsonl")) {
    return body
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .flatMap((line) => parseJsonMessages(JSON.parse(line)));
  }
  if (path.endsWith(".json")) return parseJsonMessages(JSON.parse(body));
  try {
    return parseJsonMessages(JSON.parse(body));
  } catch {
    return parsePlainTranscript(body);
  }
}

function filterAndTrimMessages(
  messages: DigestMessage[],
  input: NormalizedInput,
): { messages: DigestMessage[]; warnings: string[] } {
  const warnings: string[] = [];
  const cutoffMs = Date.now() - input.sinceHours * 60 * 60 * 1000;
  const seen = new Set<string>();
  let filtered = messages
    .filter((message) => messageMatchesChat(message, input.sourceChatId))
    .filter((message) => {
      if (!message.at) return true;
      const atMs = Date.parse(message.at);
      return Number.isFinite(atMs) ? atMs >= cutoffMs : true;
    })
    .filter((message) => {
      const key = `${message.id}:${message.at ?? ""}:${message.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (Date.parse(a.at ?? "") || 0) - (Date.parse(b.at ?? "") || 0));

  if (filtered.length > input.maxMessages) {
    warnings.push(`Trimmed ${filtered.length - input.maxMessages} older messages due to maxMessages.`);
    filtered = filtered.slice(-input.maxMessages);
  }
  return { messages: filtered, warnings };
}

function rangeFor(messages: DigestMessage[]): { from: string | null; to: string | null; label: string } {
  const dated = messages.map((message) => message.at).filter((at): at is string => Boolean(at));
  const from = dated[0] ?? null;
  const to = dated.at(-1) ?? null;
  if (!from || !to) return { from, to, label: "messages without complete timestamps" };
  return { from, to, label: `${from} to ${to}` };
}

function maxUpdateId(updates: unknown[]): number | null {
  const ids = updates
    .map((update) => (isRecord(update) && typeof update.update_id === "number" ? update.update_id : null))
    .filter((id): id is number => id !== null);
  return ids.length ? Math.max(...ids) : null;
}

async function telegramCall<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as TelegramApiResponse<T>;
  if (!response.ok || !parsed.ok) {
    const message = parsed.description ?? `Telegram ${method} failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed.result as T;
}

async function collectTelegramUpdates(input: NormalizedInput): Promise<{ updates: unknown[]; nextUpdateId: number | null; warnings: string[] }> {
  const token = envString(input.telegramBotTokenEnv);
  if (!token) {
    return {
      updates: [],
      nextUpdateId: null,
      warnings: [`${input.telegramBotTokenEnv} is not set; no Telegram Bot API updates were collected.`],
    };
  }

  const state = readState(input.statePath);
  const pendingPath = pendingPathFor(input.statePath);
  const updates = readPendingUpdates(pendingPath);
  const warnings: string[] = [];
  let offset = Math.max(state.lastUpdateId ?? -1, maxUpdateId(updates) ?? -1) + 1;
  const maxBatches = Math.max(1, Math.ceil(input.maxMessages / 100) + 1);

  for (let batch = 0; batch < maxBatches && updates.length < input.maxMessages; batch += 1) {
    if (updates.length > 0) writeJson(pendingPath, updates);
    const limit = Math.min(100, input.maxMessages - updates.length);
    const result = await telegramCall<unknown[]>(token, "getUpdates", {
      offset,
      limit,
      timeout: 0,
      allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post"],
    });
    if (result.length === 0) break;
    updates.push(...result);
    const last = maxUpdateId(result);
    if (last === null) break;
    offset = last + 1;
    if (result.length < limit) break;
  }

  if (updates.length >= input.maxMessages) {
    warnings.push(
      "Telegram returned at least maxMessages updates. For very fast groups, run an ingestion workflow more frequently or use a webhook collector.",
    );
  }

  if (updates.length > 0) writeJson(pendingPath, updates);
  return { updates, nextUpdateId: maxUpdateId(updates), warnings };
}

async function collectMessages(input: NormalizedInput): Promise<CollectOutput> {
  const source: Exclude<NormalizedInput["source"], "auto"> =
    input.source !== "auto"
      ? input.source
      : input.transcript
        ? "text"
        : input.messagesPath
          ? "jsonFile"
          : envString(input.telegramBotTokenEnv)
            ? "telegramBotApi"
            : "text";

  let messages: DigestMessage[] = [];
  let nextUpdateId: number | null = null;
  const warnings: string[] = [];

  if (source === "telegramBotApi") {
    const collected = await collectTelegramUpdates(input);
    messages = parseJsonMessages(collected.updates);
    nextUpdateId = collected.nextUpdateId;
    warnings.push(...collected.warnings);
  } else if (source === "jsonFile") {
    if (!input.messagesPath) {
      warnings.push("messagesPath is required when source=jsonFile.");
    } else if (!existsSync(input.messagesPath)) {
      warnings.push(`messagesPath does not exist: ${input.messagesPath}`);
    } else {
      messages = parseMessagesFile(input.messagesPath);
    }
  } else if (source === "text") {
    messages = input.transcript ? parsePlainTranscript(input.transcript) : [];
    if (!input.transcript) warnings.push("No transcript was provided.");
  }

  const trimmed = filterAndTrimMessages(messages, input);
  warnings.push(...trimmed.warnings);
  const range = rangeFor(trimmed.messages);

  return {
    source,
    messageCount: trimmed.messages.length,
    from: range.from,
    to: range.to,
    messages: trimmed.messages,
    nextUpdateId,
    warnings,
  };
}

function transcriptForPrompt(collect: CollectOutput, input: NormalizedInput): { transcript: string; truncated: boolean } {
  const lines = collect.messages.map((message, index) => {
    const when = message.at ?? "no timestamp";
    const url = message.url ? ` (${message.url})` : "";
    return `${index + 1}. [${when}] ${message.author}: ${message.text}${url}`;
  });
  let body = lines.join("\n");
  if (body.length <= input.maxPromptChars) return { transcript: body, truncated: false };
  body = body.slice(body.length - input.maxPromptChars);
  const firstLine = body.indexOf("\n");
  return {
    transcript: firstLine >= 0 ? body.slice(firstLine + 1) : body,
    truncated: true,
  };
}

function summarizePrompt(collect: CollectOutput, input: NormalizedInput): string {
  const promptTranscript = transcriptForPrompt(collect, input);
  const context = input.topicHint
    ? `Group context / what the audience cares about: ${input.topicHint}`
    : "No extra group context was provided.";
  const truncation = promptTranscript.truncated
    ? "The transcript was truncated to fit the prompt budget; say so in caveats if it affects confidence."
    : "The transcript fits in the prompt budget.";
  return [
    "You write concise daily digests for a fast Telegram group.",
    "",
    "Goal: summarize the real topics people discussed, preserving the useful insights without amplifying noise.",
    "Rules:",
    "- Do not invent topics, claims, links, action items, or consensus.",
    "- Group related messages into topic clusters instead of summarizing chronologically.",
    "- Keep representativeMessages short and quote/paraphrase only what is necessary.",
    "- Include disagreements or uncertainty when present.",
    "- Avoid sensitive personal details unless they are central to the public group discussion.",
    "- Return only JSON matching the output schema.",
    "",
    context,
    `Message count: ${collect.messageCount}`,
    `Date range: ${rangeFor(collect.messages).label}`,
    truncation,
    "",
    "Transcript:",
    promptTranscript.transcript,
  ].join("\n");
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Kimi response did not contain a JSON object.");
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeDigestJson(value: unknown, collect: CollectOutput): DigestOutput {
  const record = isRecord(value) ? value : {};
  const rawNotableLinks = record.notableLinks ?? record.notable_links;
  const topics = Array.isArray(record.topics)
    ? record.topics
        .filter(isRecord)
        .slice(0, 10)
        .map((topic) => ({
          title: typeof topic.title === "string" ? topic.title : "Topic",
          summary: typeof topic.summary === "string" ? topic.summary : "",
          whyItMatters:
            typeof topic.whyItMatters === "string"
              ? topic.whyItMatters
              : typeof topic.why_it_matters === "string"
                ? topic.why_it_matters
                : "",
          keyPoints: stringArray(topic.keyPoints ?? topic.key_points),
          representativeMessages: stringArray(topic.representativeMessages ?? topic.representative_messages),
          participants: stringArray(topic.participants),
          followUps: stringArray(topic.followUps ?? topic.follow_ups),
        }))
    : [];
  const notableLinks = Array.isArray(rawNotableLinks)
    ? rawNotableLinks
        .filter(isRecord)
        .slice(0, 10)
        .map((link) => ({
          label: typeof link.label === "string" ? link.label : "Link",
          url: typeof link.url === "string" ? link.url : "",
          context: typeof link.context === "string" ? link.context : "",
        }))
        .filter((link) => link.url)
    : [];
  return digestSchema.parse({
    headline: typeof record.headline === "string" ? record.headline : "Telegram Daily Digest",
    range: typeof record.range === "string" ? record.range : rangeFor(collect.messages).label,
    summary: typeof record.summary === "string" ? record.summary : "",
    topics,
    notableLinks,
    actionItems: stringArray(record.actionItems ?? record.action_items),
    openQuestions: stringArray(record.openQuestions ?? record.open_questions),
    caveats: stringArray(record.caveats),
  });
}

async function summarizeWithKimi(collect: CollectOutput, input: NormalizedInput): Promise<DigestOutput> {
  const apiKey = envString(input.kimiApiKeyEnv);
  if (!apiKey) throw new Error(`${input.kimiApiKeyEnv} is not set; Kimi summary cannot run.`);
  const body: Record<string, unknown> = {
    model: input.kimiModel,
    temperature: 0.2,
    max_tokens: 4096,
    messages: [
      {
        role: "system",
        content:
          "You summarize busy Telegram group discussions for members who missed the day. Be concise, specific, and preserve concrete names, tools, links, decisions, and disagreements. Return only JSON.",
      },
      { role: "user", content: summarizePrompt(collect, input) },
    ],
  };
  if (/^kimi-k2\.(5|6)\b/.test(input.kimiModel)) {
    body.thinking = { type: "disabled" };
  }

  const response = await fetch(MOONSHOT_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as KimiChatResponse;
  if (!response.ok) {
    throw new Error(parsed.error?.message ?? `Kimi request failed with HTTP ${response.status}`);
  }
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Kimi response did not include message content.");
  return normalizeDigestJson(parseJsonObject(content), collect);
}

function emptyDigest(collect: CollectOutput): DigestOutput {
  return {
    headline: "No Telegram messages to summarize",
    range: rangeFor(collect.messages).label,
    summary: "No eligible messages were collected for this digest window.",
    topics: [],
    notableLinks: [],
    actionItems: [],
    openQuestions: [],
    caveats: collect.warnings,
  };
}

function bulletList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim()))];
}

function renderDigestMarkdown(collect: CollectOutput, digest: DigestOutput, input: NormalizedInput): string {
  const warnings = uniqueStrings([...collect.warnings, ...digest.caveats]);
  const topics = digest.topics.length
    ? digest.topics
        .map((topic, index) => {
          const parts = [
            `## ${index + 1}. ${topic.title}`,
            topic.summary,
            topic.whyItMatters ? `Why it matters: ${topic.whyItMatters}` : "",
            topic.keyPoints.length ? `Key points:\n${bulletList(topic.keyPoints)}` : "",
            topic.representativeMessages.length
              ? `Representative messages:\n${bulletList(topic.representativeMessages)}`
              : "",
            topic.followUps.length ? `Follow-ups:\n${bulletList(topic.followUps)}` : "",
          ];
          return parts.filter(Boolean).join("\n\n");
        })
        .join("\n\n")
    : "## Topics\n\nNo topics found.";

  const links = digest.notableLinks.length
    ? digest.notableLinks.map((link) => `- ${link.label}: ${link.url}${link.context ? ` (${link.context})` : ""}`).join("\n")
    : "- None";

  return [
    `# ${digest.headline}`,
    "",
    `Range: ${digest.range || rangeFor(collect.messages).label}`,
    `Messages summarized: ${collect.messageCount}`,
    input.topicHint ? `Context: ${input.topicHint}` : "",
    "",
    "## Summary",
    "",
    digest.summary,
    "",
    topics,
    "",
    "## Action Items",
    "",
    bulletList(digest.actionItems),
    "",
    "## Open Questions",
    "",
    bulletList(digest.openQuestions),
    "",
    "## Notable Links",
    "",
    links,
    warnings.length ? "\n## Caveats\n\n" + bulletList(warnings) : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function reportToTelegramText(markdown: string): string {
  return markdown
    .replace(/^# /gm, "")
    .replace(/^## /gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function writeReport(collect: CollectOutput, digest: DigestOutput, input: NormalizedInput): ReportOutput {
  const markdown = renderDigestMarkdown(collect, digest, input);
  mkdirSync(dirname(input.reportPath), { recursive: true });
  writeFileSync(input.reportPath, `${markdown.trim()}\n`, "utf8");
  return {
    markdown,
    telegramText: reportToTelegramText(markdown),
    reportPath: input.reportPath,
    written: true,
    bytes: Buffer.byteLength(markdown, "utf8"),
  };
}

function splitTelegramText(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const block of text.split(/\n\n+/)) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= TELEGRAM_SEND_LIMIT) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (block.length <= TELEGRAM_SEND_LIMIT) {
      current = block;
      continue;
    }
    for (let index = 0; index < block.length; index += TELEGRAM_SEND_LIMIT) {
      chunks.push(block.slice(index, index + TELEGRAM_SEND_LIMIT));
    }
    current = "";
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text.slice(0, TELEGRAM_SEND_LIMIT)];
}

function chatIdPayload(chatId: string): string | number {
  if (/^-?\d+$/.test(chatId)) {
    const parsed = Number(chatId);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return chatId;
}

async function publishDigest(report: ReportOutput, input: NormalizedInput): Promise<PublishOutput> {
  if (input.dryRun) {
    return {
      attempted: false,
      sent: false,
      dryRun: true,
      chatId: input.outputChatId,
      chunks: splitTelegramText(report.telegramText).length,
      messageIds: [],
      note: "Dry-run: digest was not posted.",
    };
  }
  if (!input.postToTelegram) {
    return {
      attempted: false,
      sent: false,
      dryRun: false,
      chatId: input.outputChatId,
      chunks: 0,
      messageIds: [],
      note: "postToTelegram is false; digest was written but not posted.",
    };
  }
  const token = envString(input.telegramBotTokenEnv);
  if (!token || !input.outputChatId) {
    return {
      attempted: true,
      sent: false,
      dryRun: false,
      chatId: input.outputChatId,
      chunks: 0,
      messageIds: [],
      note: `Missing ${!token ? input.telegramBotTokenEnv : "outputChatId"}; digest was not posted.`,
    };
  }

  const messageIds: number[] = [];
  const chunks = splitTelegramText(report.telegramText);
  for (const chunk of chunks) {
    const result = await telegramCall<Record<string, unknown>>(token, "sendMessage", {
      chat_id: chatIdPayload(input.outputChatId),
      text: chunk,
      disable_web_page_preview: true,
      ...(input.outputMessageThreadId ? { message_thread_id: input.outputMessageThreadId } : {}),
    });
    if (typeof result.message_id === "number") messageIds.push(result.message_id);
  }

  return {
    attempted: true,
    sent: true,
    dryRun: false,
    chatId: input.outputChatId,
    chunks: chunks.length,
    messageIds,
    note: `Posted ${chunks.length} Telegram message${chunks.length === 1 ? "" : "s"}.`,
  };
}

function acknowledgeTelegram(collect: CollectOutput, publish: PublishOutput, input: NormalizedInput): z.infer<typeof ackSchema> {
  if (collect.source !== "telegramBotApi" || collect.nextUpdateId === null) {
    return {
      acknowledged: false,
      lastUpdateId: null,
      statePath: input.statePath,
      note: "No Telegram Bot API offset to acknowledge.",
    };
  }
  if (!input.acknowledge) {
    return {
      acknowledged: false,
      lastUpdateId: collect.nextUpdateId,
      statePath: input.statePath,
      note: "acknowledge is false; pending updates were preserved.",
    };
  }
  if (input.postToTelegram && !publish.sent) {
    return {
      acknowledged: false,
      lastUpdateId: collect.nextUpdateId,
      statePath: input.statePath,
      note: "Digest was not posted, so the Telegram offset was not advanced.",
    };
  }

  writeJson(input.statePath, { lastUpdateId: collect.nextUpdateId, lastRunAtMs: Date.now() });
  rmSync(pendingPathFor(input.statePath), { force: true });
  return {
    acknowledged: true,
    lastUpdateId: collect.nextUpdateId,
    statePath: input.statePath,
    note: `Acknowledged Telegram updates through ${collect.nextUpdateId}.`,
  };
}

function finalOutput(
  collect: CollectOutput,
  digest: DigestOutput,
  report: ReportOutput,
  publish: PublishOutput,
  ack: z.infer<typeof ackSchema>,
): z.infer<typeof outputSchema> {
  const posted = publish.sent;
  const status =
    collect.messageCount === 0
      ? "empty"
      : publish.dryRun
        ? "dry-run"
        : posted
          ? "posted"
          : publish.attempted
            ? "publish-failed"
            : "ready";
  return {
    status,
    source: collect.source,
    messageCount: collect.messageCount,
    range: digest.range || rangeFor(collect.messages).label,
    reportPath: report.reportPath,
    posted,
    acknowledged: ack.acknowledged,
    summary: digest.summary,
    topics: digest.topics.map((topic) => topic.title),
    warnings: uniqueStrings([...collect.warnings, ...digest.caveats, publish.note, ack.note]),
  };
}

export default smithers((ctx) => {
  const input = normalizeInput(ctx.input);
  const collect = ctx.outputMaybe(outputs.collect, { nodeId: "collect-messages" });
  const digest = ctx.outputMaybe(outputs.digest, { nodeId: "summarize-digest" });
  const report = ctx.outputMaybe(outputs.report, { nodeId: "write-report" });
  const publish = ctx.outputMaybe(outputs.publish, { nodeId: "publish-digest" });
  const ack = ctx.outputMaybe(outputs.ack, { nodeId: "acknowledge-updates" });

  return (
    <Workflow name="telegram-daily-digest">
      <UI entry="../ui/telegram-daily-digest.tsx" title={"Telegram Daily Digest"} />
      <Sequence>
        <Task id="collect-messages" output={outputs.collect}>
          {() => collectMessages(input)}
        </Task>

        {collect ? (
          collect.messageCount > 0 ? (
            <Task id="summarize-digest" output={outputs.digest} heartbeatTimeoutMs={600_000}>
              {() => summarizeWithKimi(collect, input)}
            </Task>
          ) : (
            <Task id="summarize-digest" output={outputs.digest}>
              {() => emptyDigest(collect)}
            </Task>
          )
        ) : null}

        {collect && digest ? (
          <Task id="write-report" output={outputs.report}>
            {() => writeReport(collect, digest, input)}
          </Task>
        ) : null}

        {report ? (
          <Task id="publish-digest" output={outputs.publish}>
            {() => publishDigest(report, input)}
          </Task>
        ) : null}

        {collect && publish ? (
          <Task id="acknowledge-updates" output={outputs.ack}>
            {() => acknowledgeTelegram(collect, publish, input)}
          </Task>
        ) : null}

        {collect && digest && report && publish && ack ? (
          <Task id="output" output={outputs.output}>
            {() => finalOutput(collect, digest, report, publish, ack)}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
