import type { SmithersCtx } from "@smthrs/driver";

export type ApprovalAutoApprove = {
  after?: number;
  condition?: ((ctx: SmithersCtx<unknown> | null) => boolean) | (() => boolean);
  audit?: boolean;
  revertOn?: ((ctx: SmithersCtx<unknown> | null) => boolean) | (() => boolean);
};
