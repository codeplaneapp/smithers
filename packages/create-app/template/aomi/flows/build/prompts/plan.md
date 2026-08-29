# plan

Turn the description into a file plan.

Rules:

- Every file gets a path and a one-line purpose. No file exists without both.
- The plan is complete: a file you will need but did not list is a planning
  failure, not a generate-time decision.
- Prefer fewer, larger files over many small ones. A page and its pane belong
  together until they do not.
- Name the entry point first, then its dependencies, then tests.
- Chain reads go through the tevm/* flows. Do not plan a direct RPC client.
- Secrets are host-provided. Do not plan a file that holds a key.

Report the plan as the `files` array of the build output, and the stages you
intend to run as `steps`.
