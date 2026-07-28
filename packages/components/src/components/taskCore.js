// @smithers-type-exports-begin
/**
 * @template D
 * @typedef {import("./InferDeps.ts").InferDeps<D>} InferDeps
 */
/** @typedef {import("./OutputTarget.ts").OutputTarget} OutputTarget */
// @smithers-type-exports-end

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { decodeHtmlEntities } from "../decodeHtmlEntities.js";
import { markdownComponents } from "../markdownComponents.js";
import { zodSchemaToJsonExample } from "../zod-to-example.js";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { AspectContext } from "../aspects/AspectContext.js";
import { MemoryContext } from "../memory/MemoryContext.js";
/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./DepsSpec.ts").DepsSpec} DepsSpec */
/**
 * @template Row, Output, D
 * @typedef {import("./TaskProps.ts").TaskProps<Row, Output, D>} TaskProps
 */

/**
 * Shared core behind both Task variants:
 *  - `Task.js` (Node): CLI-tool-allowlist enforcement rewrites CLI agent
 *    instances (ClaudeCodeAgent/PiAgent/GeminiAgent/AntigravityAgent), which
 *    requires statically importing those Node-only (`node:child_process`)
 *    classes.
 *  - `Task.browser.js` (browser): everything else — deps resolution,
 *    agent-chain building, MDX prompt rendering via `renderToStaticMarkup`
 *    (browser-safe), static/compute branching — is identical, so it lives
 *    here and is parameterized over `applyCliToolAllowlist` instead of
 *    duplicating this ~150 lines of logic and risking the two variants
 *    drifting apart.
 *
 * This module itself imports nothing Node-only, so importing it does not
 * pull `node:child_process` into a browser bundle; only `cliToolAllowlist.js`
 * (imported by `Task.js`, not by `Task.browser.js`) does that.
 */

/**
 * Render a prompt React node to plain markdown text.
 *
 * If the prompt is a React element (e.g. a compiled MDX component), we inject
 * `markdownComponents` via the standard MDX `components` prop so that
 * renderToStaticMarkup outputs clean markdown instead of HTML. The static
 * render entity-escapes all text, so we decode the entities back to literal
 * characters before handing the prompt to the agent.
 * @param {unknown} prompt
 * @returns {string}
 */
export function renderPromptToText(prompt) {
  if (prompt == null) return "";
  if (typeof prompt === "string") return prompt;
  if (typeof prompt === "number") return String(prompt);
  try {
    let element;
    if (React.isValidElement(prompt)) {
      // Inject markdown components into the element so MDX components
      // render fragments instead of HTML tags.
      element = React.cloneElement(prompt, {
        components: markdownComponents,
      });
    } else {
      element = React.createElement(React.Fragment, null, prompt);
    }
    return decodeHtmlEntities(renderToStaticMarkup(element))
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch (err) {
    const result = String(prompt ?? "");
    if (result === "[object Object]") {
      throw new SmithersError(
        "MDX_PRELOAD_INACTIVE",
        `MDX prompt could not be rendered — the prompt resolved to [object Object] instead of a React component.\n\n` +
          `This usually means the MDX preload is not active. Common causes:\n` +
          `  • bunfig.toml uses [run] preload instead of top-level preload (the [run] section doesn't apply to dynamic imports)\n` +
          `  • bunfig.toml is not in the current working directory\n` +
          `  • mdxPlugin() is not registered in the preload script\n` +
          `  • The MDX file is imported without a default import (use: import MyPrompt from "./prompt.mdx")\n\n` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return result;
  }
}
/**
 * @param {unknown} value
 * @returns {value is import("zod").ZodObject<import("zod").ZodRawShape>}
 */
function isZodObject(value) {
  return Boolean(value && typeof value === "object" && "shape" in value);
}
/**
 * @param {DepsSpec | undefined} deps
 * @param {Record<string, string> | undefined} needs
 * @returns {string[] | undefined}
 */
function deriveDepNodeIds(deps, needs) {
  if (!deps) return undefined;
  const ids = new Set();
  for (const key of Object.keys(deps)) {
    const nodeId = needs?.[key] ?? key;
    if (nodeId) ids.add(nodeId);
  }
  return ids.size > 0 ? [...ids] : undefined;
}
/**
 * @param {string[] | undefined} dependsOn
 * @param {string[] | undefined} depNodeIds
 * @returns {string[] | undefined}
 */
function mergeDependsOn(dependsOn, depNodeIds) {
  const merged = new Set();
  for (const id of dependsOn ?? []) merged.add(id);
  for (const id of depNodeIds ?? []) merged.add(id);
  return merged.size > 0 ? [...merged] : undefined;
}
/**
 * @param {any} ctx
 * @param {DepsSpec | undefined} deps
 * @param {Record<string, string> | undefined} needs
 * @param {boolean | undefined} depsOptional
 * @returns {Record<string, unknown> | null}
 */
function resolveDeps(ctx, deps, needs, depsOptional) {
  if (!deps) return Object.create(null);
  const keys = Object.keys(deps);
  if (keys.length === 0) return Object.create(null);
  const resolved = Object.create(null);
  for (const key of keys) {
    const target = deps[key];
    const nodeId = needs?.[key] ?? key;
    const value = ctx.outputMaybe(target, { nodeId });
    if (value === undefined) {
      // Optional deps mode: omit unresolved keys instead of deferring the
      // whole task. Used when the task is already gated by `needs`/`dependsOn`
      // and upstream tasks may legitimately fail (continueOnFail) without
      // producing an output row.
      if (depsOptional) continue;
      return null;
    }
    resolved[key] = value;
  }
  return resolved;
}
/**
 * Resolve the CLI tool allowlist to apply from an explicit `allowTools` prop
 * or the runtime's `cliAgentToolsDefault`. Portable — this only reads a
 * plain field off the ctx runtime config, so both the Node and browser Task
 * variants share it (only the enforcement step, `applyCliToolAllowlist`,
 * needs CLI-agent-class knowledge).
 * @param {unknown} ctx
 * @param {string[] | undefined} allowTools
 * @returns {string[] | undefined}
 */
export function resolveCliToolAllowlist(ctx, allowTools) {
  if (allowTools !== undefined) {
    return allowTools;
  }
  const cliAgentToolsDefault = ctx && typeof ctx === "object" ? ctx.__smithersRuntime?.cliAgentToolsDefault : undefined;
  return cliAgentToolsDefault === "explicit-only" ? [] : undefined;
}
/**
 * Build the __aspects metadata object from the current AspectContext.
 * This is attached to the smithers:task element props so the engine can read
 * budgets and tracking config at execution time.
 * @param {{
 *     tokenBudget?: unknown;
 *     latencySlo?: unknown;
 *     tracking?: unknown;
 *     accumulator?: unknown;
 * }} aspectCtx
 * @returns {{ __aspects: Record<string, unknown> }}
 */
function buildAspectMeta(aspectCtx) {
  return {
    __aspects: {
      tokenBudget: aspectCtx.tokenBudget,
      latencySlo: aspectCtx.latencySlo,
      tracking: aspectCtx.tracking,
      accumulator: aspectCtx.accumulator,
    },
  };
}
/**
 * Attach inherited Memory configuration to the host task. Graph extraction
 * applies the task-level `memory` prop as the final override.
 * @param {Record<string, unknown>} memoryCtx
 * @returns {{ __memory: Record<string, unknown> }}
 */
function buildMemoryMeta(memoryCtx) {
  return { __memory: memoryCtx };
}
/**
 * Build a `Task` component parameterized over how CLI-tool allowlisting is
 * enforced (`applyCliToolAllowlist`). Every other part of Task's render path
 * — deps resolution, agent-chain assembly, MDX prompt rendering,
 * static/compute/agent branching — is identical between the Node and browser
 * variants, so it lives here exactly once.
 * @param {{ applyCliToolAllowlist: (agent: AgentLike, allowTools: string[] | undefined) => AgentLike }} deps
 * @returns {<Row, Output, D>(props: TaskProps<Row, Output, D>) => React.ReactElement | null}
 */
export function createTaskComponent({ applyCliToolAllowlist }) {
  /**
   * @template Row, Output, D
   * @param {TaskProps<Row, Output, D>} props
   * @returns {React.ReactElement | null}
   */
  return function Task(props) {
    const { children, agent, fallbackAgent, deps, depsOptional, ...rest } = props;
    const taskContext = props.smithersContext ?? SmithersContext;
    const ctx = React.useContext(taskContext);
    const aspectCtx = React.useContext(AspectContext);
    const memoryCtx = React.useContext(MemoryContext);
    if (
      props.maxSchemaRetries !== undefined &&
      (!Number.isSafeInteger(props.maxSchemaRetries) || props.maxSchemaRetries < 0)
    ) {
      throw new SmithersError("INVALID_INPUT", "Task maxSchemaRetries must be a non-negative safe integer.");
    }
    const depNodeIds = deriveDepNodeIds(deps, rest.needs);
    if (deps && !ctx) {
      throw new SmithersError(
        "CONTEXT_OUTSIDE_WORKFLOW",
        "Task deps require a workflow context. Build the workflow with createSmithers().",
      );
    }
    const resolvedDeps = deps ? resolveDeps(ctx, deps, rest.needs, depsOptional) : undefined;
    if (deps && resolvedDeps == null) {
      // Deps not yet available — component defers until upstream tasks complete.
      // This is normal reactive behavior; the task will re-render once deps are
      // ready. Record the deferral so the engine can distinguish a transient wait
      // from a permanent one: a deferral that survives to quiescence means a
      // dependency that can never resolve (e.g. a deps key that maps to a node id
      // no task produces), which would otherwise be a silent skip.
      ctx?.recordDeferredDep?.(props.id, depNodeIds ?? []);
      return null;
    }
    const aspectMeta = aspectCtx ? buildAspectMeta(aspectCtx) : undefined;
    const memoryMeta = memoryCtx ? buildMemoryMeta(memoryCtx) : undefined;
    const agentChain = Array.isArray(agent)
      ? fallbackAgent
        ? [...agent, fallbackAgent]
        : agent
      : agent && fallbackAgent
        ? [agent, fallbackAgent]
        : agent;
    const effectiveAllowTools = resolveCliToolAllowlist(ctx, rest.allowTools);
    const restrictedAgentChain = Array.isArray(agentChain)
      ? agentChain.map((entry) => applyCliToolAllowlist(entry, effectiveAllowTools))
      : agentChain
        ? applyCliToolAllowlist(agentChain, effectiveAllowTools)
        : agentChain;
    const nextDependsOn = mergeDependsOn(rest.dependsOn, depNodeIds);
    const hasFunctionChild = typeof children === "function";
    const hasAsyncFunctionChild = hasFunctionChild && children.constructor?.name === "AsyncFunction";
    // Preserve the historical render-time ordering of synchronous deps
    // callbacks. Declared async callbacks must not run here: they route through
    // the compute bridge below, which invokes and awaits them exactly once.
    const childValue =
      hasFunctionChild && (agent || (deps && !hasAsyncFunctionChild))
        ? children(resolvedDeps ?? Object.create(null))
        : children;
    if (agent) {
      // Auto-inject `schema` prop into React element children when output is a ZodObject
      let childElement = childValue;
      const schemaForInjection = props.outputSchema ?? (isZodObject(props.output) ? props.output : undefined);
      if (React.isValidElement(childValue) && schemaForInjection) {
        childElement = React.cloneElement(childValue, {
          schema: zodSchemaToJsonExample(schemaForInjection),
        });
      }
      const prompt = renderPromptToText(childElement);
      return React.createElement(
        "smithers:task",
        {
          ...rest,
          dependsOn: nextDependsOn,
          waitAsync: rest.async === true,
          agent: restrictedAgentChain,
          __smithersKind: "agent",
          ...aspectMeta,
          ...memoryMeta,
        },
        prompt,
      );
    }
    const syncChildReturnedThenable =
      deps &&
      hasFunctionChild &&
      !hasAsyncFunctionChild &&
      childValue != null &&
      (typeof childValue === "object" || typeof childValue === "function") &&
      typeof childValue.then === "function";
    if (hasFunctionChild && (!deps || hasAsyncFunctionChild || syncChildReturnedThenable)) {
      const nextProps = {
        ...rest,
        dependsOn: nextDependsOn,
        waitAsync: rest.async === true,
        __smithersKind: "compute",
        // A normal function may still return a Promise. It was already invoked
        // above to preserve sync compatibility, so return that same thenable
        // rather than calling it twice.
        __smithersComputeFn:
          deps && !hasAsyncFunctionChild
            ? () => childValue
            : deps
              ? () => children(resolvedDeps ?? Object.create(null))
              : children,
        ...aspectMeta,
        ...memoryMeta,
      };
      return React.createElement("smithers:task", nextProps, null);
    }
    const nextProps = {
      ...rest,
      dependsOn: nextDependsOn,
      waitAsync: rest.async === true,
      __smithersKind: "static",
      __smithersPayload: childValue,
      __payload: childValue,
      ...aspectMeta,
      ...memoryMeta,
    };
    return React.createElement("smithers:task", nextProps, null);
  };
}
