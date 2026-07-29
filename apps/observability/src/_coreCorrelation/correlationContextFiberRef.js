import { Context } from "effect";

export const correlationContextFiberRef = Context.Reference("smithers/observability/correlation-context", {
  defaultValue: () => undefined,
});
