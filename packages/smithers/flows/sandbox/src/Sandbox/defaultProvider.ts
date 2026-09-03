/**
 * The provider a host composes when nothing names one.
 *
 * Microsandbox is the default: a microVM holds the workspace's declared Nix
 * environment (`MicrosandboxSandbox.make({ environment })`), which no
 * directory or container provider can promise. Every other provider stays
 * selectable by name, so a host without microVMs names `directory` or
 * `container` and gets exactly that.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "./Provider.ts"

/**
 * The names a provider is selected by.
 *
 * @category models
 * @since 0.1.0
 */
export type ProviderName =
  | "microsandbox"
  | "directory"
  | "container"
  | "kubernetes"
  | "just-bash"
  | "vercel"
  | "daytona"
  | "aws"
  | "cloudflare"

/**
 * The provider selected when none is named.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultProviderName: ProviderName = "microsandbox"

/**
 * The providers a host has composed, by name. A host registers only what it
 * can actually boot.
 *
 * @category models
 * @since 0.1.0
 */
export type ProviderRegistry = { readonly [Name in ProviderName]?: Provider | undefined }

/**
 * Selects the named provider, or the default when no name is given. A name
 * the registry does not hold fails with `unavailable`, listing what it does
 * hold, so a missing default is a typed refusal rather than a silent fall
 * back to a weaker sandbox.
 *
 * @category selection
 * @since 0.1.0
 */
export const selectProvider = (
  registry: ProviderRegistry,
  name: ProviderName | undefined = undefined
): Effect.Effect<Provider, ProviderError> => {
  const selected = name ?? defaultProviderName
  const provider = registry[selected]
  if (provider !== undefined) return Effect.succeed(provider)
  const registered = Object.keys(registry).filter((key) => registry[key as ProviderName] !== undefined).sort()
  const what = name === undefined ? `the default provider ${selected}` : `the provider ${selected}`
  return Effect.fail(
    new ProviderError({
      code: "unavailable",
      message: `sandbox: ${what} is not registered on this host; ` +
        `registered: ${registered.length === 0 ? "none" : registered.join(", ")}`
    })
  )
}
