export type ApiChatMessage = {
  role: "user" | "assistant";
  content: string;
};

/**
 * Stream a chat reply from the Cloudflare Worker backend (POST /api/chat). The
 * Worker runs Cerebras server-side and returns Server-Sent Events; this parses
 * those events and yields the assistant's answer one delta at a time.
 *
 * Drop-in for the client-side `streamCerebrasReply` but with no API key — the
 * key lives only on the Worker. `signal` cancels the in-flight request.
 */
export async function* streamReplyViaApi({
  messages,
  system,
  signal,
  endpoint = "/api/chat",
}: {
  messages: ApiChatMessage[];
  system?: string;
  signal?: AbortSignal;
  endpoint?: string;
}): AsyncGenerator<string> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, system }),
    signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Chat request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        return;
      }
      let chunk: { type?: string; delta?: unknown; message?: unknown };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.type === "TEXT_MESSAGE_CONTENT" && typeof chunk.delta === "string") {
        yield chunk.delta;
      } else if (chunk.type === "RUN_ERROR") {
        throw new Error(
          typeof chunk.message === "string" ? chunk.message : "Chat failed.",
        );
      }
    }
  }
}
