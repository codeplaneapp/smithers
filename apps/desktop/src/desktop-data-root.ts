import path from "node:path"
import { homedir } from "node:os"

type ResolveDesktopDataRootOptions = {
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
  platform?: NodeJS.Platform
}

export function resolveDesktopDataRoot(options: ResolveDesktopDataRootOptions = {}) {
  const env = options.env ?? process.env
  const configuredDataRoot = env.BURNS_DESKTOP_DATA_ROOT?.trim()
  if (configuredDataRoot) {
    return path.resolve(configuredDataRoot)
  }

  const homeDirectory = options.homeDirectory ?? homedir()
  const platform = options.platform ?? process.platform

  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", "Burns")
  }

  if (platform === "win32") {
    const appDataDirectory = env.APPDATA?.trim()
    if (appDataDirectory) {
      return path.join(appDataDirectory, "Burns")
    }

    return path.join(homeDirectory, "AppData", "Roaming", "Burns")
  }

  const xdgDataHome = env.XDG_DATA_HOME?.trim()
  if (xdgDataHome) {
    return path.join(xdgDataHome, "Burns")
  }

  return path.join(homeDirectory, ".local", "share", "Burns")
}
