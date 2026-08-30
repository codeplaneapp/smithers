# Release runbook: publishing the Smithers release train

Scope: the 40 packages `node scripts/pack-release.mjs --names` prints — every
non-private manifest whose `smthrs.group` is `engine` or `agent`, which is the
public set frozen in `docs/migration/rc-contract.md` section 3.1. Smithers 1.0
gives them one synchronized version, so `@smthrs/cli`, `@smthrs/control`, the
rest of the agent layer, and the unscoped `smthrs` migration notice publish
together with the engine. `tooling` packages are private and are never packed.

Worked example below: `v1.0.0-rc.0`, the first release candidate.

**Prerelease dist-tag rule.** A version containing `-` publishes to the `rc`
dist-tag, never `latest`. `latest` still resolves `smthrs@0.35.0` and the 0.x
`@smthrs/*` packages until 1.0.0 is final, so an existing project that runs
`npm install smthrs` does not get pulled onto the release candidate. The rule is
pinned in three places, and all three must agree: `publishConfig.tag` in every
public manifest, the `publish_tag` case in `.github/workflows/release.yml`, and
the `--tag` on the `pnpm publish` line. `scripts/pack-release.test.mjs` asserts
the manifest half.

## 0. Owner preconditions

These are decisions and account state, not code. Do them once.

- [x] The `@smthrs` npm org exists (confirmed by the owner, 2026-08-17). Still
      confirm the publishing identity is an owner before the first publish:
      `npm org ls smthrs`
- [ ] No name is already taken by someone else. The 0.x line owns `smthrs`
      itself and the `@smthrs/*` names it published, so expect those to be
      taken by this same account; every new name was unpublished (`E404`) when
      the rehearsal checked on 2026-08-16. Re-check before publishing:
      ```sh
      node scripts/pack-release.mjs --names \
        | xargs -n1 -I{} sh -c 'npm view {} name >/dev/null 2>&1 && echo "taken: {}" || echo "free:  {}"'
      ```
- [x] The `LICENSE` copyright holder is confirmed by the owner (2026-08-17):
      MIT, `Copyright (c) 2026 William Cory and the Smithers Flows contributors`,
      accepted as final and frozen by `rc-contract.md` ruling R-26. Every tarball
      ships this file, and a published version is immutable, so changing the
      holder later requires a new version and a superseding maintainer ruling.
- [ ] The GitHub environment `npm-publish` exists on this repository and carries
      the npm credential. The workflow publishes with `--provenance` under
      `id-token: write`, so configure npm **trusted publishing** for
      `smithersai/smithers` / `release.yml`. If you use a token instead, set
      `NODE_AUTH_TOKEN` as an environment secret from an automation token with
      publish rights.
- [ ] If the environment has required reviewers, a dry run needs approval too.

## 1. Set the release version

Every public manifest must equal the tag's version, and the public packages
depend on each other by exact version, so both move together. Ranges that name
a private workspace package use `workspace:*` instead, because a private
package keeps its own version and an exact range on it would dangle.

```sh
node scripts/set-release-version.mjs 1.0.0-rc.0
pnpm install --lockfile-only
bun install --lockfile-only
node scripts/set-release-version.mjs --check 1.0.0-rc.0
git add packages/*/package.json pnpm-lock.yaml bun.lock
git commit -m "🔧 chore(release): set every manifest to 1.0.0-rc.0

Docs: docs/internal/release-runbook.md"
```

Land that commit on `main` the normal way (pull request, or a direct push if
branch protection allows it). The tag in step 3 must point at it.

## 2. Rehearse without publishing

Locally, executing the workflow's own step bodies:

```sh
node scripts/release-rehearsal.mjs --tag v1.0.0-rc.0 --transcript /tmp/rehearsal.json
```

That runs every gate, including `pnpm test` over all workspaces. To rehearse only
the release-specific half, add `--skip "Typecheck all workspaces" --skip "Test all
workspaces" --skip "Lint all workspaces"`.

On GitHub, once `release.yml` with the `workflow_dispatch` trigger is on the
default branch (a dispatch is only offered for workflows present there):

```sh
gh workflow run release.yml --ref main -f releaseTag=v1.0.0-rc.0 -f dryRun=true
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

`dryRun` defaults to `true`. The run ends with `Report the skipped publication`,
which prints the exact set, order, version, and dist-tag a real run would use.

## 3. Tag and publish

```sh
git checkout main && git pull
git tag -a v1.0.0-rc.0 -m "Smithers 1.0.0-rc.0"
git push origin v1.0.0-rc.0
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

The tag push publishes: `DRY_RUN` is false on that path and cannot be overridden.
Publication runs in dependency order and skips any version already on the
registry, so a failed run can be resumed by deleting and re-pushing the same tag
(`git push origin :v1.0.0-rc.0` then push it again).

## 4. Verify the published set

```sh
# Every name published at the released version, on the rc dist-tag. `latest`
# must still point at the 0.x line for every name that has one.
for name in $(node scripts/pack-release.mjs --names); do
  echo "$name $(npm view "$name@1.0.0-rc.0" version) rc=$(npm view "$name" dist-tags.rc) latest=$(npm view "$name" dist-tags.latest)"
done

# Provenance attestation is attached.
npm view @smthrs/flows@1.0.0-rc.0 --json \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c)
      .on("end",()=>console.log(JSON.parse(s).dist.attestations ?? "NO ATTESTATION"))'

# A consumer outside the repo installs the whole set from the registry and loads it.
repo=$PWD
rm -rf /tmp/smithers-verify && mkdir -p /tmp/smithers-verify && cd /tmp/smithers-verify
npm init -y >/dev/null && npm pkg set type=module
npm install $(node "$repo/scripts/pack-release.mjs" --names | sed 's/$/@1.0.0-rc.0/')
for name in $(node "$repo/scripts/pack-release.mjs" --names); do
  node --input-type=module --eval "await import('$name')" && echo "esm ok $name"
  node --eval "require('$name')" && echo "cjs ok $name"
done
```

`@smthrs/platform-bun` declares `@effect/platform-bun` as an optional peer.
Install it in the verification project too, or that one import fails by design.

`smthrs` is the migration notice, and importing it throws by design
(`rc-contract.md` section 3.3). Both loops above report it as a failure; that
is the pass. `scripts/smoke-release.mjs` encodes the same expectation, so the
release workflow gets it right without a human reading the output.

## 5. If it goes wrong

npm versions are immutable. Do not try to republish a version.

- Broken publish, under 72 hours old and nobody depends on it:
  `npm unpublish @smthrs/<name>@1.0.0-rc.0`
- Otherwise: `npm deprecate @smthrs/<name>@1.0.0-rc.0 "superseded by
  1.0.0-rc.1"`, then repeat from step 1 with the next candidate. Never mutate an
  already published candidate.
- Partial publish (some names landed, the run died): fix, re-push the same tag.
  The publish loop leaves published versions in place and continues.
