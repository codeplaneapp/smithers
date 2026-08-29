import { APP_BOOTSTRAP_PATH, AppBootstrapSchema, hasCapability } from "smithers-shared/AppBootstrap"
import type { AppBootstrap } from "smithers-shared/AppBootstrap"
import type { FetchLike, StartAgentTurnResult } from "smithers-shared/NativeAgent"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createWebAgent } from "../native/WebAgent"

export interface IdentityPort {
  readonly authFlow: AppBootstrap["authFlow"]
}

export interface JjhubPort {
  readonly available: true
}

export interface LocalHostPort {
  readonly repositories: NativeRepositories
  readonly sandbox: NonNullable<AppBootstrap["sandbox"]>
}

export type ShellPort =
  | { readonly kind: "browser" }
  | { readonly kind: "native"; readonly openExternal: (url: string) => Promise<boolean> }

export interface AppRuntime {
  readonly bootstrap: AppBootstrap
  readonly http: FetchLike
  readonly backend: {
    readonly agent?: NativeAgent
    readonly identity?: IdentityPort
    readonly jjhub?: JjhubPort
    readonly local?: LocalHostPort
  }
  readonly shell: ShellPort
}

export const unavailableAgent = (): NativeAgent => ({
  available: false,
  startTurn: async (): Promise<StartAgentTurnResult> => ({
    status: "error",
    message: "No agent provider is available in this runtime."
  }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

export const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repository selection is unavailable in this runtime."
  })
}

export const loadBootstrap = async (http: FetchLike): Promise<AppBootstrap> => {
  const response = await http(APP_BOOTSTRAP_PATH, { headers: { accept: "application/json" } })
  if (!response.ok) throw new Error(`Runtime bootstrap failed with HTTP ${response.status}.`)
  const parsed = AppBootstrapSchema.safeParse(await response.json().catch(() => undefined))
  if (!parsed.success) throw new Error(`Runtime bootstrap broke its contract: ${parsed.error.message}`)
  return parsed.data
}

export const createRuntime = (options: {
  readonly bootstrap: AppBootstrap
  readonly http: FetchLike
  readonly nativeRepositories?: NativeRepositories
  readonly nativeOpenExternal?: (url: string) => Promise<boolean>
}): AppRuntime => {
  const { bootstrap, http } = options
  const native = options.nativeOpenExternal === undefined
    ? ({ kind: "browser" } as const)
    : ({ kind: "native", openExternal: options.nativeOpenExternal } as const)
  return {
    bootstrap,
    http,
    backend: {
      ...(hasCapability(bootstrap, "agent") ? { agent: createWebAgent({ fetchImpl: http }) } : {}),
      ...(hasCapability(bootstrap, "identity") ? { identity: { authFlow: bootstrap.authFlow } } : {}),
      ...(hasCapability(bootstrap, "jjhub") ? { jjhub: { available: true as const } } : {}),
      ...(bootstrap.host === "local" && bootstrap.sandbox !== null
        ? { local: { repositories: options.nativeRepositories ?? unavailableRepositories, sandbox: bootstrap.sandbox } }
        : {})
    },
    shell: native
  }
}
