import { Context } from "effect";
/** @typedef {import("./SmithersObservabilityService.ts").SmithersObservabilityService} SmithersObservabilityService */

/** @typedef {Context.ServiceClass.Shape<"SmithersObservability", SmithersObservabilityService>} SmithersObservability */
const SmithersObservabilityTag =
  /** @type {Context.ServiceClass<SmithersObservability, "SmithersObservability", SmithersObservabilityService>} */ (
    Context.Service()("SmithersObservability")
  );
export const SmithersObservability = /** @type {Context.ServiceClass<SmithersObservability, "SmithersObservability", SmithersObservabilityService>} */ (
  class SmithersObservability extends SmithersObservabilityTag {
    constructor(...args) {
      super(...args);
    }
  }
);
