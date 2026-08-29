/**
 * Consumer-scoped source overlays for package-mode execution.
 *
 * Overlay declarations stay inert file-set values. A consumer whose `data`
 * closure reaches one receives the replacement files in a scratch workspace,
 * leaving the real source tree untouched.
 *
 * @since 0.1.0
 */
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"

/** One replacement applied to a consumer scratch tree.
 *
 * @category models
 * @since 0.1.0
 */
export interface Replacement {
  readonly overlay: string
  readonly path: string
  readonly source: string
  readonly digest: string
}

/** A resolved overlay closure, or a typed planning refusal.
 *
 * @category models
 * @since 0.1.0
 */
export type Resolution =
  | { readonly replacements: ReadonlyArray<Replacement>; readonly refusal?: undefined }
  | { readonly replacements: ReadonlyArray<Replacement>; readonly refusal: string }

const targetsIn = (value: unknown, into: Array<Target.AnyTarget>, seen: Set<object>): void => {
  if (Target.isTarget(value)) {
    into.push(value)
    return
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) targetsIn(entry, into, seen)
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && "value" in descriptor) targetsIn(descriptor.value, into, seen)
  }
}

const member = (attrs: unknown, name: string): unknown => {
  if (typeof attrs !== "object" || attrs === null) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(attrs, name)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
}

/**
 * Resolves every Overlay reachable from a target's data/filegroup closure.
 * Replacement destinations and source files are anchored to the Overlay's
 * declaring package, not to the eventual consumer.
 *
 * @category planning
 * @since 0.1.0
 */
export const resolve = async (options: {
  readonly root: string
  readonly consumer: Target.AnyTarget
  readonly packagePathOf: (target: Target.AnyTarget) => string
  readonly labelOf: (target: Target.AnyTarget) => string
}): Promise<Resolution> => {
  const direct: Array<Target.AnyTarget> = []
  targetsIn(member(Target.metadata(options.consumer).attrs, "data"), direct, new Set())
  const visited = new Set<Target.AnyTarget>()
  const overlays = new Set<Target.AnyTarget>()
  const walk = (target: Target.AnyTarget): void => {
    if (visited.has(target)) return
    visited.add(target)
    const metadata = Target.metadata(target)
    if (metadata.target === "Overlay") {
      overlays.add(target)
      const base: Array<Target.AnyTarget> = []
      targetsIn(member(metadata.attrs, "base"), base, new Set())
      for (const nested of base) walk(nested)
      return
    }
    // A Filegroup is a file-set union: an Overlay listed in its `srcs` is a
    // member of the consumer's own set and reaches it. Every other target
    // contributes its declared outputs, not its inputs, so its `data` is not
    // walked: descending there would hand one build's private source
    // substitution to every downstream consumer of its outputs.
    if (metadata.target !== "Filegroup") return
    const next: Array<Target.AnyTarget> = []
    targetsIn(member(metadata.attrs, "srcs"), next, new Set())
    for (const nested of next) walk(nested)
  }
  for (const target of direct) walk(target)

  const replacements: Array<Replacement> = []
  const destinations = new Map<string, string>()
  for (const overlay of overlays) {
    const metadata = Target.metadata(overlay)
    const packagePath = options.packagePathOf(overlay)
    const replace = member(metadata.attrs, "replace")
    if (typeof replace !== "object" || replace === null) continue
    for (const [declared, value] of Object.entries(replace)) {
      if (typeof value !== "object" || value === null || (value as { readonly _tag?: unknown })._tag !== "File") {
        continue
      }
      const path = Input.resolvePath(packagePath, declared)
      const earlier = destinations.get(path)
      const label = options.labelOf(overlay)
      if (earlier !== undefined && earlier !== label) {
        return {
          replacements,
          refusal: `Overlay conflict: ${earlier} and ${label} both replace ${path}`
        }
      }
      destinations.set(path, label)
      const source = Input.resolvePath(packagePath, String((value as { readonly path: unknown }).path))
      const digest = await Input.digestFile(NodePath.join(options.root, ...source.split("/")), {
        workspaceRoot: options.root
      })
      if (digest === undefined) {
        return { replacements, refusal: `Overlay ${label} replacement source is missing: ${source}` }
      }
      replacements.push({ overlay: label, path, source, digest })
    }
  }
  replacements.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : left.overlay < right.overlay ? -1 : 1
  )
  return { replacements }
}

/** Applies replacements to a scratch workspace without touching the source tree.
 *
 * @category execution
 * @since 0.1.0
 */
export const apply = async (root: string, replacements: ReadonlyArray<Replacement>): Promise<void> => {
  for (const replacement of replacements) {
    const source = NodePath.join(root, ...replacement.source.split("/"))
    const destination = NodePath.join(root, ...replacement.path.split("/"))
    await Fs.mkdir(NodePath.dirname(destination), { recursive: true })
    await Fs.copyFile(source, destination)
  }
}
