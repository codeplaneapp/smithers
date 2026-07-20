# Harden scripts/bump.mjs staging against shell interpolation

GitHub: https://github.com/smithersai/smithers/issues/934

Replace the manually quoted git add command in scripts/bump.mjs with execFileSync or spawnSync using an argument array, preserving all generated pathspecs. Add tests with a fake git executable that capture argv for paths containing spaces, quotes, semicolons, backticks, and dollar syntax, verifying no shell interpretation occurs.


> Closed by ticket-fleet sync: scripts/bump.mjs uses execFileSync("git", ["add", "--", ...paths]) and preserves changed files, pnpm-lock.yaml, and expanded artifact paths. scripts/bump.test.mjs uses a fake git executable to capture argv and covers spaces, quotes, semicolons, backticks, dollar syntax, and shell-injection prevention. The test passed: bun test scripts/bump.test.mjs — 8 pass, 0 fail.
