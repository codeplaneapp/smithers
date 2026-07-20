import type { GatewayDocRow } from "../src/rpc/index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type Assert<T extends true> = T;

type ExpectedGatewayDocKind = "ticket" | "plan" | "spec" | "proposal" | "conflict" | (string & {});

type _GatewayDocRowKindPreservesKnownLiterals = Assert<
  Equal<GatewayDocRow["kind"], ExpectedGatewayDocKind>
>;

"ticket" satisfies GatewayDocRow["kind"];
"custom-kind" satisfies GatewayDocRow["kind"];
