# Harden scripts/sandbox.ts against shell interpolation

GitHub: https://github.com/smithersai/smithers/issues/933

Replace the interpolated gcloud delete command in scripts/sandbox.ts with execFileSync or spawnSync using an argument array and option separators where appropriate. Validate name and zone fields from .sandbox-vm as defense in depth. Add tests using spaces, quotes, semicolons, backticks, and dollar syntax to verify literal argument passing without shell execution.


> Closed by ticket-fleet sync: scripts/sandbox.ts uses spawnSync with argument arrays and validates name/zone via SAFE_RESOURCE before deletion. scripts/sandbox.test.ts verifies exact argv, invalid state fields, and payloads containing spaces, quotes, semicolons, backticks, and dollar syntax without shell execution. bun test scripts/sandbox.test.ts passes 22 tests. Implemented in commit 8cc99b53c59cae88d0b7cea509a7b2e9835dfe83 on main.
