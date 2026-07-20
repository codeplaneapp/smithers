import { Metric } from "effect";

export const openApiToolCallErrorsTotal = Metric.counter("smithers.openapi.tool_call_errors");
