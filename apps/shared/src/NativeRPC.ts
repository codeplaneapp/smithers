import type { PickLocalRepositoryResult, RepositoryAccess } from "./NativeRepository"

/*
 * The two native doors the local app keeps on Electrobun RPC (LOCAL-APP.md,
 * "Runtime topology"). Chat rides the local HTTP origin (/api/chat/*), so the
 * agent requests and the agentFrame message are gone. Privileged native
 * operations deliberately have no renderer-controlled HTTP fallback.
 */
/*
 * Structurally an Electrobun `ElectrobunRPCSchema` (`{ bun, webview }`, each
 * with `requests` and `messages`); apps/shared does not depend on the SDK,
 * which in 2.x lives only in apps/ui's Hutch devkit. apps/ui's
 * `BrowserView.defineRPC<SmithersNativeRPC>` checks the shape at the use site.
 */
export interface SmithersNativeRPC {
  readonly bun: {
    readonly requests: {
      readonly pickLocalRepository: {
        readonly params: { readonly access: RepositoryAccess }
        readonly response: PickLocalRepositoryResult
      }
      /**
       * Open a URL in the SYSTEM browser (never the webview). The native
       * sign-in handoff runs GitHub OAuth there because an embedded webview
       * has no platform authenticator; passkeys only work outside.
       */
      readonly openExternal: {
        readonly params: { readonly url: string }
        readonly response: { readonly opened: boolean }
      }
    }
    readonly messages: Record<never, never>
  }
  readonly webview: {
    readonly requests: Record<never, never>
    readonly messages: Record<never, never>
  }
}
