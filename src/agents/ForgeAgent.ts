import {
  BaseCliAgent,
  pushFlag,
} from "./BaseCliAgent";
import type { BaseCliAgentOptions } from "./BaseCliAgent";

type ForgeAgentOptions = BaseCliAgentOptions & {
  directory?: string;
  provider?: string;
  agent?: string;
  conversationId?: string;
  sandbox?: string;
  restricted?: boolean;
  verbose?: boolean;
  workflow?: string;
  event?: string;
  conversation?: string;
};

export class ForgeAgent extends BaseCliAgent {
  private readonly opts: ForgeAgentOptions;

  constructor(opts: ForgeAgentOptions = {}) {
    super(opts);
    this.opts = opts;
  }

  protected async buildCommand(params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }) {
    const args: string[] = [];

    // Model
    pushFlag(args, "--model", this.opts.model ?? this.model);

    // Provider
    pushFlag(args, "--provider", this.opts.provider);

    // Agent type
    pushFlag(args, "--agent", this.opts.agent);

    // Conversation ID
    pushFlag(args, "--conversation-id", this.opts.conversationId);

    // Sandbox
    pushFlag(args, "--sandbox", this.opts.sandbox);

    // Restricted mode
    if (this.opts.restricted) args.push("--restricted");

    // Verbose
    if (this.opts.verbose) args.push("--verbose");

    // Workflow file
    pushFlag(args, "--workflow", this.opts.workflow);

    // Event JSON
    pushFlag(args, "--event", this.opts.event);

    // Conversation file
    pushFlag(args, "--conversation", this.opts.conversation);

    // Directory — default to cwd
    pushFlag(args, "-C", this.opts.directory ?? params.cwd);

    if (this.extraArgs?.length) args.push(...this.extraArgs);

    // Build prompt with system prompt prepended
    const systemPrefix = params.systemPrompt
      ? `${params.systemPrompt}\n\n`
      : "";
    const fullPrompt = `${systemPrefix}${params.prompt ?? ""}`;

    // Pass prompt via --prompt flag
    pushFlag(args, "--prompt", fullPrompt);

    return {
      command: "forge",
      args,
      outputFormat: "text" as const,
    };
  }
}
