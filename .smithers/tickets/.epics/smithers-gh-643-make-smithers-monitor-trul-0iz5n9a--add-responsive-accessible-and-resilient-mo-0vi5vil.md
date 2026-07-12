# Add responsive, accessible, and resilient monitor validation

GitHub: https://github.com/smithersai/smithers/issues/995

Parent: smithers/gh-643-make-smithers-monitor-truly-beautiful-matc-00hgmat.md

Context: the monitor is a live operational surface and must not look broken during loading, failures, narrow layouts, or transient gateway outages. Acceptance criteria: define responsive layouts for mobile through wide desktop without forced overflow; implement consistent focus rings, keyboard operation, dialog semantics, escape handling, focus trapping/restoration, contrast, reduced motion, and screen-reader labels; add real browser tests covering both themes, viewport sizes, loading/empty/error/offline states, approvals, tree interaction, events, and modal behavior.
