const smithersToolMetadata = Symbol.for("smithers.tool.metadata");

export function getDefinedToolMetadata(value: unknown):
  | {
      name: string;
      sideEffect: boolean;
      idempotent: boolean;
    }
  | null {
  return value && typeof value === "object"
    ? ((value as any)[smithersToolMetadata] ?? null)
    : null;
}
