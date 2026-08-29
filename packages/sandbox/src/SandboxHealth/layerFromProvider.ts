/**
 * Provides the provider-backed health service as a layer.
 *
 * @since 0.1.0
 */
import * as Layer from "effect/Layer"
import type { Provider } from "../RemoteChildProcessSpawner/Provider.ts"
import { fromProvider } from "./fromProvider.ts"
import type { ProbeOptions } from "./ProbeOptions.ts"
import { SandboxHealth } from "./SandboxHealth.ts"
import type { Service } from "./Service.ts"

/**
 * Layer form of {@link fromProvider}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFromProvider = (provider: Provider, options?: ProbeOptions): Layer.Layer<Service> =>
  Layer.sync(SandboxHealth, () => fromProvider(provider, options))
