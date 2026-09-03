import { z } from "zod"

export const APP_API_VERSION = 1 as const
export const APP_BOOTSTRAP_PATH = "/api/bootstrap"

export const RuntimeCapabilitySchema = z.enum([
  "agent",
  "identity",
  "jjhub",
  "billing.checkout",
  "keys.byok",
  // Cloud doors a host serves itself, declared by the host that opens them
  // (packages/rpc/src/HostCapabilities.ts holds the per-host tables).
  "cloud.terminal", // this origin tunnels workspace terminals (/api/cloud-ws/*)
  "cloud.pat", // a host-held jjhub PAT session (/api/cloud-auth/*, the Linear loopback)
  "local.repositories",
  "local.repository-path-entry",
  "local.targets",
  "local.terminal",
  "local.harnesses",
  // The code-intelligence routes (/api/lsp/*, apps/ui/docs/code-intel/PLAN.md §3): a
  // local.* door, so `code.*` flows hide on the web and the refusal names the native app.
  "local.lsp"
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
