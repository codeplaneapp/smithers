# Fireworks signup and runbook

## Contents

- [Current provider decision](#current-provider-decision)
- [Sign up](#sign-up)
- [Build the corpus](#build-the-corpus)
- [Self-serve Kimi K2.7 SFT](#self-serve-kimi-k27-sft)
- [Kimi K3 private preview](#kimi-k3-private-preview)
- [Evaluate and deploy](#evaluate-and-deploy)
- [Use the tuned model in Smithers](#use-the-tuned-model-in-smithers)
- [Costs and teardown](#costs-and-teardown)
- [Primary sources](#primary-sources)

## Current provider decision

Verified 2026-07-27:

- Kimi K3 launched as an open-weight 2.8T MoE model with a 1M-token context.
- Fireworks serves K3 pay-per-token, but its public model page says
  fine-tuning is not supported. Fireworks separately offers K3 LoRA through
  Serverless Training private preview.
- Kimi K2.7 Code is open-weight, coding-focused, serverless, and explicitly
  marked `Tunable` with LoRA on Fireworks.
- Fireworks managed SFT is self-serve and charges per training token. This makes
  K2.7 the immediate path and K3 the no-rewrite upgrade path after preview
  approval.

Together also provides a general pay-as-you-go fine-tuning product, but its
current public Kimi material does not establish K2.7 or K3 as a supported
self-serve fine-tuning base. Fireworks publishes model-specific tunability and
the K3 preview, so it is the evidence-backed choice.

## Sign up

The human account owner must:

1. Create or sign in to an account at <https://app.fireworks.ai/>.
2. Add a payment method in Billing and set a conservative monthly spend limit.
3. Create an API key at
   <https://app.fireworks.ai/settings/users/api-keys>. Prefer a scoped service
   account for automation. Never paste or commit the key.
4. Install the current CLI:

   ```bash
   brew tap fw-ai/firectl
   brew trust --formula fw-ai/firectl/firectl
   brew install firectl
   firectl signin
   firectl whoami
   firectl quota list
   ```

5. For K3, submit <https://fireworks.ai/contact-training> with:

   > Please enable Kimi K3 Serverless Training private preview. We are training
   > a LoRA for Smithers TypeScript/JSX workflow authoring using reviewed
   > repository workflows, a held-out graph-render benchmark, one pilot epoch,
   > rank 8, and a 32K maximum training sequence. We want pay-per-token training
   > on accounts/fireworks/models/kimi-k3.

K2.7 managed SFT does not require waiting for K3 preview approval.

## Build the corpus

```bash
node skills/train-kimi-smithers/scripts/prepare-dataset.mjs \
  --out artifacts/kimi-smithers
node skills/train-kimi-smithers/scripts/validate-dataset.mjs \
  artifacts/kimi-smithers/train.jsonl \
  artifacts/kimi-smithers/validation.jsonl
```

Inspect `artifacts/kimi-smithers/manifest.json` for exact rows, hashes, estimated
tokens, and the one-epoch managed-LoRA cost estimate. The token estimate uses
characters ÷ 4; the provider's tokenizer and invoice are authoritative.

## Self-serve Kimi K2.7 SFT

Verify live support before upload:

```bash
firectl version
firectl whoami
firectl quota list
firectl model get -a fireworks kimi-k2p7-code
```

The model must still report `Tunable: true`. In the Fireworks dashboard, the
equivalent flow is Datasets → Create Dataset, then Fine-Tuning → Fine-Tune a
Model → Supervised.

Upload the already validated files:

```bash
firectl dataset create smithers-kimi-train-v1 \
  artifacts/kimi-smithers/train.jsonl
firectl dataset create smithers-kimi-validation-v1 \
  artifacts/kimi-smithers/validation.jsonl
```

Resolve the current flags with
`firectl supervised-fine-tuning-job create --help`, review the UI/CLI price
estimate, then launch this one-run pilot:

```bash
firectl supervised-fine-tuning-job create \
  --job-id smithers-kimi-k2p7-v1 \
  --base-model accounts/fireworks/models/kimi-k2p7-code \
  --dataset smithers-kimi-train-v1 \
  --evaluation-dataset smithers-kimi-validation-v1 \
  --output-model smithers-kimi-k2p7-v1 \
  --epochs 1 \
  --lora-rank 8 \
  --max-context-length 32768
```

Leave learning rate and batch size at current platform defaults for the first
job. Monitor with:

```bash
firectl supervised-fine-tuning-job get smithers-kimi-k2p7-v1
firectl model list
```

If the CLI rejects a deprecated field, update `firectl` and rerun its current
help rather than guessing a replacement.

## Kimi K3 private preview

K3 uses the Fireworks Training API and the official cookbook renderer. After
the account is enabled:

```bash
git clone https://github.com/fw-ai/cookbook.git ../fireworks-cookbook
git -C ../fireworks-cookbook rev-parse HEAD
python -m venv ../fireworks-cookbook/.venv
source ../fireworks-cookbook/.venv/bin/activate
pip install -e ../fireworks-cookbook/training
export FIREWORKS_API_KEY="fw_..."
```

Record the cookbook commit and installed SDK version. Inspect the resolved local
plan:

```bash
python skills/train-kimi-smithers/scripts/train_kimi_k3.py \
  --dataset artifacts/kimi-smithers/train.jsonl \
  --output-model-id smithers-kimi-k3-v1 \
  --print-config
```

After confirming the private-preview rate and displayed parameters:

```bash
python skills/train-kimi-smithers/scripts/train_kimi_k3.py \
  --dataset artifacts/kimi-smithers/train.jsonl \
  --output-model-id smithers-kimi-k3-v1 \
  --confirm-spend
```

The wrapper uses the official `training.recipes.sft_loop`, `kimi_k3` renderer,
serverless pooled trainer, LoRA rank 8, one epoch, and 32K max sequence. It does
not vendor or reimplement Fireworks training internals.

## Evaluate and deploy

Capture the base before training:

```bash
FIREWORKS_API_KEY=... node \
  skills/train-kimi-smithers/scripts/evaluate-fireworks.mjs \
  --model accounts/fireworks/models/kimi-k2p7-code \
  --out artifacts/kimi-smithers/eval-base.json
```

After training, create a temporary deployment from the completed model using
the dashboard's Deploy action or the current `firectl deployment create --help`.
Then score its full model resource:

```bash
FIREWORKS_API_KEY=... node \
  skills/train-kimi-smithers/scripts/evaluate-fireworks.mjs \
  --model accounts/YOUR_ACCOUNT/models/smithers-kimi-k2p7-v1 \
  --out artifacts/kimi-smithers/eval-tuned.json
```

Do not promote the tune into Smithers defaults until the SKILL.md acceptance
gate passes.

## Use the tuned model in Smithers

Fireworks exposes deployed LoRAs through its OpenAI-compatible chat endpoint.
Register the full deployed model resource in `.smithers/agents.ts`:

```ts
import { OpenAIAgent } from "smthrs";

const smithersKimi = new OpenAIAgent({
  model: "accounts/YOUR_ACCOUNT/models/smithers-kimi-k2p7-v1",
  baseURL: "https://api.fireworks.ai/inference/v1",
  apiKey: process.env.FIREWORKS_API_KEY,
  api: "chat",
});
```

Add `smithersKimi` to a narrow authoring pool first; do not replace general
planning, implementation, or review agents until broader evals pass. Keep the
key in the environment or a secret manager, never in `.smithers/agents.ts`.

## Costs and teardown

At verification time, Fireworks listed managed LoRA SFT for models above 300B
parameters at $10 per 1M training tokens. Recheck
<https://fireworks.ai/pricing> immediately before launch. One-epoch cost is:

```text
estimated tokens / 1,000,000 × live LoRA SFT rate
```

K3 Serverless Training preview pricing is account-specific/currently not listed
in the public serverless training table; obtain and confirm the rate during
access enablement. Fireworks gives a public RL example of about $65 for 860K
training tokens plus sampling, but that is not an SFT quote.

Fine-tuned LoRAs may require a dedicated deployment. Deployment time can cost
more than the tune, so use scale-to-zero when supported and delete the
validation deployment after the comparison. Keep spend limits enabled.

## Primary sources

- K3 release and preview:
  <https://fireworks.ai/blog/kimik3-on-fireworks>
- K3 LoRA walkthrough:
  <https://fireworks.ai/blog/K3-LoRA-Training>
- Fireworks K3 model:
  <https://fireworks.ai/models/fireworks/kimi-k3>
- Moonshot K3 model card:
  <https://huggingface.co/moonshotai/Kimi-K3>
- Fireworks K2.7 model:
  <https://app.fireworks.ai/models/fireworks/kimi-k2p7-code>
- Managed SFT:
  <https://docs.fireworks.ai/fine-tuning/fine-tuning-models>
- Training overview:
  <https://docs.fireworks.ai/fine-tuning/finetuning-intro>
- Pricing:
  <https://fireworks.ai/pricing>
- CLI dataset creation:
  <https://docs.fireworks.ai/tools-sdks/firectl/commands/dataset-create>
- CLI SFT creation:
  <https://docs.fireworks.ai/tools-sdks/firectl/commands/supervised-fine-tuning-job-create>
- Official training cookbook:
  <https://github.com/fw-ai/cookbook>
