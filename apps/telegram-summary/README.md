# Telegram Summary

Cloudflare Worker app for `telegram-summary.smithers.sh`.

The production path is:

1. Cloudflare Cron calls the Worker every 15 minutes to collect Telegram Bot API `getUpdates` into D1.
2. A daily Cron run reads the last `DIGEST_WINDOW_HOURS` messages, calls Kimi through Moonshot's OpenAI-compatible `/v1/chat/completions` endpoint, stores the digest, and posts it back to Telegram.
3. The root page serves a lightweight dashboard showing the latest digest and digest history. Raw messages stay in D1 and are not exposed by the dashboard API.

Smithers itself is not embedded in this Worker. The local replayable workflow lives at `.smithers/workflows/telegram-daily-digest.tsx`, and its custom Smithers UI lives at `.smithers/ui/telegram-daily-digest.tsx`.

## Deploy

```bash
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_SUMMARY_SOURCE_CHAT_ID=... \
TELEGRAM_SUMMARY_ADMIN_TOKEN=... \
MOONSHOT_API_KEY=... \
CLOUDFLARE_SMITHERS_ZONE_ID=... \
pnpm -C apps/telegram-summary deploy
```

`MOONSHOT_API_KEY` can be omitted for an infrastructure-only deploy. Digest runs will report missing Kimi credentials until the secret is provided.

## Configuration

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token used for `getUpdates` and `sendMessage`. |
| `TELEGRAM_SUMMARY_SOURCE_CHAT_ID` | Group chat id or username to summarize. Set this in production so the bot ignores other chats. |
| `TELEGRAM_SUMMARY_OUTPUT_CHAT_ID` | Optional destination chat. Defaults to the source chat. |
| `TELEGRAM_SUMMARY_OUTPUT_THREAD_ID` | Optional Telegram forum topic id. |
| `TELEGRAM_SUMMARY_ADMIN_TOKEN` | Bearer token for manual `/api/ingest` and `/api/run-digest`. |
| `MOONSHOT_API_KEY` | Kimi API key. |
| `KIMI_MODEL` | Defaults to `kimi-k2.6`. |
| `TELEGRAM_SUMMARY_INGEST_CRON` | Defaults to `*/15 * * * *`, in UTC. |
| `TELEGRAM_SUMMARY_DIGEST_CRON` | Defaults to `0 0 * * *`, in UTC. |
| `TELEGRAM_SUMMARY_WINDOW_HOURS` | Defaults to `24`. |
| `CLOUDFLARE_SMITHERS_ZONE_ID` | Optional zone id for `telegram-summary.smithers.sh` if Alchemy cannot infer it. |

The Telegram bot must be able to see normal group messages. In Telegram this usually means adding the bot to the group and disabling privacy mode through BotFather, or making the bot an admin.
