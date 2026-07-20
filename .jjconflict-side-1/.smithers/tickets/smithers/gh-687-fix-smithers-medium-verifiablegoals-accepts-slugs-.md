# 🐛 fix(smithers): [medium] VerifiableGoals accepts slugs that make ticket writes fail

GitHub: https://github.com/smithersai/smithers/issues/687

via /codex review (pass 3)

Refs:
- `.smithers/components/VerifiableGoals.tsx:8` defines `ticketSchema`.
- `.smithers/components/VerifiableGoals.tsx:9` accepts `slug` as any string.
- `.smithers/components/VerifiableGoals.tsx:40` asks the agent for kebab-case, but that is prompt text rather than schema validation.
- `.smithers/components/VerifiableGoals.tsx:82` iterates accepted tickets.
- `.smithers/components/VerifiableGoals.tsx:84` builds the output path from `${index}-${t.slug}.md`.
- `.smithers/components/VerifiableGoals.tsx:107` writes the file without sanitizing the slug or creating per-slug parent directories.
- `.smithers/workflows/ship-pipeline.tsx:49` uses this component before `ShipTickets` consumes the generated queue.

Failure scenario:
The goals agent emits a schema-valid slug like `auth/login` or `phase 1/login`. `VerifiableGoals` accepts the output because `slug` is just `z.string()`. The write task then tries to write a path such as `.smithers/tickets/ship-pipeline/0001-auth/login.md`; because `0001-auth` was not created, `writeFileSync()` throws `ENOENT` and the whole `ship-pipeline` fails after the planning agent already completed. With pre-existing matching directories, `..` segments in the slug can also normalize outside the intended ticket queue.

Why it matters:
This is a generated-output contract violation: the schema says the value is valid, but the persistence step cannot safely handle it. It makes the seeded ship pipeline brittle on crash/resume and creates an avoidable filesystem hazard. Constrain `slug` with a kebab-case regex such as `^[a-z0-9]+(?:-[a-z0-9]+)*$`, or normalize/reject before constructing the path.
