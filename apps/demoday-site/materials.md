# Raw materials — everything pitch-usable, distilled from smithers + multi + existing decks

Source-of-truth locations: `../smithers/docs/` (product + strategy docs),
`../smithers/marketing/` (release threads 0.22→0.28, investor-deck/, technical-deck/,
sub-sites), `../multi/` (the app, `docs/deck/` 20-slide review deck, `src/billing/plans.ts`).
Live decks: deck.smithers.sh → 19-slide investor deck; technical-deck.smithers.sh →
35-slide technical deck (both generated from `marketing/*/build_deck.py`).

---

## The product stack (naming is overloaded — be precise)

| Repo | What it is | Status |
|---|---|---|
| **smithers** (`smithers-orchestrator` on npm) | The durable orchestration engine + gateway + CLI for AI coding agents. MIT, open source. | Shipped, v0.28.0 |
| **multi** | The product surface: browser-native PWA + Electrobun desktop control plane/IDE. Ships to users as "Smithers." Cloudflare Worker + Durable Objects. | Deployed, private preview + waitlist |
| **plue** (aka jjhub, self-identifies "Smithers") | Backend platform: Go + Postgres + Rust jj-lib. jj-native code host ("GitHub but Jujutsu-native"), provisions Freestyle micro-VMs where agents run. AGPL. | ~78% of MVP (per technical deck) |

Technical deck's three-product framing: ① orchestrator (shipped, OSS, npm) ② the forge
(AGPL, in build) ③ Smithers GUI (native macOS, downloadable today).

## One-liners already in use

- **"The durable control plane for humans + agents doing real work"** (investor deck headline)
- "Agent workflows with **time travel**." (landing hero / social card)
- "Agent workflows you can watch live, rewind, fork, and replay." (README)
- "Be the layer that doesn't change" / "the part you build on once and never throw away"
- "A home for your agents" / "Chat to build. Watch the work happen live." (multi)
- "Humans and agents are the same primitive: a step that can fail and resume."
- "A paused workflow is a row, not a server — $0."
- "Git for work" / "Git history for AI workflows"
- "Smithers writes Smithers" / "Prompting is the authoring step"
- "Land one workflow. Expand to how the company runs."

## Core thesis (the deck's spine today)

Three layers, three speeds: **Model** (volatile, weekly — GPT/Claude/Gemini/Kimi) →
**Topology** (fluid, quarterly — ReAct/crews/swarms/background agents) →
**Orchestration** (stable, never changes — durable steps, retries, state, approvals,
audit). *Smithers sells the bottom layer.* Plus a "missing fourth layer": authoring —
JSX because it's the densest domain in every model's training corpus.

Problem framing: "The AI got good. The plumbing to run it like a business didn't."
A queue + DB gets you ~60% of an orchestrator, badly. Anthropic shipping Dynamic
Workflows = third-party validation of the category (closed, Claude-only, ephemeral —
Smithers is the open, durable, any-model version).

## Traction — FOUNDER-UPDATED Jul 16 2026 (supersedes the June deck numbers below)

- **97,000 npm downloads in June alone** · **329 GitHub stars** · **38 forks** ·
  **18 external contributors** · **450 Telegram members**
- Hobbyists and small startups using it for real work
- 1 large public company in talks to hire Will as a forward-deployed engineer to
  integrate Smithers into their dev workflows
- ⚠️ To verify: May's final download count (for an honest MoM multiple vs June's 97K)

## Traction (investor deck, "as of Jun 2026" — stale, kept for the historical curve)

- npm downloads: **36,913+ all-time**, **21,001 last 30 days**; Jan 3,235 → Feb 2,608 →
  Mar 2,760 → Apr 4,827 → May 7,224 → Jun 16,259 (MTD, 2.2× May)
- GitHub: **268 stars** (5.6× since Jan 2026 launch), 30 forks, **15+ external contributors**, ~3,000 commits
- Launched Jan 2026. 100+ example workflows. 6+ ecosystem projects on the runtime
  (Burns, Ralphinho, Cairo Coder, Agentix, Era, Local Isolated Ralph)
- v0.28.0: 1,188 commits / 4,232 files changed in one release cycle (424 fixes, 244 test commits)
- multi: 717 commits in the last month, ~87 merged PRs, live deployment, waitlist live
- Ecosystem proof: third-party UIs, Kubernetes automation in prod, custom workflow packs — by non-employees

## Benchmarks (investor slide 8; flagged "full results release next week" — verify before use)

- SWE-EVO (long-horizon): frontier ~23% → **Smithers 71%** (dvc subset)
- RoadmapBench (completion): SOTA 0.69 → **Smithers 0.86**
- Claw-Eval-Live (105 real enterprise workflows) + SWE-Bench Pro (731 tasks): pending

## User voice (as used in investor deck — generic attribution)

- "A **Claude-3.5 step-function moment** for my own productivity." — multiple users on adopting
- "Can you build me a **Zapier / n8n replacement** on this?" — non-technical users, unprompted

## Business model — TWO stories exist, must reconcile

**Investor deck (directional):** ① OSS engine free → adoption flywheel ② collaboration
tool at cost, no token markup ("cheapest credible default") ③ Enterprise = the revenue
line (BYOK, SSO, governance, audit, on-prem, SLAs). "Money is in governance + control,
not tokens."

**multi's actual shipped pricing (`src/billing/plans.ts`, real Stripe):**
Free $0 (1 concurrent run) · Hobby **$40/mo** (3 runs) · Pro **$200/mo** (10 runs,
priority, 5× inference) · Enterprise custom (SSO/SAML, SCIM, audit, RBAC, VPC/self-hosted).
BYOK at cost, no markup — on every tier (deliberate trust positioning).

## Market

SMBs automating multi-step workflows: "the most process work, the least platform team,"
"they can't hire a Temporal team." Wedge: developers → operators → whole orgs. Demand
crossing the technical fence (Zapier/n8n replacement asks). No TAM/SAM/SOM numbers exist
anywhere yet — **must be built for the Airbnb-style market-size slide.**

## Competition (arguments on record)

- **Temporal**: durable-execution heavyweight for platform teams; replays (determinism
  contract) vs Smithers re-renders (no contract); cluster + workers vs a file next to
  your repo; no agent/human nodes, no filesystem time travel.
- **Model-lab tools (Claude Dynamic Workflows)**: validates the category; closed,
  Claude-only, cloud-gated, ephemeral. Smithers = open, any-model, durable, composable.
- **LangGraph**: unit of work is an LLM call (build a custom agent); Smithers' unit is a
  coding agent doing a job. They compose.
- **Amp Code / coding agents**: products, not a substrate you compose on.
- Airbnb-style 2×2 candidate axes: open ↔ closed · durable ↔ ephemeral · any-model ↔
  single-vendor · agents-as-users ↔ humans-only.

## Founder / team (investor slide 16)

Solo founder narrative: proven agentic coder. **Fastest EVM ever** (beat revm, built
with Claude 3.5). Ex-Google (monorepo discipline → high-throughput agent organization).
Thesis: "Raise the skill floor of agentic coding... The company is that personal result,
productized."

## GTM (investor slide 17)

Reputation-led: OSS credibility → founder relationships → hands-on onboarding → land &
expand. In progress: **early conversations with Opendoor** (consulting engagement to
onboard their org — "a live example of the motion, not a closed deal").

## The ask

No fundraising amount, runway, or milestones exist in any current deck. Slide 18 is
"why now, why us" but never names a number. **The Airbnb-style Financial/Ask slide is
net-new content we must decide.**

## Existing deck inventory (what we're building relative to)

1. **Investor deck** (19 slides, deck.smithers.sh): title → problem ×2 → solution (layer
   thesis) → product ×3 → moat ×2 (JSX + stickiness) → market → traction ×2 → flywheel →
   business model → competition → team → GTM → why-now → close. Missing vs Airbnb:
   market size numbers, explicit ask, product screenshots-as-flow.
2. **Technical deck** (35 slides, technical-deck.smithers.sh): 9 acts, treadmill →
   primitives → runtime loop → components → CLI → live crash-resume demo → production →
   "this slideshow is itself a Smithers workflow" → three-products reveal.
3. **multi review deck** (20 slides, `../multi/docs/deck/index.html`): product +
   engineering walkthrough with real screenshots; slide 19 = "honest gaps."
4. **Product tour** (`../multi/docs/deck/product-tour.html`, ui-preview.smithers.sh):
   animated marketing tour + waitlist.

## Known tensions to resolve while building (flag, don't hide)

- "Smithers" names three things (engine, app brand, backend). Pick one deck vocabulary.
- Two pricing stories (at-cost positioning vs $40/$200 tiers). Reconcile.
- Traction numbers dated Jun 2026 — repull npm/stars before presenting.
- Benchmarks marked "release next week" in a Jun deck — confirm status before citing.
- Investor deck targets SMB workflow automation; docs/product are dev-first coding
  agents. The Airbnb Problem/Solution slides force a choice of primary audience.
- Pre-1.0 (0.28.0), plue at ~78% MVP — frame as velocity, not maturity.
