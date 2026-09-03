/*
 * The repo plugin manifest (LOCAL-APP.md "Plugin manifest"): a repository
 * may declare its first-class plugin surface in `smithers-ui.json` at its root. The
 * read is total — an absent file is no plugin and no warning, and anything
 * invalid (bad JSON, a schema failure, an entry naming an undetected
 * workspace) becomes repo warnings with the plugin undefined, never a 500.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseRepoPlugin } from "smithers-shared/LocalApp"
import type { RepoPlugin } from "smithers-shared/LocalApp"

/** Where the manifest lives inside the repository. */
export const PLUGIN_MANIFEST = "smithers-ui.json"

/*
 * The pre-rc.0 location. rc.0 treats `.smithers/` as 0.x state (the release policy),
 * so a manifest there is never read; the repo gets a warning naming the move.
 */
export const LEGACY_PLUGIN_MANIFEST = join(".smithers", "UI.json")

export interface RepoPluginRead {
  readonly plugin: RepoPlugin | undefined
  readonly warnings: Array<string>
}

/** The parsed manifest for a root, validated against its detected workspace paths. */
export const readRepoPlugin = (root: string, workspaces: ReadonlyArray<string>): RepoPluginRead => {
  const legacyWarnings = existsSync(join(root, LEGACY_PLUGIN_MANIFEST))
    ? [`${LEGACY_PLUGIN_MANIFEST} is not read: rc.0 treats .smithers/ as 0.x state. Move it to ${PLUGIN_MANIFEST}.`]
    : []
  let text: string
  try {
    text = readFileSync(join(root, PLUGIN_MANIFEST), "utf8")
  } catch {
    return { plugin: undefined, warnings: legacyWarnings }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { plugin: undefined, warnings: [...legacyWarnings, `${PLUGIN_MANIFEST} is not valid JSON.`] }
  }
  const parsed = parseRepoPlugin(value, workspaces)
  if ("issues" in parsed) {
    return { plugin: undefined, warnings: [...legacyWarnings, ...parsed.issues.map((issue) => `${PLUGIN_MANIFEST}: ${issue}`)] }
  }
  return { plugin: parsed.plugin, warnings: legacyWarnings }
}
