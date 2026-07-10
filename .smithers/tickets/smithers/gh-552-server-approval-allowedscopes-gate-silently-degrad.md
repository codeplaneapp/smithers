# 🐛 server: approval allowedScopes gate silently degrades unknown scopes to run:read

GitHub: https://github.com/smithersai/smithers/issues/552

**What happens**
In `approvals.submit` (packages/server/src/gateway.js:6600-6603) the gate is `request.allowedScopes.some((scope) => hasScope(connection.scopes, scope))`. `hasScope` (gateway.js:995-997) treats its second argument as a *method name*: `requiredScopeForMethod` (gateway.js:967-988) returns the input only for the 8 canonical GatewayScope strings and otherwise falls through to `getRequiredScopeForGatewayMethod(scope) ?? "run:read"`.

**Why it's wrong / failure scenario**
`allowedScopes` on `<Approval>` is an arbitrary `string[]` (packages/components/src/components/ApprovalProps.ts:20, flows through engine deferred-state-bridge.js:71). A workflow author writing `allowedScopes: ["deploy:approve"]` intends to restrict who may decide the gate. Because "deploy:approve" is not a canonical scope or gateway method, the required scope silently becomes `run:read` — any connection holding run:read (i.e. effectively every caller allowed to reach the method) passes the extra restriction. The gate weakens instead of failing closed. (Literal grants still work via the method-name branch of hasGatewayScope, which masks the bug in tests that grant the custom scope.)

**Expected**
Unknown `allowedScopes` entries should be matched literally against the connection's granted scopes, or rejected — never defaulted to run:read.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
