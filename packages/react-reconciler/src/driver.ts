import { WorkflowDriver, type WorkflowDriverOptions } from "@smithers/driver";
export declare class ReactWorkflowDriver<Schema = unknown> extends WorkflowDriver<Schema> {
    constructor(options: WorkflowDriverOptions<Schema>);
}
