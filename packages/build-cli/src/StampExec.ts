/**
 * Late stamp resolution. Values are deliberately read only immediately before spawn.
 *
 * @since 0.1.0
 */
/* eslint-disable jsdoc/require-description, jsdoc/no-restricted-syntax */
import * as Stamp from "@smthrs/targets/Stamp"
import * as PackageTree from "./PackageTree.ts"

/** */
export const token = Stamp.token

const stampValue = async (
  root: string,
  value: { readonly _tag?: unknown; readonly name?: unknown; readonly env?: unknown } | string
): Promise<string> => {
  if (typeof value === "string") return value
  if (value._tag === "Secret" && typeof value.env === "string") return process.env[value.env] ?? ""
  if (value._tag !== "Stamp") return ""
  switch (value.name) {
    case "version":
      return (await PackageTree.runGit(root, ["describe", "--tags", "--always", "--dirty"])).trim()
    case "commit":
      return (await PackageTree.runGit(root, ["rev-parse", "HEAD"])).trim()
    case "commitDate":
      return (await PackageTree.runGit(root, ["show", "-s", "--format=%cI", "HEAD"])).trim()
    case "buildTime":
      return new Date().toISOString()
    case "versionMeta": {
      const exact = await PackageTree.runGit(root, ["describe", "--tags", "--exact-match", "HEAD"]).catch(() => "")
      return exact.trim() === "" ? "dev" : ""
    }
    default:
      return ""
  }
}

const expression = /\{smthrs:stamp:([A-Za-z0-9_-]+)\}/g

/** */
export const resolveArgv = async (root: string, argv: ReadonlyArray<string>): Promise<Array<string>> => {
  const resolved: Array<string> = []
  for (const arg of argv) {
    let text = arg
    for (const match of arg.matchAll(expression)) {
      const payload = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as {
        readonly name: string
        readonly value: { readonly _tag?: unknown; readonly name?: unknown; readonly env?: unknown } | string
      }
      text = text.replace(match[0], await stampValue(root, payload.value))
    }
    resolved.push(text)
  }
  return resolved
}
