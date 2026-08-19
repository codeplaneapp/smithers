/**
 * `RunControl`: the attributed control verbs, journaled.
 *
 * Spec 1.4. Before this, `smithers pause` wrote `pause_requested_at_ms` and
 * `smithers hijack` wrote `hijack_requested_at_ms` with no record of who asked
 * or why — the exact gap flows' analysis names in §4. Every verb now writes a
 * `RunControlRequested` entry into the run's own event journal first, flips
 * durable state second, and writes `RunControlApplied` with the observed
 * outcome third. The journal, not a column, is the attribution store, so no
 * new run columns are needed and the record survives the run row being
 * rewritten by a later lifecycle transition.
 *
 * The CLI verbs are thin calls onto this: `apps/cli/src/index.js` builds the
 * attribution and calls one method.
 *
 * @typedef {import("./RunControl.ts").RunControlAttribution} RunControlAttribution
 * @typedef {import("./RunControl.ts").RunControlOutcome} RunControlOutcome
 * @typedef {import("./RunControl.ts").RunControlVerb} RunControlVerb
 * @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb
 */
import { Effect } from "effect";
import { RUN_CONTROL_APPLIED_EVENT_TYPE, RUN_CONTROL_EVENT_TYPE } from "./runControlEventTypes.js";
import { normalizeRunControlAttribution, runCancellationAttributionFor } from "./runControlAttribution.js";

/**
 * @param {{ adapter: SmithersDb; nowMs?: () => number }} options
 */
export function createRunControl(options) {
  const { adapter } = options;
  const nowMs = options.nowMs ?? (() => Date.now());

  /**
   * @param {string} type
   * @param {string} runId
   * @param {Record<string, unknown>} payload
   * @returns {Promise<number | undefined>}
   */
  const journal = async (type, runId, payload) => {
    const timestampMs = nowMs();
    try {
      return await Effect.runPromise(
        adapter.insertEventWithNextSeq({
          runId,
          type,
          timestampMs,
          payloadJson: JSON.stringify({ type, runId, timestampMs, ...payload }),
        }),
      );
    } catch {
      // A control verb whose journal write failed still has to flip durable
      // state: refusing to cancel a run because its event stream is
      // unavailable is strictly worse than an unattributed cancel.
      return undefined;
    }
  };

  /**
   * @param {RunControlVerb} verb
   * @param {string} runId
   * @param {Partial<RunControlAttribution> | null | undefined} attribution
   * @param {Record<string, unknown>} [extra]
   */
  const requestControl = async (verb, runId, attribution, extra = {}) => {
    const normalized = normalizeRunControlAttribution(attribution);
    const seq = await journal(RUN_CONTROL_EVENT_TYPE, runId, { verb, ...normalized, ...extra });
    return { attribution: normalized, seq };
  };

  /**
   * @param {RunControlVerb} verb
   * @param {string} runId
   * @param {RunControlAttribution} attribution
   * @param {{ accepted: boolean; status: string | null; refusedBecause?: string }} outcome
   */
  const appliedControl = (verb, runId, attribution, outcome) =>
    journal(RUN_CONTROL_APPLIED_EVENT_TYPE, runId, { verb, ...attribution, ...outcome });

  /**
   * @param {string} runId
   * @param {RunControlVerb} verb
   * @param {RunControlAttribution} attribution
   * @param {number | undefined} seq
   * @param {{ accepted: boolean; status: string | null; refusedBecause?: string }} outcome
   * @returns {Promise<RunControlOutcome>}
   */
  const settle = async (runId, verb, attribution, seq, outcome) => {
    await appliedControl(verb, runId, attribution, outcome);
    return {
      runId,
      verb,
      attribution,
      ...(seq !== undefined ? { seq } : {}),
      ...outcome,
    };
  };

  return {
    /**
     * Journal an attributed control request without flipping state. For call
     * sites that own a bespoke durable transition (the terminal cancellation
     * claim, the engine's own shutdown park) and only need the attribution.
     * @param {RunControlVerb} verb
     * @param {string} runId
     * @param {Partial<RunControlAttribution> | null | undefined} attribution
     * @param {Record<string, unknown>} [extra]
     */
    journalRequest: (verb, runId, attribution, extra) => requestControl(verb, runId, attribution, extra),

    /**
     * Graceful pause: stop scheduling, drain in-flight tasks, park resumably.
     * @param {string} runId
     * @param {Partial<RunControlAttribution>} attribution
     * @returns {Promise<RunControlOutcome>}
     */
    async pause(runId, attribution) {
      const { attribution: actor, seq } = await requestControl("pause", runId, attribution);
      const run = await Effect.runPromise(adapter.getRun(runId));
      if (!run) {
        return settle(runId, "pause", actor, seq, {
          accepted: false,
          status: null,
          refusedBecause: "run-not-found",
        });
      }
      if (run.status === "paused") {
        return settle(runId, "pause", actor, seq, { accepted: true, status: "paused" });
      }
      if (run.status !== "running") {
        return settle(runId, "pause", actor, seq, {
          accepted: false,
          status: run.status ?? null,
          refusedBecause: "run-not-active",
        });
      }
      await Effect.runPromise(adapter.requestRunPause(runId, nowMs()));
      return settle(runId, "pause", actor, seq, { accepted: true, status: "pause-requested" });
    },

    /**
     * Request cancellation. The durable request is unfenced on purpose: the
     * owning engine observes it inside its own guarded transition, which is
     * where the terminal claim happens.
     * @param {string} runId
     * @param {Partial<RunControlAttribution>} attribution
     * @returns {Promise<RunControlOutcome>}
     */
    async cancel(runId, attribution) {
      const { attribution: actor, seq } = await requestControl("cancel", runId, attribution);
      const requested = await Effect.runPromise(
        adapter.requestRunCancel(runId, nowMs(), runCancellationAttributionFor(actor, "cancel")),
      );
      const run = await Effect.runPromise(adapter.getRun(runId));
      return settle(runId, "cancel", actor, seq, {
        accepted: requested === true,
        status: run?.status ?? null,
        ...(requested === true ? {} : { refusedBecause: run ? "run-not-running" : "run-not-found" }),
      });
    },

    /**
     * Hand the run's agent session to a human. flows models hijack as an
     * alternative `RunControl` implementation; here it is a verb on the same
     * service, journaled the same way, so the attribution shape is identical.
     * @param {string} runId
     * @param {Partial<RunControlAttribution> & { target?: string | null }} attribution
     * @returns {Promise<RunControlOutcome>}
     */
    async hijack(runId, attribution) {
      const target = attribution?.target ?? null;
      const { attribution: actor, seq } = await requestControl("hijack", runId, attribution, { target });
      const run = await Effect.runPromise(adapter.getRun(runId));
      if (!run) {
        return settle(runId, "hijack", actor, seq, {
          accepted: false,
          status: null,
          refusedBecause: "run-not-found",
        });
      }
      await Effect.runPromise(adapter.requestRunHijack(runId, nowMs(), target));
      return settle(runId, "hijack", actor, seq, { accepted: true, status: run.status ?? null });
    },

    /**
     * Steer: deliver a message to a live agent. The durable enqueue itself is
     * owned by the caller (it needs the target node and the steer author), so
     * this verb journals the attribution and runs the supplied enqueue.
     * @param {string} runId
     * @param {Partial<RunControlAttribution> & { message?: string; nodeId?: string }} attribution
     * @param {() => Promise<{ accepted: boolean; status?: string | null }>} enqueue
     * @returns {Promise<RunControlOutcome>}
     */
    async steer(runId, attribution, enqueue) {
      const { attribution: actor, seq } = await requestControl("steer", runId, attribution, {
        ...(attribution?.nodeId !== undefined ? { nodeId: attribution.nodeId } : {}),
        ...(attribution?.message !== undefined ? { message: String(attribution.message).slice(0, 1024) } : {}),
      });
      try {
        const result = await enqueue();
        return settle(runId, "steer", actor, seq, {
          accepted: result.accepted,
          status: result.status ?? null,
          ...(result.accepted ? {} : { refusedBecause: "enqueue-refused" }),
        });
      } catch (error) {
        // The refusal is journaled, then rethrown: the caller owns how a
        // failed enqueue is reported (its error code and exit status are
        // part of the CLI contract) and must not have that swallowed here.
        await settle(runId, "steer", actor, seq, {
          accepted: false,
          status: null,
          refusedBecause: error instanceof Error ? error.message.slice(0, 200) : "enqueue-failed",
        });
        throw error;
      }
    },
  };
}

/** @typedef {ReturnType<typeof createRunControl>} RunControl */
