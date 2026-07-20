export type WaitReason =
  | { readonly _tag: "Approval"; readonly nodeId: string }
  | { readonly _tag: "Event"; readonly eventName: string }
  | { readonly _tag: "Timer"; readonly resumeAtMs: number }
  | { readonly _tag: "RetryBackoff"; readonly waitMs: number }
  | { readonly _tag: "HotReload" }
  | { readonly _tag: "OrphanRecovery"; readonly count: number }
  | { readonly _tag: "ExternalTrigger" }
  | {
      readonly _tag: "Bound";
      readonly nodeId: string;
      readonly code: "BOUND_STALE" | "BOUND_MISSING";
      readonly bindings?: ReadonlyArray<{
        readonly table: string;
        readonly nodeId: string;
        readonly iteration: number;
        readonly digest: string;
      }>;
    }
  | {
      readonly _tag: "Quota";
      readonly quotaBlockedCount: number;
      readonly resetAtMs?: number;
      /**
       * The quota-blocked tasks (capped sample): which node hit which
       * provider limit, so operators see WHO is waiting, not just a count.
       */
      readonly blocked?: ReadonlyArray<{
        readonly nodeId: string;
        readonly resetAtMs?: number;
        readonly message?: string;
      }>;
    };
