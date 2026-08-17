import { SmithersError } from "@smthrs/errors";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeUnavailableAgent } from "../agent-detection.js";
import { SOTA_SLOTS } from "../sota-models.generated.js";
import { classifyOneshotGoal } from "./classifyOneshotGoal.js";
import { oneshotCodexPauseDetail } from "./oneshotCodexPauseDetail.js";

// Oneshot's kimi seat runs Kimi K3 (`kimi-code/k3` in the Kimi CLI), ahead of
// the registry's `kimi` slot (k2.7-code): K3's 1M window absorbs a whole
// oneshot session without compaction.
export const ONESHOT_KIMI_MODEL = "kimi-code/k3";
// The same Kimi K3 reached through OpenCode's kimi-for-coding provider and
// through the Pi CLI's kimi-coding provider (`pi --provider kimi-coding
// --model k3`). UI-flavored goals lead with these two kimi seats.
export const ONESHOT_OPENCODE_KIMI_MODEL = "kimi-for-coding/k3";
export const ONESHOT_PI_KIMI_PROVIDER = "kimi-coding";
export const ONESHOT_PI_KIMI_MODEL = "k3";
const SLOTS = Object.freeze({
  sol: SOTA_SLOTS.codexSol,
  terra: SOTA_SLOTS.codexTerra,
  luna: SOTA_SLOTS.codex,
  kimi: ONESHOT_KIMI_MODEL,
  grok: SOTA_SLOTS.grok,
  fable: SOTA_SLOTS.fable,
  opus: SOTA_SLOTS.opus,
  sonnet: SOTA_SLOTS.sonnet,
});
const ALLOWED = ["claude", "codex", "grok", "kimi", "opencode", "pi"];

function providerNamesFromJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const names = new Set();
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const entry of value) visit(entry);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        names.add(key.toLowerCase());
        visit(child);
      }
    };
    visit(parsed);
    return names;
  } catch {
    return new Set();
  }
}

function hasNamedProvider(names, patterns) {
  return [...names].some((name) => patterns.some((pattern) => name.includes(pattern)));
}

function resolveProviderCapabilities(env) {
  const home = env.HOME ?? homedir();
  const openCodeProviders = providerNamesFromJson(join(home, ".local", "share", "opencode", "auth.json"));
  const piProviders = providerNamesFromJson(join(home, ".pi", "agent", "auth.json"));
  return {
    openCodeAnthropic: Boolean(env.ANTHROPIC_API_KEY) || hasNamedProvider(openCodeProviders, ["anthropic", "claude"]),
    openCodeKimi: Boolean(env.KIMI_API_KEY) || hasNamedProvider(openCodeProviders, ["kimi-for-coding", "kimi"]),
    piKimi: Boolean(env.KIMI_API_KEY) || hasNamedProvider(piProviders, ["kimi-coding", "kimi"]),
  };
}

/** @param {string} model @param {Set<string>} usable */
function engineForCanonicalModel(model, usable) {
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4"))
    return "codex";
  if (model.startsWith("kimi-for-coding/")) return "opencode";
  if (model.startsWith("kimi-")) return "kimi";
  if (model.startsWith("grok-")) return "grok";
  if (model.startsWith("anthropic/")) return "opencode";
  if (model.startsWith("claude-")) return usable.has("claude") ? "claude" : "opencode";
  return undefined;
}

/**
 * @param {import("../AgentAvailability.ts").AgentAvailability[]} detections
 * @param {{ model?: string; agent?: string; goal?: string; env?: NodeJS.ProcessEnv }} [options]
 */
export function resolveOneshotChain(detections, options = {}) {
  const env = options.env ?? process.env;
  const capabilities = resolveProviderCapabilities(env);
  let requestedEngine = options.agent === "claude-code" ? "claude" : options.agent;
  if (requestedEngine && !ALLOWED.includes(requestedEngine))
    throw new SmithersError(
      "CLI_AGENT_UNSUPPORTED",
      `Agent "${options.agent}" is not supported for \`smithers oneshot\`.`,
    );
  const usable = new Set(
    detections.filter((item) => ALLOWED.includes(item.id) && item.usable && !item.deprecated).map((item) => item.id),
  );
  const codexPause = oneshotCodexPauseDetail(env);
  if (codexPause.paused) usable.delete("codex");
  const requestedModel = options.model ? (SLOTS[options.model] ?? options.model) : undefined;
  if (!requestedEngine && requestedModel) {
    if ([SOTA_SLOTS.codexSol, SOTA_SLOTS.codexTerra, SOTA_SLOTS.codex].includes(requestedModel))
      requestedEngine = "codex";
    else if (requestedModel === ONESHOT_KIMI_MODEL) requestedEngine = "kimi";
    else if (requestedModel === SOTA_SLOTS.grok) requestedEngine = "grok";
    else if ([SOTA_SLOTS.fable, SOTA_SLOTS.opus, SOTA_SLOTS.sonnet].includes(requestedModel))
      requestedEngine = usable.has("claude") ? "claude" : "opencode";
    else requestedEngine = engineForCanonicalModel(requestedModel, usable);
    if (!requestedEngine)
      throw new SmithersError(
        "CLI_MODEL_UNSUPPORTED",
        `Cannot infer an agent engine for model "${requestedModel}". Pass --agent with this canonical model id.`,
      );
  }
  if (requestedEngine && !usable.has(requestedEngine)) {
    const detection = detections.find((item) => item.id === requestedEngine);
    if (requestedEngine === "codex" && codexPause.paused && detection?.usable && !detection.deprecated) {
      const until = codexPause.until ? ` until ${codexPause.until}` : "";
      const reason = codexPause.reason ? ` (${codexPause.reason})` : "";
      const clearHint =
        codexPause.pausedBy === "env"
          ? "Unset SMITHERS_CODEX_PAUSED to use it."
          : `Override with SMITHERS_CODEX_PAUSED=0, or delete ${codexPause.markerPath} if the limit has reset.`;
      throw new SmithersError(
        "NO_USABLE_AGENTS",
        `Requested oneshot agent "${options.agent ?? requestedEngine}" is paused${until}${reason}. ${clearHint}`,
      );
    }
    throw new SmithersError(
      "NO_USABLE_AGENTS",
      `Requested oneshot agent "${options.agent ?? requestedEngine}" is unavailable. ${
        detection ? describeUnavailableAgent(detection) : "Run `smithers agents add` to register it."
      }`,
    );
  }
  const claudeEngine = usable.has("claude")
    ? "claude"
    : usable.has("opencode") && capabilities.openCodeAnthropic
      ? "opencode"
      : null;
  const claudeSpec = (model) => ({
    engine: claudeEngine,
    model: claudeEngine === "opencode" ? `anthropic/${model}` : model,
  });
  const piSpec = { engine: "pi", provider: ONESHOT_PI_KIMI_PROVIDER, model: ONESHOT_PI_KIMI_MODEL };
  // General/default chain: Opus leads (Claude Opus 5 is the default implementer,
  // registry v7), with Codex Sol, Kimi K3, and Fable as availability fallbacks
  // in that order; pi's kimi-coding seat is the last-resort rung.
  const general = [
    ...(claudeEngine ? [claudeSpec(SOTA_SLOTS.opus)] : []),
    ...(usable.has("codex") ? [{ engine: "codex", model: SOTA_SLOTS.codexSol }] : []),
    ...(usable.has("grok") ? [{ engine: "grok", model: SOTA_SLOTS.grok }] : []),
    ...(usable.has("kimi") ? [{ engine: "kimi", model: ONESHOT_KIMI_MODEL }] : []),
    ...(claudeEngine ? [claudeSpec(SOTA_SLOTS.fable)] : []),
    ...(usable.has("pi") && capabilities.piKimi ? [piSpec] : []),
  ];
  // UI-flavored goals lead with Kimi K3 (registry v8 oneshot doctrine):
  // OpenCode's kimi-for-coding seat first, then kimi through pi, then the Kimi
  // CLI. With no kimi reachable, Claude Opus then Fable; Codex Sol is the
  // last-resort rung when nothing else is usable.
  const ui = [
    ...(usable.has("opencode") && capabilities.openCodeKimi
      ? [{ engine: "opencode", model: ONESHOT_OPENCODE_KIMI_MODEL }]
      : []),
    ...(usable.has("pi") && capabilities.piKimi ? [piSpec] : []),
    ...(usable.has("kimi") ? [{ engine: "kimi", model: ONESHOT_KIMI_MODEL }] : []),
    ...(usable.has("grok") ? [{ engine: "grok", model: SOTA_SLOTS.grok }] : []),
    ...(claudeEngine ? [claudeSpec(SOTA_SLOTS.opus), claudeSpec(SOTA_SLOTS.fable)] : []),
    ...(usable.has("codex") ? [{ engine: "codex", model: SOTA_SLOTS.codexSol }] : []),
  ];
  const defaults = classifyOneshotGoal(options.goal) === "ui" ? ui : general;
  let requestedSpec = requestedEngine ? defaults.find((item) => item.engine === requestedEngine) : undefined;
  if (requestedEngine === "opencode" && !requestedModel && !requestedSpec) {
    if (capabilities.openCodeAnthropic) {
      requestedSpec = { engine: "opencode", model: `anthropic/${SOTA_SLOTS.fable}` };
    } else if (capabilities.openCodeKimi) {
      requestedSpec = { engine: "opencode", model: ONESHOT_OPENCODE_KIMI_MODEL };
    }
  }
  if (
    requestedEngine === "opencode" &&
    (((requestedModel?.startsWith("anthropic/") || requestedModel?.startsWith("claude-")) &&
      !capabilities.openCodeAnthropic) ||
      (requestedModel?.startsWith("kimi-for-coding/") && !capabilities.openCodeKimi) ||
      (!requestedModel && !requestedSpec))
  ) {
    throw new SmithersError(
      "NO_USABLE_AGENTS",
      "OpenCode is installed, but no authenticated provider can run the requested oneshot model.",
    );
  }
  if (requestedEngine === "pi" && !capabilities.piKimi) {
    throw new SmithersError(
      "NO_USABLE_AGENTS",
      "Pi is installed, but its kimi-coding provider is not authenticated for the oneshot chain.",
    );
  }
  const chain = requestedEngine
    ? [
        {
          engine: requestedEngine,
          ...(requestedSpec?.provider ? { provider: requestedSpec.provider } : {}),
          model: requestedModel ?? requestedSpec?.model ?? SOTA_SLOTS.fable,
        },
        ...defaults.filter((item) => item.engine !== requestedEngine),
      ]
    : defaults;
  if (chain.length === 0)
    throw new SmithersError(
      "NO_USABLE_AGENTS",
      "No usable oneshot agents remain after applying availability and pause settings.",
    );
  return chain;
}
