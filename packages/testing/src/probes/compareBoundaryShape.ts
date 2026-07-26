export type BoundaryShape = Readonly<{
  readonly name: string;
  readonly className: string;
  readonly tag?: string;
  readonly code?: string;
  readonly message?: string;
  readonly summary?: string;
  readonly hasCause: boolean;
  readonly cause?: BoundaryShape;
  readonly details?: unknown;
  readonly detailsKeys: readonly string[];
  readonly docsUrl?: string;
  readonly serialized?: unknown;
}>;
const publicErrorFields = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    ["name", "message", "code", "tag", "summary", "details", "docsUrl", "cause"]
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
const ownErrorField = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.get ? descriptor.get.call(value) : descriptor?.value;
};
const boundarySerializable = (value: unknown, seen = new Set<object>()): unknown => {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const record = value as Record<string, unknown>;
  return publicErrorFields({
    name: ownErrorField(record, "name"),
    message: ownErrorField(record, "message"),
    code: ownErrorField(record, "code"),
    tag: ownErrorField(record, "tag"),
    summary: ownErrorField(record, "summary"),
    details: ownErrorField(record, "details"),
    docsUrl: ownErrorField(record, "docsUrl"),
    cause:
      ownErrorField(record, "cause") === undefined
        ? undefined
        : boundarySerializable(ownErrorField(record, "cause"), seen),
  });
};
export const boundaryShape = (error: unknown, serialized?: unknown): BoundaryShape => {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const name = ownErrorField(value, "name") ?? value.name;
  const message = ownErrorField(value, "message") ?? value.message;
  const causeValue = ownErrorField(value, "cause") ?? value.cause;
  const details = ownErrorField(value, "details") ?? value.details;
  const cause = causeValue === undefined ? undefined : boundaryShape(causeValue);
  const nativeSerialized = serialized ?? (error instanceof Error ? boundarySerializable(error) : undefined);
  return {
    name: String(name ?? "Error"),
    className: error && typeof error === "object" ? String((error as object).constructor?.name ?? "Object") : "Error",
    ...(value.tag === undefined ? {} : { tag: String(value.tag) }),
    ...(value.code === undefined ? {} : { code: String(value.code) }),
    ...(message === undefined ? {} : { message: String(message) }),
    ...(value.summary === undefined ? {} : { summary: String(value.summary) }),
    hasCause: causeValue !== undefined,
    ...(cause ? { cause } : {}),
    ...(details === undefined ? {} : { details }),
    detailsKeys: details && typeof details === "object" ? Object.keys(details).sort() : [],
    ...(value.docsUrl === undefined ? {} : { docsUrl: String(value.docsUrl) }),
    ...(nativeSerialized === undefined ? {} : { serialized: nativeSerialized }),
  };
};
const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || !a || !b || typeof a !== "object") return false;
  const ak = Object.keys(a as object).sort(),
    bk = Object.keys(b as object).sort();
  return (
    ak.length === bk.length &&
    ak.every(
      (key, index) =>
        key === bk[index] && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
};
export const compareBoundaryShape = (expected: BoundaryShape, actual: BoundaryShape): readonly string[] => {
  const fields = [
    "name",
    "className",
    "tag",
    "code",
    "message",
    "summary",
    "hasCause",
    "details",
    "detailsKeys",
    "docsUrl",
    "serialized",
  ] as const;
  const differences = fields
    .filter((field) => !equal(expected[field], actual[field]))
    .map((field) => field + " differs");
  if (!equal(expected.cause, actual.cause)) differences.push("cause differs");
  return differences;
};
