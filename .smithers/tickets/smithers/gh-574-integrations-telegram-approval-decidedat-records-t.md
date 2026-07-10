# 🐛 integrations: telegram approval decidedAt records the prompt's send time, not the button-press time

GitHub: https://github.com/smithersai/smithers/issues/574

**What happens**
`decidedAtFromCallback` (`packages/integrations/src/telegram/approval.js:203-206`) returns `callbackQuery.message.date` as the decision timestamp (:233). In the Bot API, `callback_query.message` is the message the inline keyboard is attached to — its `date` is when the PROMPT was sent, not when the button was pressed.

**Why it's wrong / failure scenario**
A press one hour after the prompt yields a `decidedAt` one hour in the past, corrupting any audit trail of when the human actually decided. Worse, for prompts older than 48h Telegram delivers an `InaccessibleMessage` with `date: 0`, which this code converts to `1970-01-01T00:00:00.000Z`.

**Expected behavior**
Use the press time. Telegram does not put one on `callback_query`, so the honest value is the delivery `receivedAtMs` or the resolution wall clock — or rename/document the field as "prompt sent at".

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
