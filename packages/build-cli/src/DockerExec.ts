/**
 * Planning helpers for Docker services, OCI builds, bake targets, and pushes.
 *
 * Every Docker rule needs the same host facts before it can plan: the CLI
 * on PATH, a daemon that answers `docker info`, and a buildx builder that
 * supports the OCI exporter. This module resolves those once per target
 * and turns the declarations into argv: `docker run --rm` for supervised
 * services, `buildx build`/`buildx bake` writing an OCI archive into the
 * captured output directory, and an approval-gated `docker push` for the
 * outward effect. A silent daemon is a typed refusal, never a green no-op.
 *
 * @since 0.1.0
 */
import type * as Docker from "@smthrs/targets/Docker"
import * as Input from "@smthrs/targets/Input"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as PackageTree from "./PackageTree.ts"
import type * as ServiceSupervisor from "./ServiceSupervisor.ts"

/**
 * Resolved docker CLI plus daemon identity.
 *
 * @category models
 * @since 0.1.0
 */
export type DockerTool =
  | { readonly ok: true; readonly path: string; readonly builder: string | undefined; readonly identity: unknown }
  | { readonly ok: false; readonly refusal: string; readonly identity: unknown }

/**
 * Resolves Docker and verifies that its daemon answers.
 *
 * @category planning
 * @since 0.1.0
 */
export const resolveDocker = async (): Promise<DockerTool> => {
  const path = PackageTree.findOnPath("docker")
  if (path === undefined) {
    return {
      ok: false,
      refusal: "host binary \"docker\" is not present on PATH",
      identity: { tag: "Docker", absent: true }
    }
  }
  const version = await PackageTree.probeVersion(path)
  const daemon = await PackageTree.probeCommand(path, ["info", "--format", "{{.ServerVersion}}"])
  const builders = daemon.exitCode === 0 ? await PackageTree.probeCommand(path, ["buildx", "ls"]) : undefined
  const builder = builders?.output.match(/^(\S+)\s+docker-container\s*$/m)?.[1]?.replace(/\*$/, "")
  const identity = { tag: "Docker", path, version, daemon, builder: builder ?? null }
  return daemon.exitCode === 0
    ? { ok: true, path, builder, identity }
    : {
      ok: false,
      refusal: `docker daemon did not answer "docker info": ${daemon.output.trim() || `exit ${daemon.exitCode}`}`,
      identity
    }
}

const safeTarget = (target: string): string => target.replaceAll(/[^A-Za-z0-9._-]/g, "-")

/**
 * The package-relative output directory of a Docker build target.
 *
 * @category planning
 * @since 0.1.0
 */
export const outputDir = (rule: "Docker.Build" | "Docker.Bake", packagePath: string, attrs: unknown): string =>
  Input.resolvePath(
    packagePath,
    rule === "Docker.Bake"
      ? `docker-image-${safeTarget((attrs as { readonly target: string }).target)}`
      : "docker-image"
  )

const scalar = (value: unknown): string | undefined => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  if (
    typeof value === "object" && value !== null &&
    (value as { readonly _tag?: unknown })._tag === "Stamp" &&
    typeof (value as { readonly name?: unknown }).name === "string"
  ) {
    return `{smthrs:stamp:${Buffer.from(JSON.stringify({ name: "docker-tag", value })).toString("base64url")}}`
  }
  return undefined
}

/**
 * Reduced plan fields for a Docker build/bake/push.
 *
 * @category models
 * @since 0.1.0
 */
export interface Plan {
  readonly argv?: ReadonlyArray<string> | undefined
  readonly outDirs: ReadonlyArray<string>
  readonly toolchain: unknown
  readonly refusal?: string | undefined
}

/**
 * Plans one non-service Docker target.
 *
 * @category planning
 * @since 0.1.0
 */
export const plan = async (options: {
  readonly rule: "Docker.Build" | "Docker.Bake" | "Docker.Push"
  readonly packagePath: string
  readonly attrs:
    | (typeof Docker.BuildAttrs)["Type"]
    | (typeof Docker.BakeAttrs)["Type"]
    | (typeof Docker.PushAttrs)["Type"]
}): Promise<Plan> => {
  const tool = await resolveDocker()
  if (!tool.ok) return { outDirs: [], toolchain: tool.identity, refusal: tool.refusal }
  if (options.rule === "Docker.Push") {
    const attrs = options.attrs as (typeof Docker.PushAttrs)["Type"]
    const tags = attrs.tags.map(scalar)
    if (tags.some((tag) => tag === undefined)) {
      return {
        outDirs: [],
        toolchain: tool.identity,
        refusal: "Docker.Push tags must resolve to strings before execution"
      }
    }
    return {
      argv: [tool.path, "push", ...tags.map((tag) => `${attrs.registry}/${attrs.name}:${tag}`)],
      outDirs: [],
      toolchain: tool.identity
    }
  }
  const outDir = outputDir(options.rule, options.packagePath, options.attrs)
  const destination = `${outDir}/image.tar`
  if (options.rule === "Docker.Build") {
    const attrs = options.attrs as (typeof Docker.BuildAttrs)["Type"]
    const args: Array<string> = [
      tool.path,
      "buildx",
      "build",
      ...(tool.builder === undefined ? [] : ["--builder", tool.builder]),
      "--file",
      Input.resolvePath(options.packagePath, attrs.dockerfile.path)
    ]
    if ((attrs.platforms?.length ?? 0) > 0) args.push("--platform", attrs.platforms!.join(","))
    for (const [name, value] of Object.entries(attrs.buildArgs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      const rendered = scalar(value)
      if (rendered === undefined) {
        return {
          outDirs: [outDir],
          toolchain: tool.identity,
          refusal: `Docker.Build buildArgs.${name} must resolve to a string before execution`
        }
      }
      args.push("--build-arg", `${name}=${rendered}`)
    }
    args.push(
      "--output",
      `type=oci,dest=${destination}`,
      Input.resolvePath(options.packagePath, attrs.context) || "."
    )
    return { argv: args, outDirs: [outDir], toolchain: tool.identity }
  }
  const attrs = options.attrs as (typeof Docker.BakeAttrs)["Type"]
  return {
    argv: [
      tool.path,
      "buildx",
      "bake",
      ...(tool.builder === undefined ? [] : ["--builder", tool.builder]),
      "--file",
      Input.resolvePath(options.packagePath, attrs.config.path),
      "--set",
      `${attrs.target}.output=type=oci,dest=${destination}`,
      attrs.target
    ],
    outDirs: [outDir],
    toolchain: tool.identity
  }
}

/**
 * Creates output parents before Docker writes its OCI tar.
 *
 * @category execution
 * @since 0.1.0
 */
export const prepareOutputs = async (root: string, outDirs: ReadonlyArray<string>): Promise<void> => {
  for (const outDir of outDirs) await Fs.mkdir(NodePath.join(root, ...outDir.split("/")), { recursive: true })
}

/**
 * Stable container name derived from a target label.
 *
 * @category planning
 * @since 0.1.0
 */
export const containerName = (label: string): string =>
  `smthrs-${createHash("sha256").update(label).digest("hex").slice(0, 20)}`

/**
 * Resolves one Docker service declaration into the supervisor's process spec.
 *
 * @category planning
 * @since 0.1.0
 */
export const serviceSpec = async (options: {
  readonly label: string
  readonly cwd: string
  readonly attrs: (typeof Docker.ServeAttrs)["Type"]
}): Promise<ServiceSupervisor.ServiceSpec | { readonly error: string }> => {
  const tool = await resolveDocker()
  if (!tool.ok) return { error: tool.refusal }
  const name = containerName(options.label)
  const attrs = options.attrs
  const argv: Array<string> = [tool.path, "run", "--rm", "--name", name]
  for (const [container, host] of Object.entries(attrs.ports ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    argv.push("-p", `${host}:${container}`)
  }
  for (const [key, value] of Object.entries(attrs.env ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    argv.push("-e", `${key}=${value}`)
  }
  for (const [volume, destination] of Object.entries(attrs.volumes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    argv.push("-v", `${volume}:${destination}`)
  }
  argv.push(attrs.tag === undefined ? attrs.image : `${attrs.image}:${attrs.tag}`)
  argv.push(...(attrs.command ?? []))
  const readiness = attrs.readiness === undefined
    ? undefined
    : "exec" in attrs.readiness
    ? { exec: [tool.path, "exec", name, ...attrs.readiness.exec], timeout: attrs.readiness.timeout }
    : attrs.readiness
  const init = (attrs.init ?? []).map((command) => [tool.path, "exec", name, ...command] as const)
  return {
    key: options.label,
    cwd: options.cwd,
    argv: argv as [string, ...Array<string>],
    readiness,
    health: attrs.health,
    stop: attrs.stop,
    // The name is deterministic per label, so a run that died without its
    // finalizer leaves a container that would make the next `docker run`
    // refuse with "name already in use". Removing it first is idempotent.
    prepare: [[tool.path, "rm", "-f", name]],
    init,
    cleanup: [[tool.path, "rm", "-f", name]]
  }
}
