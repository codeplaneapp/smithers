# Smithers demo-day pitch — v2 (merged draft, ~450 words ≈ 2:55 spoken)

One-liner (opens and closes the pitch, verbatim): **"Smithers makes agent workflows reliable."**

---

## 1. What you do (~30w)

> Hi, I'm Will. Smithers makes agent workflows reliable. They run for days or weeks,
> survive crashes, pause for human sign-off, improve the more you use them — and you
> never lose work.

SHOW: logo + "Agent workflows, reliable."

## 2. Problem (~52w)

> Everyone can describe a workflow they want automated. Making it real is where the
> friction starts — and making it bulletproof is a whole project. You author it, monitor
> it, wire in approvals, and when it crashes halfway through, you clean up the mess. The
> plumbing is more work than the idea.

SHOW: "The plumbing is more work than the idea."

## 3. Solution (~48w)

> Smithers ships the plumbing as the framework. Durability, retries, approvals,
> observability — built in, not bolted on. And you don't write the workflows: the
> Smithers skill and API are optimized for agents to one-shot sophisticated workflows.
> Describe the job. Your agent builds it.

SHOW: "Describe the job. Your agent builds it."

## 4. The super slide (~60w) — the demo

One layout, ~5 beats; only the multi-UI screenshot advances. Feels like watching the
product without live-demo risk.

> Here's what that looks like. *(1)* I describe the job in chat. *(2)* My agent authors
> the workflow. *(3)* It runs — every step streaming live. *(4)* It pauses for my
> approval — and costs nothing while it waits. I kill the process mid-run… it resumes
> exactly where it stopped. *(5)* Done: reviewed, diffed, shipped.

SHOW frames (capture from multi): ① composer/chat with the request ② workflow source/graph
③ run tree streaming ④ approval card + kill/resume moment ⑤ diff + completed run.

## 5. Traction (~62w)

> We launched in January, open source. June alone: ninety-seven thousand downloads.
> Three hundred twenty-nine GitHub stars, thirty-eight forks, eighteen outside
> contributors, four hundred fifty people in our Telegram. Hobbyists and small startups
> run it for real work today — and one large public company is in talks to bring me in
> as a forward-deployed engineer to wire Smithers into their dev workflows.

SHOW: downloads chart. Headline: "97K downloads in June."
⚠️ If June (97K) vs May is really ~13× MoM, LEAD with the multiple — verify May's final
number first.

## 6. Insight / why we win (~55w)

> The right way to build agents changes every six months. Frameworks optimized for
> today's meta die with it. So we built the layer that doesn't change — durable
> orchestration — flexible enough to evolve with the meta, and it plugs into every
> agent: Claude Code, Codex, whatever comes next. Agents author their own workflows, so
> every model release makes Smithers stronger, not obsolete.

SHOW: three-layer stack, bottom highlighted: "the layer that doesn't change."
Optional +12w if we want the aggression: "Anthropic just shipped a closed, Claude-only
version. Validation. The open, every-agent layer wins."

## 7. Market (~38w)

> Workflow automation was a giant market before agents — Zapier, UiPath, Temporal built
> on slices of it. Post-agents it gets bigger: companies that never automated a single
> process are saying they want to start. Every one of those workflows needs this layer.

SHOW: "Workflow automation: bigger after agents than before."
(Still worth adding one defensible $B number if we find one we trust.)

## 8. Business model (~38w)

> Smithers is free. That's our distribution — and the community making it the canonical
> open-source workflow engine is our technological moat. Revenue is the cloud that runs
> these workflows, and the enterprise last mile: making it dead simple to plug in.

SHOW: "Free engine → cloud → enterprise last mile."

## 9. Team (~33w)

> In 2025 I built the fastest open-source Ethereum VM — using agents. I've been early to
> every agentic trend since, with a track record across popular open source: Tevm, the
> OP Stack, and now Smithers.

SHOW: face + "Fastest OSS EVM, built with agents · Tevm · OP Stack."

## 10. The ask (~35w)

> We're looking for design partners. I will personally work hands-on with you to
> integrate Smithers into your product or your back-of-house operations. Smithers makes
> agent workflows reliable. Come find me.

SHOW: "Looking for design partners · will@tevm.tech"

---

Total: ~451 words. Read aloud with a timer; if over 2:55, first cuts are the optional
Anthropic line, then trim Problem to 45w.

## What changed from v1 → v2 (and why)

- **Ask is design partners, not dollars** (founder decision) — kills the missing-$ hole
  and matches the FDE motion already in flight.
- **Problem reframed** from "agents lose work" to "the plumbing is more work than the
  idea" — broader, hits anyone who's tried to automate anything, still lands the
  reliability pain.
- **One-liner shortened** to "Smithers makes agent workflows reliable" so it survives the
  repeat-test; the days/weeks/crashes/sign-off list becomes the supporting sentence.
- **Super slide added** as its own timed beat (~60w) with the 5 capture frames specified —
  crash-resume moved here as the demo climax instead of living inside Solution prose.
- **Traction updated to founder's fresh numbers** (97K June downloads, 329 stars, 38
  forks, 18 contributors, 450 Telegram) — all time-framed per the Seibel rule.
- **Moat folded into business model** (canonical-OSS argument) per founder's framing;
  insight slide keeps the layer thesis + agents-author-workflows.
- **Team drops ex-Google**, leads with the EVM-with-agents proof and the OSS track record
  (Tevm, OP Stack). Ex-Google can come back if we need a big-co credential.

## Verify before stage

- May's final download number (to compute the MoM multiple honestly).
- "Fastest open source Ethereum VM" phrasing — confirm the claim's current defensibility.
- The public company / FDE talks — confirm what's sayable on stage.
- Telegram/community link to put on the closing slide alongside the email.
