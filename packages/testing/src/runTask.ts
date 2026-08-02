import type { TaskDescriptor } from "@smthrs/graph";

export type RunTaskOptions = {
  rootDir?: string;
  attempt?: number;
  runId?: string;
};

export async function runTask(task: TaskDescriptor, options: RunTaskOptions = {}): Promise<unknown> {
  if (task.kind === "static" || task.staticPayload !== undefined) {
    return validateOutput(task, task.staticPayload);
  }
  if (task.kind === "compute" || task.computeFn) {
    if (!task.computeFn) {
      throw new TypeError(`Task ${task.nodeId} is marked compute but has no compute function`);
    }
    return validateOutput(task, await task.computeFn());
  }
  const agent = Array.isArray(task.agent)
    ? task.agent[Math.min((options.attempt ?? 1) - 1, task.agent.length - 1)]
    : task.agent;
  if (!agent?.generate) {
    throw new TypeError(`Task ${task.nodeId} has no runnable agent, compute function, or static payload`);
  }
  const result = await agent.generate({
    prompt: task.prompt,
    outputSchema: task.outputSchema,
    rootDir: options.rootDir,
    taskContext: {
      runId: options.runId,
      nodeId: task.nodeId,
      iteration: task.iteration,
      attempt: options.attempt ?? 1,
    },
  });
  if (result && typeof result === "object" && "output" in result) {
    return validateOutput(task, (result as { output?: unknown }).output);
  }
  if (task.outputSchema) return validateOutput(task, result);
  return result;
}

function validateOutput(task: TaskDescriptor, value: unknown): unknown {
  if (!task.outputSchema) return value;
  const parsed = task.outputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const message = parsed.error.issues.map((issue) => issue.message).join("; ");
  throw new TypeError(`Task ${task.nodeId} output failed validation: ${message}`);
}
