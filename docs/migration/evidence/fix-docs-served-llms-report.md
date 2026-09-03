# Fix report: docs-served-llms

Lane `docs-served-llms`, round 1. Branch `phase7/docs-served-llms` at
`510621c763`, based on `f63809382b` on `v1/rc0-migration`.

Worktree:
`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/wt/docs-served-llms`.
Install: `corepack pnpm install --frozen-lockfile --offline`, exit 0. Neither
lockfile changed.

Status: **done**. One defect, fixed red-first.

## Item 1: the built site served vocs' llms bundles, not the curated ones

### Source lines

`node_modules/vocs/src/vite.ts:34` registers the plugin unconditionally:

```ts
Plugins.llms(config),
```

`node_modules/vocs/src/internal/vite-plugins.ts:233` writes the two files at
build end, into the directory the deploy uploads:

```ts
async buildEnd() {
  const content = await buildLlmsContent()
  const outDir = path.resolve(viteConfig.root, config.outDir, 'public')
  await fs.mkdir(outDir, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(outDir, 'llms-full.txt'), content.full, { encoding: 'utf-8' }),
    fs.writeFile(path.join(outDir, 'llms.txt'), content.short, { encoding: 'utf-8' }),
```

`.github/workflows/docs-deploy.yml` uploads that directory:

```yaml
- uses: actions/upload-pages-artifact@v3
  with:
    path: docs/dist/public
```

`claude-plugin/skills/smithers/SKILL.md:17,141,156` tells every agent to read
`https://smithers.sh/llms-full.txt` first.

### Reproduction (lane worktree, base `f63809382b`)

`rm -rf docs/dist && pnpm exec vocs build` (exit 0), then:

```
docs/dist/public/llms.txt    24886 bytes
docs/llms.txt     1494 bytes
docs/dist/public/llms-full.txt  1432111 bytes
docs/llms-full.txt   957481 bytes
--- contamination in served bundle ---
40          # '<Task'
8           # 'smithers oneshot'
--- cmp ---
docs/dist/public/llms-full.txt docs/llms-full.txt differ: char 11, line 1
cmp exit=1
--- base check-llms ignores it ---
✓ 12 documentation artifact(s) are current
check-llms exit=0
```

The served bundle also carries 88 distinct `/changelogs/0.*` routes and zero
`Version:` stamps; the curated bundle carries 7 stamps and zero changelog
bodies.

### Why the vocs.config.ts route is not available

vocs 2.8.5 exposes no config option for the llms plugin (`grep -n "llms"
node_modules/vocs/src/internal/config.ts` finds nothing), and its build command
disables user vite config entirely, so no user plugin can run a later hook:

```ts
const builder = await vite.createBuilder({
  configFile: false,
  plugins: [react(), vocs()],
```

The overwrite-at-deploy shape is therefore the only one available without
patching vocs. It is pinned twice so it cannot drift silently: `check-llms`
compares the served bytes whenever `docs/dist` exists, and the deploy runs
`check-llms` a second time after the copy and before the upload.

### Test

`scripts/check-llms.test.mjs` (new, 6 tests), registered in
`scripts/PACKAGE.ts` `docsUnit`:

- `a tree with no built site has no served bundle to compare`
- `served bundles that match the curated bundles byte for byte are not drift`
- `vocs' own bundle left in the served directory is drift`
- `a served bundle the build never wrote is drift, because the URL the skill names would 404`
- `the deploy replaces vocs' bundles with the curated ones and re-checks before it uploads`
- `the built site in this tree serves the curated bundles` (skipped when
  `docs/dist/public` is absent, which is every CI run of `//scripts:docsUnit`)

### RED runs against the pre-fix source

`node --test scripts/check-llms.test.mjs` on base, load 7.27:

```
SyntaxError: The requested module './check-llms.mjs' does not provide an export named 'servedBundles'
```

The deploy-shape test alone, extracted so it links (base `docs-deploy.yml`),
load 7.27:

```
✖ the deploy replaces vocs' bundles with the curated ones and re-checks before it uploads (0.767791ms)
  AssertionError [ERR_ASSERTION]: the deploy does not copy the curated bundles over vocs' own
```

The built-site test against the real `docs/dist` from `pnpm exec vocs build`,
after the new exports existed and before the deploy's copy step ran, load 8.93:

```
✖ the built site in this tree serves the curated bundles (1.828583ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

  + [
  +   'docs/dist/public/llms.txt is 24886 bytes, not the 1494 bytes of docs/llms.txt',
  +   'docs/dist/public/llms-full.txt is 1432111 bytes, not the 957481 bytes of docs/llms-full.txt'
  + ]
  - []
```

The gate itself, run on a fresh `vocs build` before the copy, load 8.95:

```
✗ the built site does not serve the curated documentation bundles:
    docs/dist/public/llms.txt is 24886 bytes, not the 1494 bytes of docs/llms.txt
    docs/dist/public/llms-full.txt is 1432111 bytes, not the 957481 bytes of docs/llms-full.txt

Run `cp docs/llms.txt docs/llms-full.txt docs/dist/public/` after `vocs build`,
the way .github/workflows/docs-deploy.yml does.
exit=1
```

### Fix

- `scripts/check-llms.mjs`: exports `servedRoot`, `servedBundles`,
  `siteIsBuilt`, and `servedDrift`; the imperative gate moves behind the
  repository's usual `process.argv[1]` main guard so the comparison is
  importable without spawning the generator. After the staleness check the gate
  fails when a built site's `llms.txt` or `llms-full.txt` is not the curated
  bundle byte for byte, or is missing.
- `.github/workflows/docs-deploy.yml`: after `pnpm exec vocs build`, a
  `cp docs/llms.txt docs/llms-full.txt docs/dist/public/` step, then a second
  `node scripts/check-llms.mjs` before `actions/configure-pages@v5` and the
  upload.
- `scripts/PACKAGE.ts`: `//scripts/check-llms.test.mjs` added to `docsUnit`.
- `known-files.d.ts`: regenerated for the new file
  (`node scripts/generate-known-files.mjs`), same commit.

`docs-deploy.yml` is hand-written, not generated from `PACKAGE.ts`; only
`.github/workflows/ci.yml` is generated. No pin in
`packages/flows/test/vitestCoverageIsolation.test.ts` names its contents, and
`//:ci` is unchanged.

### GREEN and gate lines

All in the lane worktree, `uptime` load recorded per run.

| Command                                                             | Load          | Result                                                                                                 |
| ------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `node --test scripts/check-llms.test.mjs` (after the deploy's copy) | 9.65          | `pass 6, fail 0`                                                                                       |
| `node scripts/check-docs.mjs`                                       | 13.08         | exit 0, 16 checks green, `all 504 internal links resolve`                                              |
| `node scripts/check-llms.mjs`                                       | 8.95          | exit 0: `✓ 12 documentation artifact(s) are current` and `✓ the built site serves 2 curated bundle(s)` |
| `pnpm run docs:llms`                                                | 8.95          | `12 artifact(s) written, 0 changed.`, `git status --short` shows no bundle change                      |
| `pnpm exec vocs build` (clean `docs/dist`)                          | 3.54 and 8.95 | exit 0, `349 files generated`                                                                          |
| `pnpm exec smithers-build test '//scripts:docsUnit'`                | 11.03         | `1 targets: 0 hit, 1 ran, 0 failed`, 101.8s                                                            |
| `pnpm exec smithers-build lint '//:ci'`                             | 11.03         | `0 failed`, `ok: true`                                                                                 |
| `pnpm exec smithers-build lint '//:knownFiles'`                     | 11.03         | `0 failed`, `ok: true`                                                                                 |
| `actionlint .github/workflows/docs-deploy.yml`                      | 11.03         | exit 0                                                                                                 |

Served bundles after `pnpm exec vocs build` plus the deploy's copy step:

```
docs/dist/public/llms-full.txt 957481
docs/dist/public/llms.txt 1494
<Task = 7
smithers oneshot = 0
/changelogs/0. = 44
Version stamps = 7
cmp docs/dist/public/llms-full.txt docs/llms-full.txt -> llms-full identical
cmp docs/dist/public/llms.txt      docs/llms.txt      -> llms identical
```

Two counts the spec expected to reach zero do not, and should not:

- `<Task` = 7, not 0. Every one is in the migration guide and the internals
  pages, naming the 0.x API that 1.0 removed: `` `<Task>` with a closure |
  `Action.make(...)` ``, `` `<Task agent>` with prompt children ``,
  `` `<Task hijack>` is unsafe ``. The defect was the served bundle's 40 live
  JSX examples; the curated bundle's 7 are documentation of the removal.
- `/changelogs/0.` = 44, all of them route-plan table rows in
  `docs/pages/routes`. The invariant `generate-llms.test.mjs` pins is the
  changelog bodies, `Route: /changelogs/0.`, which is 0.

`smithers oneshot` is 0, down from 8.

## Out of scope, recorded only

`https://github.com/smithersai/plugins` returns 404 to anonymous requests
because the repository is private, not because it is missing:
`gh api repos/smithersai/plugins` reports `private=true`, and
`smithersai/smithers-plugins` redirects to it. Five documentation pages link to
it. This is a publication-order item for the maintainer, who has to make the
repository public before the docs deploy, not a documentation edit. No page was
changed for it.

Also unchanged: vocs' llms plugin still writes per-page Markdown into
`docs/dist/public/assets/md/`, which carries the same 0.x text. No shipped
instruction names those URLs, so they were left alone.

## Teardown

`rm -rf node_modules apps/*/node_modules packages/*/node_modules
packages/build/*/node_modules examples/node_modules apps/ui/.hutch` after the
last gate. `docs/dist` is gitignored and was not committed.
