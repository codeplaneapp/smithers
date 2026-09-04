/**
 * Constructs sandbox health services.
 *
 * @since 0.1.0
 */
import type { PingProvider } from "./PingProvider.ts"
import { probe } from "./probe.ts"
import type { ProbeOptions } from "./ProbeOptions.ts"
import { SandboxHealth } from "./SandboxHealth.ts"
import type { Service } from "./Service.ts"

/**
 * Builds the service from a provider's ping capability.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (provider: PingProvider, options?: ProbeOptions): Service =>
  SandboxHealth.of({ check: probe(provider, options) })
