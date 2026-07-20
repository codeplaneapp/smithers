/** Safely pretty-print JSON values, including BigInt and unserializable input. */
export function formatJsonSafe(value: unknown): string {
  try {
    const formatted = JSON.stringify(
      value,
      (_key, current) => typeof current === "bigint" ? `${current}n` : current,
      2,
    );
    return formatted === undefined ? String(value) : formatted;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[unserializable: ${message}]`;
  }
}
