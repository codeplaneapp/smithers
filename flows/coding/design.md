# Coding interaction design review

Reviewed September 9, 2026.

Official product documentation checked on September 9, 2026. Graphite, Linear and VS Code screenshots were also inspected. These are design recommendations for Smithers, not claims that those products implement our lifecycle.

## Graphite: keep the stack beside the selected work

The current PR-page screenshot puts a compact connected stack directly below the title, highlights the selected row, and aligns each row's review or dependency status at the right. Its information panel separates unresolved comments, agent review, checks and human reviewers. A green review can coexist with pending checks. The current page differs from older documentation describing a right-hand stack tray. [Current official page and two inspected screenshots](https://graphite.com/docs/pr-page-overview).

**Smithers design recommendation:** Use one selected Change and a compact linear rail. Keep implementation, fast checks and slow review as distinct facts. An earlier finding should point to its owning Change and retain the user's selected context when descendants restack.

**Scenario:** While Change 3 is implementing, Change 1 gets a review finding. Its row explains why it needs repair; the recursive detail shows the exact failed review and affected suffix. Change 3 does not acquire a generic failure badge merely because its ancestor needs work.

**Constraint:** Collapse distant Changes and expand their atomic commits on demand; a full beginning-of-time stack cannot stay readable at this screenshot's scale.

## Graphite: review the difference since the last review

The versions interface lets reviewers choose both operands and offers a comparison against the last reviewed version after an update. Review context is a particular version, rather than an undifferentiated current diff. [Current official interaction documentation](https://graphite.com/docs/pull-request-versions).

**Smithers design recommendation:** Keep selection on the native JJ change ID while exposing the immutable reviewed and current commits. Offer an explicit comparison after restack, with the reason for the rewrite beside it.

**Scenario:** A user returns after a late review repaired Change 1. The UI can show what changed since that user's inspected revision and which receipts became stale. It must never present an old passing receipt as evidence for the new commit.

**Constraint:** Smithers needs recorded native revision pairs. A frontend timestamp or guessed previous SHA is insufficient, and historical views should keep their original operands.

## Linear: communicate the work at conversational scale

The documented session card shows a compact working status and elapsed time beside an explicit link to the detailed session. Semantic activities distinguish progress, actions, clarification and results. Temporary progress can be replaced by a later activity; the evolving plan is a session-level checklist, currently described as a technology preview. [Current official documentation and inspected session screenshot](https://linear.app/developers/agent-interaction).

**Smithers design recommendation:** Lead each turn with a cheap, concrete explanation derived from existing recorded work: what changed, why and what comes next. Keep one clear action for opening the recursive execution detail. Summarize observable work rather than exposing model reasoning as the explanation.

**Scenario:** The person sees 'Checking the database change; starting the server' and can click into the check's command, inputs and receipt without leaving the current conversation frame.

**Constraint:** Replacing a visible progress line must not erase durable evidence. Predicted work, actual activity and validated results need distinct wording, and elapsed time is not percent complete.

## VS Code: every detail belongs to the selected frame

The debugger groups variables, watches and the call stack in one sidebar, puts source in the main pane and output below it. Variable values are relative to the selected stack frame. In multiple-session debugging, the selected session also determines which execution the toolbar controls. [Current official documentation and inspected debugger diagram](https://code.visualstudio.com/docs/debugtest/debugging).

**Smithers design recommendation:** Use the existing recursive card selection as the single context for inputs, outputs, commands, source and control actions. Always show the selected native execution and historical cursor near detailed evidence. Separate navigating recorded history from continuing execution.

**Scenario:** Selecting a review child shows that child's immutable source and receipt. Cancel or steer controls name the owning live run. Opening an older POC shows its original source and cannot silently send feedback to a different run.

**Constraint:** A debugger metaphor is useful for inspection, but stepping through recorded events does not rerun code. Retry, resume and fork are different operations and need their existing precise labels.

## Temporal: compact explanation over exact event history

Temporal offers timeline, all-events, compact logical groups and JSON views of one execution history. Parent/child relationships are separate from that event timeline. Pending activities and waiting locations have their own inspection views; task failures can exist while the workflow is still running. [Current official interaction documentation; no authenticated product session inspected](https://docs.temporal.io/web-ui).

**Smithers design recommendation:** Build the cheap explanation and expanded debugger from the same native execution evidence. Group routine attempts beneath their owning operation, retain exact receipts, and say why a run is waiting. Preserve the distinction between a recoverable child failure and the request's outcome.

**Scenario:** An early slow finding short-circuits one round, cancels obsolete checks and starts repair. The conversation says 'Repairing Change 1'; the expanded history retains the failed round, cancellation acknowledgement and later validation.

**Constraint:** Smithers' mythical code order and its execution event order are different axes. The linear Change rail represents the code; timestamps and child relationships explain concurrent execution below it.

## LangSmith Studio: make detail a progressive choice

Studio distinguishes a simpler chat mode from graph mode, which exposes traversed nodes and intermediate state. It also supports inspecting prior state through time travel. [Current official interaction documentation; no authenticated product session inspected](https://docs.langchain.com/langsmith/studio).

**Smithers design recommendation:** Keep Smithers' conversation and recursive details within one existing frame. Opening the graph should preserve the selected run and cursor, rather than introduce a second independent workspace or navigation history.

**Scenario:** A user opens the implementation behind a one-line explanation, drills into a model/tool turn, then returns to the same Change without losing its preview or feedback draft.

**Constraint:** Graph complexity should be opt-in. The full build graph is useful for explaining dependencies; it should not become the default progress screen for one linear mythical history.

## Implementation boundary

These recommendations guide the recursive run cards; they are not a claim that every interaction has landed. Current native plan and POC evidence cards reuse the existing historical cursor and source-qualified commands. Coordinator-owned steering, direct rewrite comparisons and finalization remain separate work. Original source screenshots are retained in the local HTML study.
