import { Smithers as S } from "@smthrs/targets"

const manual = S.Github.Workflow({
  name: "manual",
  on: {
    workflowDispatch: {
      inputs: {
        channel: {
          description: "Release channel",
          required: true,
          default: "stable",
          type: "choice",
          options: ["stable", "next"]
        }
      }
    }
  },
  permissions: { contents: "read" },
  concurrency: { group: "manual-${{ github.ref }}", cancelInProgress: false },
  env: { CHANNEL: "stable" },
  environment: "release",
  condition: "github.ref == 'refs/heads/main'",
  jobName: "Manual release",
  runsOn: "blacksmith-4vcpu-ubuntu-2404",
  steps: [
    { uses: "actions/checkout@v4", with: { "fetch-depth": "0" } },
    {
      name: "Publish",
      id: "publish",
      if: "inputs.channel != ''",
      run: ["echo \"$CHANNEL\"", "echo done"],
      shell: "bash",
      workingDirectory: "scripts",
      env: { GH_TOKEN: "${{ github.token }}" }
    }
  ]
})

const github = S.Github.CiGen({
  workflows: [manual],
  changes: ["workflows/**"]
})

export const Package = S.Package({ targets: { github, manual } })
