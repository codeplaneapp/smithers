import type { TraceEvent } from "../trace/TraceEvent.ts";
export type Divergence = Readonly<{
  readonly index: number;
  readonly sequence: number;
  readonly controlIndex?: number;
  readonly field?: string;
  readonly left?: TraceEvent;
  readonly right?: TraceEvent;
  readonly message: string;
}>;
const firstField = (left: unknown, right: unknown): string | undefined => {
  if (Object.is(left, right)) return undefined;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return "value";
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.find(
    (key) =>
      JSON.stringify((left as Record<string, unknown>)[key]) !==
      JSON.stringify((right as Record<string, unknown>)[key]),
  );
};
export const firstDivergence = (left: readonly TraceEvent[], right: readonly TraceEvent[]): Divergence | null => {
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const field = firstField(left[i], right[i]);
    if (field !== undefined || (left[i] === undefined) !== (right[i] === undefined)) {
      const leftIndex = (left[i]?.data as { controlIndex?: unknown } | undefined)?.controlIndex;
      const rightIndex = (right[i]?.data as { controlIndex?: unknown } | undefined)?.controlIndex;
      const controlIndex =
        typeof leftIndex === "number" ? leftIndex : typeof rightIndex === "number" ? rightIndex : undefined;
      return {
        index: i,
        sequence: left[i]?.seq ?? right[i]?.seq ?? i,
        ...(controlIndex === undefined ? {} : { controlIndex }),
        field,
        left: left[i],
        right: right[i],
        message: `trace divergence at event ${i}${controlIndex === undefined ? "" : ` (control ${controlIndex})`}${field ? ` (${field})` : ""}`,
      };
    }
  }
  return null;
};
