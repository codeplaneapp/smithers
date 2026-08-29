/*
 * The Node sidecar probe (LOCAL-APP.md, "Targets: load and run"). The
 * `smthrs` loader runs under Node >= 22.19, and a Finder launch gets the
 * launchd PATH, so the probe walks explicit candidates rather than trusting
 * PATH alone. Every host read is injectable so the order and the version gate
 * can be asserted without a machine's node installs.
 */
import { readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

export const MIN_NODE_VERSION = "22.19.0"

export interface NodeSidecar {
  readonly path: string
  readonly version: string
}

export interface NodeProbeHost {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  /** Entries of a directory, or [] when it does not exist. */
  readonly listDir: (dir: string) => ReadonlyArray<string>
  readonly isFile: (path: string) => boolean
  /** `node --version` for the candidate, or null when it cannot run. */
  readonly version: (path: string) => Promise<string | null>
}

const parseVersion = (raw: string): [number, number, number] | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export const compareVersions = (left: string, right: string): number => {
  const a = parseVersion(left) ?? [0, 0, 0]
  const b = parseVersion(right) ?? [0, 0, 0]
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0)
  }
  return 0
}

export const meetsMinimum = (version: string): boolean => compareVersions(version, MIN_NODE_VERSION) >= 0

const nvmCandidates = (host: NodeProbeHost): ReadonlyArray<string> => {
  const root = join(host.home, ".nvm", "versions", "node")
  return [...host.listDir(root)]
    .filter((entry) => parseVersion(entry) !== null)
    .sort((left, right) => compareVersions(right, left))
    .map((entry) => join(root, entry, "bin", "node"))
}

const fnmCandidates = (host: NodeProbeHost): ReadonlyArray<string> => {
  const root = join(host.home, ".local", "share", "fnm")
  const found: Array<string> = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    for (const entry of host.listDir(dir)) {
      const child = join(dir, entry)
      if (entry === "bin") {
        const node = join(child, "node")
        if (host.isFile(node)) found.push(node)
        continue
      }
      walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return found.sort((left, right) => compareVersions(right, left))
}

/**
 * The probe order: SMITHERS_NODE, PATH, nvm (highest first), homebrew,
 * /usr/local, volta, fnm. Duplicates keep their first position.
 */
export const nodeCandidates = (host: NodeProbeHost): ReadonlyArray<string> => {
  const explicit = host.env.SMITHERS_NODE?.trim()
  const fromPath = (host.env.PATH ?? "").split(delimiter).filter((dir) => dir !== "").map((dir) => join(dir, "node"))
  const ordered = [
    ...(explicit === undefined || explicit === "" ? [] : [explicit]),
    ...fromPath,
    ...nvmCandidates(host),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    join(host.home, ".volta", "bin", "node"),
    ...fnmCandidates(host)
  ]
  return [...new Set(ordered)]
}

/** The first candidate that exists and reports a version >= 22.19.0. */
export const findNodeWith = async (host: NodeProbeHost): Promise<NodeSidecar | null> => {
  for (const candidate of nodeCandidates(host)) {
    if (!host.isFile(candidate)) continue
    const version = await host.version(candidate)
    if (version === null || !meetsMinimum(version)) continue
    return { path: candidate, version: version.trim() }
  }
  return null
}

const runVersion = async (path: string): Promise<string | null> => {
  try {
    const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    return code === 0 && parseVersion(stdout) !== null ? stdout.trim() : null
  } catch {
    return null
  }
}

export const currentNodeProbeHost = (env: Readonly<Record<string, string | undefined>> = Bun.env): NodeProbeHost => ({
  env,
  home: env.HOME ?? homedir(),
  listDir: (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  version: runVersion
})

export const findNode = (env?: Readonly<Record<string, string | undefined>>): Promise<NodeSidecar | null> =>
  findNodeWith(currentNodeProbeHost(env))
