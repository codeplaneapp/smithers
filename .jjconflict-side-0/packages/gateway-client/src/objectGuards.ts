// Shared object guards for the gateway-client. Previously copy-pasted across
// SmithersGatewayClient, SmithersGatewayConnection, and snapshotToGatewayRunNode.
import type { GatewayResponseFrame } from "./GatewayResponseFrame.ts";

/** Narrow an unknown value to a plain (non-array, non-null) object. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow an unknown value to a well-formed Gateway response frame. */
export function isGatewayResponseFrame(value: unknown): value is GatewayResponseFrame {
  if (!isObject(value)) {
    return false;
  }
  if (value.type !== "res" || typeof value.id !== "string" || typeof value.ok !== "boolean") {
    return false;
  }
  if (value.ok === true) {
    return "payload" in value;
  }
  return isObject(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string";
}

/** Coerce an unknown value to a record, returning {} when it is not a plain object. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}
