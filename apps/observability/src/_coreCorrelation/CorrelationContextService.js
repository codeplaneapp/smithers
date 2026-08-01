import { Context } from "effect";
/** @typedef {import("./CorrelationContextServiceShape.ts").CorrelationContextServiceShape} CorrelationContextServiceShape */

/** @typedef {Context.ServiceClass.Shape<"CorrelationContextService", CorrelationContextServiceShape>} CorrelationContextService */
const CorrelationContextServiceTag =
  /** @type {Context.ServiceClass<CorrelationContextService, "CorrelationContextService", CorrelationContextServiceShape>} */ (
    Context.Service()("CorrelationContextService")
  );
export const CorrelationContextService = /** @type {Context.ServiceClass<CorrelationContextService, "CorrelationContextService", CorrelationContextServiceShape>} */ (
  class CorrelationContextService extends CorrelationContextServiceTag {
    constructor(...args) {
      super(...args);
    }
  }
);
