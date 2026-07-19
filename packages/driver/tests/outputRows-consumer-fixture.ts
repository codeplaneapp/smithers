import type { SmithersCtx } from "@smithers-orchestrator/driver";
import { z } from "zod";
const report = z.object({ title: z.string(), count: z.number() });
declare const ctx: SmithersCtx<{ report: typeof report }>;
const row = ctx.outputRows("report")[0];
row.payload.title satisfies string;
row.payload.count satisfies number;
// @ts-expect-error schema-derived payloads must reject incompatible fields
row.payload.count satisfies string;
const signal = ctx.signalRows("REVISE", { correlationId: "abc" })[0];
signal.signalName satisfies string;
signal.seq satisfies number;
signal.receivedAtMs satisfies number;
signal.correlationId satisfies string | undefined;
signal.payload satisfies unknown;
// @ts-expect-error signal seq is a number, not a string
signal.seq satisfies string;
