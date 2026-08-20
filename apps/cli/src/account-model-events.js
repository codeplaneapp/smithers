import { registeredAgentLabel } from "@smthrs/accounts";
import { findAndOpenDb } from "./find-db.js";

/** @param {unknown} value */
function object(value) {
  if (typeof value === "string") {
    try {
      return object(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** @param {Record<string, unknown>} row */
function attemptKey(row) {
  const payload = object(row.payloadJson ?? row.payload_json ?? row.payload) ?? row;
  const correlation = object(payload.correlation) ?? payload;
  return `${correlation.nodeId ?? correlation.node_id ?? ""}::${correlation.iteration ?? 0}::${correlation.attempt ?? 0}`;
}

/**
 * Read persisted flows model events and attribute them through the attempt's
 * durable registered-agent id. Failure is soft: account selection must still
 * work before a workspace has a run store.
 *
 * @param {string} cwd
 * @returns {Promise<Map<string, unknown[]>>}
 */
export async function modelEventsByAccount(cwd) {
  /** @type {Map<string, unknown[]>} */
  const byAccount = new Map();
  let opened;
  try {
    opened = await findAndOpenDb(cwd);
    const runs = await opened.adapter.listRuns(200);
    for (const run of runs) {
      const runId = String(run.runId ?? run.run_id ?? "");
      if (!runId) continue;
      const labels = new Map();
      for (const attempt of await opened.adapter.listAttemptsForRun(runId)) {
        const meta = object(attempt.metaJson ?? attempt.meta_json);
        const label = registeredAgentLabel(meta?.agentId);
        if (label) labels.set(attemptKey(attempt), label);
      }
      if (labels.size === 0) continue;
      let afterSeq = -1;
      for (;;) {
        const page = await opened.adapter.listEvents(runId, afterSeq, 1_000);
        for (const row of page) {
          const payload = object(row.payloadJson ?? row.payload_json ?? row.payload);
          const label = registeredAgentLabel(payload?.agentId ?? object(payload?.correlation)?.agentId) ?? labels.get(attemptKey(row));
          if (label) {
            const values = byAccount.get(label) ?? [];
            values.push(row);
            byAccount.set(label, values);
          }
        }
        if (page.length === 0 || page.length < 1_000) break;
        afterSeq = Number(page.at(-1)?.seq ?? afterSeq);
      }
    }
  } catch {
    return byAccount;
  } finally {
    opened?.cleanup();
  }
  return byAccount;
}
