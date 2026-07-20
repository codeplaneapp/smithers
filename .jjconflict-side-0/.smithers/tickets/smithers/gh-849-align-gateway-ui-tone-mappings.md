# Align gateway UI tone mappings

GitHub: https://github.com/smithersai/smithers/issues/849

Update packages/gateway-ui/src/theme.ts statusColors and statusColor behavior so canonical raw and derived run states use the same tones as the shared UI helpers, including recovering, stale, orphaned, succeeded, and cancelled. Add regression coverage for the gateway status-color map.
