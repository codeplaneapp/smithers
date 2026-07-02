const SNAKE_SEGMENT = /_([a-z0-9])/g;

function toCamelKey(key: string): string {
  return key.replace(SNAKE_SEGMENT, (_, char: string) => char.toUpperCase());
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  return value;
}

export function normalizeApiRow<Row extends Record<string, unknown>>(row: Row): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = toCamelKey(key);
    normalized[camelKey] = normalizeValue(value);
  }
  return normalized;
}
