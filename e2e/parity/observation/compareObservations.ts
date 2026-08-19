import type { ParityObservation } from "../ParityObservation.ts";

/**
 * Structural diff between two parity observations.
 *
 * `bun:test`'s `toEqual` already fails a mismatch, but its output on a nested
 * observation is hard to act on. This produces one line per divergence with
 * the JSON path, which is what a lane owner reads when the flows engine
 * diverges from the recorded legacy oracle.
 */

export type ParityDifference = {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
};

export function diffObservations(
  expected: ParityObservation,
  actual: ParityObservation,
): ParityDifference[] {
  const differences: ParityDifference[] = [];
  walk("", expected as unknown, actual as unknown, differences);
  return differences;
}

export function formatParityDifferences(
  differences: readonly ParityDifference[],
  expectedLabel: string,
  actualLabel: string,
): string {
  if (differences.length === 0) return "";
  const lines = differences.map(
    (difference) =>
      `  ${difference.path || "<root>"}\n` +
      `    ${expectedLabel}: ${render(difference.expected)}\n` +
      `    ${actualLabel}:   ${render(difference.actual)}`,
  );
  return `${differences.length} parity difference(s):\n${lines.join("\n")}`;
}

function walk(path: string, expected: unknown, actual: unknown, out: ParityDifference[]): void {
  if (Object.is(expected, actual)) return;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      out.push({ path, expected, actual });
      return;
    }
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      walk(`${path}[${index}]`, expected[index], actual[index], out);
    }
    return;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      walk(path ? `${path}.${key}` : key, expected[key], actual[key], out);
    }
    return;
  }
  out.push({ path, expected, actual });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function render(value: unknown): string {
  if (value === undefined) return "<absent>";
  return JSON.stringify(value);
}
