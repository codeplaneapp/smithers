# 🐛 fix(cli): [low] workflow required-bins treats non-executable files as eligible

GitHub: https://github.com/smithersai/smithers/issues/686

via /codex review (pass 3)

Refs:
- `apps/cli/src/workflows.js:253` evaluates workflow capability gates.
- `apps/cli/src/workflows.js:259` treats every `required-bins` entry as satisfied when `binaryOnPath()` returns true.
- `apps/cli/src/workflows.js:274` checks absolute/relative paths with `statSync(bin).isFile()` only.
- `apps/cli/src/workflows.js:284` scans `PATH`, and `apps/cli/src/workflows.js:291` again accepts any regular file as a binary.

Failure scenario:
A workflow declares `required-bins: [gh]`. On a machine where the first `gh` on `PATH` is a regular file without execute permission, or where a relative required-bin path points at a non-executable file, Smithers marks the workflow eligible because the file exists. The picker/listing/MCP workflow metadata then advertises it as runnable, but launching the workflow fails later with `EACCES`/`ENOEXEC` or an equivalent spawn failure.

Why it matters:
`required-bins` is the preflight contract that keeps unavailable workflows out of user-facing launch paths. Checking only `isFile()` makes the gate lie in exactly the cases it is supposed to catch. The POSIX path should verify execute permission (for example with `accessSync(candidate, X_OK)`), and the Windows path should preserve the `PATHEXT` behavior while rejecting non-runnable files where possible.
