# @smthrs/chain

The Agent Chain spine: an append-only journal of typed events, keyed
replayable calls, and the trampoline that runs model-authored flow scripts.

The journal is the only state. Every other structure — the call cache used
for replay, transcripts, UIs — is a pure fold over it. The model seat is a
port (`Author`), mocked in tests; the script interpreter is a port
(`ScriptRunner`), implemented in-process here and swappable for a hardened
sandbox without touching the chain. The in-memory `Journal` layer is a
deletable stand-in for the Smithers engine: the e2e suite asserts journal
contents, not kernel API, so the suite survives the engine swap.
