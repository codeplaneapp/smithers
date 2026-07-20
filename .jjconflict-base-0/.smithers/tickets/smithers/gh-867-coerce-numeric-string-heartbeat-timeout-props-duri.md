# Coerce numeric-string heartbeat timeout props during graph extraction

GitHub: https://github.com/smithersai/smithers/issues/867

Update parseHeartbeatTimeoutMs in core and DOM extraction to coerce heartbeatTimeoutMs and heartbeatTimeout numeric strings while preserving finite, positive, floored semantics and defaults. Add regression tests for both aliases.
