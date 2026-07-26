import { assertMaxBytes, assertMaxStringLength } from "@smithers-orchestrator/db/input-bounds";
import { CLI_JSON_ARGUMENT_MAX_BYTES } from "./json-args.js";

export const CLI_ARGUMENT_MAX_LENGTH = 4096;
export const CLI_IDENTIFIER_MAX_LENGTH = 256;
export const CLI_TEXT_ARGUMENT_MAX_LENGTH = 64 * 1024;

const CLI_HANDLER_BOUNDS_WRAPPED = Symbol("smithers.cliHandlerBoundsWrapped");

/**
 * @param {string} path
 * @param {string} value
 */
export function validateCliStringArgument(path, value) {
  // Strip array indices, keep the last dotted segment as the field name.
  const trimmed = path.replace(/\[\d+\]/g, "");
  const lastDot = trimmed.lastIndexOf(".");
  const field = lastDot >= 0 ? trimmed.slice(lastDot + 1) : trimmed;
  switch (field) {
    case "runId":
    case "requestId":
    case "correlation":
    case "correlationId":
    case "name":
      assertMaxStringLength(path, value, CLI_IDENTIFIER_MAX_LENGTH);
      return;
    case "workflow":
    case "root":
    case "logDir":
      assertMaxStringLength(path, value, CLI_ARGUMENT_MAX_LENGTH);
      return;
    case "input":
    case "data":
    case "value":
      assertMaxBytes(path, value, CLI_JSON_ARGUMENT_MAX_BYTES);
      return;
    case "prompt":
    case "note":
    case "authToken":
      assertMaxStringLength(path, value, CLI_TEXT_ARGUMENT_MAX_LENGTH);
      return;
    default:
      assertMaxStringLength(path, value, CLI_ARGUMENT_MAX_LENGTH);
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 */
export function assertCliArgumentBounds(value, path) {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    validateCliStringArgument(path, value);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertCliArgumentBounds(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    assertCliArgumentBounds(entry, `${path}.${key}`);
  }
}

/**
 * @param {Map<string, any>} commands
 */
export function wrapCliCommandHandlersWithInputBounds(commands) {
  for (const entry of commands.values()) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if ("_group" in entry) {
      wrapCliCommandHandlersWithInputBounds(entry.commands);
      continue;
    }
    if ("_fetch" in entry) {
      continue;
    }
    if (entry[CLI_HANDLER_BOUNDS_WRAPPED]) {
      continue;
    }
    const originalRun = entry.run;
    if (typeof originalRun !== "function") {
      continue;
    }
    entry.run = function wrappedRun(context) {
      assertCliArgumentBounds(context.args, "args");
      assertCliArgumentBounds(context.options, "options");
      return originalRun.call(this, context);
    };
    entry[CLI_HANDLER_BOUNDS_WRAPPED] = true;
  }
}
