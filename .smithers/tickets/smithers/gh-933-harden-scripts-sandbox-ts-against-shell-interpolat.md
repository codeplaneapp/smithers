# Harden scripts/sandbox.ts against shell interpolation

GitHub: https://github.com/smithersai/smithers/issues/933

Replace the interpolated gcloud delete command in scripts/sandbox.ts with execFileSync or spawnSync using an argument array and option separators where appropriate. Validate name and zone fields from .sandbox-vm as defense in depth. Add tests using spaces, quotes, semicolons, backticks, and dollar syntax to verify literal argument passing without shell execution.
