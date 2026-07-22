// GENERATED FILE. Edit docs/data/sota-models.json, then run `pnpm sota:gen`.
//
// The SOTA model registry: which concrete model ids smithers configures by
// default. Code refers to stable slots (codexSol, codexTerra, codex, ...) so a model
// bump is a registry edit, not a code change. See docs/reference/sota-models.mdx.

export const SOTA_REGISTRY_VERSION = 5;

export const SOTA_REGISTRY_UPDATED_AT = "2026-07-21";

/** Stable handle → current best model id for that seat. */
export const SOTA_SLOTS = Object.freeze({
  "fable": "claude-fable-5",
  "opus": "claude-opus-4-8",
  "sonnet": "claude-sonnet-5",
  "haiku": "claude-haiku-4-5",
  "codexSol": "gpt-5.6-sol",
  "codexTerra": "gpt-5.6-terra",
  "codex": "gpt-5.6-luna",
  "codexMini": "gpt-5.4-mini",
  "spark": "gpt-5.3-codex-spark",
  "gemini": "gemini-3.5-flash",
  "geminiPro": "gemini-3.1-pro-preview",
  "kimi": "kimi-k2.7-code",
  "kimiFlagship": "kimi-k2.6"
});

/** Workflow role → current best model id. */
export const SOTA_ROLE_MODELS = Object.freeze({
  "orchestrator": "claude-opus-4-8",
  "planning": "claude-fable-5",
  "review": "gpt-5.6-sol",
  "smart": "gpt-5.6-sol",
  "midTier": "gpt-5.6-terra",
  "smartTool": "gpt-5.6-terra",
  "validate": "gpt-5.6-terra",
  "implement": "gpt-5.6-terra",
  "cheapFast": "gpt-5.6-luna",
  "ui": "gpt-5.6-terra",
  "realtime": "gpt-5.3-codex-spark",
  "research": "gpt-5.6-luna"
});

/** Deprecated id → the id sweeps rewrite it to. */
export const SOTA_DEPRECATED_MODELS = Object.freeze({
  "claude-sonnet-4-6": "claude-sonnet-5",
  "claude-sonnet-4-7": "claude-sonnet-5",
  "claude-sonnet-4-20250514": "claude-sonnet-5",
  "gpt-5.3-codex": "gpt-5.6-terra",
  "gpt-5.2": "gpt-5.6-terra",
  "gpt-4o": "gpt-5.4-mini",
  "kimi-latest": "kimi-k2.7-code"
});

/** The full registry entries (active and deprecated). */
export const SOTA_MODELS = Object.freeze([
  {
    "id": "claude-fable-5",
    "slot": "fable",
    "provider": "anthropic",
    "name": "Claude Fable 5",
    "status": "current",
    "engines": [
      "claude",
      "opencode"
    ],
    "badges": [],
    "roles": [
      "planning",
      "review",
      "smart"
    ],
    "description": "Anthropic's Mythos-class model for ambitious, long, complex knowledge and coding work. Developers can use `claude-fable-5` through the Claude API at $10 per million input tokens and $50 per million output tokens. Anthropic's July 1 redeployment restored access on Claude Platform, Claude.ai, Claude Code, and Claude Cowork; the temporary included window for eligible subscription plans runs through July 12, 2026 at 11:59:59 PM PT ([promotion details](https://support.claude.com/en/articles/15424964-claude-fable-5-promotional-access)), and cloud-platform availability remains subject to the marketplace, provider, and account. Its updated safeguards may reroute blocked requests to Opus 4.8 and may false-positive during routine coding and debugging. Current Claude applications and Claude Code enable that switching by default, while API customers must opt in and configure it ([default product behavior and API opt-in](https://support.claude.com/en/articles/15363606-why-claude-switched-models-in-your-conversation-with-fable-5)); treat the notice as current product behavior rather than a permanent provider guarantee. Smithers runs planning and design-freeze steps on Fable, escalates unusually consequential orchestration calls to it (Opus 4.8 holds the orchestrator default), and keeps it as the non-Codex fallback for Sol-backed review and smart work. Claude Code uses `claude-fable-5`; Smithers' OpenCode configuration uses the provider-qualified id `anthropic/claude-fable-5`. See [Anthropic's launch announcement](https://www.anthropic.com/news/claude-fable-5-mythos-5), [redeployment update](https://www.anthropic.com/news/redeploying-fable-5), and [current Fable availability](https://www.anthropic.com/claude/fable)."
  },
  {
    "id": "claude-opus-4-8",
    "slot": "opus",
    "provider": "anthropic",
    "name": "Claude Opus 4.8",
    "status": "current",
    "engines": [
      "claude",
      "opencode"
    ],
    "badges": [
      "best-orchestrator"
    ],
    "roles": [
      "orchestrator",
      "smart"
    ],
    "description": "Anthropic's Opus tier and the default Smithers orchestrator. Orchestration and gating decisions (scope, choosing direction, judging progress, deciding whether work is done, approving or denying gates) run here at medium reasoning effort rather than on GPT-5.6 Sol or Terra, which are strong reviewers but poor gatekeepers. Also a top-shelf generalist and the always-present fallback behind Fable in the smart, planning, and review pools."
  },
  {
    "id": "claude-sonnet-5",
    "slot": "sonnet",
    "provider": "anthropic",
    "name": "Claude Sonnet 5",
    "status": "current",
    "released": "2026-06-29",
    "engines": [
      "claude",
      "opencode"
    ],
    "badges": [],
    "roles": [
      "implement",
      "cheapFast"
    ],
    "description": "The newest Sonnet: fast, cheap, 1M context. It is the primary non-Codex fallback for Codex-backed research, implementation, validation, mid-tier, and tool-heavy work when Codex is unavailable; Sol-backed review and smart work fall back to Fable instead, and orchestration and planning already run on Claude (Opus 4.8 and Fable 5)."
  },
  {
    "id": "claude-haiku-4-5",
    "slot": "haiku",
    "provider": "anthropic",
    "name": "Claude Haiku 4.5",
    "status": "current",
    "engines": [
      "claude",
      "opencode"
    ],
    "badges": [],
    "roles": [],
    "description": "Anthropic's cheapest tier, for high-volume summarization and classification where even Sonnet is overkill."
  },
  {
    "id": "gpt-5.6-sol",
    "slot": "codexSol",
    "provider": "openai",
    "name": "GPT-5.6 Sol",
    "status": "sota",
    "engines": [
      "codex",
      "pi"
    ],
    "badges": [
      "smartest-reviewer",
      "smartest-coder"
    ],
    "roles": [
      "review",
      "smart"
    ],
    "description": "OpenAI's GPT-5.6 flagship for the hardest reasoning, coding, and judgment-heavy work. Use Sol for the hardest implementation, final code review, ambiguous or high-stakes changes, and recovery when a lower-cost pass is not enough. Do not use Sol for orchestration or gating (scope, direction, progress, done-or-not): it is a strong reviewer but a poor gatekeeper, and those seats belong to Claude (Opus 4.8 by default). See [OpenAI's GPT-5.6 release](https://openai.com/index/gpt-5-6/)."
  },
  {
    "id": "gpt-5.6-terra",
    "slot": "codexTerra",
    "provider": "openai",
    "name": "GPT-5.6 Terra",
    "status": "sota",
    "engines": [
      "codex",
      "pi"
    ],
    "badges": [],
    "roles": [
      "implement",
      "midTier",
      "smartTool",
      "validate",
      "ui"
    ],
    "description": "OpenAI's balanced GPT-5.6 model and the default implementer: substantial implementation starts on Terra, as do validation, structured checking, and explicitly tool-heavy work. Escalate to Sol when the change is genuinely hard, ambiguous, or high-stakes. Like Sol, Terra does not orchestrate or gate; its validation findings feed the Claude orchestrator's decision. See [OpenAI's GPT-5.6 release](https://openai.com/index/gpt-5-6/)."
  },
  {
    "id": "gpt-5.6-luna",
    "slot": "codex",
    "provider": "openai",
    "name": "GPT-5.6 Luna",
    "status": "sota",
    "engines": [
      "codex",
      "pi"
    ],
    "badges": [
      "fast-and-cheap",
      "best-value-coding"
    ],
    "roles": [
      "cheapFast",
      "research"
    ],
    "description": "OpenAI's fastest and most affordable GPT-5.6 tier. In Smithers, Luna handles trivial, minimal-risk work only: tiny scoped edits, mechanical transforms, quick research and lookups, and high-volume cheap passes. Substantial implementation starts on Terra instead, with Sol for the hardest changes; escalate rather than letting Luna carry work with real blast radius. See [OpenAI's GPT-5.6 release](https://openai.com/index/gpt-5-6/) and the [GPT-5.6 preview release](https://openai.com/index/previewing-gpt-5-6-sol/)."
  },
  {
    "id": "gpt-5.5",
    "slot": null,
    "provider": "openai",
    "name": "GPT-5.5",
    "status": "current",
    "engines": [
      "codex",
      "pi"
    ],
    "badges": [],
    "roles": [],
    "description": "The previous OpenAI flagship. Keep it as a compatibility fallback for Codex accounts that do not yet expose GPT-5.6."
  },
  {
    "id": "gpt-5.4",
    "slot": null,
    "provider": "openai",
    "name": "GPT-5.4",
    "status": "current",
    "engines": [
      "codex",
      "pi"
    ],
    "badges": [],
    "roles": [],
    "description": "The previous OpenAI flagship, retained for pinned compatibility. New Smithers workflows use the GPT-5.6 Sol/Terra/Luna role split instead."
  },
  {
    "id": "gpt-5.4-mini",
    "slot": "codexMini",
    "provider": "openai",
    "name": "GPT-5.4 mini",
    "status": "current",
    "engines": [
      "codex",
      "pi"
    ],
    "badges": [],
    "roles": [],
    "description": "OpenAI's prior fast, efficient tier. Retained as the OpenRouter compatibility fallback (openai/gpt-5.4-mini); Codex-native cheap work defaults to GPT-5.6 Luna."
  },
  {
    "id": "gpt-5.3-codex-spark",
    "slot": "spark",
    "provider": "openai",
    "name": "GPT-5.3-Codex-Spark",
    "status": "sota",
    "released": "2026-02-12",
    "engines": [
      "codex"
    ],
    "badges": [
      "fastest-coding"
    ],
    "roles": [
      "realtime"
    ],
    "description": "OpenAI's first real-time coding model: 1000+ tokens per second on dedicated Cerebras hardware while staying genuinely capable. Research preview, ChatGPT Pro only. Reach for it when iteration latency matters more than depth."
  },
  {
    "id": "gemini-3.5-flash",
    "slot": "gemini",
    "provider": "google",
    "name": "Gemini 3.5 Flash",
    "status": "sota",
    "released": "2026-05-19",
    "engines": [
      "antigravity"
    ],
    "badges": [
      "best-ui"
    ],
    "roles": [
      "ui",
      "implement",
      "cheapFast"
    ],
    "description": "Google's best price-to-performance model and the best non-Codex fallback for UI work: near-Pro intelligence at Flash speed and cost, 1M context, and it beats Gemini 3.1 Pro on coding and agentic benchmarks while running roughly 4x faster. Smithers can use it for UI work when its provider-specific route is configured; it is not a universal fallback policy."
  },
  {
    "id": "gemini-3.1-pro-preview",
    "slot": "geminiPro",
    "provider": "google",
    "name": "Gemini 3.1 Pro",
    "status": "current",
    "engines": [
      "antigravity"
    ],
    "badges": [],
    "roles": [],
    "description": "Google's Pro tier (still preview). Superseded for coding and agentic work by Gemini 3.5 Flash; keep it for long-horizon reasoning where Pro depth wins."
  },
  {
    "id": "gemini-3.1-flash-lite",
    "slot": null,
    "provider": "google",
    "name": "Gemini 3.1 Flash-Lite",
    "status": "current",
    "engines": [
      "antigravity"
    ],
    "badges": [],
    "roles": [],
    "description": "Frontier-class performance at a fraction of the cost. The floor of the Gemini lineup for bulk, low-stakes calls."
  },
  {
    "id": "kimi-k2.7-code",
    "slot": "kimi",
    "provider": "moonshot",
    "name": "Kimi K2.7-Code",
    "status": "sota",
    "released": "2026-06-12",
    "engines": [
      "kimi"
    ],
    "badges": [],
    "roles": [
      "implement",
      "cheapFast"
    ],
    "description": "Moonshot's most capable coding model: 256k context, roughly 30% fewer reasoning tokens than K2.6, and strong instruction-following in long contexts. Smithers keeps it as a no-Codex implementation fallback; the -highspeed variant trades a little quality for ~180 tok/s."
  },
  {
    "id": "kimi-k2.7-code-highspeed",
    "slot": null,
    "provider": "moonshot",
    "name": "Kimi K2.7-Code High-Speed",
    "status": "current",
    "engines": [
      "kimi"
    ],
    "badges": [],
    "roles": [
      "realtime"
    ],
    "description": "The high-throughput K2.7-Code variant, around 180 tokens per second. The open-weights answer to Codex-Spark for latency-sensitive loops."
  },
  {
    "id": "kimi-k2.6",
    "slot": "kimiFlagship",
    "provider": "moonshot",
    "name": "Kimi K2.6",
    "status": "current",
    "released": "2026-04-20",
    "engines": [
      "kimi"
    ],
    "badges": [
      "best-open-source"
    ],
    "roles": [
      "research"
    ],
    "description": "Moonshot's open-source (modified MIT) trillion-parameter MoE flagship: native multimodal, agent swarms up to 300 sub-agents, up to 13 hours of continuous coding. Ties GPT-5.5 on SWE-Bench Pro at roughly 80% lower cost. The strongest model you can self-host."
  },
  {
    "id": "kimi-k3",
    "slot": null,
    "provider": "moonshot",
    "name": "Kimi K3",
    "status": "sota",
    "engines": [
      "kimi",
      "opencode"
    ],
    "badges": [],
    "roles": [],
    "description": "Moonshot's newest long-context model, served on Kimi-for-Coding: a 1M-token context window with thinking plus image and video input. Its niche is very-long-context coding and mid-run model swaps where a huge window absorbs accumulated state. Exact usable ids: `kimi-code/k3` in the Kimi CLI, `kimi-for-coding/k3` in OpenCode, `moonshotai/kimi-k3` via Cloudflare AI Gateway."
  },
  {
    "id": "claude-sonnet-4-6",
    "slot": null,
    "provider": "anthropic",
    "name": "Claude Sonnet 4.6",
    "status": "deprecated",
    "replacedBy": "claude-sonnet-5",
    "engines": [
      "claude",
      "opencode"
    ],
    "badges": [],
    "roles": [],
    "description": "Superseded by Claude Sonnet 5."
  },
  {
    "id": "claude-sonnet-4-7",
    "slot": null,
    "provider": "anthropic",
    "name": "Claude Sonnet 4.7",
    "status": "deprecated",
    "replacedBy": "claude-sonnet-5",
    "engines": [
      "claude",
      "opencode"
    ],
    "badges": [],
    "roles": [],
    "description": "Superseded by Claude Sonnet 5."
  },
  {
    "id": "claude-sonnet-4-20250514",
    "slot": null,
    "provider": "anthropic",
    "name": "Claude Sonnet 4 (dated)",
    "status": "deprecated",
    "replacedBy": "claude-sonnet-5",
    "engines": [
      "claude",
      "opencode"
    ],
    "badges": [],
    "roles": [],
    "description": "Superseded by Claude Sonnet 5."
  },
  {
    "id": "gpt-5.3-codex",
    "slot": null,
    "provider": "openai",
    "name": "GPT-5.3-Codex",
    "status": "deprecated",
    "replacedBy": "gpt-5.6-terra",
    "engines": [
      "codex"
    ],
    "badges": [],
    "roles": [],
    "description": "Deprecated in Codex under ChatGPT auth. Use GPT-5.6 Terra for implementation or select a role-specific GPT-5.6 tier."
  },
  {
    "id": "gpt-5.2",
    "slot": null,
    "provider": "openai",
    "name": "GPT-5.2",
    "status": "deprecated",
    "replacedBy": "gpt-5.6-terra",
    "engines": [
      "codex"
    ],
    "badges": [],
    "roles": [],
    "description": "Deprecated in Codex under ChatGPT auth. Use GPT-5.6 Terra for implementation or select a role-specific GPT-5.6 tier."
  },
  {
    "id": "gpt-4o",
    "slot": null,
    "provider": "openai",
    "name": "GPT-4o",
    "status": "deprecated",
    "replacedBy": "gpt-5.4-mini",
    "engines": [
      "pi"
    ],
    "badges": [],
    "roles": [],
    "description": "Two generations old. Use GPT-5.6 Terra for implementation and validation, Luna for trivial cheap passes and lookups, or Sol for the hardest work and final review."
  },
  {
    "id": "kimi-latest",
    "slot": null,
    "provider": "moonshot",
    "name": "kimi-latest (floating alias)",
    "status": "deprecated",
    "replacedBy": "kimi-k2.7-code",
    "engines": [
      "kimi"
    ],
    "badges": [],
    "roles": [],
    "description": "A floating alias that hides model bumps from this registry. Pin kimi-k2.7-code instead."
  }
]);
