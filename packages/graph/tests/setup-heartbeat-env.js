// Test preload: exercise the module-load-time SMITHERS_TASK_HEARTBEAT_MS parse
// branch in extract.js / dom/extract.js. That env var is read exactly once, when
// each module is first imported (to seed the DEFAULT_*_HEARTBEAT_TIMEOUT_MS
// constants), so the only way to cover the parse-and-validate path in-process is
// to have the value present on that first import. We set a deliberately
// non-numeric value (so the constants still fall back to the 600_000 default
// every other test asserts against), force both modules to load, then delete the
// var again so it never leaks into the subprocess-based heartbeat tests.
process.env.SMITHERS_TASK_HEARTBEAT_MS = "coverage-not-a-number";
await import("../src/extract.js");
await import("../src/dom/extract.js");
delete process.env.SMITHERS_TASK_HEARTBEAT_MS;
