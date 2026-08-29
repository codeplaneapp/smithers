import { Electroview } from "electrobun/view"
import type { AgentTurnFrame, StartAgentTurnRequest, StartAgentTurnResult } from "smithers-shared/NativeAgent"
import type { PickLocalRepositoryResult, RepositoryAccess } from "smithers-shared/NativeRepository"
import type { SmithersNativeRPC } from "smithers-shared/NativeRPC"

const rpc = (() => {
  if (typeof window === "undefined" || window.__electrobun === undefined) return undefined
  const nativeRpc = Electroview.defineRPC<SmithersNativeRPC>({
    handlers: {
      requests: {},
      messages: {}
    }
  })
  new Electroview({ rpc: nativeRpc })
  return nativeRpc
})()

/**
 * Native shell capability. Pure web has no privileged external-navigation
 * fallback; its identity port uses ordinary browser navigation instead.
 */
export const nativeShellAvailable = rpc !== undefined
export const nativeOpenExternal: (url: string) => Promise<boolean> = rpc === undefined
  ? async () => false
  : async (url) => (await rpc.proxy.request.openExternal({ url })).opened

export interface NativeRepositories {
  readonly available: boolean
  readonly pickLocalRepository: (
    access: RepositoryAccess
  ) => Promise<PickLocalRepositoryResult>
}

export const nativeRepositories: NativeRepositories = {
  available: rpc !== undefined,
  pickLocalRepository: (access) =>
    rpc === undefined
      ? Promise.resolve({
        status: "error",
        code: "native-required",
        message: "Local repositories can only be connected from the Smithers native app."
      })
      : rpc.proxy.request.pickLocalRepository({ access })
}

export interface NativeAgent {
  readonly available: boolean
  readonly startTurn: (request: StartAgentTurnRequest) => Promise<StartAgentTurnResult>
  readonly cancelTurn: (runId: string) => Promise<void>
  /**
   * Mid-turn input (DESIGN.md §14): admit a message into the running turn's
   * steering queue, drained at the next link boundary. Absent on backends
   * without steering; callers treat undefined as "not steerable".
   */
  readonly steer?: (runId: string, text: string) => Promise<boolean>
  /**
   * Resolve a chain approval park (DESIGN.md §14): record the human's
   * decision against the pending ask so a fresh startTurn on the same
   * lineage converges under it. Absent on backends without the seam.
   */
  readonly resolveApproval?: (
    runId: string,
    decision: "approved" | "denied",
    ask?: { readonly name: string; readonly claim: string }
  ) => Promise<boolean>
  /** Drop every session grant and pending denial (admin /debug.grants.reset). */
  readonly revokeGrants?: () => Promise<void>
  readonly subscribe: (listener: (frame: AgentTurnFrame) => void) => () => void
}
