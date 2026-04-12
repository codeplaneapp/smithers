import { WorkflowDriver, } from "@smithers/driver";
import { SmithersRenderer } from "./reconciler.js";
/** @typedef {import("./driver.ts").driver} driver */

/** @typedef {import("@smithers/driver").WorkflowDriverOptions} WorkflowDriverOptions */

export class ReactWorkflowDriver extends WorkflowDriver {
    /**
   * @param {WorkflowDriverOptions<Schema>} options
   */
    constructor(options) {
        const renderer = options.renderer ?? new SmithersRenderer();
        super({
            ...options,
            renderer,
        });
    }
}
