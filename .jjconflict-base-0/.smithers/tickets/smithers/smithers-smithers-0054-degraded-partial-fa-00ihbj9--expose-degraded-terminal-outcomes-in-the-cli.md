# Expose degraded terminal outcomes in the CLI

GitHub: https://github.com/smithersai/smithers/issues/977

Parent: smithers/smithers-0054-degraded-partial-failure-run-status--propagate-degraded-outcome-through-events-gateway-.md

Context: CLI inspect currently reconstructs failed-child information by scanning node rows, while event formatting only conditionally displays fields already present in an event payload. Acceptance criteria: consume the authoritative RunFinished/result fields, expose failedChildren and failedChildKeys in inspect and terminal event output, retain the clean-run omission behavior, and add regression tests.
