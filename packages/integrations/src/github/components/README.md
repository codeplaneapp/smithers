# components/

GitHub workflow components:

- `OnWebhook.js` — declarative listeners: generic `OnWebhook` plus
  `OnPullRequest`/`OnIssueOpened`/`OnIssueComment`/`OnPush` sugar. The
  Signal.js pattern: render `WaitForEvent` on
  `integration:github:<event>[.<action>]` with the most specific correlation
  the props allow (`githubCorrelationId`), then zod-parse the delivered row
  and call the render-prop children with the typed payload.
- `outbound.js` — deterministic compute-Task components (`Comment`,
  `CreateIssue`, `CreatePullRequest`, `AddLabels`, `SetCommitStatus`) over
  `makeGitHubClient`, plus `splitRepo`.

Key constraint (see `githubComputeTask` in outbound.js): Task compiles
function children to compute kind only WITHOUT a `deps` prop, so these
components resolve deps themselves at render (ctx.outputMaybe walk, defer
until every dep is ready) and render a dep-less zero-arg function child gated
by `dependsOn`.

Props types live in the `.ts` sidecars (`OnWebhookProps.ts`,
`outboundProps.ts`).
