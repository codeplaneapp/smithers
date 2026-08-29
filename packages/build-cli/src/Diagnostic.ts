/**
 * Side-effect-free rendering of values that cross a failure boundary.
 *
 * A rejected promise may carry any JavaScript value. Calling `String` on an
 * object, reading an accessor-backed `message`, or inspecting a Proxy can run
 * arbitrary user code while the original failure is being reported. These
 * helpers accept only primitives and own data properties, bound the resulting
 * text, and otherwise use a caller-owned fallback.
 *
 * @since 0.1.0
 */
import * as NodeUtil from "node:util/types"

/**
 * Maximum UTF-16 code units admitted into one rendered failure.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maximumMessageCodeUnits = 64 * 1024

const bounded = (message: string, fallback: string): string => {
  const wellFormed = message.isWellFormed() ? message : message.toWellFormed()
  if (wellFormed === "") return fallback
  return wellFormed.length <= maximumMessageCodeUnits
    ? wellFormed
    : `${wellFormed.slice(0, maximumMessageCodeUnits - 3)}...`
}

/**
 * Renders a rejected value without invoking object-owned behavior.
 *
 * @category rendering
 * @since 0.1.0
 * @slop
 */
export const message = (cause: unknown, fallback = "operation failed"): string => {
  if (typeof cause === "string") return bounded(cause, fallback)
  if (
    typeof cause === "number" ||
    typeof cause === "bigint" ||
    typeof cause === "boolean" ||
    typeof cause === "symbol"
  ) return bounded(String(cause), fallback)
  if ((typeof cause !== "object" && typeof cause !== "function") || cause === null || NodeUtil.isProxy(cause)) {
    return fallback
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cause, "message")
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? bounded(descriptor.value, fallback)
      : fallback
  } catch {
    return fallback
  }
}

/**
 * Converts an arbitrary rejection into an Error whose message is safe to read.
 * Standard Errors with a bounded own data message retain their original stack.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const error = (cause: unknown, fallback = "operation failed"): Error => {
  if (typeof cause === "object" && cause !== null && !NodeUtil.isProxy(cause)) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(cause, "message")
      if (
        NodeUtil.isNativeError(cause) &&
        descriptor !== undefined &&
        "value" in descriptor &&
        typeof descriptor.value === "string" &&
        descriptor.value !== "" &&
        descriptor.value.isWellFormed() &&
        descriptor.value.length <= maximumMessageCodeUnits
      ) return cause
    } catch {
      // Wrap below with the caller-owned fallback.
    }
  }
  return new Error(message(cause, fallback), { cause })
}
