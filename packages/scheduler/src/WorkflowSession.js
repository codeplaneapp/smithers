import { Context } from "effect";
/** @typedef {import("./WorkflowSessionService.ts").WorkflowSessionService} WorkflowSessionService */

const WorkflowSessionBase =
  /** @type {Context.ServiceClass<WorkflowSession, "WorkflowSession", WorkflowSessionService>} */ (
    /** @type {unknown} */ (Context.Service("WorkflowSession"))
  );

export class WorkflowSession extends WorkflowSessionBase {}
