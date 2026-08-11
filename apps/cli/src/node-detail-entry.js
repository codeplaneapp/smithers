#!/usr/bin/env bun
/**
 * Thin entry for herdr detail tabs: node HUD + dual-control dock.
 *
 * Avoids loading the full `index.js` CLI surface (~1.2s cold start). Target is
 * first paint well under ~300–400ms for Enter/click from the workflow supervisor.
 *
 * Argv (positional, herdr-stable):
 *   bun node-detail-entry.js <runId> --node <nodeId> [--linger] [--hud]
 *
 * Discovers smithers.db via cwd (same contract as `smithers tail` without --db).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Effect } from "effect";
import { SmithersError } from "@smthrs/errors";
import { enqueueSteer } from "@smthrs/engine/steers";
import { findAndOpenDb } from "./find-db.js";
import { closeCurrentHerdrDetail } from "./herdr.js";
import { countInFlightAgentSiblings } from "./steer.js";
import { createNodeHud } from "./node-hud.js";
import {
  attachTailKeyControls,
  formatTailFinalStatusLine,
  isTailActiveState,
  lingerUntilClosed,
  tailRunEvents,
} from "./tail.js";

function parseArgs(argv) {
  /** @type {{ runId?: string, nodeId?: string, linger: boolean, db?: string }} */
  const out = { linger: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--node" || a === "-n") out.nodeId = argv[++i];
    else if (a.startsWith("--node=")) out.nodeId = a.slice("--node=".length);
    else if (a === "--db") out.db = argv[++i];
    else if (a.startsWith("--db=")) out.db = a.slice("--db=".length);
    else if (a === "--linger") out.linger = true;
    else if (a === "--hud" || a === "--hud=true") {
      /* always on for this entry */
    } else if (a === "--help" || a === "-h") {
      process.stdout.write("Usage: node-detail-entry <runId> --node <nodeId> [--db <smithers.db>] [--linger]\n");
      process.exit(0);
    } else if (!a.startsWith("-") && !out.runId) {
      out.runId = a;
    }
  }
  return out;
}

async function openDetailStore(args) {
  // Write mode: dual-control `s` steers enqueue steers into this same store.
  // (read-only would accept the keypress then fail the insert silently.)
  if (typeof args.db === "string" && args.db !== "") {
    const { openSmithersStore } = await import("smthrs/openSmithersStore");
    const { resolve, dirname } = await import("node:path");
    const dbPath = resolve(args.db);
    const opened = await openSmithersStore({
      cwd: dirname(dbPath),
      dbPath,
      mode: "write",
      backend: "sqlite",
    });
    return {
      adapter: opened.adapter,
      cleanup: opened.cleanup,
      dbPath: opened.dbPath ?? dbPath,
    };
  }
  const { openSmithersStore } = await import("smthrs/openSmithersStore");
  try {
    const opened = await openSmithersStore({ cwd: process.cwd(), mode: "write" });
    return { adapter: opened.adapter, cleanup: opened.cleanup, dbPath: opened.dbPath };
  } catch {
    // Fallback: read-only discovery (steer will fail loud in dock).
    const opened = await findAndOpenDb(process.cwd());
    return { adapter: opened.adapter, cleanup: opened.cleanup, dbPath: opened.dbPath };
  }
}

/**
 * Tear down HUD + store and close the herdr detail tab so `q` does not leave a
 * grey dead pane. Always process.exit — never wait for the poll loop.
 * @param {{
 *   nodeHud: ReturnType<typeof createNodeHud> | null,
 *   cleanup?: (() => void) | undefined,
 *   keyControls?: { stop: () => void } | undefined,
 * }} ctx
 */
async function exitDetailClean(ctx) {
  try {
    ctx.keyControls?.stop();
  } catch {
    /* ignore */
  }
  try {
    ctx.nodeHud?.exit();
  } catch {
    /* ignore */
  }
  try {
    ctx.cleanup?.();
  } catch {
    /* ignore */
  }
  await closeCurrentHerdrDetail();
  process.exit(0);
}

/** Retry getRun briefly — engine may still be committing the first frame. */
async function getRunSoon(adapter, runId, attempts = 12, gapMs = 50) {
  for (let i = 0; i < attempts; i++) {
    const run = await adapter.getRun(runId);
    if (run) return run;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runId || !args.nodeId) {
    process.stderr.write("node-detail-entry: need <runId> --node <nodeId>\n");
    process.exit(2);
  }

  const opened = await openDetailStore(args);
  const { adapter, cleanup } = opened;
  /** @type {ReturnType<typeof createNodeHud> | null} */
  let nodeHud = null;
  let cancelledByKey = false;

  try {
    const run = await getRunSoon(adapter, args.runId);
    if (!run) {
      const msg = `Run not found: ${args.runId}${opened.dbPath ? ` (db ${opened.dbPath})` : ""}`;
      process.stderr.write(`${msg}\n`);
      // Paint error into HUD when possible so herdr tabs are not blank.
      try {
        nodeHud = createNodeHud({ runId: args.runId, nodeId: args.nodeId });
        nodeHud.enter();
        nodeHud.setMeta({ status: "error", note: msg });
        nodeHud.pushBody(msg);
        await new Promise((r) => setTimeout(r, 2500));
      } catch {
        /* ignore */
      }
      process.exit(4);
    }

    const runId = args.runId;
    const nodeId = args.nodeId;
    const baseMs = run.startedAtMs ?? run.createdAtMs ?? Date.now();
    const cliEntry = fileURLToPath(new URL("./index.js", import.meta.url));
    const steerEligible = Boolean(process.stdin.isTTY);

    nodeHud = createNodeHud({ runId, nodeId });
    nodeHud.enter();
    // First paint ASAP — empty body, dock ready (snappy tab open).
    nodeHud.setMeta({ status: "starting", note: "loading…" });

    // Seed tool-call / agent activity history (same source as supervisor strip).
    // Use nearly full terminal width for detail (strip stays compact at 48).
    const cols = Math.max(40, process.stdout.columns || 80);
    try {
      const { loadNodeActivity, formatActivityPlainWidth } = await import("./cockpit-activity.js");
      const lines = await loadNodeActivity(adapter, runId, nodeId, {
        limit: 40,
        detailMax: Math.max(48, cols - 12),
      });
      if (lines.length > 0) {
        nodeHud.pushBody("── agent activity (tools) ──");
        for (const line of lines) {
          nodeHud.pushBody(formatActivityPlainWidth(line, cols));
        }
        nodeHud.pushBody("── lifecycle (run events) ──");
      }
    } catch {
      /* soft — lifecycle tail still works */
    }
    // Surface effort/model from latest attempt meta in the header note.
    try {
      const all = (await adapter.listAttemptsForRun(runId)) ?? [];
      const attempts = all.filter((a) => a?.nodeId === nodeId);
      const last = attempts[attempts.length - 1];
      if (last) {
        const meta = typeof last.metaJson === "string" && last.metaJson !== "" ? JSON.parse(last.metaJson) : {};
        // First-class effort column wins; meta_json keys are the back-compat
        // fallback for rows recorded before the column existed. Keep this
        // chain identical to the gateway path (getDevToolsSnapshot.js) so
        // both render the same effort for any externally-authored row.
        const effort =
          (typeof last.effort === "string" && last.effort) ||
          (typeof meta.effort === "string" && meta.effort) ||
          (typeof meta.reasoningEffort === "string" && meta.reasoningEffort) ||
          (typeof meta.variant === "string" && meta.variant) ||
          (typeof meta.effortLevel === "string" && meta.effortLevel) ||
          "";
        const bits = [];
        if (typeof meta.agentModel === "string") bits.push(meta.agentModel);
        if (effort) bits.push(effort);
        if (bits.length) nodeHud.setMeta({ note: bits.join(" · ") });
        if (typeof last.attempt === "number") nodeHud.setMeta({ attempt: last.attempt });
      }
    } catch {
      /* soft */
    }

    const onStatusBlock = async (status) => {
      nodeHud?.setMeta({
        status: status ?? "unknown",
        note: isTailActiveState(status)
          ? "dual-control dock · always at bottom"
          : "run finished — steer only while working",
      });
      if (!isTailActiveState(status)) {
        nodeHud?.setDock("linger");
      }
    };

    // Seed status from store immediately (before event drain).
    try {
      const { computeRunStateFromRow } = await import("@smthrs/db/runState");
      const { deriveTailStatus } = await import("./tail.js");
      const derived = deriveTailStatus(await computeRunStateFromRow(adapter, run));
      await onStatusBlock(derived ?? run.status);
    } catch {
      await onStatusBlock(run.status);
    }

    /** @type {{ stop: () => void } | undefined} */
    let keyControls;
    const exitCtx = () => ({
      nodeHud,
      cleanup,
      keyControls,
    });
    keyControls = steerEligible
      ? attachTailKeyControls({
          runId,
          nodeId,
          cliEntry,
          // Hijack (`h`) aborts every in-flight sibling agent; let the pane
          // refuse instead of silently killing them (see tail.js takeover).
          inFlightSiblings: () => countInFlightAgentSiblings(adapter, runId, nodeId),
          onClose: () => {
            cancelledByKey = true;
            // Fire-and-forget: close herdr tab + exit so the pane is not left grey.
            void exitDetailClean(exitCtx());
          },
          // Inline steer — no full CLI spawn under the alt-screen HUD.
          enqueue: (message) => {
            void (async () => {
              try {
                const queued = await Effect.runPromise(
                  enqueueSteer(adapter, runId, nodeId, message, {
                    author: "supervisor",
                  }),
                );
                nodeHud?.setMeta({
                  note: `steer queued · ${queued.steerId.slice(0, 12)}…`,
                });
                nodeHud?.setDock("idle");
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                nodeHud?.pushBanner(`steer failed: ${msg}`);
                nodeHud?.setMeta({ note: "steer failed" });
              }
            })();
          },
          emit: (t) => nodeHud?.pushBody(t),
          onSteerOutput: (t) => {
            const s = String(t).trim();
            if (!s) return;
            // Collapse multi-line CLI/Claude errors into a short banner so the
            // header/dock layout is not shoved off-screen (prior hijack failures
            // painted the full "deferred tool marker" wall and cut the top).
            const one = s
              .replace(/\s+/g, " ")
              .replace(/^\[smithers\]\s*/i, "")
              .slice(0, 160);
            if (/error|failed|not found|HIJACK|deferred tool/i.test(s)) {
              nodeHud?.setBanner(one);
              nodeHud?.setMeta({ note: "hijack failed — try again or q close" });
              nodeHud?.paint();
            } else {
              nodeHud?.setMeta({ note: one.slice(0, 100) });
            }
          },
          onDock: (state) => {
            if (!nodeHud) return;
            if (state.mode === "input") {
              nodeHud.setDock("input", state.buffer ?? "");
            } else if (state.mode === "linger") {
              nodeHud.setDock("linger");
            } else {
              nodeHud.setDock("idle");
              if (state.note) nodeHud.setMeta({ note: state.note });
            }
          },
        })
      : undefined;

    let finalStatus;
    try {
      finalStatus = await tailRunEvents(adapter, run, {
        nodeId,
        jsonl: false,
        follow: true,
        baseMs,
        emit: (text) => nodeHud?.pushBody(text),
        onStatusBlock,
        isCancelled: keyControls ? () => cancelledByKey : undefined,
      });
    } finally {
      keyControls?.stop();
    }

    if (!isTailActiveState(finalStatus) && !cancelledByKey) {
      nodeHud.setMeta({ status: finalStatus ?? "finished" });
      nodeHud.setDock("linger");
      nodeHud.pushBody(formatTailFinalStatusLine(runId, finalStatus));
      if (args.linger) {
        await lingerUntilClosed(
          steerEligible
            ? {
                steer: {
                  runId,
                  nodeId,
                  cliEntry,
                  // stdin+stdout inherit for interactive claude on success;
                  // stderr piped so failures land in the HUD banner.
                  stdio: ["inherit", "inherit", "pipe"],
                },
                suppressChromeHints: true,
                emit: (t) => {
                  const s = String(t).trim();
                  if (!s) return;
                  if (/hijack|taking over|no conversation|error|failed|HIJACK/i.test(s)) {
                    nodeHud?.pushBanner(s);
                    nodeHud?.setMeta({ note: "hijack failed — try again or q close" });
                  } else if (/steer|run finished/i.test(s)) {
                    nodeHud?.setMeta({ note: s });
                  }
                },
              }
            : {
                suppressChromeHints: true,
                emit: (t) => nodeHud?.pushBody(t),
              },
        );
      }
    }
  } catch (error) {
    const msg =
      error instanceof SmithersError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    process.stderr.write(`node-detail-entry failed: ${msg}\n`);
    try {
      if (!nodeHud) {
        nodeHud = createNodeHud({
          runId: args.runId ?? "?",
          nodeId: args.nodeId ?? "?",
        });
        nodeHud.enter();
      }
      nodeHud.setMeta({ status: "error", note: msg });
      nodeHud.pushBody(`error: ${msg}`);
      nodeHud.setDock("linger");
      await new Promise((r) => setTimeout(r, 3000));
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    try {
      nodeHud?.exit();
    } catch {
      /* ignore */
    }
    cleanup?.();
  }
}

await main();
