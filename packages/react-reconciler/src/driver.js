import { WorkflowDriver } from "@smthrs/driver";
import { SmithersRenderer } from "./reconciler.js";

/**
 * @template [Schema=unknown]
 * @extends {WorkflowDriver<Schema>}
 */
export class ReactWorkflowDriver extends WorkflowDriver {
  /**
   * @param {import("@smthrs/driver").WorkflowDriverOptions<Schema>} options
   */
  constructor(options) {
    const renderer = options.renderer ?? new SmithersRenderer();
    super({
      ...options,
      renderer,
    });
  }
}
