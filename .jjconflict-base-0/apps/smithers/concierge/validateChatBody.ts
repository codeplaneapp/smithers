export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ChatBody = {
  messages: ChatMessage[];
  system?: string;
};

export type ValidationResult =
  | { ok: true; body: ChatBody }
  | { ok: false; status: number; message: string };

const MAX_MESSAGES = 100;
const MAX_CONTENT_BYTES = 100 * 1024;
const MAX_SYSTEM_BYTES = 4 * 1024;

const encoder = new TextEncoder();

function isChatMessage(value: unknown): value is ChatMessage {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string"
  );
}

/**
 * Validate an untrusted `/api/chat` body: it must be an object with a bounded
 * `messages[]` (count + total content bytes) of {role,content} turns, and an
 * optional `system` string that is byte-clamped and trimmed to undefined when
 * empty. Returns the typed body or an HTTP status + message to reject with.
 */
export function validateChatBody(parsed: unknown): ValidationResult {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, message: "Request body must be a JSON object" };
  }
  const candidate = parsed as Record<string, unknown>;

  if (!Array.isArray(candidate.messages)) {
    return { ok: false, status: 400, message: "Request body must include messages[]" };
  }
  if (candidate.messages.length > MAX_MESSAGES) {
    return { ok: false, status: 413, message: `Too many messages (max ${MAX_MESSAGES})` };
  }

  let contentBytes = 0;
  for (const message of candidate.messages) {
    if (!isChatMessage(message)) {
      return {
        ok: false,
        status: 400,
        message: 'Each message must have role "user" or "assistant" and string content',
      };
    }
    contentBytes += encoder.encode(message.content).length;
    if (contentBytes > MAX_CONTENT_BYTES) {
      return {
        ok: false,
        status: 413,
        message: `Message content too large (max ${MAX_CONTENT_BYTES} bytes)`,
      };
    }
  }

  let system: string | undefined;
  if (candidate.system !== undefined) {
    if (typeof candidate.system !== "string") {
      return { ok: false, status: 400, message: "system must be a string" };
    }
    const encoded = encoder.encode(candidate.system);
    const bounded =
      encoded.length > MAX_SYSTEM_BYTES
        ? new TextDecoder().decode(encoded.slice(0, MAX_SYSTEM_BYTES))
        : candidate.system;
    system = bounded.trim().length === 0 ? undefined : bounded;
  }

  return { ok: true, body: { messages: candidate.messages as ChatMessage[], system } };
}
