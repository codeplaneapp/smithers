# 🐛 components(renderMdx): [medium] public renderMdx HTML-entity-escapes prompt text (no decode), corrupting agent prompts

GitHub: https://github.com/smithersai/smithers/issues/693

_via ultracode (Opus multi-agent) review_

**Summary:** `renderMdx` returns raw `renderToStaticMarkup` output without decoding HTML entities, so `<`, `>`, `&`, `"`, `'` in prompt text reach agents as `&lt;`/`&gt;`/`&amp;`/`&quot;`/`&#x27;` — the exact corruption its sibling `renderPromptToText` fixes.

**Refs:**
- Bug: `packages/components/src/renderMdx.js:23-25` — `return renderToStaticMarkup(element).replace(/\n{3,}/g,"\n\n").trim();` (no decode).
- Correct sibling: `packages/components/src/components/Task.js:76` wraps the identical render in `decodeHtmlEntities(...)`; helper at `Task.js:37-45` with rationale at `Task.js:27-33`.
- Public re-export: `packages/smithers/src/index.js:254` (`smthrs` → `renderMdx`).
- Documented agent-prompt use: `docs/examples/worktree-feature-prompts.mdx:195` (`export const SYSTEM_PROMPT = renderMdx(...)`).

**Failure scenario (reproduced):** A component/MDX emitting `if a < b && c > d then "go"` renders via `renderMdx` to `<p>if a &lt; b &amp;&amp; c &gt; d then &quot;go&quot;</p>`, whereas `renderPromptToText` yields the literal text. Any prompt with comparison operators, ampersands, quotes, or embedded JSON/code (`{"key": 1}`) is silently mangled when passed to an agent, with no error.

**Why it matters:** `renderMdx` is a documented public helper for building agent prompts (system prompts). Every consumer not routed through `Task.renderPromptToText` gets corrupted operators/quotes/JSON, degrading agent behavior silently. The existing `tests/render-mdx.test.jsx` misses it because all inputs are escape-free.

**Fix:** Reuse the same decode pass — extract `decodeHtmlEntities` to a shared module and apply it in `renderMdx` so the two paths cannot drift; add a test with escapable characters.
