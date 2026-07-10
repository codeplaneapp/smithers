# Add resume-safe child relaunch and deduplication

GitHub: https://github.com/smithersai/smithers/issues/886

Define stable child identity or idempotency semantics so a resumed or relaunched parent reattaches to existing child runs instead of creating duplicate fan-out. Add crash, resume, and duplicate-launch tests.
