import { select, confirm, text, note, isCancel, cancel, log } from "@clack/prompts";
import pc from "picocolors";
import { Effect } from "effect";
import { approveNode, denyNode } from "@smithers-orchestrator/engine/approvals";
import { validateHumanRequestValue, isHumanRequestPastTimeout } from "@smithers-orchestrator/engine/human-requests";

/** Bare node id for display: strip any `workflow:`-style qualifier prefix. */
function displayNode(nodeId) {
    const id = String(nodeId ?? "·");
    const i = id.lastIndexOf(":");
    return i >= 0 ? id.slice(i + 1) : id;
}

function iterationOf(row) {
    return row.iteration ?? 0;
}

/**
 * Resolve every pending approval gate for a run via clack prompts. Mirrors the
 * `smithers approve`/`deny` commands: approveNode/denyNode are Effects, so they
 * are wrapped in Effect.runPromise, and the row's own `iteration` is used.
 *
 * @param {import("@smithers-orchestrator/db/adapter").SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<{ decided: number; cancelled: boolean }>}
 */
export async function handleApprovals(adapter, runId) {
    let decided = 0;
    while (true) {
        const pending = await adapter.listPendingApprovals(runId);
        if (pending.length === 0) return { decided, cancelled: false };

        const row = pending[0];
        let request = null;
        try { request = row.requestJson ? JSON.parse(row.requestJson) : null; } catch { request = null; }
        const title = (request && typeof request.title === "string" && request.title) || displayNode(row.nodeId);
        const summary = request && typeof request.summary === "string" ? request.summary : null;

        note(summary ? `${title}\n${pc.dim(summary)}` : title, `approval · ${displayNode(row.nodeId)}`);
        const choice = await select({
            message: `${title} — approve?`,
            options: [
                { value: "approve", label: "Approve", hint: "continue the run" },
                { value: "deny", label: "Deny", hint: "fail this gate (run fails)" },
            ],
        });
        if (isCancel(choice)) {
            cancel("Approval left pending; the run stays paused.");
            return { decided, cancelled: true };
        }

        // Re-check it is still pending: approveNode/denyNode fail if the node has
        // already left waiting-approval (e.g. resolved out of band).
        const iteration = iterationOf(row);
        const stillPending = (await adapter.listPendingApprovals(runId))
            .some((a) => a.nodeId === row.nodeId && iterationOf(a) === iteration);
        if (!stillPending) {
            log.warn(`Gate ${displayNode(row.nodeId)} already resolved; skipping.`);
            continue;
        }

        try {
            if (choice === "approve") {
                // Pass a note string (not undefined): the approval bridge coerces a
                // missing note to `null`, which fails `z.string().optional()` note
                // schemas (see core bug in bridgeApprovalResolve).
                await Effect.runPromise(approveNode(adapter, runId, row.nodeId, iteration, "Approved via smithers tui", "smithers:tui"));
                log.success(`Approved ${displayNode(row.nodeId)}.`);
            } else {
                await Effect.runPromise(denyNode(adapter, runId, row.nodeId, iteration, "Denied via smithers tui", "smithers:tui"));
                log.warn(`Denied ${displayNode(row.nodeId)}.`);
            }
            decided++;
        } catch (err) {
            log.warn(`Could not decide ${displayNode(row.nodeId)}: ${err?.message ?? err}`);
            return { decided, cancelled: false };
        }
    }
}

/** Choices for a `select` human request, from optionsJson or a schema enum. */
function humanChoices(request) {
    try { if (request.optionsJson) { const o = JSON.parse(request.optionsJson); if (Array.isArray(o)) return o; } } catch { /* ignore */ }
    try { if (request.schemaJson) { const s = JSON.parse(request.schemaJson); if (Array.isArray(s?.enum)) return s.enum; } } catch { /* ignore */ }
    return [];
}

/** Prompt for one human request with a clack control matched to its kind. */
async function promptForHumanRequest(request) {
    const message = request.prompt || `${request.kind} for ${displayNode(request.nodeId)}`;
    if (request.kind === "confirm") {
        return confirm({ message });
    }
    if (request.kind === "select") {
        const choices = humanChoices(request);
        if (choices.length > 0) {
            return select({ message, options: choices.map((v) => ({ value: v, label: String(v) })) });
        }
        return text({ message });
    }
    if (request.kind === "json") {
        const raw = await text({
            message: `${message} (JSON)`,
            validate: (v) => { try { JSON.parse(v ?? ""); return undefined; } catch { return "Enter valid JSON."; } },
        });
        if (isCancel(raw)) return raw;
        return JSON.parse(raw);
    }
    return text({ message });
}

/**
 * Resolve every pending durable human request for a run via clack prompts.
 * Validates with validateHumanRequestValue before submitting, and encodes the
 * answer as responseJson = JSON.stringify(value) (mirrors the `human` command).
 *
 * @param {import("@smithers-orchestrator/db/adapter").SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<{ answered: number; cancelled: boolean }>}
 */
export async function handleHumanRequests(adapter, runId) {
    let answered = 0;
    while (true) {
        // listPendingHumanRequests returns ALL runs' pending rows — scope to this run.
        const pending = (await adapter.listPendingHumanRequests()).filter((r) => r.runId === runId);
        if (pending.length === 0) return { answered, cancelled: false };

        const fresh = await adapter.getHumanRequest(pending[0].requestId);
        if (!fresh || fresh.status !== "pending") continue;
        if (isHumanRequestPastTimeout(fresh, Date.now())) {
            log.warn(`Request for ${displayNode(fresh.nodeId)} expired.`);
            continue;
        }

        note(fresh.prompt, `${fresh.kind} · ${displayNode(fresh.nodeId)}`);
        const value = await promptForHumanRequest(fresh);
        if (isCancel(value)) {
            const approval = await adapter.getApproval(fresh.runId, fresh.nodeId, iterationOf(fresh));
            if (approval?.status === "requested") {
                await Effect.runPromise(denyNode(adapter, fresh.runId, fresh.nodeId, iterationOf(fresh), `Human request cancelled: ${fresh.requestId}`, "smithers:tui"));
            }
            await adapter.cancelHumanRequest(fresh.requestId);
            cancel("Request cancelled; the run will not proceed.");
            return { answered, cancelled: true };
        }

        const validation = validateHumanRequestValue(fresh, value);
        if (!validation.ok) {
            log.warn(validation.message || "Invalid input; try again.");
            continue; // re-prompt on the next loop
        }

        const answeredAtMs = Date.now();
        if (isHumanRequestPastTimeout(fresh, answeredAtMs)) {
            await adapter.expireStaleHumanRequests(answeredAtMs);
            log.warn(`Request for ${displayNode(fresh.nodeId)} expired.`);
            continue;
        }

        const responseJson = JSON.stringify(value);
        const approval = await adapter.getApproval(fresh.runId, fresh.nodeId, iterationOf(fresh));
        // Persist before waking the node; the resumed task reads this answer immediately.
        await adapter.answerHumanRequest(fresh.requestId, responseJson, answeredAtMs, "smithers:tui");
        if (approval?.status === "requested") {
            await Effect.runPromise(approveNode(adapter, fresh.runId, fresh.nodeId, iterationOf(fresh), responseJson, "smithers:tui"));
        }
        answered++;
        log.success(`Answered ${displayNode(fresh.nodeId)}.`);
    }
}
