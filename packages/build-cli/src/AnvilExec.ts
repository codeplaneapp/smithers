/**
 * Planning and service-spec helpers for `S.Anvil.Fork`.
 *
 * An Anvil fork is a supervised service, so this module resolves the host
 * `anvil` binary (with the typed host refusal as identity when absent) and
 * renders the fork declaration into a supervisor spec: loopback bind,
 * port readiness, and the RPC secret resolved at spawn. The spawn argv
 * carries the secret value while the canonical argv redacts it, so the
 * supervisor's identity comparison never sees the credential.
 *
 * @since 0.1.0
 */
import type * as Anvil from "@smthrs/targets/Anvil"
import * as PackageTree from "./PackageTree.ts"
import type * as ServiceSupervisor from "./ServiceSupervisor.ts"

/**
 * Resolves anvil and returns the identity used by the package key.
 *
 * @category planning
 * @since 0.1.0
 */
export const resolveAnvil = async () => {
  const path = PackageTree.findOnPath("anvil")
  if (path === undefined) {
    return {
      ok: false as const,
      refusal: "host binary \"anvil\" is not present on PATH",
      identity: { tag: "Anvil", absent: true }
    }
  }
  const probe = await PackageTree.probeVersion(path)
  return { ok: true as const, path, identity: { tag: "Anvil", path, probe } }
}

/**
 * Resolves one fork target to the scoped service supervisor.
 *
 * @category planning
 * @since 0.1.0
 */
export const serviceSpec = async (options: {
  readonly label: string
  readonly cwd: string
  readonly attrs: (typeof Anvil.ForkAttrs)["Type"]
  readonly environment: Readonly<Record<string, string | undefined>>
}): Promise<ServiceSupervisor.ServiceSpec | { readonly error: string }> => {
  const tool = await resolveAnvil()
  if (!tool.ok) return { error: tool.refusal }
  const forkUrl = options.environment[options.attrs.forkUrl.env] ?? options.attrs.forkUrl.fallback
  if (forkUrl === undefined || forkUrl === "") {
    return {
      error:
        `missing secret: environment variable ${options.attrs.forkUrl.env} is not set for Anvil.Fork ${options.label}`
    }
  }
  const argv: Array<string> = [
    tool.path,
    "--host",
    "127.0.0.1",
    "--port",
    String(options.attrs.port),
    "--fork-url",
    forkUrl
  ]
  if (options.attrs.forkBlockNumber !== "latest") {
    argv.push("--fork-block-number", String(options.attrs.forkBlockNumber))
  }
  return {
    key: options.label,
    cwd: options.cwd,
    argv: argv as [string, ...Array<string>],
    canonicalArgv: argv.map((entry) => entry === forkUrl ? `{secret:${options.attrs.forkUrl.env}}` : entry) as [
      string,
      ...Array<string>
    ],
    readiness: { port: options.attrs.port },
    stop: { signal: "SIGTERM", grace: "5s" }
  }
}
