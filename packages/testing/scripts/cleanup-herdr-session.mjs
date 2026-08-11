#!/usr/bin/env bun
/**
 * Clean a herdr session before a fresh vibe-check.
 *
 * Usage:
 *   # Soft: only campaign / ops fixtures (keeps poem/swarm/daily work)
 *   bun packages/testing/scripts/cleanup-herdr-session.mjs --session smithers-dev
 *
 *   # Hard: close ALL workspaces except "~"
 *   bun packages/testing/scripts/cleanup-herdr-session.mjs --session smithers-dev --all
 *
 *   # Nuclear: stop the named session entirely (next `herdr --session X` is fresh)
 *   bun packages/testing/scripts/cleanup-herdr-session.mjs --session smithers-dev --stop-session
 *
 *   # Nuclear + delete session state dir (if herdr supports delete)
 *   bun packages/testing/scripts/cleanup-herdr-session.mjs --session smithers-dev --delete-session
 */
import { spawnSync } from "node:child_process";
import { createHerdrClient } from "@smthrs/herdr";
import {
	isCampaignWorkspaceLabel,
	tryCloseCampaignHerdrWorkspaces,
} from "../src/herdrBridge.ts";

function parseArgs(argv) {
	const out = {
		session: undefined,
		all: false,
		stopSession: false,
		deleteSession: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--session") out.session = argv[++i];
		else if (a.startsWith("--session=")) out.session = a.slice("--session=".length);
		else if (a === "--all") out.all = true;
		else if (a === "--stop-session") out.stopSession = true;
		else if (a === "--delete-session") out.deleteSession = true;
		else if (a === "--help" || a === "-h") out.help = true;
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	console.log(`cleanup-herdr-session

  --session NAME       Herdr session (default: default socket)
  --all                Close every workspace except "~"
  --stop-session       herdr session stop NAME (fresh server next attach)
  --delete-session     herdr session delete NAME (after stop)
`);
	process.exit(0);
}

if ((args.stopSession || args.deleteSession) && !args.session && process.env.HERDR_SOCKET_PATH) {
	throw new Error("--session is required for stop/delete when HERDR_SOCKET_PATH is set");
}

const session = args.session ?? process.env.HERDR_SESSION;
const client = createHerdrClient({ session, logger: () => {} });
const pong = await client.ping().catch(() => undefined);
if (!pong) {
	console.error(
		`[cleanup] no herdr at ${client.socketPath}\n  Already clean, or start: herdr --session ${session ?? "default"}`,
	);
	// Still allow stop/delete via CLI if server is half-dead
} else {
	const list = /** @type {any} */ (await client.tryCall("workspace.list", {}));
	const workspaces = list?.workspaces ?? [];
	let closed = 0;
	for (const w of workspaces) {
		if (typeof w.workspace_id !== "string") continue;
		const label = String(w.label ?? "");
		const isHome = label === "~" || label === "";
		const isCampaign =
			isCampaignWorkspaceLabel(label) ||
			label === "smithers-ops" ||
			label.startsWith("hud-probe") ||
			label.startsWith("cockpit-split");
		if (args.all) {
			if (isHome) continue;
			await client.call("workspace.close", { workspace_id: w.workspace_id });
			console.log(`[cleanup] closed ${w.workspace_id}  ${label}`);
			closed += 1;
		} else if (isCampaign) {
			await client.call("workspace.close", { workspace_id: w.workspace_id });
			console.log(`[cleanup] closed ${w.workspace_id}  ${label}`);
			closed += 1;
		}
	}
	if (!args.all) {
		const n = await tryCloseCampaignHerdrWorkspaces(client);
		if (n > closed) closed = n;
	}
	console.log(`[cleanup] closed ${closed} workspace(s) (mode=${args.all ? "all-except-~" : "campaign+ops"})`);
}

if (args.stopSession || args.deleteSession) {
	const name = session ?? "default";
	const stop = spawnSync("herdr", ["session", "stop", name], { encoding: "utf8" });
	console.log(`[cleanup] session stop ${name}: exit=${stop.status}`);
	if (stop.stdout) process.stdout.write(stop.stdout);
	if (stop.stderr) process.stderr.write(stop.stderr);
	if (args.deleteSession) {
		const del = spawnSync("herdr", ["session", "delete", name], { encoding: "utf8" });
		console.log(`[cleanup] session delete ${name}: exit=${del.status}`);
		if (del.stdout) process.stdout.write(del.stdout);
		if (del.stderr) process.stderr.write(del.stderr);
	}
	console.log(`
[cleanup] session torn down.
  Restart UI:  herdr --session ${name}
  Then ops:    bun packages/testing/scripts/setup-ops-workspace.mjs --session ${name}
`);
} else {
	console.log(`
[cleanup] workspaces cleaned; session still running.
  Full reset:  bun packages/testing/scripts/cleanup-herdr-session.mjs --session ${session ?? "default"} --stop-session
`);
}
