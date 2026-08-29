import { Flow } from "@smthrs/flow"
import * as Schema from "effect/Schema"
import { opaqueHandlerBody } from "./OpaqueHandlerBody.ts"

/**
 * The flow a killed process was running when it died.
 *
 * Declared in its own module because two processes need the same declaration:
 * the child fixture that claims the run, and the case that reclaims it. The
 * fixture is a process entrypoint, so importing the declaration from there
 * would start a second engine inside the test worker.
 */
export const ReclaimFlow = Flow.make("LeaseReclaim/HardKill", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})
