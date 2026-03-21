import type { GenerateTextResult } from "ai";
import {
  BaseCliAgent,
  buildGenerateResult,
  combineNonEmpty,
  extractPrompt,
  extractTextFromPiNdjson,
  resolveTimeouts,
  runCommand,
  runRpcCommand,
  tryParseJson,
  pushFlag,
} from "./BaseCliAgent";
import type { BaseCliAgentOptions, PiExtensionUiRequest, PiExtensionUiResponse } from "./BaseCliAgent";
import { getToolContext } from "../tools/context";
import { SmithersError } from "../utils/errors";

export type { PiExtensionUiRequest, PiExtensionUiResponse };

export type PiAgentOptions = BaseCliAgentOptions & {
  provider?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  mode?: "text" | "json" | "rpc";
  print?: boolean;
  continue?: boolean;
  resume?: boolean;
  session?: string;
  sessionDir?: string;
  noSession?: boolean;
  models?: string | string[];
  listModels?: boolean | string;
  tools?: string[];
  noTools?: boolean;
  extension?: string[];
  noExtensions?: boolean;
  skill?: string[];
  noSkills?: boolean;
  promptTemplate?: string[];
  noPromptTemplates?: boolean;
  theme?: string[];
  noThemes?: boolean;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  export?: string;
  files?: string[];
  verbose?: boolean;
  onExtensionUiRequest?: (request: PiExtensionUiRequest) =>
    | Promise<PiExtensionUiResponse | null>
    | PiExtensionUiResponse
    | null;
};

export class PiAgent extends BaseCliAgent {
  private readonly opts: PiAgentOptions;

  constructor(opts: PiAgentOptions = {}) {
    super(opts);
    this.opts = opts;
  }

  async generate(options: any): Promise<GenerateTextResult<any, any>> {
    const { prompt, systemFromMessages } = extractPrompt(options);
    const callTimeouts = resolveTimeouts(options?.timeout, {
      totalMs: this.timeoutMs,
      idleMs: this.idleTimeoutMs,
    });
    const cwd = this.cwd ?? getToolContext()?.rootDir ?? process.cwd();
    const env = { ...process.env, ...(this.env ?? {}) } as Record<string, string>;
    const combinedSystem = combineNonEmpty([this.systemPrompt, systemFromMessages]);

    const mode = this.opts.mode ?? "text";

    if (mode === "rpc" && this.opts.files?.length) {
      throw new SmithersError("AGENT_RPC_FILE_ARGS", "RPC mode does not support file arguments");
    }

    const args: string[] = [];

    // Mode handling: text uses --print (no --mode), json/rpc use --mode
    if (mode === "text") {
      if (this.opts.print !== false) args.push("--print");
    } else {
      args.push("--mode", mode);
    }

    pushFlag(args, "--provider", this.opts.provider);
    pushFlag(args, "--model", this.opts.model ?? this.model);
    pushFlag(args, "--api-key", this.opts.apiKey);
    pushFlag(args, "--system-prompt", this.opts.systemPrompt);

    // Combine appendSystemPrompt with systemFromMessages
    const appendParts = combineNonEmpty([this.opts.appendSystemPrompt, systemFromMessages]);
    pushFlag(args, "--append-system-prompt", appendParts);

    if (this.opts.continue) args.push("--continue");
    if (this.opts.resume) args.push("--resume");
    pushFlag(args, "--session", this.opts.session);
    pushFlag(args, "--session-dir", this.opts.sessionDir);

    // noSession defaults to true unless session flags are set
    const hasSessionFlags = !!(this.opts.session || this.opts.sessionDir || this.opts.continue || this.opts.resume);
    if (this.opts.noSession ?? (!hasSessionFlags)) {
      args.push("--no-session");
    }

    if (this.opts.models) {
      const modelsStr = Array.isArray(this.opts.models) ? this.opts.models.join(",") : this.opts.models;
      args.push("--models", modelsStr);
    }
    if (this.opts.listModels !== undefined && this.opts.listModels !== false) {
      if (typeof this.opts.listModels === "string") {
        args.push("--list-models", this.opts.listModels);
      } else {
        args.push("--list-models");
      }
    }
    pushFlag(args, "--export", this.opts.export);

    if (this.opts.tools?.length) {
      args.push("--tools", this.opts.tools.join(","));
    }
    if (this.opts.noTools) args.push("--no-tools");

    if (this.opts.extension) {
      for (const ext of this.opts.extension) {
        args.push("--extension", ext);
      }
    }
    if (this.opts.noExtensions) args.push("--no-extensions");

    if (this.opts.skill) {
      for (const s of this.opts.skill) {
        args.push("--skill", s);
      }
    }
    if (this.opts.noSkills) args.push("--no-skills");

    if (this.opts.promptTemplate) {
      for (const pt of this.opts.promptTemplate) {
        args.push("--prompt-template", pt);
      }
    }
    if (this.opts.noPromptTemplates) args.push("--no-prompt-templates");

    if (this.opts.theme) {
      for (const t of this.opts.theme) {
        args.push("--theme", t);
      }
    }
    if (this.opts.noThemes) args.push("--no-themes");

    pushFlag(args, "--thinking", this.opts.thinking);
    if (this.opts.verbose) args.push("--verbose");
    if (this.extraArgs?.length) args.push(...this.extraArgs);

    if (mode !== "rpc") {
      // File args as @path
      if (this.opts.files) {
        for (const f of this.opts.files) {
          args.push(`@${f}`);
        }
      }
      // Prompt as last positional arg
      if (prompt) args.push(prompt);

      const result = await runCommand("pi", args, {
        cwd,
        env,
        timeoutMs: callTimeouts.totalMs,
        idleTimeoutMs: callTimeouts.idleMs,
        signal: options?.abortSignal,
        maxOutputBytes: this.maxOutputBytes ?? getToolContext()?.maxOutputBytes,
        onStdout: options?.onStdout,
        onStderr: options?.onStderr,
      });

      if (result.exitCode && result.exitCode !== 0) {
        throw new SmithersError("AGENT_CLI_ERROR", result.stderr.trim() || result.stdout.trim() || `CLI exited with code ${result.exitCode}`);
      }

      const rawText = result.stdout.trim();
      // In json mode, pi outputs NDJSON stream. Extract text from turn_end message
      // rather than returning the first JSON object (session metadata).
      const extractedText = mode === "json"
        ? (extractTextFromPiNdjson(rawText) ?? rawText)
        : rawText;
      const output = tryParseJson(extractedText);
      return buildGenerateResult(extractedText, output, this.opts.model ?? "pi");
    }

    // RPC mode
    const rpcResult = await runRpcCommand("pi", args, {
      cwd,
      env,
      prompt,
      timeoutMs: callTimeouts.totalMs,
      idleTimeoutMs: callTimeouts.idleMs,
      signal: options?.abortSignal,
      maxOutputBytes: this.maxOutputBytes ?? getToolContext()?.maxOutputBytes,
      onStderr: options?.onStderr,
      onExtensionUiRequest: this.opts.onExtensionUiRequest,
    });

    return buildGenerateResult(rpcResult.text, rpcResult.output, this.opts.model ?? "pi");
  }

  protected async buildCommand(_params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }): Promise<{
    command: string;
    args: string[];
    stdin?: string;
    outputFormat?: string;
    outputFile?: string;
    cleanup?: () => Promise<void>;
  }> {
    // PiAgent overrides generate() directly, so buildCommand is not used
    throw new SmithersError("AGENT_BUILD_COMMAND", "PiAgent does not use buildCommand");
  }
}
