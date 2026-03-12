import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const configDir = path.dirname(fileURLToPath(import.meta.url))
const daemonRoot = path.resolve(configDir, "../..")
const configuredDataRoot = process.env.BURNS_DATA_ROOT?.trim()
const dataRoot =
  configuredDataRoot && configuredDataRoot.length > 0
    ? path.resolve(configuredDataRoot)
    : path.join(daemonRoot, ".data")

mkdirSync(dataRoot, { recursive: true })

export const DAEMON_ROOT = daemonRoot
export const DATA_ROOT = dataRoot
export const DATABASE_PATH = path.join(DATA_ROOT, "burns.sqlite")
export const DEFAULT_WORKSPACES_ROOT = path.join(DATA_ROOT, "workspaces")

mkdirSync(DEFAULT_WORKSPACES_ROOT, { recursive: true })
