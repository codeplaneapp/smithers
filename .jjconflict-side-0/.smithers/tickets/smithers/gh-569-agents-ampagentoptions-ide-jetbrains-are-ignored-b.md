# 🐛 agents: AmpAgentOptions.ide/.jetbrains are ignored — buildCommand always emits --no-ide/--no-jetbrains

GitHub: https://github.com/smithersai/smithers/issues/569

**What happens**
`packages/agents/src/AmpAgentOptions.ts:29-31` declares `ide?: boolean` ("Whether to enable IDE integrations (disabled by default in AmpAgent)") and `jetbrains?: boolean`, but `buildCommand` in `packages/agents/src/AmpAgent.js:226-227` unconditionally pushes `--no-ide` and `--no-jetbrains`. Neither option is consulted anywhere.

**Why it's wrong / failure scenario**
`new AmpAgent({ ide: true })` type-checks, is documented as "disabled by default" (implying it can be enabled), and has zero effect — the flag pair always disables the integrations.

**Expected behavior**
Gate the flags on the options (`if (this.opts.ide !== true) args.push("--no-ide")`, same for jetbrains), or remove/redocument the options as ignored in headless mode.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
