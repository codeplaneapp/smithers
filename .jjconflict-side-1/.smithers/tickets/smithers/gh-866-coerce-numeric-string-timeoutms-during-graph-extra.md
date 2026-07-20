# Coerce numeric-string timeoutMs during graph extraction

GitHub: https://github.com/smithersai/smithers/issues/866

Update core and DOM graph extraction so numeric-string timeoutMs props are converted to finite numeric timeout values, with regression tests covering string values and invalid inputs.
