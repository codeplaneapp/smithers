> Local-app cut (2026-08-26, `docs/LOCAL-APP.md`): the hermetic web runners
> (`web-chat-*.ts`, `worker-e2e.ts`, `e2e-harness.ts`, `stub-backends.ts`,
> `launch-gateway-double.ts`, `live-check.ts`) and the `wrangler dev` stack
> they booted were removed with the web build path. End-to-end coverage is
> the Playwright tiers: `pnpm --filter smithers-ui test:e2e` (T1, local
> origin in headless Chromium) and `test:e2e:native` (T2, the Electrobun
> window over CDP). The sections below that describe those runners are
> historical.

# apps/ui/scripts

E2E and live-check scripts. Unless a section says otherwise, run them from
`apps/ui`.

## Launch checklist (`launch-checklist.ts`)

Headless, one-command re-run of the signed-in launch checklist (§A-F) that
produced `apps/reports/launch-checklist/*`. No origin is hardcoded — the
target is always explicit, via `--target`/`-t` or `$CHECKLIST_TARGET`.

The command works from the repository root and from `apps/ui`; the root
`checklist` script forwards to this one.

### Post-deploy re-run

Right after a deploy, point it at the deployed origin:

```sh
CHECKLIST_SESSION_COOKIE='smithers_session=<cookie value>' \
CHECKLIST_ZERO_BALANCE_BEARER='smithers_session=<zero-balance test account cookie>' \
pnpm run checklist -- --target https://canary.smithers.sh
```

or with the flag instead of `$CHECKLIST_TARGET`:

```sh
pnpm run checklist -- --target <origin>
```

### What it actually checks

Every row in the catalog has a probe — nothing is enumerated but unchecked:

- The §A, §B, §C and §F rows, plus D-3 and D-4's pause half, drive a **real
  headless Chrome page** on the target over the DevTools protocol
  (`headless-page.ts`), carrying `$CHECKLIST_SESSION_COOKIE` as the session.
  They assert against the rendered document: the composer next to the
  transcript, the `[data-flows]` command manifest the app shell publishes,
  the `[data-flow]` name on each affordance, the `$500 of usage on us` line
  against the balance seam's `introUsd`, the reply to each impossible ask.
- D-1, D-2 and the §E rows are HTTP: the product Worker's billing seams and
  the billing upstream's admin surface.
- D-4 asserts **both** halves: the turn seam still answers at $0 (chat is
  complimentary), and a workflow launch on the $0 session is refused into the
  transcript with the client's zero-balance pause statement instead of
  starting a run.

No browser is downloaded or installed. The driver uses a system
Chrome/Chromium (`--browser <path>`, else `$CHECKLIST_BROWSER`, else the usual
install locations). One browser process is launched per run and one page per
distinct session cookie.

A row reports `not-testable-yet` only for a named, specific reason: a missing
auth env var, no browser on this machine (or `--no-browser`), or a fact the
target's own state does not contain — an empty watched set for A-3, no
recommendation to dismiss for A-9, no run id rendered for B-3. It is never a
blanket deferral. `live-signed-in-check.ts` and `live-workflow-check.ts`
remain the checks that drive the real OAuth redirect and launch their own
workflow runs.

### Auth material

The `CHECKLIST_*` env vars are auth material; never commit them.

| Variable                         | Rows                                       | What it is                                                                                               |
| -------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `CHECKLIST_SESSION_COOKIE`       | §A (except A-1), §B, §C, §F, D-1, D-2, D-3 | Cookie header for a normal signed-in session                                                             |
| `CHECKLIST_ZERO_BALANCE_BEARER`  | D-4                                        | Cookie header for a session already parked at $0                                                         |
| `CHECKLIST_BILLING_UPSTREAM_URL` | §E                                         | Billing upstream origin                                                                                  |
| `CHECKLIST_BILLING_ADMIN_TOKEN`  | E-2, E-3                                   | Billing upstream admin token                                                                             |

Get the cookie headers from a real browser session (e.g.
`launch-mint-session.ts`'s storage-state output, formatted as
`name=value; name2=value2`). Rows whose required env var is missing report
`not-testable-yet` instead of failing — the run still completes and still
writes a report. A-1 is deliberately cookie-less: it is the signed-out view.

### Dry run (no target needed)

Proves the row catalog, CLI wiring, and report writer all work without
touching any origin — zero network calls and no browser:

```sh
pnpm run checklist -- --dry-run
```

### Local mode

Point `--target` at a local/dev origin instead of canary. The probes really
run against it; if nothing answers, that reports an honest `fail` per row
(connection refused) rather than crashing the run — this is how the runner
proves it "wires up" without needing the live deployment. Add `--no-browser`
to keep a local run HTTP-only.

### Where the code lives

The row catalog, the runner, and the CLI contract are under
`../src/launch-checklist/` and are covered by `bun test src`. This script is
the process shell (clock, filesystem, browser, exit code), and
`headless-page.ts` is the DevTools-protocol page driver.

### Output

Every run (dry, local, or live) writes `launch-checklist-report.json` and
`launch-checklist-report.md` under `apps/reports/launch-checklist/<timestamp>Z-<dry-run|run>/`
(override with `--out <dir>`), matching the historical `launch-checklist-report.*`
shape (`generatedAt`, `target`, `totals`, `rows[]`). Exit code is `1` if any
row's status is `fail`, `0` otherwise (a dry run, or a run made entirely of
`not-testable-yet`/`pass` rows, never fails the command).

## The browser e2e scripts

Four scripts drive a real headless Chrome over the DevTools protocol. Three of
them are **hermetic**: `e2e-harness.ts` builds the SPA, boots `wrangler dev`
with every seam pointed at a test double in `stub-backends.ts`, mints a
signed-in allowlisted session, and answers the repo chooser, so the run needs no
credential, no deployment, and no model spend. Each costs one vite build plus
one wrangler boot, roughly a minute before the first assertion.

| Script                     | Cost                 | What it proves                                                                                                                                            |
| -------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-chat-hermetic-e2e.ts` | free                 | One prompt streams a scripted NDJSON reply through the Worker, and the hidden runtime context reaches the model without leaking into the transcript.      |
| `web-chat-context-e2e.ts`  | free                 | The reply is derived from the runtime context, and a state change (the theme) reaches the NEXT turn on the wire and in the composed instructions.         |
| `web-chat-shell-e2e.ts`    | free                 | World and Connectors open as embedded panes; the transcript and composer DOM nodes survive every transition, on a 1400px and a 700px window.              |
| `web-chat-e2e.ts`          | **real model spend** | The same first-prompt journey against a real model. Boots the vite dev server if nothing answers the target. Never in CI — run it by hand or as a canary. |

`web-chat-hermetic-e2e.ts` and `web-chat-e2e.ts` are the two halves of one
split (I-7). The live half asserts "some genuine streamed prose arrived", which
needs a credential and metered dollars, so it can never gate a pull request.
The hermetic half asserts the same path with a scripted model at the far end,
plus the two things a live reply cannot check: that the Worker composed the
context into `instructions`, and that the reply echoes it back.

None of them hardcodes a browser path any more. The binary resolves through
`findBrowser` (`--browser`-equivalent `$CHECKLIST_BROWSER`, else the seven usual
install locations, including `/usr/bin/google-chrome` for a CI runner), the same
discovery the launch checklist uses.

## Other scripts

- `e2e-harness.ts` — shared boot for the browser e2e scripts: the scripted chat double, the hermetic app, the CDP target, and the pinned wrangler specifier.
- `stub-backends.ts` — test doubles for identity/billing/gateway/reco, used by `test:e2e:worker` and by `e2e-harness.ts`.
- `worker-e2e.ts` — `bun test:e2e:worker`, drives the product Worker against the stub backends.
- `live-check.ts`, `live-signed-in-check.ts`, `live-workflow-check.ts`, `canary-seam-probe.ts`, `launch-seam-probe.ts` — browser-driven and HTTP live checks against a real deployment (see each file's header comment for invocation and required env/profile). `live-check.ts local` is the exception: it boots its own stub identity and `wrangler dev` and needs no deployment.
- `live-store-reset.ts` — shared helper: clears a page's persisted store (OPFS/localStorage) over CDP, keeping cookies.
- `launch-mint-session.ts` — mints a Playwright storage-state file for the live checks.

### The suite resets what it dirties

Rows that write state (a grant, an allowlist entry, a watched selection) run
against seams that record the write with attribution, so the report's
evidence names what the row changed.

### A leftover `wrangler dev` outlives an interrupted run

`Bun.spawn(["bun", "x", "wrangler", ...]).kill()` signals the `bun x` wrapper,
not the `workerd` it started, so a script killed by a timeout can leave the port
bound. The next run then boots "successfully" against the dead stack and every
row fails for a reason that has nothing to do with the product. `live-check.ts
local` and `e2e-harness.ts` both refuse to start when their port already
answers; if that is what you get, `pkill -f "wrangler dev --ip 127.0.0.1"`.

### Two browser drivers, on purpose

`launch-checklist.ts` drives a **system Chrome over the DevTools protocol**
(`headless-page.ts`): no browser download, no Playwright. The `live-*.ts`
scripts drive **Playwright**, because they need a persistent profile to carry a
real GitHub OAuth session through a redirect — the one thing the checklist
cannot do. Playwright is a devDependency of this package; it used to be
`require`d over an absolute path into a sibling checkout, which made those three
scripts runnable on exactly one machine.

Playwright's browser download is not part of `pnpm install` (the workspace
blocks package build scripts). Install a browser once with
`pnpm --filter smithers-ui exec playwright install chromium`, or point
`MULTI_E2E_PROFILE` at a profile whose browser is already on the machine.

Everything under `scripts/` is covered by `pnpm --filter smithers-ui run
typecheck`. It was not until 2026-08-18, which is how the foreign-path
`require` and nine assertions against a card kind that no longer exists
(`workflow-run`, renamed to `flow-run`) both survived in here.

### What the typecheck still cannot see

A selector is a string inside a CDP expression or a Playwright locator, so
`tsc` has nothing to check it against. The 2026-08-15 `command` → `flow` rename
therefore left 17 selectors across four scripts still naming the pre-rename
attribute, matching nothing at all, for three days, while the suites reported
the same numbers they always had. (The dead attribute name is deliberately not
spelled here: a `grep -rc` over this directory is the cheapest gate against the
next one, and it should read zero.) The same rename also moved the run card's
kind from `workflow-run` to `flow-run` and the slash form from
`/workflow.create` to `/flow.create`.

Four more selectors here were dead for the same silent reason and are worth
knowing about, because they are the shapes to look for next time:

- The Approve/Deny buttons and the composer's Stop button come from
  `@smthrs/ui`, which names them `[data-decision]` and `.sui-chat-composer-stop`.
  They carry no `data-flow`, so no rename of the flow behind them can ever be
  visible in the DOM.
- `.message-author` stopped rendering when the chat bubble moved into
  `@smthrs/ui`; it survives only in two CSS rules. A filter on it matched zero
  bubbles, so `web-chat-context-e2e.ts` waited 90 seconds and then failed on a
  count of 0.
- The theme toggle's accessible name is "Toggle light and dark mode", not
  "Toggle theme".
- World and Connectors moved behind the composer's surfaces dropdown (§2c′).
  `.composer-actions [data-flow="connect"]` still resolves — to the repository-
  connections trigger, which opens a different menu — so a blind rename of that
  selector would have looked right and measured the wrong button.

When a script's selector goes stale, grep `apps/ui/src` for the affordance the
script MEANS before renaming the string. A wrong `data-flow` name is the same
defect in a new coat.
