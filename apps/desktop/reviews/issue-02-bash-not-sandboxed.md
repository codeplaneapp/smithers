# /bash is not actually sandboxed to the workspace

Severity: High

Location: `src/bun/tools/index.ts:78`, `README.md:23`

Description:
The `/bash` tool only sets `cwd` to the workspace root. It does not prevent absolute paths or `..` traversal, so commands can access files outside the workspace. This contradicts the README statement that tool commands run in a sandbox rooted at the current working directory.

Impact:
A user (or injected prompt) can read or modify arbitrary files on the host, which may be unexpected and unsafe.

Suggested Fix:
Either implement OS-level sandboxing or a constrained command runner that enforces a filesystem boundary, or update documentation to reflect the true behavior.
