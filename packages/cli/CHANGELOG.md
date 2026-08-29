# /cli

## [Unreleased]

### Added

- Added `NodeControl.rebuildableTransport`: the production executor now runs on an Undici agent it can replace. Each agent is acquired in a scope forked off the caller's and the previous one is closed the moment the next is in hand, so a run that keeps meeting dead sockets holds one connection pool rather than a queue of them. The dispatcher factory is a parameter so a test can hand it a scripted one.

- Added the `openrouter:` seat provider: `openrouter:vendor/model` routes through the OpenAI-compatible Responses surface at openrouter.ai with `OPENROUTER_API_KEY`.

- Initial release.
- Rendered `flows logs` as a turn-by-turn transcript and `flows status <run-id>` as a diagnosis card (verdict, gating cause, refusal histogram, edit and token accounting) in human output; `--json` output is unchanged.
