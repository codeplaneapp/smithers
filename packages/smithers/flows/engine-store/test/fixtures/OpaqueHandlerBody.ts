import { Node } from "@smthrs/plan"

/**
 * Marks a test flow whose behavior is supplied directly at the runtime
 * registration seam. Interpreting this body is always a fixture error.
 */
export const opaqueHandlerBody = (): Node.Node<never> => {
  throw new Error("opaque-handler fixture bodies must not be interpreted")
}
