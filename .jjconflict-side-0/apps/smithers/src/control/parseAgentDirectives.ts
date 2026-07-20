import type { AgentDirective } from "./agentTools";

/** A complete fenced action block: ```` ```smithers:action … ``` ````. */
const BLOCK = /```smithers:action\s*\n?([\s\S]*?)```/g;
/** An unterminated block still streaming in — stripped from the visible text. */
const TRAILING = /```smithers:action[\s\S]*$/;

/**
 * Split an assistant reply into the text the user sees and the directives the
 * agent emitted. Directives ride in a fenced `smithers:action` block as JSONL
 * (one JSON object per line); everything outside the block is the prose reply.
 * A half-streamed or malformed line is skipped rather than thrown.
 */
export function parseAgentDirectives(text: string): {
  cleanedText: string;
  directives: AgentDirective[];
} {
  const directives: AgentDirective[] = [];
  for (const match of text.matchAll(BLOCK)) {
    for (const line of match[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          typeof (parsed as { tool?: unknown }).tool === "string"
        ) {
          directives.push(parsed as AgentDirective);
        }
      } catch {
        // Not a complete JSON object yet (or malformed) — ignore this line.
      }
    }
  }
  const cleanedText = text.replace(BLOCK, "").replace(TRAILING, "").trim();
  return { cleanedText, directives };
}
