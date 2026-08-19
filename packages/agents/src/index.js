// @smithers-type-exports-begin
/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/AgentGenerateOptions.ts").AgentGenerateOptions} AgentGenerateOptions */
/** @typedef {import("./AgentLike.ts").AgentLike} AgentLike */
/** @typedef {import("./GenerateResult.ts").GenerateTextResult} GenerateTextResult */
/** @typedef {import("./Tool.ts").Tool} Tool */
/** @typedef {import("./Tool.ts").ToolSet} ToolSet */
/** @typedef {import("./AgentCheckpoint.ts").AgentCheckpoint} AgentCheckpoint */
/** @typedef {import("./AgentCheckpoint.ts").AgentCheckpointCapability} AgentCheckpointCapability */
/** @typedef {import("./AgentCheckpoint.ts").AgentCheckpointFormat} AgentCheckpointFormat */
/** @typedef {import("./AgentCheckpoint.ts").AgentCheckpointJsonArray} AgentCheckpointJsonArray */
/** @typedef {import("./AgentCheckpoint.ts").AgentCheckpointJsonObject} AgentCheckpointJsonObject */
/** @typedef {import("./AgentCheckpoint.ts").AgentCheckpointJsonPrimitive} AgentCheckpointJsonPrimitive */
/** @typedef {import("./AgentCheckpoint.ts").AgentCheckpointJsonValue} AgentCheckpointJsonValue */
/** @typedef {import("./AgentCheckpoint.ts").AgentCheckpointMode} AgentCheckpointMode */
/** @typedef {import("./AgentCheckpoint.ts").AgentCheckpointPublisher} AgentCheckpointPublisher */
/** @typedef {import("./AgentCheckpoint.ts").AgentCheckpointResult} AgentCheckpointResult */
/** @typedef {import("./BaseCliAgent/AgentGenerateOptions.ts").AgentCheckpointContinuationOptions} AgentCheckpointContinuationOptions */
/** @typedef {import("./capability-registry/AgentToolDescriptor.ts").AgentToolDescriptor} AgentToolDescriptor */
/**
 * @template [CALL_OPTIONS=never]
 * @template [TOOLS=import("./Tool.ts").ToolSet]
 * @typedef {import("./AnthropicAgentOptions.ts").AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} AnthropicAgentOptions
 */
/**
 * @template [CALL_OPTIONS=never]
 * @template [TOOLS=import("./Tool.ts").ToolSet]
 * @typedef {import("./OpenAIAgentOptions.ts").OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} OpenAIAgentOptions
 */
/**
 * @template [CALL_OPTIONS=never]
 * @template [TOOLS=import("./Tool.ts").ToolSet]
 * @typedef {import("./HermesAgentOptions.ts").HermesAgentOptions<CALL_OPTIONS, TOOLS>} HermesAgentOptions
 */
/** @typedef {import("./HermesCliAgentOptions.ts").HermesCliAgentOptions} HermesCliAgentOptions */
/** @typedef {import("./GrokAgentOptions.ts").GrokAgentOptions} GrokAgentOptions */
/** @typedef {import("./OpenClawAgentOptions.ts").OpenClawAgentOptions} OpenClawAgentOptions */
/** @typedef {import("./PiAgentOptions.ts").PiAgentOptions} PiAgentOptions */
/** @typedef {import("./CursorAgentOptions.ts").CursorAgentOptions} CursorAgentOptions */
/** @typedef {import("./BaseCliAgent/PiExtensionUiRequest.ts").PiExtensionUiRequest} PiExtensionUiRequest */
/** @typedef {import("./BaseCliAgent/PiExtensionUiResponse.ts").PiExtensionUiResponse} PiExtensionUiResponse */
/** @typedef {import("./OpenCodeAgentOptions.ts").OpenCodeAgentOptions} OpenCodeAgentOptions */
/** @typedef {import("./PoolAgentOptions.ts").PoolAgentOptions} PoolAgentOptions */
/** @typedef {import("./VibeAgentOptions.ts").VibeAgentOptions} VibeAgentOptions */
/** @typedef {import("./FallbackAgentsOptions.ts").FallbackAgentsOptions} FallbackAgentsOptions */
/** @typedef {import("./FallbackAgentsOptions.ts").FallbackAgentProvider} FallbackAgentProvider */
/** @typedef {import("./NanocodexAgentOptions.ts").NanocodexAgentOptions} NanocodexAgentOptions */
/** @typedef {import("./NanocodexAgentOptions.ts").NanocodexGenerateOptions} NanocodexGenerateOptions */
/** @typedef {import("./NanocodexAgentOptions.ts").NanocodexAuth} NanocodexAuth */
/** @typedef {import("./NanocodexAgentOptions.ts").NanocodexThinking} NanocodexThinking */
/** @typedef {import("./NanocodexAgentOptions.ts").NanocodexReasoningMode} NanocodexReasoningMode */
/** @typedef {import("./agent-contract/SmithersAgentContract.ts").SmithersAgentContract} SmithersAgentContract */
/** @typedef {import("./agent-contract/SmithersAgentContractTool.ts").SmithersAgentContractTool} SmithersAgentContractTool */
/** @typedef {import("./agent-contract/SmithersAgentToolCategory.ts").SmithersAgentToolCategory} SmithersAgentToolCategory */
/** @typedef {import("./agent-contract/SmithersListedTool.ts").SmithersListedTool} SmithersListedTool */
/** @typedef {import("./agent-contract/SmithersToolSurface.ts").SmithersToolSurface} SmithersToolSurface */
/** @typedef {import("./agent-contract/AgentFileChange.ts").AgentFileChangeKind} AgentFileChangeKind */
/** @typedef {import("./agent-contract/AgentFileChange.ts").AgentFileChange} AgentFileChange */
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
/** @typedef {import("./transcription/createTranscriptionTool.ts").AudioHostResolver} AudioHostResolver */
/** @typedef {import("./transcription/createTranscriptionTool.ts").CreateTranscriptionToolOptions} CreateTranscriptionToolOptions */
/** @typedef {import("./transcription/createTranscriptionTool.ts").PinnedAudioTransport} PinnedAudioTransport */
/** @typedef {import("./transcription/createTranscriptionTool.ts").PinnedAudioTransportRequest} PinnedAudioTransportRequest */
/** @typedef {import("./transcription/createTranscriptionTool.ts").ResolvedAudioAddress} ResolvedAudioAddress */
/** @typedef {import("./transcription/createTranscriptionTool.ts").TranscriptionProvider} TranscriptionProvider */
/** @typedef {import("./transcription/createTranscriptionTool.ts").TranscriptionToolInput} TranscriptionToolInput */
/** @typedef {import("./transcription/createTranscriptionTool.ts").TranscriptionToolResult} TranscriptionToolResult */
// @smithers-type-exports-end

export { BaseCliAgent } from "./BaseCliAgent/index.js";
export {
  DEFAULT_AGENT_CHECKPOINT_MAX_BYTES,
  agentProducesCheckpoint,
  agentSupportsCheckpoint,
  cloneAgentCheckpoint,
  hashAgentCheckpointCapabilities,
} from "./agent-checkpoint.js";
export { hashCapabilityRegistry } from "./capability-registry/index.js";
export { AnthropicAgent } from "./AnthropicAgent.js";
export { OpenAIAgent } from "./OpenAIAgent.js";
export { ModelAgent } from "./ModelAgent.js";
export { dynamicTool, jsonSchema, tool, zodSchema } from "./runtime-tool.js";
export { HermesAgent } from "./HermesAgent.js";
export { HermesCliAgent, createHermesCliCapabilityRegistry } from "./HermesCliAgent.js";
export { OpenClawAgent, createOpenClawCapabilityRegistry } from "./OpenClawAgent.js";
export { PoolAgent, createPoolCapabilityRegistry } from "./PoolAgent.js";
export { AmpAgent } from "./AmpAgent.js";
export { AntigravityAgent } from "./AntigravityAgent.js";
export { ClaudeCodeAgent } from "./ClaudeCodeAgent.js";
export { CodexAgent } from "./CodexAgent.js";
export { CursorAgent } from "./CursorAgent.js";
export { GeminiAgent } from "./GeminiAgent.js";
export { PiAgent } from "./PiAgent.js";
export { OmpAgent, createOmpCapabilityRegistry } from "./OmpAgent.js";
export { KimiAgent } from "./KimiAgent.js";
export { GrokAgent, createGrokCapabilityRegistry } from "./GrokAgent.js";
export { ForgeAgent } from "./ForgeAgent.js";
export { OpenCodeAgent } from "./OpenCodeAgent.js";
export { VibeAgent } from "./VibeAgent.js";
export { fallbackAgents } from "./fallbackAgents.js";
export { NanocodexAgent } from "./NanocodexAgent.js";
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
