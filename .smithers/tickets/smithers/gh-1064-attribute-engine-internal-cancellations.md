# Attribute engine-internal cancellations

GitHub: https://github.com/smithersai/smithers/issues/1064

Identify engine-generated cancellation paths and persist them with source kind engine plus a useful detail string, while preserving attribution when cancellation is triggered by an external signal, CLI, or RPC. Add end-to-end coverage for competing cancellation sources.
