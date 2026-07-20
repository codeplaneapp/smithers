# Integrations: agent-callable tool catalog — remaining

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#222](https://github.com/smithersai/smithers/issues/222) (roadmap tracking issue)
> Triaged 2026-06-18 against `main` (post-#442): **15 of 87 delivered, 72 still open**

## Context

Substrate (Tier 0) is mostly in place — inbound/outbound MCP, OpenAPI->tools curation, generic HTTP tool, and the scoped token broker all landed. The **load-bearing gap is the delegated per-user OAuth connection/credentials plane** (`accounts.json` is still plaintext and `AccountProvider` is a closed union of LLM engines). Tier 1 is a curated-connector backlog — none shipped yet (each is just a logo on the wishlist). Tier 2 primitives are half done: web search, OCR, transcription, TTS, image gen landed; code-exec sandbox, browser automation, RAG, agent-memory-as-tool remain. See issue #222 for the full strategy + anti-patterns. Mirror check-offs here onto #222.

## Open items


### Tier 0 — Substrate (the actual product; harden before any logos)

- [ ] **Import-any-package sandbox step**: back `<Sandbox>` with E2B / Daytona / Modal
  - _missing:_ <Sandbox> primitive + provider abstraction exist, but no managed cloud sandbox backing (E2B/Daytona/Modal) is implemented
- [ ] **Connection / credentials plane** with delegated per-user OAuth (auth-code + PKCE, encrypted storage, single-flight refresh, per-tenant scoping) — buy Nango or Composio/Arcade behind a thin vault abstraction
  - _missing:_ The load-bearing gap: no delegated per-user OAuth, no auth-code+PKCE, no encrypted storage, no single-flight refresh, no per-tenant scoping, no Nango/Composio/Arcade vault abstraction
- [ ] **Webhook ingress generalization**: per-provider signature schemes + payload mappers + idempotent dedup (`packages/server` `GatewayWebhookConfig`)
  - _missing:_ Single configurable HMAC scheme only; no per-provider signature schemes, no payload mappers, and no idempotent dedup (grep for idempotent/dedup in server returns nothing)

### Tier 1 — Table stakes (curated ergonomic connectors)


**Communication & human-in-loop**
- [ ] Slack
- [ ] Discord
- [ ] Telegram
- [ ] Email (SMTP send / IMAP read)
- [ ] Microsoft Teams
- [ ] WhatsApp
- [ ] Twilio SMS

**Dev & DevOps**
- [ ] GitHub
- [ ] GitLab
- [ ] Bitbucket
- [ ] Sentry
- [ ] PagerDuty
- [ ] Vercel
- [ ] Netlify
- [ ] Cloudflare
- [ ] CI (GitHub Actions)

**Project management & issue tracking**
- [ ] Linear
- [ ] Jira
- [ ] Asana
- [ ] ClickUp
- [ ] Shortcut
- [ ] Height

**Docs & knowledge**
- [ ] Notion
- [ ] Google Docs / Drive
- [ ] Confluence
- [ ] Coda

**Data & databases**
- [ ] Postgres
- [ ] MySQL
- [ ] MongoDB
- [ ] Redis
- [ ] Supabase
- [ ] Snowflake
- [ ] BigQuery
- [ ] Airtable
- [ ] Google Sheets

**CRM, sales & support**
- [ ] HubSpot
- [ ] Salesforce
- [ ] Attio
- [ ] Pipedrive
- [ ] Intercom
- [ ] Zendesk
- [ ] Front

**Payments & commerce**
- [ ] Stripe
- [ ] Shopify
- [ ] PayPal
- [ ] Plaid
- [ ] QuickBooks

**Calendar & scheduling**
- [ ] Google Calendar
- [ ] Cal.com
- [ ] Outlook / 365 Calendar
- [ ] Calendly

**Storage & files**
- [ ] S3
- [ ] Google Drive
- [ ] Dropbox
- [ ] Box
- [ ] OneDrive / SharePoint

**Marketing & transactional email**
- [ ] Resend
- [ ] SendGrid
- [ ] Customer.io
- [ ] Loops
- [ ] Mailchimp

**Universal triggers (ship early)**
- [ ] RSS

### Tier 2 — Agent-native capability primitives (the differentiator)

- [ ] **Code execution sandbox** — E2B / Daytona / Modal (write-run-observe loop behind `<Sandbox>`)
  - _missing:_ Sandbox primitive exists but the differentiated managed-cloud code-execution backing (E2B/Daytona/Modal) is not implemented
- [ ] **Browser automation** — Browserbase + Stagehand, Computer-Use vision fallback
  - _missing:_ Not implemented; no browser automation primitive
- [ ] **RAG retrieval** — pgvector default + Qdrant / Weaviate (hybrid vector + BM25 + metadata)
  - _missing:_ No RAG retrieval primitive; memory package is agent-memory facts, not vector RAG retrieval
- [ ] **Agent memory** (distinct from RAG) — Mem0 / Zep on cross-run memory facts
  - _missing:_ Smithers has internal cross-run memory, but the Mem0/Zep agent-memory tool primitive on top of it was not shipped for this catalog

### Long tail — handled by the generic mechanism, never hand-built

- [ ] Any OAuth SaaS action via Composio / Arcade / Nango catalog (1000+ toolkits)
  - _missing:_ Not implemented; blocked on the missing delegated-OAuth plane
- [ ] Enterprise Microsoft stack as ONE Graph / admin-consent workstream behind the OAuth broker
  - _missing:_ Not implemented; blocked on OAuth broker
- [ ] Unified-API data sync (Merge / Apideck) — only for a deep vertical that needs normalized data
  - _missing:_ Not implemented
