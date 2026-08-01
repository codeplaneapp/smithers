import { Context } from "effect";
/** @typedef {import("./SmithersObservabilityService.ts").SmithersObservabilityService} SmithersObservabilityService */

const _SmithersObservabilityBase =
  /** @type {Context.ServiceClass<SmithersObservability, "SmithersObservability", SmithersObservabilityService>} */ (
    /** @type {unknown} */ (Context.Service("SmithersObservability"))
  );
export class SmithersObservability extends _SmithersObservabilityBase {}
