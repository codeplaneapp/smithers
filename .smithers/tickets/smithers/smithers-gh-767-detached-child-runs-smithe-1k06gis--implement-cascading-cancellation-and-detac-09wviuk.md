# Implement cascading cancellation and detached-owner process cleanup

GitHub: https://github.com/smithersai/smithers/issues/1001

Parent: smithers/gh-767-detached-child-runs-smithers-up-detach-orp-07nrnmp.md

Context: smithers cancel currently affects only the selected run, allowing linked descendants and their agent processes to continue. Acceptance criteria: recursively discover descendants; cancel live children through durable requests and handle waiting, paused, and stale children; terminate detached owners and agent process groups with platform-appropriate fallbacks; make the operation idempotent and cover nested descendants and race cases with integration tests.
