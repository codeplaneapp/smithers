# Wave reconciliation

Reconcile one named queue of completed lane branches into the moving
integration tip. Preserve every lane's intent, regenerate every derived root
surface, and prove the committed result with the root gate suite. Issue #1443
and PR #1538 are the governing lesson: a green dirty worktree is not evidence
that the commit is green.

## Inputs

- `waveName` identifies the integration wave or queue.
- `laneBookmarks` is the ordered, comma- or newline-separated list of lane
  bookmarks or branches. Order is authoritative.
- `notes` carries known conflicts, ordering constraints, or operator context.

The fields are optional so suites can plan this lane without runtime input.
Execution still requires an unambiguous named queue and at least one resolvable
lane ref; never invent either from nearby branch names.

## Procedure

1. Resolve the current integration tip and every named lane ref to immutable
   commit IDs. Record the queue order and verify each lane contains committed
   work based on the intended integration base. Start only when
   `git status --porcelain` is empty.
2. Merge the lane branches in the declared order. Do not rebase or force-update
   a shared lane. Treat an already-integrated lane as an idempotent no-op and
   record it. Resolve mechanical generated-file conflicts from source; decline
   semantic conflicts instead of guessing which lane wins.
3. After the final merge, regenerate the known-file registry:

   ```sh
   node scripts/generate-known-files.mjs
   ```

4. Regenerate every curated llms bundle and its CLI/skill mirrors:

   ```sh
   pnpm docs:llms
   ```

5. Regenerate the root tsconfig and generated CI from their declarations. Do
   not hand-edit generated output:

   ```sh
   pnpm exec smithers-build build '//:tsconfig'
   pnpm exec smithers-build build '//:ci'
   ```

   When either declaration changes, update the corresponding source-text pins
   in `packages/flows/test/vitestCoverageIsolation.test.ts` in the same
   reconciliation.
6. Refresh both lockfiles from the merged manifest set, even when only one
   appears to change:

   ```sh
   pnpm install --lockfile-only
   bun install --lockfile-only
   ```

7. Review the complete merge and regeneration diff. It may contain lane work
   plus deterministic generated output, but no opportunistic cleanup or
   unrelated dependency movement. Commit the reconciliation result.
8. Before any acceptance gate, assert the tree being tested is exactly the
   committed tree:

   ```sh
   test -z "$(git status --porcelain)"
   ```

   A non-empty result is a hard stop. Commit an intentional correction, assert
   cleanliness again, then gate that new commit.
9. Run the committed root check set:

   ```sh
   pnpm exec smithers-build test '//:gates'
   ```

   If a gate fails, fix the cause, regenerate any affected surfaces, commit,
   reassert the empty status, and rerun the whole root suite. Never cite a gate
   run made before the final commit.
10. Confirm the integration tip did not move during reconciliation. Report the
    wave name, ordered lane commit IDs, merge commit IDs, regeneration commit,
    and the final root-gate result.

## Decline conditions

Decline without changing the tree when the queue name or lane order is absent
or ambiguous; a ref is missing, mutable in an unexplained way, or based on the
wrong integration line; the starting tree is dirty; the integration tip moves;
a merge needs a product or contract decision; a generator or either lockfile
tool cannot complete deterministically; or the committed root suite cannot be
run. Never drop a lane, rewrite shared history, force a merge, or gate an
uncommitted tree to make the wave appear green.
