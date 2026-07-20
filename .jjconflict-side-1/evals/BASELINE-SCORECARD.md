<!-- Illustrative baseline from a bounded live run (mostly haiku, a few sonnet). Regenerate with: bun evals/harness/run-all.ts --only-model haiku && bun evals/harness/scorecard.ts -->

# Fluency Scorecard

> 18 case results across 7 report(s). Lower one-shot rate = docs that need work.

## Overall

- **Pass rate:** 89% (16/18)
- **One-shot rate:** 78%
- **Mean correctness score:** 0.89

### By model

| Key | n | pass | one-shot | mean score |
| --- | --- | --- | --- | --- |
| haiku | 17 | 88% | 82% | 0.88 |
| sonnet | 1 | 100% | 0% | 1.00 |

### By tier

| Key | n | pass | one-shot | mean score |
| --- | --- | --- | --- | --- |
| weak | 18 | 89% | 78% | 0.89 |

### By area

| Key | n | pass | one-shot | mean score |
| --- | --- | --- | --- | --- |
| components-control-flow | 7 | 100% | 86% | 1.00 |
| cli | 4 | 100% | 100% | 1.00 |
| memory | 3 | 33% | 0% | 0.33 |
| agent-instantiation | 3 | 100% | 100% | 1.00 |
| db-query | 1 | 100% | 100% | 1.00 |

## Worst features (fix these first)

| Feature | pass | n |
| --- | --- | --- |
| fact-storage | 33% | 3 |
| approval-component | 100% | 2 |
| task-component | 100% | 1 |
| parallel-component | 100% | 1 |
| branch-component | 100% | 1 |
| logs | 100% | 1 |
| up | 100% | 1 |
| rewind | 100% | 1 |
| optimize | 100% | 1 |
| sequence-component | 100% | 1 |
| runs-status | 100% | 1 |
| claudecode-agent | 100% | 1 |
| codex-agent | 100% | 1 |
| kimi-agent | 100% | 1 |
| human-task-component | 100% | 1 |

## Friction themes → docs/APIs to fix (ranked)

| × | kind :: doc pointer | sample |
| --- | --- | --- |
| 1 | ambiguous-docs :: llms-full.txt lines ~2650-2680 in the Approvals section | The section 'Approvals & human-in-the-loop' uses the phrase "<HumanTask> is for richer int |
| 1 | ambiguous-docs :: bunx smithers-orchestrator docs-full — sections 'Quick Start | Two different patterns for Workflow import exist in the docs: (1) import Workflow directly |
| 1 | had-to-guess :: docs-full — Integrations / CLI Agents section | The task requires ClaudeCodeAgent but the docs primarily show AnthropicAgent for structure |
| 1 | ambiguous-docs :: docs-full — Tour, step 1 | It is unclear whether the ctx parameter is needed for a simple inline-prompt workflow. Som |
| 1 | api-confusing :: ? | The confidence field in the output schema is typed as 'number' with min 0 and max 1 in the |
| 1 | ambiguous-docs :: llms-full.txt Memory section | Memory store access within a Smithers workflow context is not explicitly documented; had t |
| 1 | missing-docs :: llms-full.txt Memory section and Components | No explicit example showing how to imperatively call store.setFact() from within a running |
| 1 | missing-docs :: smithers-orchestrator/memory | No documented examples showing how to retrieve facts from agent namespace using Smithers m |
| 1 | had-to-guess :: ? | Agent ID for the namespace was not specified, used 'default' as a reasonable assumption. |
| 1 | ambiguous-docs :: Memory section in llms-full.txt | Task description says 'delete from workflow namespace' but does not specify which workflow |
| 1 | had-to-guess :: Memory section initialization example | Database path (.smithers/smithers.db) assumed from standard Smithers project structure; do |
| 1 | missing-docs :: Memory Quickstart and Task components sections | No complete example in the docs showing how to call memory store deleteFact from within a  |

