# 🐛 openapi: YAML specs fail on Node — parseSpecText uses bare require() in an ESM module

GitHub: https://github.com/smithersai/smithers/issues/591

**What happens**
`parseSpecText` (packages/openapi/src/_specHelpers.js:19-27) loads the YAML parser with `const yaml = require("yaml")` inside the YAML try/catch. The package is `"type": "module"` with `engines.node >= 22`, and on Node `require` is not defined in ESM scope — the `ReferenceError: require is not defined` is swallowed by the surrounding `catch`, which rethrows the generic "Failed to parse OpenAPI spec as JSON or YAML".

**Why it's wrong / failure scenario**
Any consumer running on Node (not Bun) who passes a YAML OpenAPI spec — file, URL, or raw string — gets a parse failure even though `yaml` ^2.9.0 is a declared dependency. Bun defines `require` in ESM scope, so tests and Bun-based usage mask the bug entirely.

**Expected behavior**
Static `import { parse } from "yaml"` at module top (or `createRequire(import.meta.url)` if lazy loading is deliberate), so YAML parsing works on both runtimes and real YAML syntax errors surface instead of being conflated with a missing loader.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
