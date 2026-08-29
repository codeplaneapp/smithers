/**
 * `smithers init`: the smallest project a flow can be run from.
 *
 * rc.0 scaffolds one thing, a markdown flow at `flows/<name>/flow.mdx`, and
 * makes one edit, adding `.flows/` to the repository's ignore file. The 0.x
 * ceremony — interactive agent selection, a workflow pack, a global
 * `~/.smithers` install, skill installation as a side effect — is gone: seats
 * resolve from environment keys, and every side effect a command performs
 * without being asked is a side effect an operator has to undo.
 *
 * The ignore edit is idempotent and repository-scoped, carried over from the
 * 0.x `ensureRootGitignore` requirement: append once, never inside a
 * non-repository directory, and never a second time when a rule already
 * covers the path.
 *
 * @since 1.0.0
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The ignore rule rc.0 state needs.
 *
 * @category constants
 * @since 1.0.0
 */
export const ignoreRule = ".flows/"

/**
 * What one ignore-file edit did.
 *
 * @category models
 * @since 1.0.0
 */
export type IgnoreStatus = "created" | "updated" | "unchanged" | "skipped"

/**
 * Whether a directory is the root of a repository whose ignore file is worth
 * editing.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isRepository = (root: string, exists: (path: string) => boolean = existsSync): boolean =>
  exists(join(root, ".git")) || exists(join(root, ".jj"))

/** Whether an existing ignore file already covers `.flows/`. */
const alreadyIgnored = (contents: string): boolean =>
  contents.split("\n").map((line) => line.trim()).some((line) =>
    line === ".flows" || line === ".flows/" || line === "/.flows" || line === "/.flows/"
  )

/**
 * Adds `.flows/` to the repository ignore file, once.
 *
 * Outside a git or jj repository this reports `skipped` and writes nothing: a
 * `.gitignore` in a directory that is not a repository is litter.
 *
 * @category constructors
 * @since 1.0.0
 */
export const ensureIgnored = (root: string): IgnoreStatus => {
  if (!isRepository(root)) return "skipped"
  const file = join(root, ".gitignore")
  const block = `# Smithers run state\n${ignoreRule}\n`
  if (!existsSync(file)) {
    writeFileSync(file, block, "utf8")
    return "created"
  }
  const contents = readFileSync(file, "utf8")
  if (alreadyIgnored(contents)) return "unchanged"
  const separator = contents === "" || contents.endsWith("\n") ? "" : "\n"
  writeFileSync(file, `${contents}${separator}${block}`, "utf8")
  return "updated"
}

/**
 * The scaffolded flow body.
 *
 * Markdown, not TypeScript: `flow.mdx` needs no build step, no import
 * resolution, and no dependency on the package layout of the project it lands
 * in, so `smithers up <name>` works in the directory `init` just created.
 *
 * @category constructors
 * @since 1.0.0
 */
export const template = (name: string): string =>
  `---
name: ${name}
description: A starter Smithers flow.
---

# ${name}

Describe the work in prose. Every heading below is a step the agent performs in
order, and the text under it is the instruction for that step.

## Read the request

Summarise what was asked for, and list the files that answer it.

## Do the work

Make the change. Keep it small enough to review in one sitting.

## Check the work

Run the project's tests and report what passed.
`

/**
 * What `smithers init` created.
 *
 * @category models
 * @since 1.0.0
 */
export interface Scaffolded {
  readonly name: string
  readonly flowFile: string
  readonly created: boolean
  readonly gitignore: IgnoreStatus
  /** The state directory this project's runs will use. */
  readonly stateDirectory: string
}

/**
 * Scaffolds `flows/<name>/flow.mdx` and ignores `.flows/`.
 *
 * An existing flow file is left exactly as it is: `init` is a starting point,
 * not an overwrite, and a second `init` in a project that already has flows
 * must not destroy one.
 *
 * @category constructors
 * @since 1.0.0
 */
export const scaffold = (root: string, name: string): Scaffolded => {
  const directory = join(root, "flows", name)
  const flowFile = join(directory, "flow.mdx")
  const exists = existsSync(flowFile)
  if (!exists) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(flowFile, template(name), "utf8")
  }
  // The empty state directory is the project's anchor. `Project.root` treats
  // `.flows/` as proof on its own and a bare `flows/` only beside a project
  // marker, so a scaffold in a plain directory that is neither a package nor a
  // repository would otherwise resolve a different root from every
  // subdirectory, which is the one failure `init` exists to prevent.
  const stateDirectory = join(root, ".flows")
  mkdirSync(stateDirectory, { recursive: true })
  return { name, flowFile, created: !exists, gitignore: ensureIgnored(root), stateDirectory }
}

/**
 * The default flow name, taken from the project directory.
 *
 * @category constructors
 * @since 1.0.0
 */
export const defaultName = (root: string): string => {
  const base = root.split(/[/\\]/).filter((part) => part !== "").at(-1) ?? "flow"
  const slug = base.toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-").replaceAll(/^-+|-+$/g, "")
  return slug === "" ? "flow" : slug
}
