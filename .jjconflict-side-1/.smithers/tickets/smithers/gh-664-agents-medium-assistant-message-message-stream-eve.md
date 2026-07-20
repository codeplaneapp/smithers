# 🐛 agents: [medium] assistant "message"/"MESSAGE" stream events emitted 2–3× to live output

GitHub: https://github.com/smithersai/smithers/issues/664

_via ultracode (Opus multi-agent) review_

**Summary:** The three final-text branches in `extractCliStreamTextChunks` overlap and `emitFinal` never dedupes, so a single string-content assistant `message` line is streamed to `onText` twice or three times.

**Locations:**
- `packages/agents/src/BaseCliAgent/createAgentStdoutTextEmitter.js:45` — `emitFinal` guards only on `state.sawDeltaSinceBoundary`, never on `state.lastFinalText` (contrast `emitResult` at line 63).
- Overlapping `if`s: line 103 (`type==="message" && role==="assistant"`), line 106 (`upperType==="MESSAGE" && role==="assistant"`), line 114 (`role==="assistant" && typeof content==="string"`).

**Failure scenario (verified by running the emitter):**
- Input line `{"type":"message","role":"assistant","content":"Answer"}` → `onText` receives `["Answer","Answer","Answer"]`. Because `"message".toUpperCase()==="MESSAGE"` and `content` is a string, all three branches fire; each calls `emitFinal("Answer")`, which pushes every time.
- Input line `{"type":"MESSAGE","role":"assistant","content":"x"}` → `onText` receives `["x","x"]` (branches at 106 + 114).

Consumers (TUI, `smithers chat`, gateway UI) render the streamed answer doubled/tripled, and it is persisted as a NodeOutput duplicated — exactly the corruption the `emitResult` comment (lines 52-59) calls out and guards against, but `emitFinal` does not.

**Why it matters:** Real string-content assistant lines hit branch 114 (a bare catch-all) in addition to 103/106, so the duplication is structural, not a contrived input. The unit test at `packages/agents/tests/coverage-base-cli-helpers.test.js:197` feeds these lines but asserts only `.toContain`, so it never catches it.

**Fix sketch:** Make the branches mutually exclusive (`else if`) and/or add the `text !== state.lastFinalText` guard to `emitFinal` (mirroring `emitResult`), and tighten the test to assert exact chunk counts.
