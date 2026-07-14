# 🧹 gateway: GatewayDocRow.kind literal union is absorbed by `| string`

GitHub: https://github.com/smithersai/smithers/issues/610

**What happens**
`packages/gateway/src/rpc/index.ts:258`:
```ts
kind: "ticket" | "plan" | "spec" | "proposal" | "conflict" | string;
```

**Why it's wrong**
TypeScript eagerly collapses `"a" | string` to `string`, so the five listed literals provide no narrowing, no exhaustiveness help, and no editor autocomplete — the annotation is documentation-only while looking like a checked union.

**Expected behavior**
The conventional "known values plus open set" idiom:
```ts
kind: "ticket" | "plan" | "spec" | "proposal" | "conflict" | (string & {});
```
which keeps autocomplete/narrowing for the known literals while still admitting arbitrary strings.

No runtime effect; it is a public-type change, so treat as a deliberate API tweak.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).


> Closed by ticket-fleet: landed on main in a38c4a8940c56477284d48041369d92ab7e6eb4f.
