import type { SmithersCtx } from "@smthrs/driver";

declare const ctx: SmithersCtx<unknown>;
const row = ctx.signalRows("REVISE")[0];
row.payload satisfies unknown;
row.signalName satisfies string;
row.seq satisfies number;
row.receivedAtMs satisfies number;
row.correlationId satisfies string | null;
// @ts-expect-error signal payloads are intentionally unknown, never widened to a concrete shape
row.payload.anything satisfies string;

const scoped = ctx.signalRows("REVISE", { correlationId: "rev-1" });
scoped satisfies Array<{
  payload: unknown;
  signalName: string;
  correlationId: string | null;
  seq: number;
  receivedAtMs: number;
}>;
