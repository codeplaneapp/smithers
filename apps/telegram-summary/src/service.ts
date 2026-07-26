import type { D1Database, TelegramSummaryEnv } from "./env.ts";
import { ensureSchema } from "./schema.ts";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const OPENAI_CHAT_COMPLETIONS = "https://api.openai.com/v1/chat/completions";
const MOONSHOT_CHAT_COMPLETIONS = "https://api.moonshot.ai/v1/chat/completions";
// Telegram sendMessage rejects texts over 4096 chars; 3800 leaves headroom so
// splitTelegramText's trim/newline handling can never overshoot.
const TELEGRAM_SEND_LIMIT = 3800;
const STATE_LAST_UPDATE_ID = "telegram.last_update_id";
// These must stay in sync with the model binding defaults in alchemy.run.ts.
const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
const DEFAULT_KIMI_MODEL = "kimi-k2.6";
// getUpdates page size; also the ingest loop's exit check (a short page means
// Telegram has no more updates), so both uses must agree.
const GETUPDATES_PAGE_SIZE = 100;
// Bounds one cron invocation; any remaining backlog is picked up by the next run.
const MAX_GETUPDATES_BATCHES_PER_RUN = 5;
// Caps the prompt payload sent to the summarizer; transcriptFor keeps the TAIL
// (the most recent messages) when over budget.
const TRANSCRIPT_MAX_CHARS = 120000;

export interface MessageRecord {
  updateId: number;
  chatId: string | null;
  chatUsername: string | null;
  messageId: number | null;
  author: string;
  text: string;
  atMs: number | null;
  url: string | null;
  rawJson: string;
}

export interface MessageRow {
  update_id: number;
  chat_id: string | null;
  message_id: number | null;
  author: string;
  text: string;
  at_ms: number | null;
  url: string | null;
}

export interface DigestTopic {
  title: string;
  summary: string;
  keyPoints: string[];
  participants: string[];
  followUps: string[];
}

export interface DigestJson {
  headline: string;
  summary: string;
  topics: DigestTopic[];
  actionItems: string[];
  openQuestions: string[];
  notableLinks: Array<{ label: string; url: string; context: string }>;
  caveats: string[];
}

export interface DigestRow {
  id: string;
  period_start_ms: number;
  period_end_ms: number;
  message_count: number;
  model: string;
  summary_json: string;
  telegram_text: string;
  created_at_ms: number;
  posted_at_ms: number | null;
  post_error: string | null;
}

export interface IngestResult {
  batches: number;
  updateCount: number;
  storedMessages: number;
  lastUpdateId: number | null;
  warning: string | null;
}

export interface DigestRunResult {
  id: string | null;
  messageCount: number;
  periodStartMs: number;
  periodEndMs: number;
  model: string;
  status: "created" | "empty" | "missing-model-key" | "failed";
  posted: boolean;
  error: string | null;
}

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

type TelegramUpdate = Record<string, unknown>;

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: { message?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compact(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function extractText(value: unknown): string {
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
  return "";
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

function chatUsernameFromMessage(message: Record<string, unknown>): string | null {
  const chat = isRecord(message.chat) ? message.chat : null;
  return chat && typeof chat.username === "string" ? chat.username : null;
}

function messageUrl(message: Record<string, unknown>): string | null {
  const chat = isRecord(message.chat) ? message.chat : null;
  const messageId = message.message_id;
  if (!chat || typeof chat.username !== "string" || typeof messageId !== "number") return null;
  return `https://t.me/${chat.username}/${messageId}`;
}

function sourceChatId(env: TelegramSummaryEnv): string | null {
  return compact(env.TELEGRAM_SOURCE_CHAT_ID);
}

function outputChatId(env: TelegramSummaryEnv): string | null {
  return compact(env.TELEGRAM_OUTPUT_CHAT_ID) ?? sourceChatId(env);
}

function configuredDigestModel(env: TelegramSummaryEnv): string {
  if (compact(env.OPENAI_API_KEY) || !compact(env.MOONSHOT_API_KEY)) {
    return compact(env.OPENAI_MODEL) ?? DEFAULT_OPENAI_MODEL;
  }
  return compact(env.KIMI_MODEL) ?? DEFAULT_KIMI_MODEL;
}

function parseThreadId(env: TelegramSummaryEnv): number | null {
  const value = compact(env.TELEGRAM_OUTPUT_THREAD_ID);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function messageMatchesChat(message: MessageRecord, wanted: string | null): boolean {
  if (!wanted) return true;
  if (message.chatId === wanted) return true;
  if (!message.chatUsername) return false;
  return message.chatUsername.replace(/^@/, "") === wanted.replace(/^@/, "");
}

function messageFromUpdate(update: TelegramUpdate): MessageRecord | null {
  const message =
    (isRecord(update.message) && update.message) ||
    (isRecord(update.edited_message) && update.edited_message) ||
    (isRecord(update.channel_post) && update.channel_post) ||
    (isRecord(update.edited_channel_post) && update.edited_channel_post) ||
    null;
  const updateId = typeof update.update_id === "number" ? update.update_id : null;
  if (!message || updateId === null) return null;
  const text = (extractText(message.text) || extractText(message.caption)).replace(/\s+/g, " ").trim(); // collapse whitespace to one line
  if (!text) return null;
  const date = typeof message.date === "number" ? message.date * 1000 : null;
  const messageId = typeof message.message_id === "number" ? message.message_id : null;
  return {
    updateId,
    chatId: chatIdFromMessage(message),
    chatUsername: chatUsernameFromMessage(message),
    messageId,
    author: authorFromMessage(message),
    text,
    atMs: date,
    url: messageUrl(message),
    rawJson: safeJson(update),
  };
}

async function telegramCall<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as TelegramApiResponse<T>;
  if (!response.ok || !parsed.ok) {
    throw new Error(parsed.description ?? `Telegram ${method} failed with HTTP ${response.status}`);
  }
  return parsed.result as T;
}

async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function setState(db: D1Database, key: string, value: string, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO state (key, value, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
    )
    .bind(key, value, nowMs)
    .run();
}

async function insertMessages(db: D1Database, messages: MessageRecord[], nowMs: number): Promise<number> {
  if (messages.length === 0) return 0;
  const statements = messages.map((message) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO messages
         (update_id, chat_id, message_id, author, text, at_ms, url, raw_json, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        message.updateId,
        message.chatId,
        message.messageId,
        message.author,
        message.text,
        message.atMs,
        message.url,
        message.rawJson,
        nowMs,
      ),
  );
  const results = await db.batch(statements);
  return results.reduce((count, result) => count + (result.meta?.changes ?? 0), 0);
}

export async function ingestTelegramUpdates(env: TelegramSummaryEnv, nowMs = Date.now()): Promise<IngestResult> {
  await ensureSchema(env.DB);
  const token = compact(env.TELEGRAM_BOT_TOKEN);
  if (!token) {
    return {
      batches: 0,
      updateCount: 0,
      storedMessages: 0,
      lastUpdateId: null,
      warning: "TELEGRAM_BOT_TOKEN is not configured.",
    };
  }

  const lastUpdateId = Number((await getState(env.DB, STATE_LAST_UPDATE_ID)) ?? "-1");
  let offset = Number.isFinite(lastUpdateId) ? lastUpdateId + 1 : 0;
  let batches = 0;
  let updateCount = 0;
  let storedMessages = 0;
  let maxSeen: number | null = null;
  const wantedChat = sourceChatId(env);

  for (let i = 0; i < MAX_GETUPDATES_BATCHES_PER_RUN; i += 1) {
    const updates = await telegramCall<TelegramUpdate[]>(token, "getUpdates", {
      offset,
      limit: GETUPDATES_PAGE_SIZE,
      timeout: 0,
      allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post"],
    });
    if (updates.length === 0) break;
    batches += 1;
    updateCount += updates.length;
    const messages = updates.map(messageFromUpdate).filter((message): message is MessageRecord => Boolean(message));
    const filtered = messages.filter((message) => messageMatchesChat(message, wantedChat));
    storedMessages += await insertMessages(env.DB, filtered, nowMs);
    const batchMax = Math.max(
      ...updates.map((update) => (typeof update.update_id === "number" ? update.update_id : -1)),
    );
    if (batchMax >= 0) {
      maxSeen = Math.max(maxSeen ?? -1, batchMax);
      await setState(env.DB, STATE_LAST_UPDATE_ID, String(maxSeen), nowMs);
      offset = maxSeen + 1;
    }
    if (updates.length < GETUPDATES_PAGE_SIZE) break;
  }

  return { batches, updateCount, storedMessages, lastUpdateId: maxSeen, warning: null };
}

async function selectMessagesForDigest(db: D1Database, startMs: number, endMs: number): Promise<MessageRow[]> {
  // LIMIT 1200 is the row-count companion to the TRANSCRIPT_MAX_CHARS char cap.
  const rows = await db
    .prepare(
      `SELECT update_id, chat_id, message_id, author, text, at_ms, url
       FROM messages
       WHERE COALESCE(at_ms, created_at_ms) >= ? AND COALESCE(at_ms, created_at_ms) < ?
       ORDER BY COALESCE(at_ms, created_at_ms), update_id
       LIMIT 1200`,
    )
    .bind(startMs, endMs)
    .all<MessageRow>();
  return rows.results ?? [];
}

function transcriptFor(messages: MessageRow[], maxChars: number): string {
  const lines = messages.map((message) => {
    const when = message.at_ms ? new Date(message.at_ms).toISOString() : "unknown-time";
    const link = message.url ? ` ${message.url}` : "";
    return `[${when}] ${message.author}: ${message.text}${link}`;
  });
  const body = lines.join("\n");
  if (body.length <= maxChars) return body;
  // Keep the tail so the most recent messages survive truncation.
  return body.slice(body.length - maxChars);
}

function extractJson(text: string): unknown {
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
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
}

function normalizeDigest(value: unknown): DigestJson {
  const record = isRecord(value) ? value : {};
  const topics = Array.isArray(record.topics)
    ? record.topics
        .filter(isRecord)
        .slice(0, 8)
        .map((topic) => ({
          title: typeof topic.title === "string" ? topic.title : "Topic",
          summary: typeof topic.summary === "string" ? topic.summary : "",
          keyPoints: stringArray(topic.keyPoints),
          participants: stringArray(topic.participants),
          followUps: stringArray(topic.followUps),
        }))
    : [];
  const notableLinks = Array.isArray(record.notableLinks)
    ? record.notableLinks
        .filter(isRecord)
        .slice(0, 8)
        .map((link) => ({
          label: typeof link.label === "string" ? link.label : "Link",
          url: typeof link.url === "string" ? link.url : "",
          context: typeof link.context === "string" ? link.context : "",
        }))
        .filter((link) => link.url)
    : [];
  return {
    headline: typeof record.headline === "string" ? record.headline : "Telegram Daily Summary",
    summary: typeof record.summary === "string" ? record.summary : "",
    topics,
    actionItems: stringArray(record.actionItems),
    openQuestions: stringArray(record.openQuestions),
    notableLinks,
    caveats: stringArray(record.caveats),
  };
}

function digestRequestMessages(
  env: TelegramSummaryEnv,
  messages: MessageRow[],
  startMs: number,
  endMs: number,
): Array<{ role: "system" | "user"; content: string }> {
  const hint = compact(env.DIGEST_TOPIC_HINT);
  return [
    {
      role: "system",
      content:
        "You summarize busy Telegram group discussions for members who missed the day. Be concise, specific, and preserve concrete names, tools, links, decisions, and disagreements. Return only JSON.",
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "Create a daily Telegram group digest.",
        period: {
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
        },
        topicHint: hint,
        requiredJsonShape: {
          headline: "short headline",
          summary: "one concise paragraph",
          topics: [
            {
              title: "topic title",
              summary: "what was discussed",
              keyPoints: ["specific point"],
              participants: ["name or handle"],
              followUps: ["optional follow-up"],
            },
          ],
          actionItems: ["ownerless action item"],
          openQuestions: ["question"],
          notableLinks: [{ label: "label", url: "https://example.com", context: "why it came up" }],
          caveats: ["uncertainty or low confidence note"],
        },
        transcript: transcriptFor(messages, TRANSCRIPT_MAX_CHARS),
      }),
    },
  ];
}

async function requestDigest(
  endpoint: string,
  apiKey: string,
  model: string,
  provider: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  reasoningEffort?: "medium",
): Promise<DigestJson> {
  const body: Record<string, unknown> = {
    model,
    messages,
  };
  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
    body.max_completion_tokens = 4096;
  } else {
    body.temperature = 0.2;
    body.max_tokens = 4096;
  }
  if (/^kimi-k2\.(5|6)\b/.test(model)) {
    body.thinking = { type: "disabled" };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as ChatCompletionResponse;
  if (!response.ok) {
    throw new Error(parsed.error?.message ?? `${provider} request failed with HTTP ${response.status}`);
  }
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`${provider} response did not include message content.`);
  return normalizeDigest(extractJson(content));
}

async function createCodexFirstDigest(
  env: TelegramSummaryEnv,
  messages: MessageRow[],
  startMs: number,
  endMs: number,
): Promise<{ digest: DigestJson; model: string }> {
  const requestMessages = digestRequestMessages(env, messages, startMs, endMs);
  const openaiKey = compact(env.OPENAI_API_KEY);
  const openaiModel = compact(env.OPENAI_MODEL) ?? DEFAULT_OPENAI_MODEL;
  let primaryError: unknown;

  if (openaiKey) {
    try {
      return {
        digest: await requestDigest(
          OPENAI_CHAT_COMPLETIONS,
          openaiKey,
          openaiModel,
          "OpenAI",
          requestMessages,
          "medium",
        ),
        model: openaiModel,
      };
    } catch (error) {
      primaryError = error;
    }
  }

  const kimiKey = compact(env.MOONSHOT_API_KEY);
  if (kimiKey) {
    const kimiModel = compact(env.KIMI_MODEL) ?? DEFAULT_KIMI_MODEL;
    return {
      digest: await requestDigest(MOONSHOT_CHAT_COMPLETIONS, kimiKey, kimiModel, "Kimi fallback", requestMessages),
      model: kimiModel,
    };
  }

  if (primaryError instanceof Error) throw primaryError;
  throw new Error("OPENAI_API_KEY is not configured and no MOONSHOT_API_KEY fallback is available.");
}

function renderTelegramDigest(digest: DigestJson, messages: MessageRow[], startMs: number, endMs: number): string {
  const lines = [
    digest.headline,
    "",
    `${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()} - ${messages.length} messages`,
    "",
    digest.summary,
  ];
  for (const topic of digest.topics) {
    lines.push("", `* ${topic.title}`, topic.summary);
    for (const point of topic.keyPoints.slice(0, 4)) lines.push(`  - ${point}`);
    if (topic.followUps.length) lines.push(`  Follow-up: ${topic.followUps.join("; ")}`);
  }
  if (digest.actionItems.length) {
    lines.push("", "Action items");
    for (const item of digest.actionItems) lines.push(`- ${item}`);
  }
  if (digest.openQuestions.length) {
    lines.push("", "Open questions");
    for (const question of digest.openQuestions) lines.push(`- ${question}`);
  }
  if (digest.notableLinks.length) {
    lines.push("", "Links");
    for (const link of digest.notableLinks) lines.push(`- ${link.label}: ${link.url}`);
  }
  if (digest.caveats.length) {
    lines.push("", "Caveats");
    for (const caveat of digest.caveats) lines.push(`- ${caveat}`);
  }
  return lines
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n")
    .trim();
}

function splitTelegramText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > TELEGRAM_SEND_LIMIT) {
    const cut = remaining.lastIndexOf("\n", TELEGRAM_SEND_LIMIT);
    const end = cut > 1000 ? cut : TELEGRAM_SEND_LIMIT;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function postDigest(
  env: TelegramSummaryEnv,
  telegramText: string,
): Promise<{ posted: boolean; error: string | null }> {
  const token = compact(env.TELEGRAM_BOT_TOKEN);
  const chatId = outputChatId(env);
  if (!token || !chatId) return { posted: false, error: "Telegram token or output chat id is not configured." };
  const threadId = parseThreadId(env);
  const chunks = splitTelegramText(telegramText);
  let sent = 0;
  for (const chunk of chunks) {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    };
    if (threadId !== null) body.message_thread_id = threadId;
    try {
      await telegramCall<unknown>(token, "sendMessage", body);
      sent += 1;
    } catch (error) {
      // Don't throw: the caller inserts the digest row BEFORE posting and only
      // records the outcome (posted_at_ms / post_error) if we return. Throwing
      // here orphans that row as a falsely-clean "Ready" digest and the next run
      // re-summarizes and re-posts the overlapping window.
      const message = error instanceof Error ? error.message : String(error);
      return {
        posted: false,
        error: sent > 0 ? `Partial post: sent ${sent}/${chunks.length} chunks, then failed: ${message}` : message,
      };
    }
  }
  return { posted: true, error: null };
}

async function insertDigest(
  db: D1Database,
  id: string,
  digest: DigestJson,
  telegramText: string,
  model: string,
  messageCount: number,
  startMs: number,
  endMs: number,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO digests
       (id, period_start_ms, period_end_ms, message_count, model, summary_json, telegram_text, created_at_ms, posted_at_ms, post_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(id, startMs, endMs, messageCount, model, safeJson(digest), telegramText, nowMs)
    .run();
}

async function markDigestPosted(
  db: D1Database,
  id: string,
  postedAtMs: number | null,
  error: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE digests SET posted_at_ms = ?, post_error = ? WHERE id = ?")
    .bind(postedAtMs, error, id)
    .run();
}

export async function runDailyDigest(env: TelegramSummaryEnv, nowMs = Date.now()): Promise<DigestRunResult> {
  await ensureSchema(env.DB);
  // DIGEST_WINDOW_HOURS: default 24h, clamped to 1h..168h (one week).
  const parsedHours = Number(env.DIGEST_WINDOW_HOURS);
  const hours = Number.isFinite(parsedHours) ? Math.min(168, Math.max(1, Math.floor(parsedHours))) : 24;
  const periodEndMs = nowMs;
  const periodStartMs = nowMs - hours * 60 * 60 * 1000;
  const configuredModel = configuredDigestModel(env);
  const messages = await selectMessagesForDigest(env.DB, periodStartMs, periodEndMs);
  if (messages.length === 0) {
    return {
      id: null,
      messageCount: 0,
      periodStartMs,
      periodEndMs,
      model: configuredModel,
      status: "empty",
      posted: false,
      error: null,
    };
  }
  if (!compact(env.OPENAI_API_KEY) && !compact(env.MOONSHOT_API_KEY)) {
    return {
      id: null,
      messageCount: messages.length,
      periodStartMs,
      periodEndMs,
      model: configuredModel,
      status: "missing-model-key",
      posted: false,
      error: "OPENAI_API_KEY is not configured and no MOONSHOT_API_KEY fallback is available.",
    };
  }

  try {
    const { digest, model } = await createCodexFirstDigest(env, messages, periodStartMs, periodEndMs);
    const telegramText = renderTelegramDigest(digest, messages, periodStartMs, periodEndMs);
    const id = `digest-${new Date(nowMs).toISOString().replace(/[:.]/g, "-")}`;
    await insertDigest(env.DB, id, digest, telegramText, model, messages.length, periodStartMs, periodEndMs, nowMs);
    const post = await postDigest(env, telegramText);
    await markDigestPosted(env.DB, id, post.posted ? Date.now() : null, post.error);
    return {
      id,
      messageCount: messages.length,
      periodStartMs,
      periodEndMs,
      model,
      status: "created",
      posted: post.posted,
      error: post.error,
    };
  } catch (error) {
    return {
      id: null,
      messageCount: messages.length,
      periodStartMs,
      periodEndMs,
      model: configuredModel,
      status: "failed",
      posted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function latestDigest(db: D1Database): Promise<DigestRow | null> {
  await ensureSchema(db);
  return await db
    .prepare(
      `SELECT id, period_start_ms, period_end_ms, message_count, model, summary_json, telegram_text, created_at_ms, posted_at_ms, post_error
       FROM digests
       ORDER BY created_at_ms DESC
       LIMIT 1`,
    )
    .first<DigestRow>();
}

export async function listDigests(db: D1Database, limit = 20): Promise<DigestRow[]> {
  await ensureSchema(db);
  const rows = await db
    .prepare(
      `SELECT id, period_start_ms, period_end_ms, message_count, model, summary_json, telegram_text, created_at_ms, posted_at_ms, post_error
       FROM digests
       ORDER BY created_at_ms DESC
       LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(100, limit)))
    .all<DigestRow>();
  return rows.results ?? [];
}

export async function status(env: TelegramSummaryEnv): Promise<Record<string, unknown>> {
  await ensureSchema(env.DB);
  const messageRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first<{ count: number }>();
  const digestRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM digests").first<{ count: number }>();
  const latest = await latestDigest(env.DB);
  const offset = await getState(env.DB, STATE_LAST_UPDATE_ID);
  return {
    messages: messageRow?.count ?? 0,
    digests: digestRow?.count ?? 0,
    lastUpdateId: offset ? Number(offset) : null,
    latestDigestId: latest?.id ?? null,
    model: configuredDigestModel(env),
    openaiConfigured: Boolean(compact(env.OPENAI_API_KEY)),
    kimiFallbackConfigured: Boolean(compact(env.MOONSHOT_API_KEY)),
    telegramConfigured: Boolean(compact(env.TELEGRAM_BOT_TOKEN)),
    outputChatConfigured: Boolean(outputChatId(env)),
    ingestCron: compact(env.INGEST_CRON),
    digestCron: compact(env.DIGEST_CRON),
  };
}

export function digestJsonFromRow(row: DigestRow): DigestJson {
  try {
    return normalizeDigest(JSON.parse(row.summary_json));
  } catch {
    return normalizeDigest({});
  }
}
