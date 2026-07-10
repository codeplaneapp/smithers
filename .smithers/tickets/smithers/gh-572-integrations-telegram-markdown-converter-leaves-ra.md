# 🐛 integrations: telegram markdown converter leaves raw NUL sentinels when a header contains inline formatting

GitHub: https://github.com/smithersai/smithers/issues/572

**What happens**
In `packages/integrations/src/telegram/markdown.js`, `convertMarkdownToTelegram` replaces inline code/links/bold/strike/italic with NUL sentinels (steps 1-6) before the header pass (step 7, :116-117). The header replacement stores a string that itself contains a sentinel, and the final `finalEscaped.replace(SENTINEL_REPLACE, ...)` does not rescan substituted text, so the inner sentinel is never expanded.

Reproduced on the current tree:
- `convertMarkdownToTelegram("# see \`code\` here")` → `"*see \^@0\^@ here*"`
- `convertMarkdownToTelegram("# **Bold** title")` → `"*\^@0\^@ title*"`

**Why it's wrong / failure scenario**
Telegram rejects messages containing NUL bytes, so any bot message whose markdown has a header with inline formatting (extremely common in agent output) fails MarkdownV2 send and at best falls back to plain text.

**Expected behavior**
Header bodies contain the converted inner formatting — either expand sentinels recursively until none remain, or run the header pass before the inline passes.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
