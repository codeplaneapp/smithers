/**
 * Go-specific planning kept out of the package executor's dispatch switch.
 *
 * @since 0.1.0
 */
/* eslint-disable jsdoc/require-description, jsdoc/no-restricted-syntax */
import type * as Go from "@smthrs/targets/Go"
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as NodeChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as PackageTree from "./PackageTree.ts"
import * as StampExec from "./StampExec.ts"

/** */
export interface Context {
  readonly root: string
  readonly packagePath: string
  readonly workspace: WorkspaceDeclaration.WorkspaceDeclaration
}

/** */
export interface Planned {
  readonly refusal?: string
  readonly argv?: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly outDirs: ReadonlyArray<string>
  readonly writeSet: ReadonlyArray<string>
  readonly closureIdentity?: unknown
}

const toolchain = (workspace: WorkspaceDeclaration.WorkspaceDeclaration): Go.ToolchainDeclaration | undefined =>
  workspace.toolchains?.find((entry): entry is Go.ToolchainDeclaration => entry._tag === "GoToolchain")

const moduleDirectory = (context: Context): string => {
  const declaration = toolchain(context.workspace)
  if (declaration === undefined) return context.root
  const mod = Input.resolvePath("", declaration.mod.path)
  return NodePath.join(context.root, NodePath.dirname(mod))
}

const execFile = (
  file: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env?: Readonly<Record<string, string>>
): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      file,
      [...args],
      { cwd, maxBuffer: 256 * 1024 * 1024, ...(env === undefined ? {} : { env: { ...process.env, ...env } }) },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(`${file} ${args.join(" ")} failed: ${stderr || error.message}`))
        else resolve(stdout)
      }
    )
  })

/** */
export const resolveGo = async (context: Context): Promise<
  | { readonly ok: true; readonly path: string; readonly identity: unknown }
  | { readonly ok: false; readonly refusal: string; readonly identity: unknown }
> => {
  const path = PackageTree.findOnPath("go")
  if (path === undefined) {
    return { ok: false, refusal: "host binary \"go\" is not present on PATH", identity: { tag: "GoBin", absent: true } }
  }
  const cwd = moduleDirectory(context)
  // `go --version` is a usage error; `go version` is the subcommand that
  // reports the toolchain GOTOOLCHAIN actually switched to for this module,
  // which is the resolved version the key must record.
  const probe = await PackageTree.probeVersion(path, { cwd, args: ["version"] })
  const declaration = toolchain(context.workspace)
  const authorities: Array<unknown> = []
  if (declaration !== undefined) {
    for (const input of [declaration.mod, declaration.sum]) {
      const relative = Input.resolvePath("", input.path)
      authorities.push({
        path: relative,
        digest: await Input.digestFile(NodePath.join(context.root, relative), { workspaceRoot: context.root })
      })
    }
    const versions = declaration.versions as unknown as {
      readonly config?: Input.File
      readonly flake?: Input.File
      readonly lock?: Input.File
    }
    for (const input of [versions.config, versions.flake, versions.lock]) {
      if (input === undefined) continue
      const relative = Input.resolvePath("", input.path)
      authorities.push({
        path: relative,
        digest: await Input.digestFile(NodePath.join(context.root, relative), { workspaceRoot: context.root })
      })
    }
  }
  return {
    ok: true,
    path,
    identity: { tag: "GoBin", path, cwd: NodePath.relative(context.root, cwd), probe, authorities }
  }
}

/** */
export const resolveNix = async (name: string, context: Context): Promise<
  | { readonly ok: true; readonly path: string; readonly identity: unknown }
  | { readonly ok: false; readonly refusal: string; readonly identity: unknown }
> => {
  const nix = PackageTree.findOnPath("nix")
  const declaration = context.workspace.toolchains?.find((entry) => entry._tag === "NixDevShell") as
    | { readonly flake: Input.File; readonly lock: Input.File }
    | undefined
  const authority: Array<unknown> = []
  for (const input of [declaration?.flake, declaration?.lock]) {
    if (input === undefined) continue
    const relative = Input.resolvePath("", input.path)
    authority.push({
      path: relative,
      digest: await Input.digestFile(NodePath.join(context.root, relative), { workspaceRoot: context.root })
    })
  }
  if (nix === undefined) {
    return {
      ok: false,
      refusal: `host binary "nix" is not present on PATH (required by S.Nix.bin(${JSON.stringify(name)}))`,
      identity: { tag: "NixBin", name, absent: true, authority }
    }
  }
  try {
    const path = (await execFile(nix, ["develop", "--command", "which", name], context.root)).trim()
    if (path === "") throw new Error("which returned no path")
    return { ok: true, path, identity: { tag: "NixBin", name, nix, path, authority } }
  } catch (cause) {
    return {
      ok: false,
      refusal: `Nix dev shell does not provide ${JSON.stringify(name)}: ${String(cause)}`,
      identity: { tag: "NixBin", name, nix, authority }
    }
  }
}

const anchor = (pattern: string, packagePath: string): string => {
  if (pattern.startsWith("//")) return `./${pattern.slice(2)}`
  if (!pattern.startsWith("./") || packagePath === "") return pattern
  return `./${[packagePath, pattern.slice(2)].filter(Boolean).join("/")}`
}

const targetOf = (value: unknown): Target.AnyTarget | undefined => {
  if (Target.isTarget(value)) return value
  if (typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === "TargetFiles") {
    const candidate = (value as { readonly target?: unknown }).target
    return Target.isTarget(candidate) ? candidate : undefined
  }
  return undefined
}

const patternsOf = (value: unknown, context: Context): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.map((entry) => anchor(String(entry), context.packagePath))
  const target = targetOf(value)
  if (target !== undefined && Target.metadata(target).target === "Go.Packages") {
    const source = Target.metadata(target).sourceFile
    const ownPath = source === undefined
      ? context.packagePath
      : NodePath.relative(context.root, NodePath.dirname(source)).split(NodePath.sep).join("/")
    return (Target.metadata(target).attrs as { readonly pkgs: ReadonlyArray<string> }).pkgs.map((entry) =>
      anchor(entry, ownPath)
    )
  }
  return []
}

interface GoListRow {
  readonly ImportPath?: string
  readonly Dir?: string
  readonly GoFiles?: ReadonlyArray<string>
  readonly CgoFiles?: ReadonlyArray<string>
  readonly TestGoFiles?: ReadonlyArray<string>
  readonly XTestGoFiles?: ReadonlyArray<string>
  readonly EmbedFiles?: ReadonlyArray<string>
  readonly TestEmbedFiles?: ReadonlyArray<string>
  readonly XTestEmbedFiles?: ReadonlyArray<string>
}

const jsonRows = (text: string): ReadonlyArray<GoListRow> => {
  const rows: Array<GoListRow> = []
  let start = -1, depth = 0, string = false, escape = false
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!
    if (string) {
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === "\"") string = false
      continue
    }
    if (ch === "\"") string = true
    else if (ch === "{") { if (depth++ === 0) start = index }
    else if (ch === "}" && --depth === 0 && start >= 0) {
      rows.push(JSON.parse(text.slice(start, index + 1)))
      start = -1
    }
  }
  return rows
}

const listed = async (
  goPath: string,
  cwd: string,
  patterns: ReadonlyArray<string>,
  deps: boolean,
  env: Readonly<Record<string, string>>
): Promise<ReadonlyArray<GoListRow>> =>
  jsonRows(await execFile(goPath, ["list", ...(deps ? ["-deps"] : []), "-json", ...patterns], cwd, env))

const selectedPackages = async (
  selection: unknown,
  context: Context,
  goPath: string,
  env: Readonly<Record<string, string>>
): Promise<ReadonlyArray<string>> => {
  if (
    typeof selection === "object" && selection !== null &&
    (selection as { readonly _tag?: unknown })._tag === "FilesDifference"
  ) {
    const difference = selection as { readonly left: unknown; readonly right: unknown }
    const left = await listed(goPath, moduleDirectory(context), patternsOf(difference.left, context), false, env)
    const right = new Set(
      (await listed(goPath, moduleDirectory(context), patternsOf(difference.right, context), false, env)).map((row) =>
        row.ImportPath
      )
    )
    return left.flatMap((row) => row.ImportPath !== undefined && !right.has(row.ImportPath) ? [row.ImportPath] : [])
  }
  const patterns = patternsOf(selection, context)
  const rows = await listed(goPath, moduleDirectory(context), patterns, false, env)
  return rows.flatMap((row) => row.ImportPath === undefined ? [] : [row.ImportPath])
}

const closure = async (
  packages: ReadonlyArray<string>,
  context: Context,
  goPath: string,
  env: Readonly<Record<string, string>>
): Promise<unknown> => {
  const rows = await listed(goPath, moduleDirectory(context), packages, true, env)
  const files = new Set<string>()
  for (const row of rows) {
    if (row.Dir === undefined) continue
    for (
      const name of [
        ...(row.GoFiles ?? []),
        ...(row.CgoFiles ?? []),
        ...(row.TestGoFiles ?? []),
        ...(row.XTestGoFiles ?? []),
        ...(row.EmbedFiles ?? []),
        ...(row.TestEmbedFiles ?? []),
        ...(row.XTestEmbedFiles ?? [])
      ]
    ) {
      const absolute = NodePath.join(row.Dir, name)
      const relative = NodePath.relative(context.root, absolute).split(NodePath.sep).join("/")
      if (!relative.startsWith("../") && relative !== "") files.add(relative)
    }
  }
  const digests: Array<readonly [string, string]> = []
  for (const file of [...files].sort()) {
    const bytes = await Fs.readFile(NodePath.join(context.root, file))
    digests.push([file, createHash("sha256").update(bytes).digest("hex")])
  }
  return { packages: [...packages].sort(), files: digests }
}

/**
 * The environment facts that shape which files a package contains: the
 * toolchain layer's cgo and experiment settings, the target triple, and the
 * target's own declared env.
 *
 * `go list` resolves build constraints, so it needs exactly these to report
 * the same package graph the build will compile. tapes turns `jsonv2` on
 * module-wide, and without `GOEXPERIMENT` every `go list` over a package that
 * imports `encoding/json/v2` fails with "build constraints exclude all Go
 * files"; a cross-compiled binary likewise resolves a different file set.
 */
const graphEnvironment = (context: Context, attrs: Record<string, unknown>): Record<string, string> => {
  const declaration = toolchain(context.workspace)
  const env = { ...((attrs["env"] as Record<string, string> | undefined) ?? {}) }
  const cgo = attrs["cgo"] ?? declaration?.cgo
  if (typeof cgo === "boolean") env["CGO_ENABLED"] = cgo ? "1" : "0"
  if ((declaration?.experiments.length ?? 0) > 0) env["GOEXPERIMENT"] = declaration!.experiments.join(",")
  if (attrs["goos"] !== undefined) env["GOOS"] = String(attrs["goos"])
  if (attrs["goarch"] !== undefined) env["GOARCH"] = String(attrs["goarch"])
  return env
}

/**
 * The module cache directory a `Go.ModDownload` on this target's `data` edge
 * fills, if it declares one.
 *
 * `offline` is only honest if it points the run at the cache the declared
 * fetch resource produced. Without this, `GOPROXY=off` runs against the
 * host's ambient `GOMODCACHE`: green on a developer's warm machine and
 * broken on a clean one, with the fetch edge doing nothing.
 */
const fetchedModuleCache = (context: Context, attrs: Record<string, unknown>): string | undefined => {
  const data = attrs["data"]
  if (!Array.isArray(data)) return undefined
  for (const entry of data) {
    const target = targetOf(entry)
    if (target === undefined || Target.metadata(target).target !== "Go.ModDownload") continue
    const outDirs = (Target.metadata(target).attrs as { readonly outDirs?: ReadonlyArray<string> }).outDirs
    const first = outDirs?.[0]
    if (first !== undefined) return NodePath.join(context.root, Input.resolvePath("", first))
  }
  return undefined
}

/**
 * The graph environment plus the fetch-shaping knobs `offline` declares.
 *
 * These stay off the plan-time `go list`: they decide where modules may come
 * from, not which files a package has, and the module cache the fetch
 * resource fills is materialized for the spawn, not for planning.
 */
const environment = (context: Context, attrs: Record<string, unknown>): Record<string, string> => {
  const env = graphEnvironment(context, attrs)
  if (attrs["offline"] === true) {
    env["GOPROXY"] = "off"
    env["GOFLAGS"] = "-mod=readonly"
    const cache = fetchedModuleCache(context, attrs)
    if (cache !== undefined) env["GOMODCACHE"] = cache
  }
  return env
}

/** */
export const toolchainEnvironment = (context: Context): Readonly<Record<string, string>> => environment(context, {})

/** */
export const planRule = async (
  rule: string,
  attrs: Record<string, unknown>,
  context: Context,
  goPath: string
): Promise<Planned> => {
  const env = environment(context, attrs)
  const listEnv = graphEnvironment(context, attrs)
  if (rule === "Go.Packages") {
    const packages = await selectedPackages(attrs["pkgs"], context, goPath, listEnv)
    return { env, outDirs: [], writeSet: [], closureIdentity: await closure(packages, context, goPath, listEnv) }
  }
  if (rule === "Go.ModDownload") {
    const outDirs = (attrs["outDirs"] as ReadonlyArray<string>).map((path) =>
      Input.resolvePath(context.packagePath, path)
    )
    return {
      argv: [goPath, "mod", "download"],
      env: { ...env, GOMODCACHE: NodePath.join(context.root, outDirs[0] ?? ".gomodcache") },
      outDirs,
      writeSet: []
    }
  }
  if (rule === "Go.Binary") {
    const pkg = anchor(String(attrs["pkg"]), context.packagePath)
    const out = Input.resolvePath(context.packagePath, String(attrs["out"]))
    const flags = [...((attrs["ldflags"] as ReadonlyArray<string> | undefined) ?? [])]
    for (const [name, value] of Object.entries((attrs["stamp"] as Record<string, unknown> | undefined) ?? {})) {
      flags.push("-X", `${name}=${StampExec.token(name, value)}`)
    }
    const argv = [goPath, "build", "-o", out, ...(flags.length === 0 ? [] : ["-ldflags", flags.join(" ")]), pkg]
    const packages = await selectedPackages([pkg], { ...context, packagePath: "" }, goPath, listEnv)
    return {
      argv,
      env,
      outDirs: [NodePath.dirname(out)],
      writeSet: [],
      closureIdentity: await closure(packages, context, goPath, listEnv)
    }
  }
  if (rule === "Go.Test") {
    const packages = await selectedPackages(attrs["pkgs"], context, goPath, listEnv)
    // A declared runner is part of what the target asked for. Falling back to
    // plain `go test` would report green for a run the declaration did not
    // describe, so an absent runner refuses by name instead.
    const gotestsum = attrs["runner"] === "gotestsum" ? PackageTree.findOnPath("gotestsum") : undefined
    if (attrs["runner"] === "gotestsum" && gotestsum === undefined) {
      return {
        refusal: "host binary \"gotestsum\" is not present on PATH (required by S.Go.Test({ runner: \"gotestsum\" }))",
        env,
        outDirs: [],
        writeSet: []
      }
    }
    const testFlags = [
      ...(attrs["timeout"] === undefined ? [] : ["-timeout", String(attrs["timeout"])]),
      // Go's own default for -parallel is GOMAXPROCS, so "cpus" is the
      // default and stays off the argv: spelling the host's core count would
      // put host state into the key and split the cache per machine.
      ...(typeof attrs["parallel"] === "number" ? [`-parallel=${String(attrs["parallel"])}`] : []),
      ...packages
    ]
    const argv = gotestsum === undefined
      ? [goPath, "test", ...testFlags]
      : [gotestsum, "--", ...testFlags]
    return { argv, env, outDirs: [], writeSet: [], closureIdentity: await closure(packages, context, goPath, listEnv) }
  }
  if (rule === "Go.Lint") {
    const pkgs = (attrs["pkgs"] as ReadonlyArray<string>).map((entry) => anchor(entry, context.packagePath))
    const config = Input.resolvePath(context.packagePath, (attrs["config"] as Input.File).path)
    const changes = ((attrs["changes"] as ReadonlyArray<string> | undefined) ?? []).map((entry) =>
      Input.resolvePath(context.packagePath, entry)
    )
    return {
      argv: [
        goPath,
        "run",
        `github.com/golangci/golangci-lint/v2/cmd/golangci-lint@${String(attrs["version"])}`,
        "run",
        "--config",
        config,
        ...(changes.length > 0 ? ["--fix"] : []),
        ...pkgs
      ],
      env,
      outDirs: [],
      writeSet: changes
    }
  }
  if (rule === "Go.Generate") {
    const packages = await selectedPackages(attrs["pkgs"], context, goPath, listEnv)
    return {
      argv: [goPath, "generate", ...packages],
      env,
      outDirs: [],
      writeSet: ((attrs["changes"] as ReadonlyArray<string>) ?? []).map((entry) =>
        Input.resolvePath(context.packagePath, entry)
      ),
      closureIdentity: await closure(packages, context, goPath, listEnv)
    }
  }
  if (rule === "Go.Fuzz") {
    const pkg = anchor(String(attrs["pkg"]), context.packagePath)
    const packages = await selectedPackages([pkg], { ...context, packagePath: "" }, goPath, listEnv)
    return {
      argv: [
        goPath,
        "test",
        pkg,
        "-run=^$",
        `-fuzz=${String(attrs["fuzz"])}`,
        `-fuzztime=${String(attrs["time"])}`,
        ...(attrs["parallel"] === undefined ? [] : [`-parallel=${String(attrs["parallel"])}`])
      ],
      env,
      outDirs: [],
      writeSet: [],
      closureIdentity: await closure(packages, context, goPath, listEnv)
    }
  }
  return { env, outDirs: [], writeSet: [] }
}
