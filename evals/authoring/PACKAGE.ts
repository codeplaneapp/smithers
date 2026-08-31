import { Smithers as S } from "@smthrs/targets"

const fireworksKey = S.Secret("FIREWORKS_API_KEY")

const srcs = S.Filegroup({
  srcs: [S.file("validate.ts"), S.file("data/pilot-sft.jsonl")]
})

const datasetValidate = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: ["evals/authoring/validate.ts"],
  data: [srcs]
})

const types = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: ["-p", "evals/authoring/tsconfig.json", "--noEmit", "--lib", "ES2024"],
  data: [srcs, S.file("tsconfig.json"), S.file("//tsconfig.base.json")]
})

const datasetUpload = S.Shell.Run({
  command: "firectl dataset create pilot-sft-v0 evals/authoring/data/pilot-sft.jsonl",
  data: [srcs],
  gates: [datasetValidate],
  secrets: [fireworksKey],
  sandbox: { network: true },
  approval: "required"
})

const sftLaunch = S.Shell.Run({
  command: "firectl supervised-fine-tuning-job create --base-model accounts/fireworks/models/kimi-k3 " +
    "--dataset pilot-sft-v0 --output-model smithers-authoring-pilot-v0 --lora-rank 8 --epochs 3 " +
    "--display-name 'smithers-authoring pilot v0'",
  secrets: [fireworksKey],
  sandbox: { network: true },
  approval: "required"
})

const sftLaunchPilot = S.Shell.Run({
  command: "firectl supervised-fine-tuning-job create " +
    "--base-model accounts/fireworks/models/llama-v3p1-8b-instruct --dataset pilot-sft-v0 " +
    "--output-model smithers-authoring-pilot-llama8b-v0 --lora-rank 8 --epochs 3 " +
    "--display-name 'smithers-authoring pilot llama8b v0'",
  secrets: [fireworksKey],
  sandbox: { network: true },
  approval: "required"
})

const ci = S.Suite({ tests: [datasetValidate, types] })

export const Package = S.Package({
  targets: {
    srcs,
    datasetValidate,
    types,
    datasetUpload,
    sftLaunch,
    sftLaunchPilot,
    ci
  }
})
