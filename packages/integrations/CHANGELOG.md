# @smthrs/integrations

## [1.0.0-rc.0] - 2026-09-01

The package is private at this version. `package.json` `files` has always
listed a changelog; this is it.

### Added

- Added `GitHub.Repository`, which validates an owner and a repository before
  either becomes part of a request path, and made it the only way this package
  builds one. `GitHub.Actions.CommentOnIssuePayload` demands the same shapes.
- Added `retryUnsafeWrites` to `GitHub.GitHubClient`'s request options, and
  `outcomeUnknown` to the failure a write raises when its result is unknown.
- Added `truncated` to what `GitHub.GitHubClient.paginate` returns, and bounds
  on `perPage`, `maxPages`, and `maxRetries`.
- Added `idempotencyKey` to `GitHub.Webhook`, `Linear.Webhook`, and
  `Telegram.Source`, so an ingress can derive the delivery identity that
  `Channels.ingest` needs to drop a redelivery.
- Added `Telegram.TelegramClient.toIntegrationError`, so a Bot API failure
  reaches the journal with a machine-readable reason.
- Added a bounded `pending` record to the listener ownership state, so a run
  interrupted between creating a hook and claiming it converges instead of
  reporting a permanent conflict. The record is retired on a refusal, dropped
  when the declaration changes, expires after `PENDING_CREATE_MAX_AGE_MS`, and
  adopts only when exactly one hook holds the URL.
- Added `outcomeUnknown` and `deliveredMessageIds` to
  `Core.ActionFailure.IntegrationFailure`, so an ambiguous write and a partial
  Telegram send are legible in the journal rather than only on the client
  error.
- Added `Environment.ambientWorkingDirectory`, package-owned documentation
  under `docs/`, and the `BUILD.ts` target that generates the published API
  page from it.
- Added `Core.ActionFailure.isMessageId` and `Core.ActionFailure.MessageId`,
  the one rule the Telegram guard, the journal conversion, and the persisted
  schema all read, so a list one accepts and another rejects cannot put a throw
  back into `Effect.mapError` or a `NaN` into a journal row.

### Changed

- Stop repeating a non-idempotent write. A rate limit is still retried for
  every method, because the request was refused rather than performed; a 5xx or
  a dropped connection on a POST, PATCH, PUT, or DELETE is not. The same rule
  applies to `issueCreate`, `issueUpdate`, and `commentCreate` in
  `Linear.LinearClient`.
- Give `Telegram.TelegramClient` and `Telegram.Source` the `(config, env)`
  signature the other providers have, so `SMITHERS_TELEGRAM_BOT_TOKEN` is
  actually read.
- Fail closed in `Telegram.Source` when an allowlist is configured and an
  update's chat cannot be determined, when a stored cursor does not parse, and
  when `getUpdates` returns something that is not an update array.
- Scope Telegram dedupe keys to the source id, since `update_id` is per bot.
- Treat an absent or empty approval token as matching nothing, and tighten
  `parseCallbackData` to the grammar `callbackData` emits.
- Validate `Telegram.Chunk.chunk`'s `maxLength`, which used to hang the event
  loop at zero, and never split a surrogate pair.
- Read own properties only in `Core.JsonPath.readJsonPath`.
- Refuse an `extraParams` entry that would overwrite an OAuth or PKCE
  parameter.
- Close `Core.SignalName.parse` over the names `eventName` can build.
- Enforce the documented "exactly one of `teamKey` and `teamId`", normalize a
  team key for both the cache and the query, freeze the cached team, and treat
  an explicit empty `labels` array as a request to clear labels.
- Run the unowned-callback collision check before every listener `create`, not
  only the one for a listener with no ownership entry, and plan a `delete` only
  for a hook that is still there, so an interrupted repository move finishes on
  the next run instead of retrying a delete GitHub answers 404.
- Raise the coverage thresholds and record what the remaining shortfall stands
  for, behavior by behavior.

### Fixed

- Fixed the typed-failure channels that died as defects instead: a missing or
  unparseable listener registry, an ownership-state write, a Linear priority
  outside the scale, a caller-supplied webhook verifier that throws, a request
  path that is not a URL, and a forged or drifted `IntegrationError` reaching
  `fromIntegrationError`.
- Fixed provider responses being cast rather than decoded. A malformed GitHub
  hook list or Linear connection now fails `decode-failed` naming the field
  path, never carrying the body.
- Fixed a multi-chunk Telegram send reporting more messages than it could name,
  and made a partial send report the ids it had already delivered.
- Fixed `Telegram.InitData` reporting a malformed `publicKeyHex` as an
  unsupported runtime, and bounded the freshness window at both ends.
- Fixed the Linear webhook accepting an unbounded replay window, and a
  fractional `maxTimestampSkewMs` the option's own documentation forbids.
- Fixed `GitHub.Repository` refusing a GitHub Enterprise Managed User's
  `<name>_<shortcode>` login, which locked every enterprise-managed account out
  of the package. Only `.` and `/` can walk a request off its endpoint, and
  neither is in the widened class.
- Fixed a `sendMessage` the Bot API answered with an unusable `message_id`
  reaching the journal as an ambiguous delivery. The message was delivered and
  only its receipt is unreadable, so it is now `decode-failed` with a known
  outcome rather than a write an operator might resend.
- Fixed `Linear.LinearClient.resolveTeam` erasing a wrong-typed `key` or `name`
  on a resolved team to `undefined`, which turned "Linear changed this field"
  into "this team has no key". It now fails `decode-failed` naming the path, the
  rule the other connection readers already followed.
- Fixed the error contract in `docs/api.md` claiming every failure a caller sees
  is an `IntegrationError`. That holds for the Effect channel; the plan-time
  helpers that validate their arguments throw `SmithersError`, and the page now
  names them.
- Fixed a request body that cannot be serialized being reported as a write
  whose outcome is unknown, a `sendMessage` result with a non-positive
  `message_id` counting as delivered, a `getUpdates` cursor read through
  `Number()` rather than as a decimal offset, an update member of the wrong
  shape reaching the mapper, an empty Telegram source id, an approval press
  whose select key carries a colon, and an `ExternalEvent` carrying a signal
  name `SignalName.eventName` could not build.
- Fixed the false claims in the README and the published API page: the Telegram
  environment variable, the redelivery guarantee, the retry promise on an
  irreversible action, and the uniform error contract.
- Fixed `Telegram.TelegramClient.isTelegramApiError` admitting a claimed Bot
  API failure that carries no `deliveredMessageIds`, which made
  `toIntegrationError` spread a missing array and throw a bare `TypeError`
  inside `Effect.mapError`, where a throw is a defect rather than the
  classified failure the action's type promises. A list whose members are not
  all message ids is now dropped rather than journaled, since `Schema.Number`
  encodes a non-finite member as the string "NaN".
