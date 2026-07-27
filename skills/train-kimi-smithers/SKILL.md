---
name: train-kimi-smithers
description: Prepare, launch, and evaluate Kimi LoRA fine-tuning for Smithers TypeScript/JSX workflow authoring. Use when building a Smithers training corpus, validating Fireworks JSONL, comparing base and tuned Kimi models, starting a Fireworks Kimi K2.7 managed SFT job, requesting or using Kimi K3 Serverless Training access, estimating training spend, or refreshing the checked-in Smithers authoring dataset.
---

# Train Kimi for Smithers

Build the corpus locally, establish a base-model score, run the smallest useful
LoRA SFT, and promote it only when the held-out benchmark improves.

## Start here

Run from the Smithers repository root:

```bash
node skills/train-kimi-smithers/scripts/prepare-dataset.mjs \
  --out artifacts/kimi-smithers
node skills/train-kimi-smithers/scripts/validate-dataset.mjs \
  artifacts/kimi-smithers/train.jsonl \
  artifacts/kimi-smithers/validation.jsonl
```

The builder uses only canonical workflow files listed in
`assets/source-manifest.json`. It splits by source file, never by generated
prompt variant, so validation cannot contain another wording of a training
completion. Read [methodology.md](references/methodology.md) before changing
sources, variants, or the system prompt.

## Choose the model path

- Prefer **Kimi K2.7 Code managed LoRA SFT** for a self-serve run now. Its
  Fireworks model is publicly marked tunable and coding-focused.
- Prefer **Kimi K3 Serverless Training** after Fireworks enables the private
  preview on the account. K3 is open-weight, but its public model card currently
  says fine-tuning is unavailable outside the preview.
- Do not fall back to K2.5: K2.7 is open-weight and self-serve tunable. Use K2.5
  only if the live K2.7 model or training shape is temporarily unavailable.

Read [fireworks.md](references/fireworks.md) completely before account setup,
upload, job creation, promotion, or deployment. Recheck every linked live model,
price, and CLI page because provider support changes quickly.

## Establish the baseline

After the account has an API key, score the public base model before training:

```bash
FIREWORKS_API_KEY=... node \
  skills/train-kimi-smithers/scripts/evaluate-fireworks.mjs \
  --model accounts/fireworks/models/kimi-k2p7-code \
  --out artifacts/kimi-smithers/eval-base.json
```

The evaluator uses held-out prompts, checks required/forbidden authoring
patterns, and renders each generated workflow through the real local
`smithers graph` command. Treat a graph failure as a failure even when lexical
checks pass.

## Launch training

For K2.7, use the exact managed SFT flow in [fireworks.md](references/fireworks.md).
Keep the first run to one epoch, LoRA rank 8, a 32K maximum context, and the
separate validation dataset. Leave the learning rate at the platform default.

For K3 preview, inspect the resolved configuration first:

```bash
python skills/train-kimi-smithers/scripts/train_kimi_k3.py \
  --dataset artifacts/kimi-smithers/train.jsonl \
  --output-model-id smithers-kimi-k3-v1 \
  --print-config
```

Run the same command with `--confirm-spend` only after preview access, live
pricing, billing, and the displayed configuration are confirmed.

## Accept or reject the tune

Deploy the completed LoRA temporarily, then rerun `evaluate-fireworks.mjs` with
its full model resource name. Keep the tune only if:

1. graph-pass rate improves without losing any previously passing case;
2. aggregate structural score improves by at least 10 percentage points;
3. a maintainer reviews the raw generations for current Smithers idioms;
4. the gain survives a second run with the same cases.

Tear down the validation deployment after the comparison. Add real, consented
request-to-workflow pairs and hard failures to the next corpus; never train on
held-out cases or generated benchmark answers.
