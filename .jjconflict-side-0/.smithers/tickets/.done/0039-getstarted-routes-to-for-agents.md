# "Get started" links into the "For Agents" tab instead of the human onboarding

Filed from user feedback on X (onboarding replies), 2026-06-17.

## Problem

A user pressing **"Get started"** on the docs site was taken to the **"For
Agents"** tab — *"I pressed Get started and noticed now it took me to 'for
Agents' 😅"*. The For-Humans get-started flow and the For-Agents reference are
separate tabs (see `docs/docs.json` navigation), and the primary "Get started"
CTA should land a human on the human get-started page, not the agent docs.

## Requirement

- The landing/nav "Get started" CTA routes to `docs/guide/get-started`
  (For Humans), not the For-Agents tab.
- Audit every "Get started" link (landing page, top nav, `docs/docs.json`) for
  the same misrouting.

## Acceptance

- Clicking "Get started" anywhere lands on the human get-started page; verified
  in the built docs site.
