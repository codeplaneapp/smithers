import { parseUsageFromJson } from "./parseUsageFromJson.ts";
import { parseUsageFromSse } from "./parseUsageFromSse.ts";
import type { UsageSummary } from "./parseUsage.ts";

/** Only release a reservation when the provider supplied final usage. */
export function completedUsage(body: string, streaming: boolean): UsageSummary | null {
  try {
    if (!streaming) {
      const payload = JSON.parse(body);
      if (typeof payload?.usage?.input_tokens !== "number" || typeof payload?.usage?.output_tokens !== "number")
        return null;
      return parseUsageFromJson(body);
    }
    let input = false;
    let output = false;
    let stopped = false;
    for (const frame of body.split(/(?:\r?\n){2,}/)) {
      const lines = frame.split(/\r?\n/);
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      const payload = JSON.parse(data);
      if (payload.type === "message_start") input = typeof payload.message?.usage?.input_tokens === "number";
      if (payload.type === "message_delta") output = typeof payload.usage?.output_tokens === "number";
      if (payload.type === "message_stop") stopped = true;
      if (payload.type === "error") return null;
    }
    return input && output && stopped ? parseUsageFromSse(body) : null;
  } catch {
    return null;
  }
}
