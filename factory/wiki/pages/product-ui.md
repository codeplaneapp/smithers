# Embedded UI and recursive inspection

The UI shares registered flows, persisted state, cards and frames across presentation modes. The September 8 onboarding brief supersedes the older always-visible-chat rule: the conversation is a translucent top panel, hidden until Command-K / Control-K opens it. The owning onboarding document distinguishes local rehearsal from live backend work. Maximizing a card remains a presentation change of the same component and state.

## One flow, three doors

A button, slash command and agent invocation share the same registered action. Required missing arguments render a schema-derived form. Human-only gestures have enumerated exceptions rather than silently hiding consequential capabilities from the agent.

State that a card projects belongs in TanStack DB and changes through the shared actor-tagged transition dispatcher. The UI rules prohibit React effects for application state synchronization. These are contributor requirements; use the owning tests and source to judge compliance of a particular component.

Every required action must have a keyboard path with visible focus and predictable focus movement. The shell controls when conversation is visible; an older embedded-card test is not evidence that the composer must remain visible throughout onboarding.

## Inspect real execution structure

The existing `RunTrace` projection and card provide a starting point for execution inspection. Keep a selected run, frame or cell connected to its recorded evidence. Historical values must come from the historical execution record; today's live state is not a substitute when an old node is selected.

The trace card now starts with a cheap Turns view: bounded excerpts of recorded model prose, falling back to actual call names for code-only responses. Selecting a turn opens its recursive call tree and details in the same card. The selection pins the journal prefix; Latest returns to live turns. These are recorded model words, not independently verified semantic summaries. Realm variable snapshots and some child-run links remain unavailable, and same-name concurrent call settlements retain the journal's FIFO association limit.

## Keep wiki truth visible

The UI rules describe the wiki as Markdown-native linked documents in its own TanStack DB collection, with provenance, confidence, actor and revision. Inferred world state must not look like ground truth. Generated wiki pages therefore expose freshness and semantic verification separately, while human-authored intent remains an independently editable lane.
