/**
 * Configured provider diagnostics and ownership-aware GitHub webhook reconciliation.
 * @since 1.0.0
 */
import * as Environment from "@smthrs/integrations/Environment"
import * as GitHub from "@smthrs/integrations/github"
import * as Linear from "@smthrs/integrations/linear"
import * as Telegram from "@smthrs/integrations/telegram"
import { Effect, Redacted } from "effect"
import { Cli, z } from "incur"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { withCredentials } from "./Credentials.ts"
import { execute, localFields, type LocalOptions, localRoot } from "./Store.ts"

const provider = z.enum(["github", "linear", "telegram"])
const endpoint = z.string().url().refine((text) => {
  const url = new URL(text)
  return ["http:", "https:"].includes(url.protocol) && url.username === "" && url.password === "" &&
    url.search === "" && url.hash === ""
}, "API endpoint must be HTTP(S), without credentials, query or fragment")
const entry = z.strictObject({
  id: z.string().min(1),
  provider,
  tokenEnv: z.string().min(1).optional(),
  credentialId: z.string().min(1).optional(),
  apiBaseUrl: endpoint.optional()
}).refine(
  (item) => item.tokenEnv === undefined || item.credentialId === undefined,
  "Use tokenEnv or credentialId, not both"
)
const configuration = z.strictObject({ version: z.literal(1), integrations: z.array(entry) })

/** One integration's public configuration, containing references rather than tokens.
 * @category models
 * @since 1.0.0
 */
export type Integration = z.infer<typeof entry>

const defaultTokenEnv = (kind: Integration["provider"]) =>
  kind === "github" ?
    "SMITHERS_GITHUB_TOKEN" :
    kind === "linear"
    ? "SMITHERS_LINEAR_API_KEY"
    : "SMITHERS_TELEGRAM_BOT_TOKEN"

/** Reads versioned provider configuration or discovers explicitly configured environment adapters.
 * @category configuration
 * @since 1.0.0
 */
export const readIntegrations = (
  root: string,
  file = ".smithers/integrations.json",
  env = Environment.ambientEnvironment()
): ReadonlyArray<Integration> => {
  const path = resolve(root, file)
  if (!existsSync(path)) {
    if (file !== ".smithers/integrations.json") throw new Error(`Integration configuration does not exist: ${file}`)
    return (["github", "linear", "telegram"] as const).flatMap((provider) => {
      const tokenEnv = provider === "github" && !env["SMITHERS_GITHUB_TOKEN"] && env["GITHUB_TOKEN"]
        ? "GITHUB_TOKEN"
        : defaultTokenEnv(provider)
      return env[tokenEnv] ||
          provider === "github" && existsSync(resolve(root, GitHub.ListenerRegistry.DEFAULT_REGISTRY_PATH))
        ? [{ id: provider, provider, tokenEnv }] :
        []
    })
  }
  const parsed = configuration.safeParse(JSON.parse(readFileSync(path, "utf8")))
  if (!parsed.success) {
    throw new Error(
      `Invalid integrations configuration: ${
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      }`
    )
  }
  const ids = parsed.data.integrations.map((item) => item.id)
  if (new Set(ids).size !== ids.length) throw new Error("Integration IDs must be unique")
  return parsed.data.integrations
}

const select = (entries: ReadonlyArray<Integration>, id?: string) => {
  if (id === undefined) return entries
  const selected = entries.filter((entry) => entry.id === id)
  if (selected.length === 0) throw new Error(`Unknown integration ${id}`)
  return selected
}

const secret = async (options: LocalOptions, entry: Integration): Promise<string> => {
  if (entry.credentialId !== undefined) {
    return withCredentials(options, (service) =>
      service.get(entry.credentialId!).pipe(
        Effect.flatMap(service.resolve),
        Effect.map(Redacted.value)
      ), true)
  }
  const envName = entry.tokenEnv ?? defaultTokenEnv(entry.provider)
  const value = process.env[envName]
  if (value === undefined || value.length === 0) throw new Error(`Missing credential environment variable ${envName}`)
  return value
}

/** Probes a provider through its real client, returning no credential or provider response body.
 * @category diagnostics
 * @since 1.0.0
 */
export const probe = async (entry: Integration, token: string, timeoutMs = 10_000) => {
  const operation = entry.provider === "github"
    ? GitHub.GitHubClient.make({ token, apiBaseUrl: entry.apiBaseUrl, maxRetries: 0 }, {}).request("GET", "/rate_limit")
    : entry.provider === "linear"
    ? Linear.LinearClient.make({ apiKey: token, apiBaseUrl: entry.apiBaseUrl }, {}).query(
      "query SmithersDoctor { viewer { id } }"
    )
    : Telegram.TelegramClient.make({ botToken: token, apiBaseUrl: entry.apiBaseUrl, maxRateLimitRetries: 0 }, {}).call(
      "getMe"
    )
  await Effect.runPromise(operation.pipe(Effect.timeout(timeoutMs)))
  return { id: entry.id, provider: entry.provider, healthy: true }
}

/** Builds provider discovery, diagnostics and the declared GitHub listener reconciler.
 * @category constructors
 * @since 1.0.0
 */
export const createIntegrationsCli = () => {
  const options = z.object({ ...localFields, config: z.string().default(".smithers/integrations.json") })
  const args = z.object({ id: z.string().optional() })
  return Cli.create("integrations", {
    description: "Inspect configured provider adapters and reconcile declared GitHub webhooks"
  })
    .command("list", {
      description: "List configured integrations and credential references without making requests",
      options,
      run: (context) =>
        execute(context, async () => readIntegrations(localRoot(context.options), context.options.config))
    })
    .command("doctor", {
      description: "Check configured credentials and probe provider authentication",
      args,
      options: options.extend({
        offline: z.boolean().default(false),
        timeoutMs: z.number().int().positive().default(10_000)
      }),
      run: (context) =>
        execute(context, async () => {
          const entries = select(readIntegrations(localRoot(context.options), context.options.config), context.args.id)
          const results = await Promise.all(entries.map(async (entry) => {
            try {
              const token = await secret(context.options, entry)
              return context.options.offline ?
                { id: entry.id, provider: entry.provider, healthy: true, check: "credential-present" } :
                { ...await probe(entry, token, context.options.timeoutMs), check: "provider-authentication" }
            } catch {
              // Provider error objects can carry nested request details; diagnostics report only inert identifiers.
              return {
                id: entry.id,
                provider: entry.provider,
                healthy: false,
                check: context.options.offline ? "credential-present" : "provider-authentication",
                error: "Credential lookup or provider authentication failed"
              }
            }
          }))
          if (results.some((result) => !result.healthy)) {
            return context.error({
              code: "integration_unhealthy",
              exitCode: 1,
              message: JSON.stringify({ healthy: false, integrations: results })
            })
          }
          return { healthy: true, integrations: results }
        })
    })
    .command("reconcile", {
      description: "Plan GitHub webhooks from .smithers/listeners.json; --apply writes owned hooks",
      args,
      options: options.extend({ apply: z.boolean().default(false), allowDelete: z.boolean().default(false) }),
      run: (context) =>
        execute(context, async () => {
          const root = localRoot(context.options)
          const entries = select(readIntegrations(root, context.options.config), context.args.id).filter((entry) =>
            entry.provider === "github"
          )
          if (entries.length !== 1) {
            throw new Error("Select exactly one configured GitHub integration for webhook reconciliation")
          }
          if (context.options.allowDelete && !context.options.apply) throw new Error("--allow-delete requires --apply")
          const item = entries[0]!
          const token = await secret(context.options, item)
          return Effect.runPromise(
            GitHub.ListenerRegistry.reconcile({
              workspaceRoot: root,
              token,
              apiBaseUrl: item.apiBaseUrl,
              env: process.env,
              apply: context.options.apply,
              allowDelete: context.options.allowDelete
            })
          )
        })
    })
}
