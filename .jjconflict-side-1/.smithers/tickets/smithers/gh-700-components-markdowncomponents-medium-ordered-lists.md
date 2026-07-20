# 🐛 components(markdownComponents): [medium] ordered lists render as bullets, step numbers dropped from agent prompts

GitHub: https://github.com/smithersai/smithers/issues/700

_via ultracode (Opus multi-agent) review_

## Summary
`markdownComponents` maps `<ol>` identically to `<ul>` and hardcodes a `"- "` bullet on every `<li>`, so ordered lists lose their `1.`/`2.` numbering when serialized into agent prompt text.

## Location
- `packages/components/src/markdownComponents.js:19` (`ol` == `ul`, `fragment(children, "\n")`)
- `packages/components/src/markdownComponents.js:21` (`li` always emits `"- "`)
- Behavior pinned by `packages/components/tests/markdown-components.test.jsx:56-58` (`ol` asserted equal to `ul`)

## Reachability
Live in the primary prompt path: `renderPromptToText` (`packages/components/src/components/Task.js:57-71`) injects `markdownComponents` into compiled MDX prompts before `renderToStaticMarkup`; `renderMdx.js:19` and `deferred-state-bridge.js:113` use the same mapping. MDX compiles markdown `1. …\n2. …` into `<ol><li>…`, which routes through this mapping.

## Failure scenario
A prompt body with an ordered list — markdown `1. First run the migration\n2. Then restart the worker` (compiled to `<ol><li>First run the migration</li><li>Then restart the worker</li></ol>`) — renders to:
```
- First run the migration
- Then restart the worker
```
The explicit step numbers the author wrote are gone from the text the agent receives.

## Why it matters
Numbered/ordered instructions are common in agent prompts and ordinal labels can carry meaning (step references). Item sequence is preserved, but the numeric labels are silently dropped, degrading prompt fidelity with no warning.

## Fix
Thread an incrementing counter through `ol` (respecting `start`) so `li` emits `1. `, `2. ` prefixes for ordered lists instead of reusing the `ul` bullet mapping.
