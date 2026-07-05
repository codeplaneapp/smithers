import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Effect, Metric } from "effect";
import { approveNode, denyNode } from "@smithers-orchestrator/engine/approvals";
import { isRunHeartbeatFresh } from "@smithers-orchestrator/engine";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { prometheusContentType, renderPrometheusMetrics, } from "@smithers-orchestrator/observability";
import { logWarning } from "@smithers-orchestrator/observability/logging";
import { recoverRewindAuditsAtStartup } from "@smithers-orchestrator/time-travel/recoverRewindAuditsAtStartup";
import { runPromise } from "./smithersRuntime.js";
import { httpRequests, httpRequestDuration, trackEvent } from "@smithers-orchestrator/observability/metrics";
/** @typedef {import("./ServeOptions.js").ServeOptions} ServeOptions */

// Event-poll cadence for the SSE stream.
const SSE_POLL_INTERVAL_MS = 500;
// Statuses after which the stream can close once drained.
const TERMINAL_RUN_STATUSES = ["finished", "failed", "cancelled", "continued"];
class HttpError extends Error {
    status;
    code;
    /**
   * @param {number} status
   * @param {HttpErrorCode} code
   * @param {string} message
   */
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
/**
 * @template A
 * @param {A} metric
 * @param {Record<string, string>} tags
 * @returns {A}
 */
function taggedMetric(metric, tags) {
    let tagged = metric;
    for (const [key, value] of Object.entries(tags)) {
        tagged = Metric.tagged(tagged, key, value);
    }
    return tagged;
}
/**
 * @param {string} pathname
 * @returns {string}
 */
function normalizeHttpMetricRoute(pathname) {
    if (pathname === "/"
        || pathname === "/health"
        || pathname === "/events"
        || pathname === "/frames"
        || pathname === "/cancel"
        || pathname === "/metrics") {
        return pathname;
    }
    if (/^\/approve\/[^/]+$/.test(pathname))
        return "/approve/:nodeId";
    if (/^\/deny\/[^/]+$/.test(pathname))
        return "/deny/:nodeId";
    return pathname;
}
/**
 * @param {number} statusCode
 * @returns {string}
 */
function statusClass(statusCode) {
    const normalized = Number.isFinite(statusCode) && statusCode > 0 ? statusCode : 500;
    return `${Math.floor(normalized / 100)}xx`;
}
/**
 * @param {string} method
 * @param {string} pathname
 * @param {number} statusCode
 * @param {number} durationMs
 */
function recordHttpRequestMetrics(method, pathname, statusCode, durationMs) {
    const tags = {
        method: method.toUpperCase(),
        route: normalizeHttpMetricRoute(pathname),
        status_code: String(statusCode),
        status_class: statusClass(statusCode),
    };
    return Effect.all([
        Metric.increment(taggedMetric(httpRequests, tags)),
        Metric.update(taggedMetric(httpRequestDuration, tags), durationMs),
    ], { discard: true });
}
/**
 * @param {string} method
 * @param {string} pathname
 * @param {number} statusCode
 * @param {number} durationMs
 */
async function recordHttpRequestMetricsSafely(method, pathname, statusCode, durationMs) {
    try {
        await runPromise(recordHttpRequestMetrics(method, pathname, statusCode, durationMs));
    }
    catch (error) {
        logWarning("failed to record serve http metrics", {
            method: method.toUpperCase(),
            pathname,
            statusCode,
            error: error instanceof Error ? error.message : String(error),
        }, "serve:metrics");
    }
}
/**
 * Whether an HTTP `Host` (or `Origin`) authority names a loopback interface.
 * Mirrors the gateway's DNS-rebinding defense (`isLoopbackHost` in gateway.js): a
 * page at evil.com rebound to 127.0.0.1 sends `Host: evil.com`, so requiring a
 * loopback Host rejects it. Handles an optional :port and IPv6 brackets, and
 * treats `*.localhost` and the whole 127/8 block as loopback.
 * @param {string} hostHeader
 * @returns {boolean}
 */
function isLoopbackHost(hostHeader) {
    let host = hostHeader.trim().toLowerCase();
    if (host.startsWith("[")) {
        // Bracketed IPv6, e.g. "[::1]:7331" or "[::1]".
        const end = host.indexOf("]");
        host = end >= 0 ? host.slice(1, end) : host.slice(1);
    }
    else {
        // Strip a trailing :port, but only from a single-colon host ("host:port"):
        // an unbracketed IPv6 literal like "::1" has multiple colons, so leaving it
        // intact lets the `host === "::1"` check below match it.
        const colon = host.lastIndexOf(":");
        if (colon >= 0 && colon === host.indexOf(":") && /^\d+$/.test(host.slice(colon + 1))) {
            host = host.slice(0, colon);
        }
    }
    return (host === "localhost"
        || host === "::1"
        || host === "::ffff:127.0.0.1"
        || host.endsWith(".localhost")
        || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host));
}
/**
 * Whether a browser `Origin` header points at a loopback authority. A same-origin
 * page served by this app carries a loopback Origin; a malicious cross-origin page
 * carries its own (non-loopback) Origin. An opaque/`null` or unparseable Origin is
 * treated as non-loopback (rejected).
 * @param {string} origin
 * @returns {boolean}
 */
function isLoopbackOrigin(origin) {
    let parsed;
    try {
        parsed = new URL(origin);
    }
    catch {
        return false;
    }
    return isLoopbackHost(parsed.host);
}
/**
 * @param {ServeOptions} opts
 */
export function createServeApp(opts) {
    const { adapter, runId, abort, authToken, insecure, metrics: metricsEnabled = true } = opts;
    // Best-effort, non-blocking startup recovery of crash-interrupted rewinds.
    // Covers SDK callers of createServeApp (the CLI `up` path recovers earlier).
    void recoverRewindAuditsAtStartup(adapter, {
        onRecovered: (count) => logWarning(`recovered ${count} incomplete rewind(s) from a prior crash`, {}, "serve:startup"),
        onError: (error) => logWarning(`rewind-audit recovery failed: ${error instanceof Error ? error.message : String(error)}`, {}, "serve:startup"),
    });
    const app = new Hono();
    // Health — no auth
    app.get("/health", (c) => c.json({ ok: true }));
    // Auth middleware — applied after /health
    if (authToken) {
        app.use("*", async (c, next) => {
            // /health already matched above, so this won't fire for it
            const smithersKey = c.req.header("x-smithers-key");
            if (smithersKey === authToken)
                return next();
            const authHeader = c.req.header("authorization");
            if (authHeader) {
                const token = authHeader.slice(0, 7).toLowerCase() === "bearer "
                    ? authHeader.slice(7)
                    : authHeader;
                if (token === authToken)
                    return next();
            }
            return c.json({ error: { code: "UNAUTHORIZED", message: "Missing or invalid authorization token" } }, 401);
        });
    }
    // Timing middleware
    app.use("*", async (c, next) => {
        const start = performance.now();
        let statusCode = 500;
        try {
            await next();
            statusCode = c.res.status;
        }
        catch (error) {
            statusCode = error instanceof HttpError ? error.status : 500;
            throw error;
        }
        finally {
            await recordHttpRequestMetricsSafely(c.req.method, c.req.path, statusCode, performance.now() - start);
        }
    });
    // DNS-rebinding + cross-origin CSRF defense for the unauthenticated local
    // bind, mirroring the gateway's isHostAllowed/isOriginAllowed. With no
    // authToken every request is trusted, so a browser page rebound to 127.0.0.1
    // (non-loopback Host), or a plain cross-origin "simple" POST to /cancel
    // (loopback Host, non-loopback Origin), could drive the mutating run-control
    // routes (/cancel, /approve, /deny). Only the unauthenticated path is gated:
    // a configured token is the real gate, and a remote authenticated client
    // legitimately sends a non-loopback Host. `--insecure` (opts.insecure) or
    // SMITHERS_SERVE_TRUST_ANY_HOST opt out for a deliberate remote unauth bind.
    const trustAnyHost = process.env.SMITHERS_SERVE_TRUST_ANY_HOST;
    const trustAnyOrigin = insecure === true || trustAnyHost === "1" || trustAnyHost === "true";
    if (!authToken && !trustAnyOrigin) {
        app.use("*", async (c, next) => {
            const host = c.req.header("host");
            if (host && !isLoopbackHost(host)) {
                return c.json({ error: { code: "FORBIDDEN", message: "Host is not allowed" } }, 403);
            }
            const origin = c.req.header("origin");
            if (origin && !isLoopbackOrigin(origin)) {
                return c.json({ error: { code: "FORBIDDEN", message: "Origin is not allowed" } }, 403);
            }
            return next();
        });
    }
    // GET / — run status
    app.get("/", async (c) => {
        const run = await adapter.getRun(runId);
        if (!run) {
            throw new HttpError(404, "RUN_NOT_FOUND", "Run not found");
        }
        const summary = await adapter.countNodesByState(runId);
        return c.json({
            runId,
            workflowName: run.workflowName ?? "workflow",
            status: run.status ?? "unknown",
            startedAtMs: run.startedAtMs ?? null,
            finishedAtMs: run.finishedAtMs ?? null,
            summary: summary.reduce((acc, row) => {
                acc[row.state] = row.count;
                return acc;
            }, {}),
        });
    });
    // GET /events — SSE stream
    app.get("/events", (c) => {
        const afterSeqParam = c.req.query("afterSeq");
        let lastSeq = afterSeqParam ? parseInt(afterSeqParam, 10) : -1;
        if (!Number.isFinite(lastSeq))
            lastSeq = -1;
        return streamSSE(c, async (stream) => {
            let closed = false;
            // Use the abort signal from the request to detect disconnects
            c.req.raw.signal.addEventListener("abort", () => {
                closed = true;
            });
            while (!closed) {
                const events = await adapter.listEvents(runId, lastSeq, 200);
                for (const ev of events) {
                    lastSeq = ev.seq;
                    await stream.writeSSE({
                        event: "smithers",
                        data: ev.payloadJson,
                        id: String(ev.seq),
                    });
                }
                // Check if run is terminal
                const runRow = await adapter.getRun(runId);
                if (runRow &&
                    TERMINAL_RUN_STATUSES.includes(runRow.status) &&
                    events.length === 0) {
                    break;
                }
                await new Promise((r) => setTimeout(r, SSE_POLL_INTERVAL_MS));
            }
        });
    });
    // GET /frames
    app.get("/frames", async (c) => {
        const limitParam = c.req.query("limit");
        const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 50) : 50;
        const afterParam = c.req.query("afterFrameNo");
        const afterFrameNo = afterParam !== null && afterParam !== undefined
            ? parseInt(afterParam, 10)
            : undefined;
        const frames = await adapter.listFrames(runId, limit, afterFrameNo !== undefined && Number.isFinite(afterFrameNo) && afterFrameNo >= 0
            ? afterFrameNo
            : undefined);
        return c.json(frames);
    });
    // POST /approve/:nodeId
    app.post("/approve/:nodeId", async (c) => {
        const nodeId = c.req.param("nodeId");
        const body = await c.req.json().catch(() => ({}));
        await Effect.runPromise(approveNode(adapter, runId, nodeId, body.iteration ?? 0, body.note, body.decidedBy));
        return c.json({ runId });
    });
    // POST /deny/:nodeId
    app.post("/deny/:nodeId", async (c) => {
        const nodeId = c.req.param("nodeId");
        const body = await c.req.json().catch(() => ({}));
        await Effect.runPromise(denyNode(adapter, runId, nodeId, body.iteration ?? 0, body.note, body.decidedBy));
        return c.json({ runId });
    });
    // POST /cancel
    app.post("/cancel", async (c) => {
        const run = await adapter.getRun(runId);
        if (!run) {
            throw new HttpError(404, "RUN_NOT_FOUND", "Run not found");
        }
        if (run.status === "waiting-approval" || run.status === "waiting-timer") {
            const cancelledAtMs = nowMs();
            const cancelEvent = {
                type: "RunCancelled",
                runId,
                timestampMs: cancelledAtMs,
            };
            if (run.status === "waiting-timer") {
                const nodes = await adapter.listNodes(runId);
                for (const node of nodes.filter((entry) => entry.state === "waiting-timer")) {
                    const attempts = await runPromise(adapter.listAttempts(runId, node.nodeId, node.iteration ?? 0));
                    const waitingAttempt = attempts.find((attempt) => attempt.state === "waiting-timer");
                    if (!waitingAttempt)
                        continue;
                    await adapter.updateAttempt(runId, node.nodeId, node.iteration ?? 0, waitingAttempt.attempt, { state: "cancelled", finishedAtMs: cancelledAtMs });
                    await adapter.insertNode({
                        runId,
                        nodeId: node.nodeId,
                        iteration: node.iteration ?? 0,
                        state: "cancelled",
                        lastAttempt: waitingAttempt.attempt,
                        updatedAtMs: cancelledAtMs,
                        outputTable: node.outputTable ?? "",
                        label: node.label ?? null,
                    });
                    const timerCancelledEvent = {
                        type: "TimerCancelled",
                        runId,
                        timerId: node.nodeId,
                        timestampMs: cancelledAtMs,
                    };
                    await adapter.insertEventWithNextSeq({
                        runId,
                        timestampMs: cancelledAtMs,
                        type: "TimerCancelled",
                        payloadJson: JSON.stringify(timerCancelledEvent),
                    });
                    await runPromise(trackEvent(timerCancelledEvent));
                }
            }
            await adapter.updateRun(runId, {
                status: "cancelled",
                finishedAtMs: cancelledAtMs,
                heartbeatAtMs: null,
                runtimeOwnerId: null,
                cancelRequestedAtMs: null,
            });
            await adapter.insertEventWithNextSeq({
                runId,
                timestampMs: cancelledAtMs,
                type: "RunCancelled",
                payloadJson: JSON.stringify(cancelEvent),
            });
            await runPromise(trackEvent(cancelEvent));
            return c.json({ runId });
        }
        if (run.status !== "running" || !isRunHeartbeatFresh(run)) {
            throw new HttpError(409, "RUN_NOT_ACTIVE", "Run is not currently active");
        }
        await adapter.requestRunCancel(runId, nowMs());
        abort.abort();
        return c.json({ runId });
    });
    // GET /metrics
    if (metricsEnabled) {
        app.get("/metrics", (c) => {
            return c.text(renderPrometheusMetrics(), 200, {
                "Content-Type": prometheusContentType,
            });
        });
    }
    // 404 catch-all
    app.notFound((c) => {
        return c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404);
    });
    // Error handler
    app.onError((err, c) => {
        if (err instanceof HttpError) {
            return c.json({ error: { code: err.code, message: err.message } }, err.status);
        }
        return c.json({ error: { code: "SERVER_ERROR", message: err.message ?? "Unknown error" } }, 500);
    });
    return app;
}
