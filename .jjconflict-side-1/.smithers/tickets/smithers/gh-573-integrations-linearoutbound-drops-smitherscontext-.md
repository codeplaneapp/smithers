# 🐛 integrations: LinearOutbound drops smithersContext when rendering its inner Task

GitHub: https://github.com/smithersai/smithers/issues/573

**What happens**
`makeLinearOutbound` in `packages/integrations/src/linear/components.js` destructures `smithersContext` from props and uses it to resolve deps (:152-156), but the `React.createElement(Task, {...})` call at :172-185 does not pass it through. The GitHub outbound (`github/components/outbound.js:119`) and Telegram outbound (`telegram/components/outboundInternals.js:111`) both forward `smithersContext: props.smithersContext`.

**Why it's wrong / failure scenario**
A workflow built with a custom smithers context resolves the Linear component's deps against the custom context, but the inner Task reads the default SmithersContext — the compute node registers against the wrong (or no) workflow, so the Linear call never runs or runs in the wrong run.

**Expected behavior**
Pass `smithersContext` to the inner Task like the other two outbound wrappers.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
