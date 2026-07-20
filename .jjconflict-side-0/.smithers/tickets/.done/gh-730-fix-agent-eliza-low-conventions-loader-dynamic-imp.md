# 🐛 fix(agent-eliza): [low] conventions loader dynamic-imports raw absolute path (breaks on Windows / special-char paths)

GitHub: https://github.com/smithersai/smithers/issues/730

_via ultracode (Opus multi-agent) review_

`importWorkflowFile` dynamic-imports a bare absolute filesystem path instead of a `file://` URL, unlike every other import site in the repo.

- `packages/agent-eliza/src/conventions/loader.js:78` — `const mod = await import(filePath)` where `filePath` is an absolute OS path (from `join(dir, entry)` / `resolve(cwd, rawPath)`).
- Consumed at `loader.js:179` (loadWorkflowsFromDir) and `loader.js:274` (loadWorkflows workflowPaths).
- Contrast: `packages/server/src/index.js:248`, `packages/engine/src/hot/HotWorkflowController.js:155`, `apps/cli/src/index.js:118` all use `import(pathToFileURL(abs).href)`. This is the only dynamic-import site in the repo passing a raw path.

**Failure scenario:** On Windows Node, `import("C:\\proj\\.smithers\\workflows\\foo.ts")` throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` (the `C:` is read as a URL scheme). The `try/catch` at line 80 swallows it and returns `null`, so the caller pushes a generic `error` diagnostic ("Could not import workflow file") and drops the workflow — every workflow silently fails to load, making the elizaOS conventions loader nonfunctional on Windows. On POSIX, workflow paths containing URL-significant chars (`#`, `?`) are also misparsed, where `pathToFileURL` would percent-encode them correctly.

**Why it matters:** `loadWorkflows`/`loadWorkflowsFromDir` are the public conventions API for discovering user workflow files. The Windows breakage is total and masked as a vague diagnostic rather than a clear error, and it diverges from the repo-wide `pathToFileURL` convention.

**Fix:** `import(pathToFileURL(filePath).href)` in `importWorkflowFile`.


> Closed by ticket-fleet: landed on main in 3ea966353e3b3588c3f54394d8fc10de6a8434d9.
