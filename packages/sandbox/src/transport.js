// @smithers-type-exports-begin
/** @typedef {import("./SandboxBundleResult.ts").SandboxBundleResult} SandboxBundleResult */
/** @typedef {import("./SandboxHandle.ts").SandboxHandle} SandboxHandle */
/** @typedef {import("./SandboxTransportConfig.ts").SandboxTransportConfig} SandboxTransportConfig */
/** @typedef {import("./SandboxTransportService.ts").SandboxTransportService} SandboxTransportService */
// @smithers-type-exports-end

import { Context, Effect, Layer } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { CodeplaneSandboxExecutorLive, DockerSandboxExecutorLive } from "./effect/http-runner.js";
import { makeSandboxTransportServiceEffect, SandboxEntityExecutor } from "./effect/sandbox-entity.js";
import { BubblewrapSandboxExecutorLive } from "./effect/socket-runner.js";
/** @typedef {import("./SandboxRuntime.ts").SandboxRuntime} SandboxRuntime */

export { SandboxEntityExecutor };

/** @typedef {Context.ServiceClass.Shape<"SandboxTransport", SandboxTransportService>} SandboxTransport */
/** @typedef {Context.ServiceClass<SandboxTransport, "SandboxTransport", SandboxTransportService> & { new(): SandboxTransport }} SandboxTransportClass */
const SandboxTransportTag =
  /** @type {Context.ServiceClass<SandboxTransport, "SandboxTransport", SandboxTransportService>} */ (
    Context.Service()("SandboxTransport")
  );
export const SandboxTransport = /** @type {SandboxTransportClass} */ (
  class SandboxTransport extends SandboxTransportTag {
    // Explicit constructor (identical to the implicit one) so runtime
    // construction is observable; JSC never records implicit constructors.
    constructor(...args) {
      super(...args);
    }
  }
);
/**
 * @template R, E
 * @param {Layer.Layer<SandboxEntityExecutor, E, R>} executorLayer
 * @returns {Layer.Layer<SandboxTransport, E, R>}
 */
export function makeSandboxTransportLayer(executorLayer) {
  return Layer.effect(
    SandboxTransport,
    makeSandboxTransportServiceEffect(executorLayer).pipe(Effect.map((service) => SandboxTransport.of(service))),
  );
}
/**
 * @param {SandboxRuntime} runtime
 */
export function layerForSandboxRuntime(runtime) {
  switch (runtime) {
    case "docker":
      return makeSandboxTransportLayer(DockerSandboxExecutorLive);
    case "codeplane":
      return makeSandboxTransportLayer(CodeplaneSandboxExecutorLive);
    case "cloudflare":
      throw new SmithersError(
        "INVALID_INPUT",
        'Sandbox runtime "cloudflare" requires a provider from smithers-orchestrator/cloudflare, e.g. createCloudflareSandboxProvider().',
        {
          runtime,
        },
      );
    case "bubblewrap":
      return makeSandboxTransportLayer(BubblewrapSandboxExecutorLive);
    default:
      throw new SmithersError("INVALID_INPUT", `Unsupported sandbox runtime: ${String(runtime)}`, {
        runtime,
      });
  }
}
/**
 * @param {SandboxRuntime} requested
 * @returns {SandboxRuntime}
 */
export function resolveSandboxRuntime(requested) {
  if (requested !== "docker" && requested !== "codeplane" && requested !== "bubblewrap" && requested !== "cloudflare") {
    throw new SmithersError("INVALID_INPUT", `Unsupported sandbox runtime: ${String(requested)}`, {
      runtime: requested,
    });
  }
  return requested;
}
