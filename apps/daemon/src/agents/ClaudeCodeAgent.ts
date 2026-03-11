import { BaseCliAgent, type BaseCliAgentOptions, pushFlag } from "@/agents/BaseCliAgent"

export class ClaudeCodeAgent extends BaseCliAgent {
  constructor(options: BaseCliAgentOptions = {}) {
    super(options)
  }

  protected async buildCommand(params: { prompt: string; cwd: string }) {
    const args = ["--print", "--output-format", "text"]

    if (this.yolo) {
      args.push(
        "--allow-dangerously-skip-permissions",
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions"
      )
    }

    pushFlag(args, "--model", this.model)
    pushFlag(args, "--system-prompt", this.systemPrompt)

    if (this.extraArgs?.length) {
      args.push(...this.extraArgs)
    }

    args.push(params.prompt)

    return {
      command: "claude",
      args,
    }
  }
}
