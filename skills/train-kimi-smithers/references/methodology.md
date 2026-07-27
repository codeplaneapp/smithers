# Dataset and evaluation methodology

## Contents

- [Objective](#objective)
- [Corpus construction](#corpus-construction)
- [Known limits](#known-limits)
- [Evaluation gate](#evaluation-gate)
- [Iteration plan](#iteration-plan)

## Objective

Teach Kimi the current Smithers workflow surface and repository taste: typed
inputs/outputs, durable dependencies, graph-shaped control flow, real agents,
approval boundaries, deterministic aggregation, and complete primary workflow
files. This is behavior/style adaptation, not new factual pretraining.

## Corpus construction

`assets/source-manifest.json` names the only allowed golden completions. Each is
a checked-in canonical `.smithers/workflows/*.tsx` file with a real metadata
description. The builder:

1. reads the metadata description, tags, and workflow ID;
2. creates deterministic natural-language request variants;
3. pairs every request with the unmodified production workflow;
4. keeps all variants for one source in one split;
5. hashes every source and final JSONL payload;
6. rejects `@ts-nocheck`, conflict markers, apparent secrets, missing metadata,
   non-workflows, and train/validation source overlap.

The default build is 1,050 training rows (35 sources × 30 variants) and 18
validation rows (6 sources × 3 variants). Fireworks receives standard
OpenAI-compatible chat JSONL: system, user, assistant. Only assistant tokens
should be trained.

The generated prompt text is synthetic; the code is not. This deliberately
avoids training on model-generated Smithers code.

## Known limits

- Request variants are templated and less diverse than real user traffic.
- A high-level request does not uniquely determine every local filename in a
  large production workflow. SFT learns conventions, not exact reconstruction.
- Several golden workflows reference existing local prompts, agents, or
  components. The target is Smithers-repository authoring, not standalone npm
  snippets.
- Validation loss is useful for overfitting detection but is not the product
  metric. The structural benchmark is the release gate.
- Repeated completions overweight the selected workflows. Keep the first run to
  one epoch and inspect outputs before increasing variants or epochs.

## Evaluation gate

`assets/eval-cases.jsonl` contains tasks absent from the training corpus. The
evaluator records raw generations and:

- checks required and forbidden authoring patterns;
- writes each response to a temporary `.smithers` workflow path;
- runs the real local `smithers graph`;
- reports per-case lexical, graph, and combined scores.

Capture the base model before training and the tuned model after temporary
deployment. Require a 10-point aggregate improvement, no loss of a previously
passing case, and maintainer review of raw generations. Run the comparison twice
because sampling is nondeterministic.

## Iteration plan

After the pilot, replace templated duplication with consented real pairs:

1. successful `create-workflow` requests and the reviewed files they produced;
2. corrected failures where a maintainer can supply the final golden file;
3. underrepresented primitives and provider integrations;
4. adversarial requests from real regressions.

Deduplicate by semantic request and source hash. Keep benchmark prompts,
benchmark answers, private data, secrets, generated reasoning traces, and
unreviewed model output out of SFT. Once K3 Serverless Training access is
available, consider RL only after the local graph/rubric scorer can be connected
as a trustworthy reward.
