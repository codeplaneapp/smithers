export type NormalizedTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

const usageFieldAliases: Record<
  keyof NormalizedTokenUsage,
  ReadonlyArray<ReadonlyArray<string>>
> = {
  inputTokens: [
    ["inputTokens"],
    ["promptTokens"],
    ["prompt_tokens"],
    ["input_tokens"],
    ["input"],
    ["models", "gemini", "tokens", "input"],
  ],
  outputTokens: [
    ["outputTokens"],
    ["completionTokens"],
    ["completion_tokens"],
    ["output_tokens"],
    ["output"],
    ["models", "gemini", "tokens", "output"],
  ],
  cacheReadTokens: [
    ["cacheReadTokens"],
    ["cache_read_input_tokens"],
    ["cached_input_tokens"],
    ["cache_read_tokens"],
    ["inputTokenDetails", "cacheReadTokens"],
  ],
  cacheWriteTokens: [
    ["cacheWriteTokens"],
    ["cache_write_input_tokens"],
    ["cache_creation_input_tokens"],
    ["cache_write_tokens"],
    ["inputTokenDetails", "cacheWriteTokens"],
  ],
  reasoningTokens: [
    ["reasoningTokens"],
    ["reasoning_tokens"],
    ["outputTokenDetails", "reasoningTokens"],
  ],
  totalTokens: [
    ["totalTokens"],
    ["total_tokens"],
  ],
};

function readUsagePath(value: unknown, path: ReadonlyArray<string>): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function hasMeaningfulTokenUsage(usage: NormalizedTokenUsage): boolean {
  return Object.values(usage).some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
}

export function normalizeTokenUsage(
  usage: unknown,
): NormalizedTokenUsage | null {
  if (!usage || typeof usage !== "object") return null;

  const normalized: NormalizedTokenUsage = {};
  for (const [field, aliases] of Object.entries(usageFieldAliases) as Array<
    [keyof NormalizedTokenUsage, ReadonlyArray<ReadonlyArray<string>>]
  >) {
    for (const path of aliases) {
      const value = readUsagePath(usage, path);
      if (typeof value === "number") {
        normalized[field] = value;
        break;
      }
    }
  }

  return hasMeaningfulTokenUsage(normalized) ? normalized : null;
}
