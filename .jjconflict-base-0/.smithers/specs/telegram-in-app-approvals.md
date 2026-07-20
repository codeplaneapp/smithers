# Telegram in-app approvals

Status: in progress (2026-07-02). Owner: will@tevm.tech.

## Problem

Smithers has durable Telegram plumbing (a `getUpdates` polling source, the
`OnMessage` / `OnCallbackQuery` durable-wait components, inline-keyboard and
`web_app` button *types*, `answerCallbackQuery`) but nothing bridges it to the
approval system. A workflow that hits an approval gate can only be resolved from
the CLI, the gateway UI, or an MCP call. You cannot approve from the phone you
already have Telegram open on, and there is no Mini App for a richer decision
(view the diff, pick an option, add a note) inside the chat.

Reference bots that already do this well: `jsayubi/ccgram` (Claude Code hooks to
inline Allow/Deny/Always/Defer), `grinev/opencode-telegram-bot` (single-user
allowlist + localhost backend), `clawvader-tech/hermes-telegram-miniapp` (a real
Mini App that HMAC-verifies `initData` server-side). The common shape: compact
`action:id` `callback_data`, an approver allowlist keyed on the presser's user
id, and, for Mini Apps, a backend that verifies `initData` before trusting it.

## What we ship

Two tiers, both landing in `@smithers-orchestrator/integrations/telegram`.

### Tier 1 — inline-keyboard approvals (the headline, no hosting)

A `Telegram.Approval` component that composes the existing durable primitives:
post the request to a chat with an inline keyboard, durably wait for the button
press, acknowledge it, edit the message to show the outcome, and return a
decision whose shape matches the existing `approvalDecisionSchema` /
`approvalSelectionSchema` / `approvalRankingSchema`. It resolves entirely in the
chat over the long-poll source. No web server, no gateway wiring.

```
<Telegram.Approval
  id="ship"
  chatId={chatId}
  request={{ title: "Deploy to prod?", summary: prBody }}
  output={outputs.decision}
  config={{ botToken }}
/>
```

Modes:
- `approve` (default): Approve / Reject buttons, output `{ approved, note,
  decidedBy, decidedAt }`.
- `select`: one button per option, output `{ selected, notes }`.
- `rank` is out of scope for Tier 1 (ranking has no natural button UX); use the
  gateway UI for ranking.

Optional `miniApp: { url }` adds a `web_app` button that opens Tier 2 alongside
the plain buttons.

Rendering (composite):

```
<>
  <SendMessage id="ship:ask" chatId inlineKeyboard={approvalInlineKeyboard(...)} text=... />
  <OnCallbackQuery id="ship:wait" chatId threadId? dependsOn={["ship:ask"]}>
    {(cq) => <>
      <AnswerCallbackQuery id="ship:ack" callbackQueryId={cq.id} text=... dependsOn={["ship:wait"]} />
      <EditMessage id="ship:done" chatId messageId={cq.message.message_id} text=... inlineKeyboard={[]} dependsOn={["ship:wait"]} />
      <Task id="ship" output={outputs.decision} dependsOn={["ship:wait"]}>
        {() => telegramApprovalDecision(cq, mode, options)}
      </Task>
    </>}
  </OnCallbackQuery>
</>
```

Decision derivation is deterministic from the persisted `callback_query`:
- `decidedBy` = `@username` or `id` from `callback_query.from`.
- `decidedAt` = ISO from `callback_query.message.date` when present, else null.
- `approved` = the pressed choice.

Constraints (documented, matching `OnCallbackQuery` semantics):
- `WaitForEvent` wakes on the first `callback_query` for the chat/thread
  correlation and has no predicate. Run one interactive approval per chat (or
  isolate concurrent approvals with `threadId` / forum topics). `callback_data`
  is namespaced (`sap:` prefix + choice) so a stray non-approval press is
  ignored rather than mis-resolving.
- `callback_data` stays inside Telegram's 1-64 byte cap: `sap:a`, `sap:d`,
  `sap:o:<optionKey>` (option keys are validated to keep the total small).
- Any group member can press. `allowedUserIds` restricts who may resolve; a
  press from anyone else is answered with an alert and the wait keeps waiting is
  NOT possible with a single WaitForEvent, so for Tier 1 the allowlist is
  advisory and the enforcement point is the private chat / allowed chat. The
  gateway/Mini App path enforces the presser id.

### Tier 2 — Mini App (rich in-app web UI)

Security primitive + client method + a reference app.

`verifyTelegramWebAppInitData(initData, botToken, options?)` — verifies a Mini
App's `initData` using the HMAC path, isomorphic (Web Crypto, so it runs in the
smithers runtime and in a Cloudflare Worker). Returns the parsed, trusted fields
on success; throws a `SmithersError` (`TELEGRAM_INIT_DATA_INVALID`) otherwise.

Algorithm (verified against official docs + `@telegram-apps/init-data-node` +
aiogram):
1. Parse with `URLSearchParams` (decode each value once). Pull out `hash`.
2. `dataCheckString` = remaining pairs (`signature` stays in) as `key=value`,
   sorted, `\n`-joined.
3. `secret = HMAC_SHA256(key="WebAppData", msg=botToken)` (raw bytes).
4. authentic iff `constantTimeEqual(hex(HMAC_SHA256(key=secret,
   msg=dataCheckString)), hash)`.
5. Reject when `auth_date + maxAgeSeconds < now` (default `maxAgeSeconds` 3600).

`verifyTelegramWebAppInitDataSignature(initData, botId, options?)` — the Ed25519
third-party path (validate with only the numeric bot id + Telegram's public
key). Excludes `hash` and `signature`; message `"<botId>:WebAppData\n" + sorted
pairs`; `crypto.subtle.verify("Ed25519", ...)`.

`parseTelegramInitData(initData)` — the shared parser (returns `{ user, authDate,
queryId, chatInstance, chatType, startParam, hash, signature, raw }`).

Client: `answerWebAppQuery(webAppQueryId, result)` on `TelegramClientService`
(for inline-launched Mini Apps that post a result back to the chat).

Durable inbound: `OnWebAppData` listener + `integration:telegram:web_app_data`
event. A reply-keyboard Mini App's `Telegram.WebApp.sendData(json)` arrives as a
`message` with a `web_app_data` field; `telegramUpdateToEvents` emits an extra
`web_app_data` event for it so a run can wait specifically for structured
Mini-App data.

Helpers: `webAppButton(text, url)` and `approvalInlineKeyboard({ mode, options,
miniAppUrl, texts })` build the keyboards.

Reference Mini App (in `apps/telegram-site`, not deployed): a static
`approve.html` using `telegram-web-app.js` (theme variables, `MainButton`,
`HapticFeedback`), and a Worker `POST /approve` endpoint that reads
`Authorization: tma <initData>`, verifies it for real, and returns the decision.
Shipped as reference code + a unit test that builds valid and tampered
`initData` with a real HMAC (no mocks). Wiring the endpoint to a live gateway
`resolve_approval` is documented as the deployment step.

## API surface (new exports from `.../integrations/telegram`)

- `verifyTelegramWebAppInitData(initData, botToken, { maxAgeSeconds? })`
- `verifyTelegramWebAppInitDataSignature(initData, botId, { maxAgeSeconds?, publicKey? })`
- `parseTelegramInitData(initData)`
- `TELEGRAM_WEBAPP_ED25519_PUBLIC_KEY_PROD` / `_TEST`
- `TelegramClientService.answerWebAppQuery(webAppQueryId, result)`
- `webAppButton(text, url)` · `approvalInlineKeyboard(spec)` ·
  `telegramApprovalCallbackData(choice)` / `parseTelegramApprovalCallbackData(data)`
- `TelegramApproval(props)` (component)
- `OnWebAppData(props)` (component) · `TELEGRAM_WEB_APP_DATA_EVENT` ·
  `telegramWebAppDataCorrelationId` (reuses chat correlation) ·
  `TelegramWebAppDataSchema`

## Testing (no mocks)

- `verifyTelegramWebAppInitData`: build a real signed `initData` with the same
  HMAC in the test, assert accept; tamper one byte / expire `auth_date` / swap
  the token, assert reject. Ed25519 path tested against a fixed known vector.
- `answerWebAppQuery`: fixture Bot API server handler; assert the wire call.
- `TelegramApproval`: drive the real engine against the fixture — push a
  `callback_query` update, assert the run posts the keyboard, answers the query,
  edits the message, and produces the decision output. Approve and reject and
  select cases.
- `OnWebAppData` + `telegramUpdateToEvents`: unit-assert the extra event; pipeline
  test that a `web_app_data` message signals a waiting run.
- Reference worker: unit test the `/approve` endpoint with real valid/invalid
  `initData`.

## Docs + marketing

- Rewrite `docs/integrations/telegram.mdx`: add "Approve from the chat"
  (Tier 1) and "Mini App approvals" (Tier 2, with the exact verify algorithm and
  the Worker snippet). Regenerate `llms-*` bundles (`pnpm docs:llms`).
- `apps/telegram-site`: add an approvals hero/section (inline Approve/Reject
  buttons + a "Open Mini App" affordance). Keep the site tests green; verify
  headless.

## Out of scope (follow-ups)

- Deploying a live Mini App wired to a real gateway `resolve_approval`.
- Rank-mode buttons.
- Enforcing the approver allowlist inside a single `WaitForEvent` (needs a
  filtering wait or a resolve-via-gateway press handler).
