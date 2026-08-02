import { randomUUID } from "node:crypto";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { assessEffectBoundary } from "./assessEffectBoundary.js";
import { executeEffectReverts } from "./executeEffectReverts.js";
import { loadEffectHandlers } from "./loadEffectHandlers.js";
import { recordForcedEffectBoundary } from "./recordForcedEffectBoundary.js";

/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smthrs/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {import("./EffectBoundaryParams.ts").EffectBoundaryParams} EffectBoundaryParams */
/** @typedef {import("./EffectBoundaryReport.ts").EffectBoundaryReport} EffectBoundaryReport */

/**
 * @param {EffectBoundaryReport} report
 * @returns {boolean}
 */
function hasUnclassifiedWarnings(report) {
  return report.warnings.some((effect) => effect.reason?.includes("unclassified"));
}

/**
 * @param {EffectBoundaryReport} report
 * @param {string} reason
 * @returns {EffectBoundaryReport}
 */
function blockRevertible(report, reason) {
  return {
    blocking: [...report.blocking, ...report.revertible.map((effect) => ({ ...effect, reason }))],
    revertible: [],
    warnings: report.warnings,
  };
}

/**
 * Resolve every handler before running any compensation. Missing handlers are
 * blockers, so an unforced operation cannot partially compensate and then
 * discover that the boundary still cannot be crossed.
 *
 * @param {EffectBoundaryReport} report
 * @param {import("./EffectHandlerRegistry.ts").EffectHandlerRegistry} registry
 * @returns {EffectBoundaryReport}
 */
function resolveHandlers(report, registry) {
  const blocking = [...report.blocking];
  const revertible = [];
  for (const effect of report.revertible) {
    const handler =
      effect.kind === "tool" ? registry.tools.get(effect.toolName)?.revert : registry.tasks.get(effect.nodeId)?.revert;
    if (typeof handler === "function") {
      revertible.push(effect);
    } else {
      blocking.push({
        ...effect,
        reason:
          effect.kind === "tool" && effect.hasRevert
            ? `The journal records hasRevert=true for tool ${effect.toolName}, but no matching defineTool instance was enumerable from task agents or exported workflow tool registries. Closed-over compute-task tools must be exported in a tool registry.`
            : `No revert handler could be resolved for ${effect.kind} ${effect.kind === "tool" ? effect.toolName : effect.nodeId}.`,
      });
    }
  }
  return { blocking, revertible, warnings: report.warnings };
}

/**
 * Assess and enforce one operation's effect boundary.
 *
 * @param {SmithersDb} db
 * @param {EffectBoundaryParams & {
 *   operation: string;
 *   force?: boolean;
 *   noRevert?: boolean;
 *   runsReverts: boolean;
 *   warningOnly?: boolean;
 *   checkStillHeld?: () => Promise<boolean>;
 *   onProgress?: (event: SmithersEvent) => void;
 * }} params
 * @returns {Promise<{ report: EffectBoundaryReport; opId: string; forced: boolean }>}
 */
export async function guardEffectBoundary(db, params) {
  let report = await assessEffectBoundary(db, params);
  let registry = null;
  if (report.revertible.length > 0 || hasUnclassifiedWarnings(report)) {
    try {
      registry = await loadEffectHandlers(db, params.runId);
      report = await assessEffectBoundary(db, {
        ...params,
        toolMetadata: registry.toolMetadata,
      });
    } catch (error) {
      if (report.revertible.length > 0) {
        const message = error instanceof Error ? error.message : String(error);
        report = blockRevertible(
          report,
          message === "workflow changed since the effect was recorded"
            ? message
            : `Workflow handlers could not be loaded: ${message}`,
        );
      }
    }
  }

  if (params.warningOnly) {
    return {
      report: {
        blocking: [],
        revertible: [],
        warnings: [
          ...report.warnings,
          ...report.blocking.map((effect) => ({
            ...effect,
            reason: "Fork warning: effect may execute again if the child is resumed.",
          })),
          ...report.revertible.map((effect) => ({
            ...effect,
            reason: "Fork warning: effect may execute again if the child is resumed.",
          })),
        ],
      },
      opId: randomUUID(),
      forced: false,
    };
  }

  if (!params.runsReverts) {
    report = blockRevertible(report, "Branch operations never revert parent effects.");
  } else if (params.noRevert) {
    report = blockRevertible(report, "Revert handler skipped by noRevert.");
  } else if (report.revertible.length > 0) {
    if (!registry) {
      report = blockRevertible(report, "Workflow handler registry is unavailable.");
    } else {
      report = resolveHandlers(report, registry);
    }
  }

  const opId = randomUUID();
  if (report.blocking.length > 0 && !params.force) {
    throw new SmithersError(
      "TIME_TRAVEL_SIDE_EFFECT_BLOCKED",
      `Time travel is blocked by ${report.blocking.length} external side effect${report.blocking.length === 1 ? "" : "s"}.`,
      { runId: params.runId, operation: params.operation, report },
    );
  }
  if (params.runsReverts && !params.noRevert && registry && report.revertible.length > 0) {
    report = await executeEffectReverts(db, {
      runId: params.runId,
      operation: params.operation,
      report,
      registry,
      checkStillHeld: params.checkStillHeld,
      onProgress: params.onProgress,
    });
  }
  const forced = report.blocking.length > 0 && params.force === true;
  if (forced) {
    report = {
      ...report,
      blocking: report.blocking.map((effect) => ({
        ...effect,
        reason: effect.reason ? `Forced crossing: ${effect.reason}` : "Forced crossing without a revert handler.",
      })),
    };
    await recordForcedEffectBoundary(db, {
      runId: params.runId,
      operation: params.operation,
      opId,
      report,
    });
  }
  return { report, opId, forced };
}
