# 🐛 electric-proxy: whereTemplate-only shapes fail open — client-supplied `where` replaces the template with no value enforcement

GitHub: https://github.com/smithersai/smithers/issues/543

**What happens**
In `validateWhere` (`packages/electric-proxy/src/createSmithersElectricProxy.ts:297-327`), a shape whose only scoping mechanism is `whereTemplate` counts as row-scoped (`hasRowScoping`, lines 297-302). But when the client supplies its own `where`, it wins outright (`effectiveWhere = where ... : fillWhereTemplate(...)`, line 303), and the `ensureValuesAllowed` checks (lines 315-326) only run for `runIdColumn` / `workspaceIdColumn` / `userPrivateColumn`. A template-only shape therefore forwards an arbitrary client predicate for a scoped principal after nothing but syntactic parsing — the template's intended scoping is silently bypassed.

**Why it's wrong / failure scenario**
Latent today: every current catalog entry with a `whereTemplate` also sets `runIdColumn` (`packages/electric-proxy/src/smithersElectricShapeCatalog.ts`). But the catalog is caller-supplied (`options.catalog`), and adding one template-only entry silently turns its scoping into a suggestion — the exact fail-open the module's fail-closed comments say it prevents.

**Expected**
Either reject client `where` on template-only shapes (template is authoritative), require a scoping column whenever `whereTemplate` is set (validate the catalog at construction), or verify the client predicate is a subset of the filled template.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).


> Closed by ticket-fleet: landed on main in 3101beb5aca018f1480653e6140752fcc834ee3e.
