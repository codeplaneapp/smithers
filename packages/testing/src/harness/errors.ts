import { toHarnessError, type HarnessError } from "../kernel/boundary.ts";
export class SimulationError extends Error {
  readonly fidelity = "simulation";
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SimulationError";
  }
}
export const normalizeHarnessError = (error: unknown): HarnessError => toHarnessError(error);

/**
 * Reusable harness-native simulation error doubles.
 *
 * A simulation double never mutates an instance's `constructor` or otherwise
 * forges identity per test: each production class name gets ONE cached
 * simulation class genuinely carrying that name, instances carry a
 * non-enumerable `fidelity: "simulation"` marker, and the parity probes in
 * e2e/testing-framework are the only mechanism that certifies these shapes
 * against the real production errors — drift turns the probe red.
 */
const simulationClasses = new Map<string, new (message: string) => Error>();
const simulationClass = (className: string): new (message: string) => Error => {
  let ctor = simulationClasses.get(className);
  if (!ctor) {
    ctor = class extends Error {};
    Object.defineProperty(ctor, "name", { value: className });
    // Native platform errors carry `name` on the prototype, not as an own
    // instance field; the double mirrors that so own-field serialization
    // compares faithfully. A spec.name still creates an own field, matching
    // production classes (like SmithersError) that assign name per instance.
    Object.defineProperty(ctor.prototype, "name", {
      value: className,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    simulationClasses.set(className, ctor);
  }
  return ctor;
};
export type SimulationNativeErrorSpec = Readonly<{
  readonly className: string;
  readonly message: string;
  readonly name?: string;
  readonly code?: string;
  readonly summary?: string;
  readonly details?: unknown;
  readonly docsUrl?: string;
  readonly cause?: unknown;
  /** Extra native own-fields (for example SQLite `errno`). */
  readonly extra?: Readonly<Record<string, unknown>>;
}>;
export const simulationNativeError = (spec: SimulationNativeErrorSpec): Error => {
  const error = new (simulationClass(spec.className))(spec.message) as Error & Record<string, unknown>;
  if (spec.name !== undefined) error.name = spec.name;
  if (spec.code !== undefined) error.code = spec.code;
  if (spec.summary !== undefined) error.summary = spec.summary;
  if (spec.details !== undefined) error.details = spec.details;
  if (spec.docsUrl !== undefined) error.docsUrl = spec.docsUrl;
  if (spec.cause !== undefined) error.cause = spec.cause;
  for (const [key, value] of Object.entries(spec.extra ?? {})) error[key] = value;
  Object.defineProperty(error, "fidelity", { value: "simulation", enumerable: false });
  return error;
};
/**
 * Simulation double for the production `SmithersError` boundary shape:
 * `message = summary + " See " + docsUrl` with own name/code/summary/docsUrl/
 * details/cause fields, mirroring packages/errors SmithersError.
 */
export const simulationSmithersError = (
  code: string,
  summary: string,
  options: Readonly<{
    readonly details?: unknown;
    readonly cause?: unknown;
    readonly docsUrl?: string;
    readonly name?: string;
  }> = {},
): Error => {
  const docsUrl = options.docsUrl ?? "https://smithers.sh/reference/errors";
  return simulationNativeError({
    className: "SmithersError",
    name: options.name ?? "SmithersError",
    message: summary.includes(docsUrl) ? summary : `${summary} See ${docsUrl}`,
    code,
    summary,
    docsUrl,
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });
};
/**
 * Canonical boundary serialization used on BOTH sides of a parity probe so the
 * `serialized` comparison covers what consumers actually receive: public
 * name/message/code/summary/details/docsUrl plus the recursive cause chain,
 * plus every remaining own enumerable native field (for example SQLite `errno`
 * and `byteOffset`) under `native` — family-specific native drift must fail
 * parity, not slip through a fixed field list. `details` and `native` are JSON
 * round-tripped, matching durable/wire delivery.
 */
/**
 * Independent simulation-side implementation of the durable error-JSON
 * contract: the shape production consumers receive from packages/errors
 * `errorToJson` on the engine's durable failed-task write path. This is
 * deliberately NOT shared with production code — parity probes serialize the
 * production error through the real `errorToJson` and the simulation double
 * through THIS serializer, then compare normalized outputs (stacks excluded),
 * so drift in either implementation turns the probe red instead of being
 * normalized away by one shared serializer.
 */
const durableJsonSafe = (value: unknown, seen: WeakSet<object>): unknown => {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") return Number.isFinite(value as number) ? value : null;
  if (type === "bigint") return (value as bigint).toString();
  if (type === "undefined" || type === "function" || type === "symbol") return undefined;
  const record = value as object;
  if (seen.has(record)) return "[Circular]";
  seen.add(record);
  try {
    if (record instanceof Error) {
      const out: Record<string, unknown> = { name: record.name, message: record.message, stack: record.stack };
      if (record.cause !== undefined) out.cause = durableJsonSafe(record.cause, seen);
      for (const key of Object.keys(record)) {
        if (key in out) continue;
        const safe = durableJsonSafe((record as unknown as Record<string, unknown>)[key], seen);
        if (safe !== undefined) out[key] = safe;
      }
      return out;
    }
    if (Array.isArray(record))
      return record.map((item) => {
        const safe = durableJsonSafe(item, seen);
        return safe === undefined ? null : safe;
      });
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      const safe = durableJsonSafe(entry, seen);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  } finally {
    seen.delete(record);
  }
};
export const serializeSimulationDurableError = (value: unknown): unknown => {
  if (value instanceof Error && value.constructor?.name === "SmithersError") {
    const error = value as Error & { code?: unknown; summary?: unknown; docsUrl?: unknown; details?: unknown };
    return durableJsonSafe(
      {
        name: error.name,
        code: error.code,
        message: error.message,
        stack: error.stack,
        cause: error.cause,
        summary: error.summary,
        docsUrl: error.docsUrl,
        details: error.details,
      },
      new WeakSet(),
    );
  }
  return durableJsonSafe(value, new WeakSet());
};
const BOUNDARY_KNOWN_FIELDS = new Set([
  "name",
  "message",
  "code",
  "summary",
  "details",
  "docsUrl",
  "cause",
  "stack",
  "fidelity",
  "serialized",
]);
export const serializeBoundaryError = (value: unknown): unknown => {
  if (!(value instanceof Error)) return value;
  const error = value as Error & {
    code?: unknown;
    summary?: unknown;
    details?: unknown;
    docsUrl?: unknown;
    cause?: unknown;
  };
  const native: Record<string, unknown> = {};
  for (const key of Object.keys(error).sort()) {
    const field = (error as unknown as Record<string, unknown>)[key];
    if (BOUNDARY_KNOWN_FIELDS.has(key) || typeof field === "function" || field === undefined) continue;
    native[key] = field;
  }
  return {
    name: error.name,
    message: error.message,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.summary === undefined ? {} : { summary: error.summary }),
    ...(error.details === undefined ? {} : { details: JSON.parse(JSON.stringify(error.details ?? null)) }),
    ...(error.docsUrl === undefined ? {} : { docsUrl: error.docsUrl }),
    ...(Object.keys(native).length === 0 ? {} : { native: JSON.parse(JSON.stringify(native)) }),
    ...(error.cause === undefined ? {} : { cause: serializeBoundaryError(error.cause) }),
  };
};
