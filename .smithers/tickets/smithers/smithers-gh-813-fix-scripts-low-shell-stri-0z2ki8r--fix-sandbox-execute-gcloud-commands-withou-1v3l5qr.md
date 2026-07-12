# 🔒 fix(sandbox): execute gcloud commands without shell interpolation

GitHub: https://github.com/smithersai/smithers/issues/1031

Parent: smithers/gh-813-fix-scripts-low-shell-string-interpolation-1f1b5aw.md

Context: scripts/sandbox.ts builds gcloud create and delete commands with execSync, and the delete path consumes name and zone from the repo-local .sandbox-vm file. Acceptance criteria: invoke gcloud with an argument array and no shell; validate the parsed state fields before use; preserve sandbox up/down behavior; add tests using a fake executable to capture argv and verify spaces, quotes, semicolons, backticks, and dollar syntax cannot execute or alter arguments.
