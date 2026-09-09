# Agents are flow callers

The Smithers agent runs model-authored JavaScript cells in a QuickJS sandbox. A cell reaches capabilities through `ctx.call(flowName, input)`. The host controls the available registry and capability envelope; the agent does not gain ambient filesystem or network access by writing JavaScript.

## Use a typed model action

`AgentAction.make` declares a model-backed step with a payload, an output schema, a named seat, system teaching and a prompt. Its `.call` composes like an ordinary action and its `.layer` supplies the implementation. The output is decoded against the declared schema before later steps consume it.

A seat names a model without carrying its credential. The host resolves the seat and provides model routing, budgets and limits. Keep that host choice outside a repository page or workflow's source content.

## The wiki reviewer is an ordinary agent action

The wiki's `ReviewPage` receives the page and bounded source evidence selected by the catalog. Original line numbers remain available, and full source files are captured separately. Its registry has no tools and its capability envelope is empty. It must assess every section and return structured findings with exact source citations. The deterministic assessment step checks coverage and citation integrity before the write gate accepts the result.

The model decides semantic support. Citation validation only establishes that the cited text exists at the claimed location; it does not turn an incorrect argument into a proof. Review uncertainty stays visible and blocks the verified publication path.

## Preserve the evidence needed for inspection

Model calls and capability calls belong to durable execution. The product contract calls for a cheap explanation first, followed by lower-level evidence. An explanation of intent and a recorded action outcome are different facts, and should stay linked rather than be merged into an invented success story.
