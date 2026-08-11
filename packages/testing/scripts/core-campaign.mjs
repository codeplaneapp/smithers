#!/usr/bin/env bun
/**
 * Core scenario campaign CLI (gates B/C machine side + human watch).
 *
 * Usage:
 *   bun scripts/core-campaign.mjs
 *   bun scripts/core-campaign.mjs --herdr --session smithers-dev --fresh
 *   bun scripts/core-campaign.mjs --herdr --watch-pack --session smithers-dev \
 *     --fresh --pause-ms 4000
 *   bun scripts/core-campaign.mjs --herdr --session smithers-dev --cleanup
 *
 * With --herdr, workspaces are LEFT OPEN after each scenario so a human can
 * inspect herdr. Pass --cleanup to close campaign workspaces when the campaign ends.
 *
 * IMPORTANT: open the SAME session in the UI, e.g.:
 *   herdr --session smithers-dev
 * Plain `herdr` is the default session and will look empty while this campaign
 * writes into smithers-dev.
 */
import { createHerdrClient } from "@smthrs/herdr";
import { runCampaign } from "../src/campaign.ts";
import {
	tryCloseCampaignHerdrWorkspaces,
	tryCloseHerdrWorkspacesForRun,
	tryOpenHerdrClient,
} from "../src/herdrBridge.ts";
import { watchPackScenarios } from "./watch-pack.mjs";

function parseArgs(argv) {
	const out = {
		herdr: false,
		session: undefined,
		watchPack: false,
		repeat: 1,
		pauseMs: 0,
		pauseMsSet: false,
		iterationPauseMs: 500,
		onFail: "stop",
		only: undefined,
		cleanup: false,
		/** Close prior core-* / camp-* workspaces before the suite (default: on with --herdr). */
		fresh: undefined,
		/** Close previous scenario workspace before the next one. */
		resetBetween: false,
		/** Fail if herdr is unreachable when --herdr (default: on with --herdr). */
		requireHerdr: undefined,
		/**
		 * Live smithers tail + 2–5s pacing (default on with --herdr).
		 * Pass --stub-panes for sleep-only panes (machine-style).
		 */
		liveUi: undefined,
		help: false,
		/** True when user only wants cleanup, no suite run. */
		cleanupOnly: false,
		/**
		 * Operator-first dual-control: dock into the focused herdr workspace
		 * (left = human harness, right = overview HUD). No auto-spawn grok.
		 */
		ops: false,
		/**
		 * Which visibility plane to attach: engine (none), herdr (mirror).
		 * Default: herdr if --herdr/--ops, else engine.
		 */
		plane: undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--herdr") out.herdr = true;
		else if (a === "--watch-pack") out.watchPack = true;
		else if (a === "--cleanup") out.cleanup = true;
		else if (a === "--fresh") out.fresh = true;
		else if (a === "--no-fresh") out.fresh = false;
		else if (a === "--reset-between") out.resetBetween = true;
		else if (a === "--require-herdr") out.requireHerdr = true;
		else if (a === "--allow-missing-herdr") out.requireHerdr = false;
		else if (a === "--live-ui") out.liveUi = true;
		else if (a === "--stub-panes") out.liveUi = false;
		else if (a === "--ops") out.ops = true;
		else if (a === "--plane") out.plane = argv[++i];
		else if (a.startsWith("--plane=")) out.plane = a.slice("--plane=".length);
		else if (a === "--session") out.session = argv[++i];
		else if (a.startsWith("--session=")) out.session = a.slice("--session=".length);
		else if (a === "--repeat") out.repeat = Number(argv[++i] || 1);
		else if (a.startsWith("--repeat=")) out.repeat = Number(a.slice("--repeat=".length));
		else if (a === "--pause-ms") {
			out.pauseMs = Number(argv[++i] || 0);
			out.pauseMsSet = true;
		} else if (a.startsWith("--pause-ms=")) {
			out.pauseMs = Number(a.slice("--pause-ms=".length));
			out.pauseMsSet = true;
		} else if (a === "--iteration-pause-ms") out.iterationPauseMs = Number(argv[++i] || 0);
		else if (a === "--on-fail") out.onFail = argv[++i] === "continue" ? "continue" : "stop";
		else if (a === "--only")
			out.only = String(argv[++i] || "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		else if (a === "--help" || a === "-h") out.help = true;
	}
	// Plane resolution: explicit --plane wins; else herdr/--ops → herdr, else engine
	const planeRaw = typeof out.plane === "string" ? out.plane.toLowerCase() : undefined;
	if (planeRaw === "herdr" || planeRaw === "engine") {
		out.plane = planeRaw;
	} else if (out.ops || out.herdr) {
		out.plane = "herdr";
	} else {
		out.plane = "engine";
	}
	if (out.plane === "herdr") {
		out.herdr = true;
	} else {
		out.herdr = false;
		out.ops = false;
	}
	// Defaults for human-watch herdr mode
	if (out.herdr) {
		if (out.fresh === undefined) out.fresh = !out.ops; // ops reuses one workspace
		if (out.requireHerdr === undefined) out.requireHerdr = true;
		if (out.liveUi === undefined) out.liveUi = true;
		if (!out.pauseMsSet) out.pauseMs = 5000;
	}
	if (out.ops) {
		out.herdr = true;
		out.plane = "herdr";
		if (out.liveUi === undefined) out.liveUi = true;
	}
	// `… --session X --cleanup` with no suite flags → cleanup only
	const suiteFlags =
		out.herdr ||
		out.watchPack ||
		(out.only && out.only.length) ||
		out.repeat > 1 ||
		out.pauseMsSet;
	if (out.cleanup && !suiteFlags) out.cleanupOnly = true;
	return out;
}

function printHelp() {
	console.log(`core-campaign — token-free scenario campaign (engine ± herdr)

Options:
  --herdr                 Attach herdr mirror (required unless --allow-missing-herdr)
  --session NAME          Herdr session (must match the UI: herdr --session NAME)
  --watch-pack            Run the watch-pack subset (hello, sequence, parallel)
  --fresh                 Close prior core-*/camp-* workspaces before start (default with --herdr)
  --no-fresh              Keep prior campaign workspaces
  --reset-between         Close each scenario's workspace before starting the next
  --live-ui               Real smithers supervisor + node tails + 2–5s pacing (default with --herdr)
  --stub-panes            Sleep-only panes (fast machine mode; empty cockpit)
  --ops                   Operator-first: dock into focused herdr workspace
                          (left = your harness, right = smithers supervisor; no spawn)
  --plane engine|herdr    Visibility plane (default: engine, or herdr with --herdr/--ops)
  --repeat N              Repeat full catalog N times (default 1)
  --pause-ms N            Pause between scenarios (default 5000 with --herdr)
  --iteration-pause-ms N  Pause between catalog iterations
  --on-fail stop|continue (default stop)
  --only id,id            Filter scenario ids
  --cleanup               Close campaign workspaces at end
  --allow-missing-herdr   Soft-skip if herdr server is down
  -h, --help              This help

Human watch (two terminals):
  # Terminal A — UI (same session name!)
  herdr --session smithers-dev

  # Terminal B — campaign
  bun packages/testing/scripts/core-campaign.mjs \\
    --herdr --watch-pack --session smithers-dev --fresh --pause-ms 4000
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	printHelp();
	process.exit(0);
}

// Default to watch-pack for herdr campaigns; full pack can expand later.
const scenarios = args.watchPack || args.herdr ? watchPackScenarios : watchPackScenarios;

/** @type {import("../src/herdrBridge.ts").HerdrBridgeClient | null} */
let herdrClient = null;
let herdrSocketPath = null;

if (args.herdr) {
	herdrClient = await tryOpenHerdrClient({ session: args.session });
	if (!herdrClient) {
		const probe = createHerdrClient({ session: args.session, logger: () => {} });
		herdrSocketPath = probe.socketPath;
		const msg = `[campaign] FATAL: no herdr server at ${herdrSocketPath}
  Open the UI first with the SAME session:
    herdr --session ${args.session ?? "default"}
  (Plain \`herdr\` without --session is a different empty session.)`;
		if (args.requireHerdr) {
			console.error(msg);
			process.exit(2);
		}
		console.warn(msg.replace("FATAL", "WARN") + "\n  Continuing without mirror (--allow-missing-herdr).");
	} else {
		herdrSocketPath = herdrClient.socketPath;
		const sessionName = args.session ?? "default";
		if (args.ops) {
			process.env.SMITHERS_HERDR_DOCK = "1";
			console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  OPS MODE — operator-owned dual-control                          ║
║                                                                  ║
║  1. herdr --session ${sessionName.padEnd(42)}║
║  2. Focus workspace "smithers-ops" (setup-ops-workspace.mjs)     ║
║  3. LEFT pane: your harness (grok)                               ║
║  4. RIGHT pane: overview HUD docks here                          ║
║                                                                  ║
║  Dock: SMITHERS_HERDR_DOCK=1 (focused workspace)                 ║
╚══════════════════════════════════════════════════════════════════╝
`);
		} else {
			console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  HERDR WATCH — open THIS session in your terminal UI             ║
║                                                                  ║
║    herdr --session ${sessionName.padEnd(44)}║
║                                                                  ║
║  Socket: ${String(herdrSocketPath).slice(0, 54).padEnd(54)}║
║  Plain \`herdr\` (no --session) is EMPTY and is NOT this run.     ║
╚══════════════════════════════════════════════════════════════════╝
`);
		}
		if (args.fresh) {
			const closed = await tryCloseCampaignHerdrWorkspaces(herdrClient);
			console.log(`[campaign] fresh: closed ${closed} prior campaign workspace(s)`);
			// Brief beat so the UI settles on empty sidebar
			await new Promise((r) => setTimeout(r, 400));
		}
	}
}

// Cleanup-only mode (no suite)
if (args.cleanupOnly) {
	herdrClient = herdrClient ?? (await tryOpenHerdrClient({ session: args.session }));
	if (!herdrClient) {
		console.error(
			`[campaign] cleanup: herdr not reachable (try: herdr --session ${args.session ?? "default"})`,
		);
		process.exit(2);
	}
	const closed = await tryCloseCampaignHerdrWorkspaces(herdrClient);
	console.log(`[campaign] cleanup closed ${closed} campaign workspace(s)`);
	process.exit(0);
}

// Live UI: one shared smithers.db for the whole campaign so a single long-lived
// `smithers supervisor --db …` (herdr right pane or bare TTY) fleet-watches every scenario.
// Machine/stub mode keeps per-scenario temp DBs (isolation).
if (args.liveUi === true && !process.env.SMITHERS_CAMPAIGN_DB) {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "smithers-camp-shared-"));
	process.env.SMITHERS_CAMPAIGN_DB = join(root, "smithers.db");
}
if (process.env.SMITHERS_CAMPAIGN_DB) {
	console.log(`[campaign] shared store ${process.env.SMITHERS_CAMPAIGN_DB}`);
	console.log(
		`[campaign] fleet board: bun apps/cli/src/index.js top --db ${process.env.SMITHERS_CAMPAIGN_DB}`,
	);
}

console.log(`[campaign] plane=${args.plane} herdr=${Boolean(args.herdr)} ops=${Boolean(args.ops)}`);

const report = await runCampaign({
	scenarios,
	repeat: args.repeat,
	pauseMs: args.pauseMs,
	iterationPauseMs: args.iterationPauseMs,
	herdr: args.herdr,
	herdrSession: args.session,
	onFail: args.onFail,
	only: args.only,
	requireHerdr: args.herdr && args.requireHerdr,
	liveUi: args.liveUi === true,
	// Ops: dock into focused workspace; no auto-spawn harness
	opsMode: args.ops === true,
	resetBetween: args.resetBetween,
	log: (msg) => console.log(msg),
	async onScenarioStart({ scenario, iteration }) {
		if (args.resetBetween && herdrClient) {
			const closed = await tryCloseCampaignHerdrWorkspaces(herdrClient);
			if (closed > 0) {
				console.log(
					`[campaign] reset-between: closed ${closed} workspace(s) before ${scenario.id} (iter ${iteration})`,
				);
				await new Promise((r) => setTimeout(r, 300));
			}
		}
	},
});

if (args.herdr && args.cleanup && herdrClient) {
	const closed = await tryCloseCampaignHerdrWorkspaces(herdrClient);
	// also by run ids for safety
	const runIds = report.results.map((r) => r.runId).filter(Boolean);
	let byRun = 0;
	for (const runId of runIds) {
		byRun += await tryCloseHerdrWorkspacesForRun(herdrClient, runId);
	}
	console.log(`[campaign] cleanup closed ${closed + byRun} workspace(s)`);
}

if (args.herdr && !args.cleanup) {
	const sessionName = args.session ?? "default";
	console.log(`
[campaign] herdr workspaces left open for human inspection.
  UI must be:  herdr --session ${sessionName}
  Socket:      ${herdrSocketPath ?? "(unknown)"}
  List:        HERDR_SESSION=${sessionName} herdr workspace list
  Cleanup:     bun packages/testing/scripts/core-campaign.mjs --session ${sessionName} --cleanup
`);
}

process.exit(report.ok ? 0 : 1);
