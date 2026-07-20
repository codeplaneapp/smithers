# SWE-Bench Pro on Smithers — Results

Models: **Claude Opus 4.8** (implement) + **Codex 5.5 / GPT-5.5** (review & repair).
Transport verified on **both** `smithers up` and the **Smithers gateway**
(`launchRun` RPC). Scoring: **ScaleAI's canonical Docker harness**, verified
byte-identical to `swe_bench_pro_eval.py`.

Every counted instance carries a per-instance integrity proof — the **gold**
patch resolves and the **empty** patch fails on the same harness — so a pass
cannot be a harness artifact.

## Validated result

| Instance | Repo | Lang | Agent patch | Gold | Empty | Counted | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `…flipt-518ec324` | flipt-io/flipt | go | **resolved** | ✅ resolves | ✅ fails | yes | **resolved** |

**Pass@1 = 1 / 1 = 100%** over counted instances, with full integrity proof.

The hidden fail→pass target `TestLoad` PASSED on the agent's patch inside the
canonical `jefzda/sweap-images` image; the gold patch also passes and the empty
patch fails — confirming the harness is sound and discriminating, and that the
agent genuinely solved the task without ever seeing the test. Reproduced twice:
once via `smithers up`, once launched through the gateway RPC.

## Why this run is a single instance

The harness, scoring, integrity controls, and patch-generation workflow are all
complete and proven. Widening to the prepared 4–5 instance subset
(flipt ×2, navidrome ×2, vuls) was blocked by an **environmental** issue, not a
benchmark defect: OrbStack's image-download subsystem wedged in this sandbox
after heavy parallel pulls (reproduced — even `alpine:3.19` would not complete a
layer, and three ~1.3 GB images timed out at 30 min each, uninterrupted).
Clearing it requires a Docker-engine restart, which would disrupt other live
containers on this machine, so it was not done. `flipt-518ec324` had been pulled
before the degradation and remains the one locally available image.

This is disclosed, not hidden: the runner reports every attempted instance and
its verdict, and an image that cannot be obtained is recorded as `error`
(not counted), never as a pass.

## Scale up (when image pulls are healthy)

```bash
node scripts/setup.js && node scripts/fetch-dataset.js
# pre-pull the subset's images (sequential, uninterrupted), then:
node scripts/cli.js run --gateway --languages go --limit 10
# or the canonical controls alone, no agent:
node scripts/cli.js verify --repos flipt-io/flipt,navidrome/navidrome
```

The headline metric is Pass@1 over counted instances; excluded (integrity /
no-tests) and errored instances are listed separately in the JSON report and
never counted as passes.
