# Cache trust model

The remote build cache is a shared oracle: a target that finds its content key
in the cache does not run, and its stored result is reported green. Whoever can
publish under a key therefore decides the outcome of every later build that
computes that key.

## Trust model

A remote build cache has untrusted readers and trusted writers. This is how
remote caches are deployed generally, in Bazel, Buck2, Nx, and Turborepo alike,
and the reason is the same everywhere: reading a result is harmless, publishing
one is a claim about what a build produces.

- A **reader** is any job that pulls. That includes a job building an
  unreviewed branch, so a read credential is expected to be widely held and is
  treated as public within the organization.
- A **writer** is a job whose inputs were reviewed before it ran. Only
  post-merge jobs on the trunk branch qualify.

The realistic failure does not need an attacker. A target whose real input is
not in its declared inputs computes the same key from different content. Run it
in a pull request, publish the green result, and the next trunk build reads a
result produced from code nobody merged. One credential makes that a routine
accident. Two credentials make publishing an authorization, not a side effect
of having read access.

Two mechanisms enforce it, and only the first is a control:

1. **The server refuses.** `worker/protocol.ts` classifies the presented bearer
   token as `write`, `read`, or `none`, and refuses `PUT` and `DELETE` on
   anything but `write` with `403`, before the request body is read. This is
   not configuration; a job holding the read credential cannot publish.
2. **The client namespaces its publications.** A job that sets
   `SMITHERS_CACHE_NAMESPACE` publishes under `<namespace>/<key>` and still
   reads at the bare key, so its results are invisible to trunk while it keeps
   every trunk cache hit. This is defence in depth, not a control: it binds
   nothing on the server, and a holder of the write credential can decline to
   use it. What it buys is a correct posture for a deployment that has not
   split its secrets yet, and containment of the accidental case above.

## Which secret goes in which job

| Secret                       | Value            | Rendered into        |
| ---------------------------- | ---------------- | -------------------- |
| `SMITHERS_CACHE_URL`         | Endpoint         | Every job            |
| `SMITHERS_CACHE_READ_TOKEN`  | Read credential  | Every job            |
| `SMITHERS_CACHE_WRITE_TOKEN` | Write credential | Post-merge jobs only |

A `pull_request`-triggered job receives the read credential and no write
credential. It pulls at full speed and publishes nothing.

## What GithubCiGen carries, and the adoption that remains

`packages/targets/src/GithubCiGen.ts` carries the split. Beside
`cacheTokenSecret`, the read credential, the attrs declare an optional
`cacheWriteTokenSecret`, and the `Job` struct declares an optional
`publishesToCache` boolean. `render` still computes the shared entries
(endpoint and read token) once and spreads them onto every generated step; the
write entry is rendered only into a job that declares `publishesToCache`, and
that job is emitted with
`if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/<branch>' }}`
over the declared push branches, so a `pull_request` run of it never starts,
let alone holds the credential.

The generator refuses the half-declared shapes rather than rendering them: a
`publishesToCache` job with no declared write credential, a declared write
credential no job publishes with, read and write secrets naming one variable,
a publishing job in a workflow with no push branches, and a gate that only a
publishing job would satisfy (its guard means GitHub skips it on every pull
request, so it proves nothing).

What remains is the adoption in the root `BUILD.ts`, which today declares
`cacheToken = Smithers.Secret("SMITHERS_CACHE_TOKEN")` and passes it as
`cacheTokenSecret`, the shared-credential posture. The change: declare
`cacheWriteToken = Smithers.Secret("SMITHERS_CACHE_WRITE_TOKEN")`, rename
`cacheToken` to name `SMITHERS_CACHE_READ_TOKEN`, pass both, and mark the
publishing job. It must wait for steps 1 and 2 of the deployment ordering
below.

Landing that adoption regenerates `.github/workflows/ci.yml`. The workflow is a
generated root file whose drift is gated, so the regenerated file belongs in
the same commit as the `GithubCiGen` and `BUILD.ts` edits:

```sh
pnpm exec smithers-build build '//:ci'
pnpm exec smithers-build lint '//:ci'
```

Today the repository declares no `RemoteCache.make(...)` at all: it uses the
`SMITHERS_CACHE_URL` override with the default `SMITHERS_CACHE_TOKEN`, which
resolves to the shared-credential posture. Declaring the split in the root
`BUILD.ts` is what makes the client send two different credentials:

```ts
export const remoteCache = Smithers.RemoteCache.make({
  endpoint: "https://build.smithers.sh",
  read: Smithers.Secret("SMITHERS_CACHE_READ_TOKEN"),
  write: Smithers.Secret("SMITHERS_CACHE_WRITE_TOKEN")
})
```

## Operational step, and deployment ordering

The deployed Worker must hold both secrets before any of that ships. Deploy in
this order:

1. **Configure the Worker with both secrets.** Set
   `SMITHERS_CACHE_READ_TOKEN` and `SMITHERS_CACHE_WRITE_TOKEN` in the
   deploying shell and run the deploy. Both are required: `alchemy.run.ts`
   fails the deployment when either is missing, rather than starting a Worker
   that answers on one credential. They must also differ. Both implementations
   refuse two equal digests at construction, because one secret configured for
   both directions is one credential wearing two names and every reader holding
   it can publish. To keep every existing client working during the rollout,
   set the **write** token to the current `SMITHERS_CACHE_TOKEN` value and mint
   a new read token: a client that still sends the old single credential
   classifies as `write` and nothing it does changes.
2. **Add the repository secrets.** Add `SMITHERS_CACHE_READ_TOKEN` holding the
   newly minted read token and `SMITHERS_CACHE_WRITE_TOKEN` holding the current
   value to the GitHub repository.
3. **Land the root `BUILD.ts` adoption** above, so pull-request jobs stop
   receiving the write credential.
4. **Rotate.** Only now generate a new write credential, redeploy the Worker
   with the new `SMITHERS_CACHE_WRITE_TOKEN` and the unchanged read token, and
   update the repository secret. Rotating before step 3 breaks every job that
   still sends the old value as its write credential.

If the Worker does not have both secrets configured before the client change
ships, the deployment fails at step 1 and no Worker is replaced. If the
repository secrets are added out of order, the failure is a build that publishes
nothing: the client sends an absent or stale write credential, the Worker
answers `401` or `403`, and the CLI warns
`remote cache publication refused; this credential may only read` once and
keeps reading for the rest of the run. That is the read-only posture, which is
exactly what a pull-request job should have. Builds stay correct and lose only
publication, and every cache hit still lands.

The self-hosted stack under `../terraform/` serves the same protocol and now
carries the same split: `SMITHERS_CACHE_READ_TOKEN` and
`SMITHERS_CACHE_WRITE_TOKEN`, refused when they are equal, classified by method
before the route is parsed. Its loopback-only development mode, which
configures no token at all, is the one deployment shape without the split, and
`variables.tf` cannot produce it.

## Public read tokens on jjhub

The jjhub-hosted cache makes the read credential a committed literal: a
per-repository `smithers_cachero_…` token that can only read that
repository's cache. That is the reader posture above taken to its conclusion.
A reader is untrusted and the read credential is public within the
organization already; publishing it in `BUILD.ts` changes who can see it, not
what it can do. The server enforces the same split (`403` on every `PUT` and
`DELETE` before the body is read), the token is refused on any other
repository, and the general token loader never accepts its shape, so a leak
costs a rotation and nothing else. The write credential stays where it was: a
`write:repository` token in the environment of post-merge trunk jobs, or the
per-run token an agent computer holds through the egress proxy.
