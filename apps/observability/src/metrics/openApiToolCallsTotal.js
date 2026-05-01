import { Metric } from "effect";

export const openApiToolCallsTotal = Metric.counter("smithers.openapi.tool_calls");
