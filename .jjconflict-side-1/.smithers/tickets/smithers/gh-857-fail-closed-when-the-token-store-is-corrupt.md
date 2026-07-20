# Fail closed when the token store is corrupt

GitHub: https://github.com/smithersai/smithers/issues/857

Change token-store loading and mutation flows so a malformed existing tokens.json cannot be treated as an empty writable store. Preserve the original bytes, return a clear failure, and require an explicit reset operation before replacing corrupt credential state. Add regression tests proving token grants and action handles are not clobbered.
