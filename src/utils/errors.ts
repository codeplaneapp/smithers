import {
  ERROR_REFERENCE_URL as CORE_ERROR_REFERENCE_URL,
  SmithersError,
  fromTaggedError,
  smithersErrorDefinitions as coreSmithersErrorDefinitions,
} from "@smithers/core/errors";
import type {
  ErrorWrapOptions,
  SmithersErrorCategory as CoreSmithersErrorCategory,
  SmithersErrorDefinition as CoreSmithersErrorDefinition,
} from "@smithers/core/errors";

export {
  EngineError,
  SmithersError,
  fromTaggedError,
  toSmithersError,
} from "@smithers/core/errors";
export type {
  EngineErrorCode,
  ErrorWrapOptions,
  SmithersErrorOptions,
} from "@smithers/core/errors";

export const ERROR_REFERENCE_URL = CORE_ERROR_REFERENCE_URL;

export type SmithersErrorCategory = CoreSmithersErrorCategory;
export type SmithersErrorDefinition = CoreSmithersErrorDefinition;

const legacyKnownSmithersErrorCodes = [
  "INVALID_INPUT",
  "MISSING_INPUT",
  "MISSING_INPUT_TABLE",
  "RESUME_METADATA_MISMATCH",
  "UNKNOWN_OUTPUT_SCHEMA",
  "INVALID_OUTPUT",
  "WORKTREE_CREATE_FAILED",
  "VCS_NOT_FOUND",
  "SNAPSHOT_NOT_FOUND",
  "VCS_WORKSPACE_CREATE_FAILED",
  "TASK_TIMEOUT",
  "RUN_NOT_FOUND",
  "NODE_NOT_FOUND",
  "INVALID_EVENTS_OPTIONS",
  "SANDBOX_BUNDLE_INVALID",
  "SANDBOX_BUNDLE_TOO_LARGE",
  "WORKFLOW_EXECUTION_FAILED",
  "SANDBOX_EXECUTION_FAILED",
  "TASK_HEARTBEAT_TIMEOUT",
  "HEARTBEAT_PAYLOAD_TOO_LARGE",
  "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
  "TASK_ABORTED",
  "TASK_ID_REQUIRED",
  "TASK_MISSING_OUTPUT",
  "DUPLICATE_ID",
  "NESTED_LOOP",
  "WORKTREE_EMPTY_PATH",
  "MDX_PRELOAD_INACTIVE",
  "CONTEXT_OUTSIDE_WORKFLOW",
  "MISSING_OUTPUT",
  "DEP_NOT_SATISFIED",
  "ASPECT_BUDGET_EXCEEDED",
  "APPROVAL_OUTSIDE_TASK",
  "WORKFLOW_MISSING_DEFAULT",
  "TOOL_PATH_INVALID",
  "TOOL_PATH_ESCAPE",
  "TOOL_FILE_TOO_LARGE",
  "TOOL_CONTENT_TOO_LARGE",
  "TOOL_PATCH_TOO_LARGE",
  "TOOL_PATCH_FAILED",
  "TOOL_NETWORK_DISABLED",
  "TOOL_GIT_REMOTE_DISABLED",
  "TOOL_COMMAND_FAILED",
  "TOOL_GREP_FAILED",
  "AGENT_CLI_ERROR",
  "AGENT_RPC_FILE_ARGS",
  "AGENT_BUILD_COMMAND",
  "AGENT_DIAGNOSTIC_TIMEOUT",
  "DB_MISSING_COLUMNS",
  "DB_REQUIRES_BUN_SQLITE",
  "DB_QUERY_FAILED",
  "DB_WRITE_FAILED",
  "INTERNAL_ERROR",
  "PROCESS_ABORTED",
  "PROCESS_TIMEOUT",
  "PROCESS_IDLE_TIMEOUT",
  "PROCESS_SPAWN_FAILED",
  "TASK_RUNTIME_UNAVAILABLE",
  "SCHEMA_CHANGE_HOT",
  "HOT_OVERLAY_FAILED",
  "HOT_RELOAD_INVALID_MODULE",
  "SCORER_FAILED",
  "WORKFLOW_EXISTS",
  "CLI_DB_NOT_FOUND",
  "CLI_AGENT_UNSUPPORTED",
  "PI_HTTP_ERROR",
  "EXTERNAL_BUILD_FAILED",
  "SCHEMA_DISCOVERY_FAILED",
  "OPENAPI_SPEC_LOAD_FAILED",
  "OPENAPI_OPERATION_NOT_FOUND",
  "OPENAPI_TOOL_EXECUTION_FAILED",
] as const satisfies readonly (keyof typeof coreSmithersErrorDefinitions)[];

export type KnownSmithersErrorCode =
  (typeof legacyKnownSmithersErrorCodes)[number];
export type SmithersErrorCode = KnownSmithersErrorCode | (string & {});

export const smithersErrorDefinitions = Object.fromEntries(
  legacyKnownSmithersErrorCodes.map((code) => [
    code,
    coreSmithersErrorDefinitions[code],
  ]),
) as {
  readonly [Code in KnownSmithersErrorCode]: SmithersErrorDefinition;
};

export const knownSmithersErrorCodes = [
  ...legacyKnownSmithersErrorCodes,
] as KnownSmithersErrorCode[];

export function isKnownSmithersErrorCode(
  code: string,
): code is KnownSmithersErrorCode {
  return code in smithersErrorDefinitions;
}

export function getSmithersErrorDefinition(
  code: SmithersErrorCode,
): SmithersErrorDefinition | undefined {
  if (!isKnownSmithersErrorCode(code)) return undefined;
  return smithersErrorDefinitions[code];
}

export function getSmithersErrorDocsUrl(_code: SmithersErrorCode): string {
  return ERROR_REFERENCE_URL;
}

export type SmithersErrorWrapOptions = ErrorWrapOptions;

export function isSmithersError(err: unknown): err is SmithersError {
  return Boolean(err && typeof err === "object" && (err as any).code);
}

export type SerializedError = Record<string, unknown> & {
  name?: string;
  message?: string;
  stack?: string;
  cause?: unknown;
  code?: unknown;
  details?: unknown;
  summary?: unknown;
  docsUrl?: unknown;
};

export function errorToJson(err: unknown): SerializedError {
  const taggedError = fromTaggedError(err);
  if (taggedError) {
    return errorToJson(taggedError);
  }

  if (err instanceof Error) {
    const anyErr = err as any;
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: anyErr?.cause,
      code: anyErr?.code,
      details: anyErr?.details,
      summary: anyErr?.summary,
      docsUrl: anyErr?.docsUrl,
    };
  }
  if (err && typeof err === "object") {
    return err as SerializedError;
  }
  return { message: String(err) };
}
