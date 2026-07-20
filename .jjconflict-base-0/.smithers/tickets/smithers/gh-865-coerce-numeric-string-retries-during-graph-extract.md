# Coerce numeric-string retries during graph extraction

GitHub: https://github.com/smithersai/smithers/issues/865

Update core and DOM graph extraction so numeric-string retries props, including retries="0", are coerced before explicit-retry detection and clamping. Update the HumanTask finite-attempt guard consistently, and add regression tests for string retry values.
