export interface FrameLocation {
  readonly workspaceId: string
  readonly branchId: string
  readonly frameId: string
}

export interface FrameHistoryPort {
  readonly current: () => FrameLocation | undefined
  readonly push: (location: FrameLocation) => void
  readonly replace: (location: FrameLocation) => void
  readonly back: () => void
  readonly forward: () => void
  readonly subscribe: (listener: (location: FrameLocation | undefined) => void) => () => void
}

const segment = (value: string): string => encodeURIComponent(value)

export const framePath = (location: FrameLocation): string =>
  `/w/${segment(location.workspaceId)}/b/${segment(location.branchId)}/f/${segment(location.frameId)}`

export const parseFramePath = (pathname: string): FrameLocation | undefined => {
  const match = /^\/w\/([^/]+)\/b\/([^/]+)\/f\/([^/]+)\/?$/.exec(pathname)
  if (match === null) return undefined
  try {
    const workspaceId = decodeURIComponent(match[1]!)
    const branchId = decodeURIComponent(match[2]!)
    const frameId = decodeURIComponent(match[3]!)
    if (workspaceId === "" || branchId === "" || frameId === "") return undefined
    return { workspaceId, branchId, frameId }
  } catch {
    return undefined
  }
}

interface BrowserHistoryHost {
  readonly location: { readonly pathname: string }
  readonly history: {
    pushState: (data: unknown, unused: string, url?: string | URL | null) => void
    replaceState: (data: unknown, unused: string, url?: string | URL | null) => void
    back: () => void
    forward: () => void
  }
  addEventListener: (type: "popstate", listener: () => void) => void
  removeEventListener: (type: "popstate", listener: () => void) => void
}

/** Browser History is an adapter at the composition root, never React state. */
export const createBrowserFrameHistory = (host: BrowserHistoryHost): FrameHistoryPort => ({
  current: () => parseFramePath(host.location.pathname),
  push: (location) => host.history.pushState({ smithersFrame: true }, "", framePath(location)),
  replace: (location) => host.history.replaceState({ smithersFrame: true }, "", framePath(location)),
  back: () => host.history.back(),
  forward: () => host.history.forward(),
  subscribe: (listener) => {
    const onPopState = (): void => listener(parseFramePath(host.location.pathname))
    host.addEventListener("popstate", onPopState)
    return () => host.removeEventListener("popstate", onPopState)
  }
})
