# components/

Telegram workflow components:

- Listeners: `OnMessage.js` (`OnMessage`, `OnCallbackQuery`, `OnWebAppData`)
  share `listenerInternals.js` — the Signal.js pattern: render `WaitForEvent`
  on the integration signal, derive chat/thread correlation from props, then
  zod-parse the delivered row for the render-prop children.
- Outbound: `SendMessage.js` (`SendMessage`, `EditMessage`, `SendDocument`,
  `AnswerCallbackQuery`) share `outboundInternals.js` — resolve deps at
  render, then render a dep-less function-child Task so the API call runs as
  a durable compute (the Task `deps` quirk is documented at the top of
  outboundInternals.js: function children WITH `deps` compile to a static
  payload, not a compute).
- `TelegramApproval.js` — composes SendMessage → OnCallbackQuery → a compute
  Task into an in-chat approval. Register `telegramApprovalSchemas` with
  `createSmithers`; run one interactive approval per chat/thread at a time
  (WaitForEvent has no predicate).

Props types live in the `.ts` sidecars (`OnMessageProps.ts`,
`outboundProps.ts`, `TelegramApprovalProps.ts`).
