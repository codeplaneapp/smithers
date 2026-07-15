export class ExactlyOnceUnsupportedError extends Error { readonly code = "EXACTLY_ONCE_UNSUPPORTED"; constructor() { super("Exactly-once external effects are unsupported; use atLeastOnce(), idempotencyKey(), or journalCas()."); this.name = "ExactlyOnceUnsupportedError"; } }
type ResultLike = Readonly<{ readonly trace: readonly { readonly type: string; readonly data?: unknown }[]; readonly ambiguity: readonly { readonly outcome: string }[] }>;
type Assertion = Readonly<{ readonly name: string; readonly guarantee: string; readonly assert: (result: ResultLike) => void }>;
const effectEvents = (result: ResultLike, name: string) => result.trace.filter((event) => event.type === "effect" && (event.data as { name?: unknown } | undefined)?.name === name);
const assertion = (name: string, guarantee: string, check: (events: number, result: ResultLike) => boolean, message: string): Assertion => Object.freeze({ name, guarantee, assert: (result) => { const events = effectEvents(result, name).filter((event) => (event.data as { state?: unknown } | undefined)?.state === "resolved").length; if (!check(events, result)) throw new Error(`${guarantee} assertion failed for ${name}: ${message}`); } });
export const expectEffect = (name: string) => ({
  name,
  exactlyOnce: (): never => { throw new ExactlyOnceUnsupportedError(); },
  atLeastOnce: (result?: ResultLike): Assertion => { const value = assertion(name, "at-least-once", (events) => events >= 1, "no mediated effect resolution was observed"); if (result) value.assert(result); return value; },
  atMostOnceJournaled: (result?: ResultLike): Assertion => { const value = assertion(name, "journaled-at-most-once", (events) => events <= 1 && events >= 1, "durable completion was absent or duplicated"); if (result) value.assert(result); return value; },
  idempotencyKey: (key: string, result?: ResultLike): Assertion & Readonly<{ readonly key: string }> => { const value = Object.freeze({ ...assertion(name, "idempotency-key", (events) => events >= 1, "no mediated effect resolution was observed"), key }); if (result) value.assert(result); return value; },
  journalCas: (result?: ResultLike): Assertion => { const value = assertion(name, "journal-cas", (events) => events >= 1 && events <= 1, "journal CAS did not produce one terminal observation"); if (result) value.assert(result); return value; },
});
export const expectTrace = (predicate: (event: ResultLike["trace"][number]) => boolean, message = "trace predicate did not match"): ((result: ResultLike) => void) => (result) => { if (!result.trace.some(predicate)) throw new Error(`trace assertion failed: ${message}`); };
export const expectAmbiguity = (outcome: string): ((result: ResultLike) => void) => (result) => { if (!result.ambiguity.some((item) => item.outcome === outcome)) throw new Error(`ambiguity assertion failed: ${outcome}`); };
