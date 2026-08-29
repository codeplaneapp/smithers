import { z } from "zod"

export const APP_API_VERSION = 1 as const
export const APP_BOOTSTRAP_PATH = "/api/bootstrap"

export const RuntimeCapabilitySchema = z.enum([
  "agent",
  "identity",
  "jjhub",
  "billing.checkout",
  "keys.byok",
  "local.repositories",
  "local.repository-path-entry",
  "local.targets",
  "local.terminal",
  "local.harnesses"
])
export type RuntimeCapability = z.infer<typeof RuntimeCapabilitySchema>

export const AppBootstrapSchema = z.object({
  apiVersion: z.literal(APP_API_VERSION),
  host: z.enum(["cloud", "local"]),
  version: z.string(),
  buildSha: z.string(),
  capabilities: z.array(RuntimeCapabilitySchema),
  authFlow: z.enum(["redirect", "native-handoff", "both", "none"]),
  sandbox: z.object({
    platform: z.string(),
    mode: z.enum(["enforced", "trusted-only", "unavailable"])
  }).nullable()
})
export type AppBootstrap = z.infer<typeof AppBootstrapSchema>

export const hasCapability = (bootstrap: AppBootstrap, capability: RuntimeCapability): boolean =>
  bootstrap.capabilities.includes(capability)
