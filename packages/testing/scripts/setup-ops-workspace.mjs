#!/usr/bin/env bun
/**
 * Prepare an operator-owned herdr workspace for the dual-control flow:
 *
 *   left  = empty shell (you start `grok` / `claude` / …)
 *   right = placeholder until a smithers run docks the overview HUD
 *
 * Usage:
 *   herdr --session smithers-dev          # Terminal A first
 *   bun packages/testing/scripts/setup-ops-workspace.mjs --session smithers-dev
 *
 * Then focus the LEFT pane, run `grok`, and start a campaign with:
 *   SMITHERS_HERDR_DOCK=1 bun packages/testing/scripts/core-campaign.mjs \
 *     --herdr --watch-pack --session smithers-dev --ops --fresh
 */
import { createHerdrClient } from "@smthrs/herdr";

function parseArgs(argv) {
	const out = { session: undefined, label: "smithers-ops", help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--session") out.session = argv[++i];
		else if (a.startsWith("--session=")) out.session = a.slice("--session=".length);
		else if (a === "--label") out.label = argv[++i] ?? "smithers-ops";
		else if (a === "--help" || a === "-h") out.help = true;
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	console.log(`setup-ops-workspace — left shell + right placeholder for smithers overview

  --session NAME   Herdr session (must match the UI)
  --label TEXT     Workspace label (default: smithers-ops)
`);
	process.exit(0);
}

const client = createHerdrClient({ session: args.session, logger: () => {} });
const pong = await client.ping().catch(() => undefined);
if (!pong) {
	console.error(`[ops] no herdr at ${client.socketPath}
  Open first:  herdr --session ${args.session ?? "default"}`);
	process.exit(2);
}

const list = /** @type {any} */ (await client.tryCall("workspace.list", {}));
const existing = (list?.workspaces ?? []).find((w) => w && w.label === args.label);
/** @type {string | undefined} */
let workspaceId = existing?.workspace_id;
/** @type {string | undefined} */
let leftPaneId;
/** @type {string | undefined} */
let tabId;

if (workspaceId) {
	console.log(`[ops] reusing workspace ${workspaceId} (${args.label})`);
	await client.tryCall("workspace.focus", { workspace_id: workspaceId });
	const tabs = /** @type {any} */ (
		await client.tryCall("tab.list", { workspace_id: workspaceId })
	);
	tabId = tabs?.tabs?.[0]?.tab_id;
	const panes = /** @type {any} */ (await client.tryCall("pane.list", {}));
	const onTab = (panes?.panes ?? []).filter((p) => p.tab_id === tabId);
	leftPaneId = onTab[0]?.pane_id;
} else {
	const created = /** @type {any} */ (
		await client.tryCall("workspace.create", {
			label: args.label,
			focus: true,
			cwd: process.cwd(),
		})
	);
	workspaceId = created?.workspace?.workspace_id;
	tabId = created?.tab?.tab_id;
	leftPaneId = created?.root_pane?.pane_id;
	console.log(`[ops] created workspace ${workspaceId} (${args.label})`);
}

if (!workspaceId || !leftPaneId || !tabId) {
	console.error("[ops] failed to resolve workspace/pane");
	process.exit(1);
}

await client.tryCall("tab.rename", { tab_id: tabId, label: "cockpit" });

// Ensure 50/50 vertical split
const layout = /** @type {any} */ (
	await client.tryCall("pane.layout", { pane_id: leftPaneId })
);
const paneCount = layout?.layout?.panes?.length ?? 1;
/** @type {string | undefined} */
let rightPaneId;
if (paneCount < 2) {
	const split = /** @type {any} */ (
		await client.tryCall("pane.split", {
			direction: "right",
			ratio: 0.5,
			target_pane_id: leftPaneId,
			focus: false,
		})
	);
	rightPaneId = split?.pane?.pane_id;
	console.log(`[ops] split right → ${rightPaneId}`);
} else {
	const sorted = [...(layout.layout.panes || [])].sort(
		(a, b) => (a.rect?.x ?? 0) - (b.rect?.x ?? 0),
	);
	leftPaneId = sorted[0]?.pane_id ?? leftPaneId;
	rightPaneId = sorted[sorted.length - 1]?.pane_id;
	console.log(`[ops] already split left=${leftPaneId} right=${rightPaneId}`);
}

// Placeholder on the right until a run docks `smithers supervisor` (portable board).
// Optional: pre-start top against a shared campaign DB if SMITHERS_CAMPAIGN_DB is set.
if (rightPaneId) {
	const campaignDb = process.env.SMITHERS_CAMPAIGN_DB;
	const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
	const lines = campaignDb
		? ["", "  smithers supervisor will dock here", "  or run now:", `    smithers supervisor --db ${campaignDb}`, ""]
		: [
				"",
				"  ╔══════════════════════════════════════════════════╗",
				"  ║  smithers supervisor (waiting for a run)                ║",
				"  ║  left  = your harness (run: grok)                ║",
				"  ║  right = this pane → smithers supervisor when a run docks║",
				"  ╚══════════════════════════════════════════════════╝",
				"",
			];
	const placeholder = `clear; printf '%s\\n' ${lines.map(quote).join(" ")}\n`;
	await client.tryCall("pane.send_text", {
		pane_id: rightPaneId,
		text: placeholder,
	});
}

// Focus left so the human can type `grok`
await client.tryCall("pane.focus", { pane_id: leftPaneId }).catch(() => {});

console.log(`
[ops] ready — dual-control workspace

  UI session:  herdr --session ${args.session ?? "default"}
  Workspace:   ${args.label}  (${workspaceId})
  Left pane:   ${leftPaneId}  ← start your harness here:  grok
  Right pane:  ${rightPaneId ?? "?"}  ← overview HUD docks here

Next:
  1. Focus LEFT pane, run:  grok
  2. In another terminal:
       SMITHERS_HERDR_DOCK=1 bun packages/testing/scripts/core-campaign.mjs \\
         --herdr --watch-pack --session ${args.session ?? "default"} --ops --pause-ms 6000

  (Focus the ops workspace in herdr before step 2 so dock attaches there.)
`);
