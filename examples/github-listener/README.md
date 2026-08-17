# Declarative GitHub issue listener

Copy `workflow.tsx` into `.smithers/workflows/github-issue-listener.tsx` and
copy the listener row into your workspace `.smithers/listeners.json`. Replace
the callback host with the public HTTPS address of your Gateway.

Set `SMITHERS_GITHUB_TOKEN` to a fine-grained token with Webhooks read/write or
a classic token with `admin:repo_hook`. Set `SMITHERS_GITHUB_WEBHOOK_SECRET` to
a random shared secret.

Preview the remote plan, apply creates and updates, then start the Gateway:

```sh
smithers listeners plan
smithers listeners apply
smithers gateway
```

Deletion stays disabled. Use `smithers listeners apply --delete` only after
reviewing the plan. Smithers deletes hooks only when their numeric GitHub hook
ID is recorded in `.smithers/listeners.state.json` as owned by this workspace.
