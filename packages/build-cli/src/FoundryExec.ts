/**
 * Planning helpers for Foundry targets and mise-pinned tool references.
 *
 * forge shares a name with unrelated binaries, so resolution probes every
 * PATH candidate and keeps the one whose version output is Foundry's; the
 * declared foundry.toml and the workspace's mise pins enter the key as
 * digested authority, and an absent or wrong forge is a typed refusal.
 * `S.Mise.bin` resolution lives here too: the pinned version is read from
 * the declared mise config and execution refuses when mise itself is not
 * on the host.
 *
 * @since 0.1.0
 */
import type * as Foundry from "@smthrs/targets/Foundry"
import * as Input from "@smthrs/targets/Input"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as PackageTree from "./PackageTree.ts"

/**
 * One resolved executable and the complete identity entering target keys.
 *
 * @category models
 * @since 0.1.0
 */
export type ResolvedTool =
  | { readonly ok: true; readonly path: string; readonly identity: unknown }
  | { readonly ok: false; readonly refusal: string; readonly identity: unknown }

const toolchainsOf = (workspace: WorkspaceDeclaration.WorkspaceDeclaration): ReadonlyArray<Record<string, unknown>> =>
  (workspace.toolchains ?? [])
    .filter((entry): entry is { readonly _tag: string } => typeof entry === "object" && entry !== null)
    .map((entry) => entry as unknown as Record<string, unknown>)

const filePath = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null &&
    (value as { readonly _tag?: unknown })._tag === "File" &&
    typeof (value as { readonly path?: unknown }).path === "string"
    ? (value as { readonly path: string }).path
    : undefined

const digestDeclared = async (
  root: string,
  value: unknown,
  packagePath = ""
): Promise<{ readonly path: string; readonly digest: string } | null> => {
  const path = filePath(value)
  if (path === undefined) return null
  const resolved = Input.resolvePath(packagePath, path)
  try {
    return { path: resolved, digest: await PackageTree.digestFileBytes(NodePath.join(root, ...resolved.split("/"))) }
  } catch {
    return { path: resolved, digest: "absent" }
  }
}

const miseVersion = async (root: string, config: unknown, name: string): Promise<string | null> => {
  const path = filePath(config)
  if (path === undefined) return null
  try {
    const text = await Fs.readFile(NodePath.join(root, ...Input.resolvePath("", path).split("/")), "utf8")
    const tools = /^\[tools\][ \t]*\r?$([\s\S]*?)(?=^\[[^\]\r\n]+\][ \t]*\r?$|(?![\s\S]))/m.exec(text)?.[1] ?? text
    const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = new RegExp(`^(?:${escaped}|["']${escaped}["'])\\s*=\\s*["']([^"']+)["']`, "m").exec(tools)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Resolves `S.Mise.bin`, keying the declared config and pinned tool entry.
 *
 * @category planning
 * @since 0.1.0
 */
export const resolveMiseBin = async (
  root: string,
  workspace: WorkspaceDeclaration.WorkspaceDeclaration,
  name: string
): Promise<ResolvedTool> => {
  const mise = toolchainsOf(workspace).find((entry) => entry["_tag"] === "Mise")
  const config = mise?.["config"]
  const authority = await digestDeclared(root, config)
  const pinned = await miseVersion(root, config, name)
  const path = PackageTree.findOnPath("mise")
  const identity = { tag: "MiseBin", name, authority, pinned }
  if (mise === undefined) {
    return {
      ok: false,
      refusal: `S.Mise.bin(${JSON.stringify(name)}) requires an S.Mise entry in Workspace toolchains`,
      identity
    }
  }
  if (path === undefined) {
    return {
      ok: false,
      refusal: `host binary "mise" is not present on PATH; S.Mise.bin(${JSON.stringify(name)}) is pinned${
        pinned === null ? " by the declared mise config" : ` to ${pinned}`
      } but cannot execute on this host`,
      identity: { ...identity, absent: true }
    }
  }
  const probe = await PackageTree.probeVersion(path)
  return {
    ok: true,
    path,
    identity: { ...identity, path, probe }
  }
}

const resolveForge = async (): Promise<ResolvedTool> => {
  const candidates = PackageTree.findAllOnPath("forge")
  for (const path of candidates) {
    const probe = await PackageTree.probeVersion(path)
    if (/^forge Version:/m.test(probe.output)) {
      return { ok: true, path, identity: { tag: "FoundryForge", path, probe } }
    }
  }
  return {
    ok: false,
    refusal: candidates.length === 0
      ? "host binary \"forge\" is not present on PATH"
      : "the PATH entries named \"forge\" are not Foundry forge executables",
    identity: { tag: "FoundryForge", candidates, absent: true }
  }
}

/**
 * The reduced plan fields a Foundry target contributes to PackageExec.
 *
 * @category models
 * @since 0.1.0
 */
export interface Plan {
  readonly argv?: ReadonlyArray<string> | undefined
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly outDirs: ReadonlyArray<string>
  readonly toolchain: unknown
  readonly refusal?: string | undefined
}

/**
 * Plans one Foundry rule from validated attrs.
 *
 * @category planning
 * @since 0.1.0
 */
export const plan = async (options: {
  readonly root: string
  readonly packagePath: string
  readonly workspace: WorkspaceDeclaration.WorkspaceDeclaration
  readonly rule: "Foundry.Build" | "Foundry.Test" | "Foundry.Fmt"
  readonly mode: "execute" | "check" | "write"
  readonly attrs:
    | (typeof Foundry.BuildAttrs)["Type"]
    | (typeof Foundry.TestAttrs)["Type"]
    | (typeof Foundry.FmtAttrs)["Type"]
}): Promise<Plan> => {
  const resolved = await resolveForge()
  const foundry = toolchainsOf(options.workspace).find((entry) => entry["_tag"] === "FoundryToolchain")
  const configValue = (options.attrs as { readonly config?: unknown }).config ?? foundry?.["config"]
  const configAuthority = await digestDeclared(
    options.root,
    configValue,
    (options.attrs as { readonly config?: unknown }).config === undefined ? "" : options.packagePath
  )
  const versions = foundry?.["versions"] as Record<string, unknown> | undefined
  const versionsAuthority = await digestDeclared(options.root, versions?.["config"])
  const pinned = await miseVersion(options.root, versions?.["config"], "forge")
  const toolchain = {
    forge: resolved.identity,
    config: configAuthority,
    versions: versionsAuthority,
    pinned
  }
  const cwd = options.packagePath || "."
  if (!resolved.ok) return { cwd, env: {}, outDirs: [], toolchain, refusal: resolved.refusal }
  const attrs = options.attrs as {
    readonly profile?: string
    readonly skip?: ReadonlyArray<string>
    readonly outDirs?: ReadonlyArray<string>
  }
  const argv: Array<string> = [resolved.path]
  if (options.rule === "Foundry.Build") argv.push("build")
  else if (options.rule === "Foundry.Test") argv.push("test")
  else argv.push("fmt", ...(options.mode === "check" ? ["--check"] : []))
  if (configAuthority !== null && options.rule !== "Foundry.Fmt") {
    argv.push(
      "--config-path",
      NodePath.relative(options.packagePath || ".", configAuthority.path) || NodePath.basename(configAuthority.path)
    )
  }
  if (options.rule === "Foundry.Build") {
    for (const skip of attrs.skip ?? []) argv.push("--skip", skip)
  }
  const env = attrs.profile === undefined ? {} : { FOUNDRY_PROFILE: attrs.profile }
  const outDirs = options.rule === "Foundry.Build"
    ? (attrs.outDirs ?? []).map((dir) => Input.resolvePath(options.packagePath, dir))
    : []
  return { argv, cwd, env, outDirs, toolchain }
}
