/**
 * Builds a health service from a remote provider's optional ping.
 *
 * @since 0.1.0
 */
import type { Provider } from "../RemoteChildProcessSpawner/Provider.ts"
import { make } from "./make.ts"
import { makeNoop } from "./makeNoop.ts"
import type { ProbeOptions } from "./ProbeOptions.ts"
import type { Service } from "./Service.ts"

/**
 * Probes the session a remote provider opened.
 *
 * `Provider.ping` is optional, so this is where the two cases meet. A provider
 * that answers a ping is probed under the usual deadline. A provider that has
 * no ping cannot be asked, so it gets the same service a host with no sandbox
 * at all gets ({@link makeNoop}): always `Healthy`. That is not a claim that
 * the session is alive; it says nothing is watching it, and supervision built
 * on such a provider will never fire. A provider that wants to be supervised
 * implements `ping`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromProvider = (provider: Provider, options?: ProbeOptions): Service =>
  provider.ping === undefined ? makeNoop() : make({ ping: provider.ping }, options)
