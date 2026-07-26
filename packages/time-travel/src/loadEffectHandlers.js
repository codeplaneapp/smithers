import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { getTableName } from "drizzle-orm";
import { loadInput, loadOutputs } from "@smithers-orchestrator/db/snapshot";
import { SmithersCtx } from "@smithers-orchestrator/driver/SmithersCtx";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler";
import { validateWorkflowIdentity } from "./validateWorkflowIdentity.js";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./EffectHandlerRegistry.ts").EffectHandlerRegistry} EffectHandlerRegistry */

/**
 * @param {unknown} db
 * @returns {Record<string, unknown>}
 */
function resolveSchema(db) {
  const candidates = [db?._?.fullSchema, db?._?.schema, db?.schema];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    /** @type {Record<string, unknown>} */
    const schema = {};
    for (const [key, table] of Object.entries(candidate)) {
      if (key.startsWith("_smithers") || !table || typeof table !== "object") continue;
      try {
        if (!getTableName(table).startsWith("_smithers")) schema[key] = table;
      } catch {
        // Non-table schema metadata is ignored.
      }
    }
    if (Object.keys(schema).length > 0) return schema;
  }
  return {};
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function definedToolMetadata(value) {
  if (!value || typeof value !== "object") return null;
  return value[Symbol.for("smithers.tool.metadata")] ?? null;
}

/**
 * @param {Map<string, Record<string, unknown>>} toolMetadata
 * @param {Map<string, Record<string, unknown>>} tools
 * @param {string} registeredName
 * @param {unknown} tool
 * @returns {boolean}
 */
function registerDefinedTool(toolMetadata, tools, registeredName, tool) {
  const metadata = definedToolMetadata(tool);
  if (!metadata || typeof metadata.name !== "string") return false;
  const handler = {
    name: metadata.name,
    sideEffect: metadata.sideEffect === true,
    idempotent: metadata.idempotent === true,
    hasRevert: metadata.hasRevert === true,
    ...(typeof metadata.revert === "function" ? { revert: metadata.revert } : {}),
  };
  toolMetadata.set(registeredName, handler);
  toolMetadata.set(metadata.name, handler);
  tools.set(registeredName, handler);
  tools.set(metadata.name, handler);
  return true;
}

/**
 * Walk exported tool registries without evaluating compute callbacks. A
 * compute task's closed-over tool is only enumerable when the workflow module
 * exports the tool itself or a registry containing it.
 *
 * @param {unknown} value
 * @param {string} registeredName
 * @param {Set<unknown>} seen
 * @param {(registeredName: string, tool: unknown) => boolean} register
 */
function collectDefinedTools(value, registeredName, seen, register) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (register(registeredName, value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return;
  for (const [name, nested] of Object.entries(value)) {
    collectDefinedTools(nested, name, seen, register);
  }
}

/**
 * Load the workflow entry recorded on the run and render its graph without
 * executing tasks. The resulting registry is the only source used to resolve
 * author-written compensation handlers.
 *
 * @param {SmithersDb} db
 * @param {string} runId
 * @returns {Promise<EffectHandlerRegistry>}
 */
export async function loadEffectHandlers(db, runId) {
  const run = await db.getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (typeof run.workflowPath !== "string" || run.workflowPath.length === 0) {
    throw new Error(`Run ${runId} has no recorded workflow entry file.`);
  }
  if (!(await validateWorkflowIdentity(run))) {
    throw new Error("workflow changed since the effect was recorded");
  }
  const module = await import(pathToFileURL(run.workflowPath).href);
  const workflow = module.default;
  if (!workflow || typeof workflow !== "object" || typeof workflow.build !== "function") {
    throw new Error(`Workflow entry ${run.workflowPath} has no built default export.`);
  }
  const schema = resolveSchema(workflow.db);
  const inputTable = schema.input;
  const [input, outputs, nodes, signals] = await Promise.all([
    inputTable ? loadInput(workflow.db, inputTable, runId) : Promise.resolve({}),
    loadOutputs(workflow.db, schema, runId),
    db.listNodes(runId),
    db.listSignals(runId, { limit: 10_000 }),
  ]);
  const iterations = new Map();
  const taskStates = new Map();
  for (const node of nodes) {
    const iteration = Number(node.iteration ?? 0);
    iterations.set(String(node.nodeId), Math.max(iterations.get(String(node.nodeId)) ?? 0, iteration));
    taskStates.set(`${node.nodeId}::${iteration}`, node.state);
  }
  const context = new SmithersCtx({
    runId,
    iteration: 0,
    iterations,
    input: input ?? {},
    outputs,
    signals,
    taskStates,
    zodToKeyName: workflow.zodToKeyName,
  });
  const renderer = new SmithersRenderer();
  const graph = await renderer.render(workflow.build(context), {
    workflowPath: run.workflowPath,
    baseRootDir: run.vcsRoot ?? dirname(run.workflowPath),
    defaultIteration: 0,
  });
  const toolMetadata = new Map();
  const tools = new Map();
  const tasks = new Map();
  const register = (registeredName, tool) => registerDefinedTool(toolMetadata, tools, registeredName, tool);
  const seenExports = new Set();
  for (const [exportName, exported] of Object.entries(module)) {
    if (exportName === "default") continue;
    collectDefinedTools(exported, exportName, seenExports, register);
  }
  if (workflow.tools && typeof workflow.tools === "object") {
    collectDefinedTools(workflow.tools, "tools", seenExports, register);
  }
  for (const task of graph.tasks) {
    if (task.sideEffect) {
      tasks.set(task.nodeId, {
        ...(typeof task.sideEffect.revert === "function" ? { revert: task.sideEffect.revert } : {}),
      });
    }
    const taskTools = task.tools && typeof task.tools === "object" ? Object.entries(task.tools) : [];
    for (const [registeredName, tool] of taskTools) {
      register(registeredName, tool);
    }
    const agents = Array.isArray(task.agent) ? task.agent : task.agent ? [task.agent] : [];
    for (const agent of agents) {
      const entries =
        agent && typeof agent === "object" && agent.tools && typeof agent.tools === "object"
          ? Object.entries(agent.tools)
          : [];
      for (const [registeredName, tool] of entries) {
        register(registeredName, tool);
      }
    }
  }
  return { toolMetadata, tools, tasks };
}
