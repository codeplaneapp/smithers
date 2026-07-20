# Smithers + dstack on Google Cloud (serving Kimi K2)

This example provisions [Kimi K2](https://huggingface.co/moonshotai/Kimi-K2-Instruct)
as an OpenAI-compatible inference service on **Google Cloud H100s** using
[dstack](https://dstack.ai), then runs a Smithers workflow against it.

```
┌─────────────────────────┐         ┌─────────────────────────────┐
│   smithers up           │  HTTPS  │   dstack service: kimi-k2    │
│   workflow.jsx          │ ──────▶ │   vLLM @ 8x H100 on GCP      │
│   (review → patch)      │         │   OpenAI-compatible /v1      │
└─────────────────────────┘         └─────────────────────────────┘
```

Smithers handles **what to do** (durable workflow, resumable, schema-validated
outputs). dstack handles **where to run the model** (GPU provisioning, fleet
management, autoscaling). They compose through one boundary: an HTTPS endpoint.

## Prerequisites

- [dstack](https://dstack.ai/docs/installation/) `>= 0.18` installed and on `PATH`
- [Bun](https://bun.sh) `>= 1.3`
- `jq` (for the env-printing script)
- A Google Cloud project with the **Compute Engine API** enabled and quota for
  `H100_80GB_GPUS` in at least one region (request via
  [GCP quotas](https://console.cloud.google.com/iam-admin/quotas))
- A HuggingFace token with access to `moonshotai/Kimi-K2-Instruct` (the model is
  gated — accept the license on the model card first)

## 1. Configure the dstack server with a GCP backend

Start a local dstack server if you don't already have one:

```bash
dstack server
```

Then add a GCP backend to `~/.dstack/server/config.yml` (replace
`PROJECT_ID` and `path/to/sa-key.json`):

```yaml
projects:
  - name: main
    backends:
      - type: gcp
        project_id: PROJECT_ID
        creds:
          type: service_account
          filename: path/to/sa-key.json
        # Optional — restrict to specific regions to control cost:
        regions: [us-central1, us-east4, us-west1]
```

Reload the server (`Ctrl-C` and re-run) so the backend takes effect, then
confirm it sees GCP offers:

```bash
dstack offer --backend gcp --gpu H100:80GB:8 --max-offers 5
```

You should see a table of H100 8x configurations with hourly prices. If the
table is empty, your GCP quota likely doesn't permit H100s yet.

## 2. Deploy the Kimi K2 service

Export your HF token (dstack picks up the **name** of the env var from
`kimi.dstack.yml` and forwards the **value** from your shell):

```bash
export HF_TOKEN=hf_...
```

Preview the apply plan — this shows the offers table dstack will choose from
and an hourly cost estimate. Nothing is provisioned yet:

```bash
bun run plan
# or: echo "n" | dstack apply -f kimi.dstack.yml
```

When the plan looks right, submit detached:

```bash
bun run deploy
# or: dstack apply -f kimi.dstack.yml -y -d
```

Watch it come up (provisioning → pulling → running). First boot is slow because
vLLM downloads the ~1 TB model checkpoint:

```bash
bun run status
# or: dstack ps -v
```

Once status is `running`, optionally tail logs to confirm vLLM has finished
loading:

```bash
dstack logs kimi-k2
```

You're looking for a line like `Uvicorn running on http://0.0.0.0:8000`.

## 3. Point the workflow at the endpoint

The Smithers workflow consumes the service through two env vars. The helper
script reads them from dstack:

```bash
source <(./scripts/print-env.sh)
```

This sets `KIMI_BASE_URL` (e.g. `https://kimi-k2.<your-server>/v1`) and
`KIMI_API_KEY` (your dstack user token, which the gateway accepts as a bearer).

## 4. Run the Smithers workflow

```bash
bun install
bun run workflow -- --input '{
  "filename": "checkout.ts",
  "code": "export function applyDiscount(price, code) {\n  if (code == \"SUMMER10\") return price * 0.9;\n  if (code == \"WINTER20\") return price * 0.8;\n  return price;\n}"
}'
```

The workflow runs two tasks in sequence:

1. **review** — Kimi reads the snippet and returns a structured critique
   (issues with severity, summary, score 0–100).
2. **patch** — Kimi proposes a minimal unified diff that addresses the
   non-`low`-severity issues from the review.

Both task outputs are Zod-validated and persisted to SQLite, so the run is
resumable if the model is briefly unreachable (e.g. during autoscale).

Check progress and outputs:

```bash
smithers ps
smithers output <run-id> review
smithers output <run-id> patch
```

## 5. Tear down

The dstack service keeps the GPU box(es) running and billable until stopped:

```bash
bun run teardown
# or: dstack stop kimi-k2 -y
```

If you also created a dedicated fleet (`fleet.dstack.yml`), the instances will
terminate after `idle_duration: 10m`. To remove the fleet entirely:

```bash
dstack fleet delete kimi-fleet -y
```

## Files

| File                  | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| `kimi.dstack.yml`     | dstack service: vLLM serves Kimi K2 on 8× H100 on GCP. |
| `fleet.dstack.yml`    | Optional cluster-placement fleet for multi-replica.    |
| `workflow.jsx`        | Smithers workflow: review → patch, both via Kimi.      |
| `scripts/print-env.sh`| Reads service URL + token from dstack, exports env.    |
| `package.json`        | `bun run plan / deploy / status / workflow / teardown`.|

## Cost notes

GCP H100 80GB on-demand is ~$11/hour for an 8-GPU box (varies by region and
preemptibility). Kimi K2 is ~1 TB on disk and needs ~640 GB GPU memory to serve
at FP8, hence the 8× H100 sizing. To shrink the bill while you iterate:

- Switch to `spot_policy: spot` in `kimi.dstack.yml` (cheaper, can be preempted).
- Drop to a smaller open model (`Qwen/Qwen2.5-Coder-32B-Instruct`,
  `meta-llama/Meta-Llama-3.1-70B-Instruct`) by editing the `vllm serve` line and
  reducing `gpu` to `80GB:2`.
- Add `--quantization fp8` (or `awq`) to `vllm serve` to halve the GPU memory
  requirement for Kimi K2 — adjust `tensor-parallel-size` accordingly.

Always run `bun run teardown` when done. dstack does not auto-stop services.

## How the integration works

dstack exposes the running service as OpenAI-compatible at
`<base>/v1/chat/completions`, authenticating via the dstack user token in the
`Authorization: Bearer` header. The workflow wires this up through the Vercel
AI SDK:

```js
import { createOpenAI } from "@ai-sdk/openai";
const kimi = createOpenAI({
  baseURL: process.env.KIMI_BASE_URL, // .../v1
  apiKey: process.env.KIMI_API_KEY,    // dstack user token
})("kimi-k2");
```

From there, `kimi` is just an AI SDK language model — pass it to a
`ToolLoopAgent` and Smithers treats it like any other model. Swap the dstack
service from Kimi to Llama to a fine-tune of your own and the workflow code
does not change.
