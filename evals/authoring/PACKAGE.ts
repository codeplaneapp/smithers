/**
 * Targets for the Smithers authoring fine-tune.
 *
 * The deterministic work is graph-owned and cache-eligible: `datasetValidate`
 * gates the SFT dataset on a program whose exit code is the verdict, and
 * `types` typechecks the validator. The Fireworks operations are irreversible
 * side effects with no file output, so they are `ToolRun` targets: never cached,
 * gated to the `run` verb, and never pulled into a `ci` graph. Each reads its
 * credential from the `FIREWORKS_API_KEY` secret, never from a literal, so no
 * key enters the plan. Run one explicitly, for example:
 *
 *   pnpm exec smithers-build run '//evals/authoring:sftLaunch'
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime, packageManager } from "../../PACKAGE.ts"

const cwd = "evals/authoring"

/** The Fireworks API token, read from the environment at execution time. */
const fireworksKey = Smithers.Secret("FIREWORKS_API_KEY")
const fireworksCredential = Smithers.HttpSecret(fireworksKey, ["https://api.fireworks.ai"])

/** The validator and the dataset it gates. */
const validator = Smithers.file("//evals/authoring/validate.ts")
const dataset = Smithers.file("//evals/authoring/data/pilot-sft.jsonl")

/**
 * Proves every row of the SFT dataset is a well-formed chat example before it
 * is uploaded or trained on. Offline and deterministic: it reads only the
 * committed dataset, so its verdict is reproducible and it belongs in `ci`.
 *
 * @since 0.1.0
 * @category test
 */
const datasetValidate = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.entrypoint(validator),
  srcs: [validator, dataset],
  deps: []
})

/**
 * Checks the validator against its tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const types = Smithers.Typecheck({
  packageManager,
  srcs: [validator],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * Uploads the SFT dataset to Fireworks. Irreversible: a second run fails
 * because the dataset name already exists, so it is gated to the `run` verb and
 * never cached. It depends on {@link datasetValidate}, so a malformed dataset
 * never reaches the account.
 *
 * @since 0.1.0
 * @category run
 */
const datasetUpload = Smithers.ToolRun({
  command: "firectl",
  args: ["dataset", "create", "pilot-sft-v0", "data/pilot-sft.jsonl"],
  inputs: [dataset],
  deps: [datasetValidate],
  secrets: [fireworksCredential],
  cwd
})

/**
 * Launches the supervised fine-tuning job on Kimi K3. Irreversible: every run
 * starts a new billed job, so it is gated to the `run` verb and never cached.
 *
 * @since 0.1.0
 * @category run
 */
const sftLaunch = Smithers.ToolRun({
  command: "firectl",
  args: [
    "supervised-fine-tuning-job",
    "create",
    "--base-model",
    "accounts/fireworks/models/kimi-k3",
    "--dataset",
    "pilot-sft-v0",
    "--output-model",
    "smithers-authoring-pilot-v0",
    "--lora-rank",
    "8",
    "--epochs",
    "3",
    "--display-name",
    "smithers-authoring pilot v0"
  ],
  inputs: [],
  deps: [],
  secrets: [fireworksCredential],
  cwd
})

/**
 * Plumbing-proof variant of {@link sftLaunch} on a small base model.
 *
 * Kimi K3 (2.8T) needs 32 GPUs of fine-tuning quota; the pilot account tier
 * allows 16. This target trains the same dataset on Llama 3.1 8B, which fits
 * that quota, so it validates the whole dataset to checkpoint path for cents
 * without a tier upgrade. Swap back to {@link sftLaunch} for the real run.
 *
 * @since 0.1.0
 * @category run
 */
const sftLaunchPilot = Smithers.ToolRun({
  command: "firectl",
  args: [
    "supervised-fine-tuning-job",
    "create",
    "--base-model",
    "accounts/fireworks/models/llama-v3p1-8b-instruct",
    "--dataset",
    "pilot-sft-v0",
    "--output-model",
    "smithers-authoring-pilot-llama8b-v0",
    "--lora-rank",
    "8",
    "--epochs",
    "3",
    "--display-name",
    "smithers-authoring pilot llama8b v0"
  ],
  inputs: [],
  deps: [],
  secrets: [fireworksCredential],
  cwd
})

export const Package = Smithers.Package({
  targets: { datasetUpload, datasetValidate, sftLaunch, sftLaunchPilot, types }
})
