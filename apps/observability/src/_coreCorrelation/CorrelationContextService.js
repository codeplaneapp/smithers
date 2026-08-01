import { Context } from "effect";
/** @typedef {import("./CorrelationContextServiceShape.ts").CorrelationContextServiceShape} CorrelationContextServiceShape */

const _CorrelationContextServiceBase =
  /** @type {Context.ServiceClass<CorrelationContextService, "CorrelationContextService", CorrelationContextServiceShape>} */ (
    /** @type {unknown} */ (Context.Service("CorrelationContextService"))
  );
export class CorrelationContextService extends _CorrelationContextServiceBase {}
