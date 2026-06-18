// @smithers-type-exports-begin
/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/AgentGenerateOptions.ts").AgentGenerateOptions} AgentGenerateOptions */
/** @typedef {import("./AgentLike.ts").AgentLike} AgentLike */
/** @typedef {import("./capability-registry/AgentToolDescriptor.ts").AgentToolDescriptor} AgentToolDescriptor */
/**
 * @template [CALL_OPTIONS=never]
 * @template [TOOLS=import("ai").ToolSet]
 * @typedef {import("./AnthropicAgentOptions.ts").AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} AnthropicAgentOptions
 */
/**
 * @template [CALL_OPTIONS=never]
 * @template [TOOLS=import("ai").ToolSet]
 * @typedef {import("./OpenAIAgentOptions.ts").OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} OpenAIAgentOptions
 */
/**
 * @template [CALL_OPTIONS=never]
 * @template [TOOLS=import("ai").ToolSet]
 * @typedef {import("./HermesAgentOptions.ts").HermesAgentOptions<CALL_OPTIONS, TOOLS>} HermesAgentOptions
 */
/** @typedef {import("./PiAgentOptions.ts").PiAgentOptions} PiAgentOptions */
/** @typedef {import("./BaseCliAgent/PiExtensionUiRequest.ts").PiExtensionUiRequest} PiExtensionUiRequest */
/** @typedef {import("./BaseCliAgent/PiExtensionUiResponse.ts").PiExtensionUiResponse} PiExtensionUiResponse */
/** @typedef {import("./OpenCodeAgent.ts").OpenCodeAgentOptions} OpenCodeAgentOptions */
/** @typedef {import("./VibeAgentOptions.ts").VibeAgentOptions} VibeAgentOptions */
/** @typedef {import("./agent-contract/SmithersAgentContract.ts").SmithersAgentContract} SmithersAgentContract */
/** @typedef {import("./agent-contract/SmithersAgentContractTool.ts").SmithersAgentContractTool} SmithersAgentContractTool */
/** @typedef {import("./agent-contract/SmithersAgentToolCategory.ts").SmithersAgentToolCategory} SmithersAgentToolCategory */
/** @typedef {import("./agent-contract/SmithersListedTool.ts").SmithersListedTool} SmithersListedTool */
/** @typedef {import("./agent-contract/SmithersToolSurface.ts").SmithersToolSurface} SmithersToolSurface */
/** @typedef {import("./cli-capabilities/CliAgentCapabilityAdapterId.ts").CliAgentCapabilityAdapterId} CliAgentCapabilityAdapterId */
/** @typedef {import("./cli-capabilities/CliAgentCapabilityDoctorReport.ts").CliAgentCapabilityDoctorEntry} CliAgentCapabilityDoctorEntry */
/** @typedef {import("./cli-capabilities/CliAgentCapabilityDoctorReport.ts").CliAgentCapabilityDoctorReport} CliAgentCapabilityDoctorReport */
/** @typedef {import("./cli-capabilities/CliAgentCapabilityDoctorReport.ts").CliAgentCapabilityIssue} CliAgentCapabilityIssue */
/** @typedef {import("./cli-capabilities/CliAgentCapabilityReportEntry.ts").CliAgentCapabilityReportEntry} CliAgentCapabilityReportEntry */
/** @typedef {import("./cli-surface/CliAgentSurfaceTypes.ts").CliAgentSurfaceManifestEntry} CliAgentSurfaceManifestEntry */
/** @typedef {import("./cli-surface/CliAgentSurfaceTypes.ts").CliAgentSurfaceOptionMapping} CliAgentSurfaceOptionMapping */
/** @typedef {import("./cli-surface/CliAgentSurfaceTypes.ts").CliAgentSurfaceResumeContract} CliAgentSurfaceResumeContract */
/** @typedef {import("./cli-surface/CliAgentSurfaceTypes.ts").CliAgentUnsupportedFlag} CliAgentUnsupportedFlag */
/** @typedef {import("./image-generation/ImageGenerationProvider.ts").ImageGenerationProvider} ImageGenerationProvider */
/** @typedef {import("./image-generation/ImageGenerationRequest.ts").ImageGenerationRequest} ImageGenerationRequest */
/** @typedef {import("./image-generation/ImageGenerationResult.ts").ImageGenerationResult} ImageGenerationResult */
/** @typedef {import("./image-generation/ImageGenerationToolOptions.ts").ImageGenerationToolOptions} ImageGenerationToolOptions */
/** @typedef {import("./http/CreateHttpToolOptions.ts").CreateHttpToolOptions} CreateHttpToolOptions */
/** @typedef {import("./http/HttpToolAuth.ts").HttpToolAuth} HttpToolAuth */
/** @typedef {import("./http/HttpToolInput.ts").HttpToolInput} HttpToolInput */
/** @typedef {import("./http/HttpToolOutput.ts").HttpToolOutput} HttpToolOutput */
// @smithers-type-exports-end

export { BaseCliAgent } from "./BaseCliAgent/index.js";
export { hashCapabilityRegistry } from "./capability-registry/index.js";
export { AnthropicAgent } from "./AnthropicAgent.js";
export { OpenAIAgent } from "./OpenAIAgent.js";
export { HermesAgent } from "./HermesAgent.js";
export { AmpAgent } from "./AmpAgent.js";
export { createAmpCapabilityRegistry } from "./AmpAgent.js";
export { AntigravityAgent, createAntigravityCapabilityRegistry } from "./AntigravityAgent.js";
export { ClaudeCodeAgent } from "./ClaudeCodeAgent.js";
export { CodexAgent } from "./CodexAgent.js";
export { GeminiAgent } from "./GeminiAgent.js";
export { PiAgent } from "./PiAgent.js";
export { KimiAgent } from "./KimiAgent.js";
export { ForgeAgent } from "./ForgeAgent.js";
export { createForgeCapabilityRegistry } from "./ForgeAgent.js";
export { OpenCodeAgent } from "./OpenCodeAgent.js";
export { VibeAgent, createVibeCapabilityRegistry } from "./VibeAgent.js";
export {
  getCliAgentCapabilityReport,
  getCliAgentCapabilityDoctorReport,
  formatCliAgentCapabilityDoctorReport,
  CLI_AGENT_SURFACE_MANIFEST,
  getCliAgentSurfaceManifestEntry,
  listCliAgentSurfaceManifests,
} from "./cli-capabilities/index.js";
export { createSmithersAgentContract } from "./agent-contract/createSmithersAgentContract.js";
export { renderSmithersAgentPromptGuidance } from "./agent-contract/renderSmithersAgentPromptGuidance.js";
export { createImageGenerationTool } from "./image-generation/createImageGenerationTool.js";
export { createHttpTool } from "./http/createHttpTool.js";
export { zodToOpenAISchema } from "./zodToOpenAISchema.js";
export { sanitizeForOpenAI } from "./sanitizeForOpenAI.js";
export { createTranscriptionTool } from "./transcription/createTranscriptionTool.js";
export {
  createGroundedWebSearchToolset,
  createExaSearchProvider,
  createTavilySearchProvider,
  createBraveSearchProvider,
  createSerperSearchProvider,
} from "./web-search/index.js";

export { createElevenLabsTextToSpeechTool } from "./createElevenLabsTextToSpeechTool.js";
