import type { RuntimeCapability } from "./AppBootstrap"

/**
 * The one place each host's bootstrap capability list is spelled out.
 *
 * The Worker (`apps/server/src/index.ts`, host `cloud`) and the Bun server
 * (`apps/ui/src/bun/server.ts`, host `local`) call these with what they have
 * configured, and the parity test builds its registries from the same two
 * functions, so the matrix cannot drift from production. Each table is the
 * emission order; a row is kept only when its flag is on.
 */

/** What the Worker has configured. `terminal` is the W4 relay; it stays false until that lane lands. */
export interface CloudCapabilityEnv {
  readonly identity: boolean
  readonly jjhub: boolean
  readonly agent: boolean
  readonly checkout: boolean
  readonly terminal: boolean
}

/** What a Bun launch has configured. `jjhub` is the cloud upstream; offline launches have none. */
export interface LocalCapabilityOptions {
  readonly agent: boolean
  readonly identity: boolean
  readonly jjhub: boolean
  readonly pathEntry: boolean
}

const present = (rows: ReadonlyArray<readonly [RuntimeCapability, boolean]>): Array<RuntimeCapability> =>
  rows.filter(([, on]) => on).map(([capability]) => capability)

/** The Worker never emits `cloud.pat`: it holds no PAT session; the GitHub cookie is its only identity. */
export const cloudCapabilities = (env: CloudCapabilityEnv): Array<RuntimeCapability> =>
  present([
    ["agent", env.agent],
    ["identity", env.identity],
    ["jjhub", env.jjhub],
    ["billing.checkout", env.checkout],
    ["cloud.terminal", env.terminal]
  ])

/**
 * Both cloud doors ride the jjhub upstream: without one, the Bun server
 * answers 501 on `/api/cloud-auth/*` and on the `/api/cloud-ws/` tunnel, so
 * claiming either would name a door the host has closed.
 */
export const localCapabilities = (opts: LocalCapabilityOptions): Array<RuntimeCapability> =>
  present([
    ["agent", opts.agent],
    ["identity", opts.identity],
    ["jjhub", opts.jjhub],
    ["cloud.terminal", opts.jjhub],
    ["cloud.pat", opts.jjhub],
    ["local.repositories", true],
    ["local.repository-path-entry", opts.pathEntry],
    ["local.targets", true],
    ["local.terminal", true],
    ["local.harnesses", true],
    // The door is the routes, which every Bun launch serves; a missing language
    // server is stated per file with its install line, never as a closed door.
    ["local.lsp", true]
  ])
