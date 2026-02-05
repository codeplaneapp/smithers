# /bash network blocking is bypassable

Severity: High

Location: `src/bun/tools/index.ts:147`

Description:
Network blocking for `/bash` is implemented as a string heuristic over tokens. This is not a reliable security boundary and can be bypassed (e.g., via interpreters, indirect network libraries, or non-URL tokens).

Impact:
If users rely on this setting for security, network access may still occur, breaking assumptions.

Suggested Fix:
If network blocking must be enforced, use OS-level sandboxing or a restricted runtime. Otherwise, document clearly that the check is advisory only.
