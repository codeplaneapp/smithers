# 🔒 fix(sandbox): execute gcloud commands without shell interpolation

GitHub: https://github.com/smithersai/smithers/issues/1031

Parent: smithers/gh-813-fix-scripts-low-shell-string-interpolation-1f1b5aw.md

Context: scripts/sandbox.ts builds gcloud create and delete commands with execSync, and the delete path consumes name and zone from the repo-local .sandbox-vm file. Acceptance criteria: invoke gcloud with an argument array and no shell; validate the parsed state fields before use; preserve sandbox up/down behavior; add tests using a fake executable to capture argv and verify spaces, quotes, semicolons, backticks, and dollar syntax cannot execute or alter arguments.


> Closed by ticket-fleet sync: scripts/sandbox.ts:20-23 invokes gcloud with spawnSync and an argument array without a shell; lines 62-70 validate both parsed .sandbox-vm fields before deletion. scripts/sandbox.test.ts:20-58 captures exact argv with a fake executable; lines 61-121 cover up/down behavior and failures; lines 141-192 reject spaces, quotes, semicolons, backticks, and dollar payloads without invoking gcloud or creating pwned. bun test scripts/sandbox.test.ts passed: 22 pass, 0 fail.
