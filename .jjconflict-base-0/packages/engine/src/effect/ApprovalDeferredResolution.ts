import type { Schema } from "effect";

/**
 * Mirrors the shape of the approvalDurableDeferredSuccessSchema defined in
 * durable-deferred-bridge.js. Kept in sync with the runtime schema.
 */
export type ApprovalDeferredResolution = Schema.Schema.Type<
	Schema.Struct<{
		approved: typeof Schema.Boolean;
		note: Schema.NullOr<typeof Schema.String>;
		decidedBy: Schema.NullOr<typeof Schema.String>;
	}>
>;
