/**
 * Watch-pack: plane-agnostic scenario ids optimized for human visibility.
 *
 * Same catalog for engine-only campaign, herdr bridge, ops dock, or future HUD
 * plane. Kept as .mjs so the campaign CLI can import without a full TS build.
 *
 * IDs (stable): hello | sequence | parallel
 *
 * Plane attach is optional via campaign ctx:
 *   - herdr liveUi: real `smithers supervisor` (overview) + `tail --node --hud`,
 *     against a campaign store named `smithers.db`
 *   - opsMode: dock focused workspace (left harness, right workflow supervisor); no harness spawn
 *   - machine herdr-bridge tests: stub panes + virtual clock (soft-skip if no server)
 *
 * Shared campaign store: set `SMITHERS_CAMPAIGN_DB` (absolute path to smithers.db)
 * so every scenario writes into one DB and one long-lived `smithers supervisor --db …`
 * can fleet-watch the whole campaign. core-campaign.mjs sets this for liveUi.
 *
 * @see docs/guides/token-free-visibility-testing.mdx
 * @see docs/guide/workflow-supervisor.mdx
 */

/** Stable watch-pack scenario ids (importable by other planes later). */
export const WATCH_PACK_IDS = Object.freeze(["hello", "sequence", "parallel"]);
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, dirname as pathDirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { z } from "zod";
import { SmithersDb } from "@smthrs/db/adapter";
import {
	createVirtualClock,
	expectNodeState,
	runScenario,
	scriptedAgent,
	loadAgentTraceVector,
} from "../src/index.ts";
import {
	tryCreateHerdrBridge,
	assertHerdrBridge,
	tryCloseHerdrWorkspacesForRun,
	focusHerdrWorkspaceByLabel,
} from "../src/herdrBridge.ts";

/**
 * `smthrs` is an optional peer of `@smthrs/testing` — depending on it outright
 * would close a publish-time cycle (smthrs → @smthrs/testing → smthrs). Only
 * the watch-pack scenarios need the facade, so load it lazily and turn the
 * not-installed case into an actionable error instead of ERR_MODULE_NOT_FOUND.
 *
 * @type {Promise<typeof import("smthrs")> | undefined}
 */
let smthrsPromise;

async function loadSmthrs() {
	if (!smthrsPromise) {
		smthrsPromise = import("smthrs").catch((error) => {
			smthrsPromise = undefined;
			throw new Error(
				'watch-pack needs the optional peer "smthrs". Install it with `npm install smthrs` ' +
					`(it is an optional peerDependency of @smthrs/testing). Original error: ${
						error instanceof Error ? error.message : String(error)
					}`,
			);
		});
	}
	return smthrsPromise;
}

const HERE = pathDirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../fixtures/agent-traces");
/** apps/cli/src/index.js — same entry production herdr panes use in a checkout. */
const CLI_PATH = join(HERE, "../../../apps/cli/src/index.js");
const outSchema = z.object({ summary: z.string(), ok: z.boolean() });

/**
 * Human-visible simulated LLM think time (real wall clock when herdr).
 * Window is long enough to press `s` on a node tab and type a mid-run steer.
 */
const HUMAN_PACING = { minMs: 4000, maxMs: 8000 };

function load(name) {
	return loadAgentTraceVector(join(FIXTURES, `${name}.v1.json`));
}

/**
 * Campaign store: always `smithers.db` so CLI find-db / `top --db` work.
 * When `SMITHERS_CAMPAIGN_DB` is set (live campaigns), all scenarios share one
 * file so a single long-lived `smithers supervisor` can fleet-watch the catalog.
 * (createTestSmithers uses db.sqlite, which the CLI never finds.)
 */
async function createCampaignSmithers(schemas) {
	const { createSmithers } = await loadSmthrs();
	const shared = process.env.SMITHERS_CAMPAIGN_DB;
	let dbPath;
	if (typeof shared === "string" && shared !== "") {
		dbPath = shared;
		mkdirSync(dirname(dbPath), { recursive: true });
	} else {
		const dir = mkdtempSync(join(tmpdir(), "smithers-camp-"));
		dbPath = join(dir, "smithers.db");
	}
	const api = createSmithers(schemas, { dbPath });
	return {
		...api,
		dbPath,
		rootDir: dirname(dbPath),
		cleanup: () => {
			try {
				api.db?.$client?.close?.();
			} catch {
				/* ignore */
			}
		},
	};
}

async function runInRoot(workflow, dbPath, opts) {
	const { runWorkflow } = await loadSmthrs();
	return Effect.runPromise(
		runWorkflow(workflow, {
			...opts,
			rootDir: dirname(dbPath),
		}),
	);
}

function makeAgent(vectorName, { clock, id, liveUi }) {
	return scriptedAgent(load(vectorName), {
		clock,
		schema: outSchema,
		id,
		pacing: liveUi ? HUMAN_PACING : undefined,
	});
}

/**
 * @param {import("../src/campaign.ts").CampaignRunContext} ctx
 * @param {string} id
 * @param {(args: any) => Promise<{ runId: string }>} body
 */
async function withHarness(ctx, id, body) {
	const runId = `${ctx.campaignId}-${id}-i${ctx.iteration}`;
	const label = `core-${id} ${runId}`;
	const { result, herdrAttached } = await body({ runId, label, ctx });
	return { runId: result?.runId ?? runId, herdr: herdrAttached };
}

async function runEngineWithOptionalHerdr(ctx, {
	runId,
	label,
	workflow,
	dbPath,
	assertEngine,
	assertHerdr,
	clock,
}) {
	let bridge = null;
	let herdrAttached = false;
	// Pacing / real-time is independent of herdr: --live-ui alone is enough for top review.
	const liveUi = Boolean(ctx.liveUi);
	if (ctx.herdr) {
		const herdrLive = liveUi; // real panes only when liveUi
		bridge = await tryCreateHerdrBridge({
			session: ctx.herdrSession,
			workspaceLabel: label,
			cwd: dirname(dbPath),
			runId,
			// Human: real smithers supervisor/tail. Machine: sleep stubs (fast).
			stubPanes: !herdrLive,
			cliPath: herdrLive ? CLI_PATH : undefined,
			// Live: first engine event creates workspace after run row exists
			attachEagerly: !herdrLive,
			focusWorkspace: true,
			// Ops / dock: human owns left harness. Spawn path B only when not ops.
			chrome: herdrLive ? "split" : "tabs",
			harnessCommand: herdrLive && !ctx.opsMode ? "auto" : "none",
			dock: herdrLive && ctx.opsMode ? true : undefined,
			renameWorkspaceOnDock: false,
			logger: (level, msg) => ctx.log(`[herdr] ${msg}`),
		});
		herdrAttached = Boolean(bridge);
		if (!bridge) {
			const hint = `herdr --session ${ctx.herdrSession ?? "default"}`;
			if (ctx.requireHerdr) {
				throw new Error(
					`herdr mirror required but unreachable for ${runId}. Open UI: ${hint}`,
				);
			}
			ctx.log(`[herdr] soft-skip mirror for ${runId} (start with: ${hint})`);
		} else if (herdrLive) {
			const dockHint = ctx.opsMode
				? "ops dock — focused workspace left=your harness, right=smithers supervisor"
				: process.env.HERDR_ENV === "1" || process.env.SMITHERS_HERDR_DOCK === "1"
					? "dock into focused pane (smithers supervisor on right)"
					: "spawn path B (optional harness left + smithers supervisor right)";
			ctx.log(
				`[herdr] LIVE UI session=${ctx.herdrSession ?? "default"} label=${label}`,
			);
			ctx.log(`[herdr] ${dockHint}`);
			ctx.log(`[herdr] cwd=${dirname(dbPath)} · smithers supervisor + node tails · 4–8s pacing`);
			ctx.log(
				`[herdr] cockpit: left=harness  right=smithers supervisor --db ${dbPath}`,
			);
			ctx.log(
				`[herdr] standalone (any TTY): smithers supervisor --db ${dbPath}`,
			);
		} else {
			ctx.log(
				`[herdr] stub panes session=${ctx.herdrSession ?? "default"} label=${label}`,
			);
		}
	} else if (liveUi) {
		ctx.log(`[campaign] liveUi pacing (no herdr) · db=${dbPath}`);
	}
	try {
		const result = await runScenario({
			workflow,
			runId,
			rootDir: dirname(dbPath),
			clock,
			onProgress: bridge ? bridge.onProgress : undefined,
			runWorkflowFn: (wf, opts) => runInRoot(wf, dbPath, opts),
		});
		if (assertEngine) await assertEngine(result);
		if (bridge && assertHerdr) {
			// Drain the surface's serialized RPC queue before reading daemon state.
			await bridge.surface.close();
			await assertHerdr(bridge);
			await focusHerdrWorkspaceByLabel(bridge.client, {
				workspaceLabel: label,
				runId,
			});
		}
		return { result, herdrAttached };
	} finally {
		if (bridge) {
			await bridge.close();
			// Leave workspaces open for human watch when herdr mode; campaign can clean.
			if (!liveUi) {
				await tryCloseHerdrWorkspacesForRun(bridge.client, runId);
			}
		}
	}
}

/** Watch-pack: high-signal scenarios for herdr dual-loop + machine oracles. */
export const watchPackScenarios = [
	{
		id: "hello",
		title: "single agent task finishes",
		async run(ctx) {
			return withHarness(ctx, "hello", async ({ runId, label }) => {
				const liveUi = Boolean(ctx.liveUi);
				const clock = createVirtualClock({ mode: liveUi ? "real" : "virtual" });
				const agent = makeAgent("hello-ok", { clock, id: "hello", liveUi });
				const { Workflow, Task } = await loadSmthrs();
				const { smithers, outputs, db, dbPath, cleanup } = await createCampaignSmithers({
					hello: outSchema,
				});
				try {
					const { createElement } = await import("react");
					const wf = smithers(() =>
						createElement(
							Workflow,
							{ name: "camp-hello" },
							createElement(
								Task,
								{ id: "hello", output: outputs.hello, agent, retries: 0 },
								"say hello",
							),
						),
					);
					const out = await runEngineWithOptionalHerdr(ctx, {
						runId,
						label,
						workflow: wf,
						dbPath,
						clock,
						assertEngine: async () => {
							await expectNodeState(new SmithersDb(db), runId, "hello", "finished");
						},
						assertHerdr: async (bridge) => {
							await assertHerdrBridge(bridge.client, {
								workspaceLabel: label,
								runId,
								expectCockpit: true,
								mustIncludeTabLabels: ["hello"],
								maxDetailTabs: 3,
							});
						},
					});
					return out;
				} finally {
					cleanup();
				}
			});
		},
	},
	{
		id: "sequence",
		title: "implement then validate",
		async run(ctx) {
			return withHarness(ctx, "sequence", async ({ runId, label }) => {
				const liveUi = Boolean(ctx.liveUi);
				const clock = createVirtualClock({ mode: liveUi ? "real" : "virtual" });
				const implement = makeAgent("pipeline-implement", {
					clock,
					id: "implement",
					liveUi,
				});
				const validate = makeAgent("pipeline-validate", {
					clock,
					id: "validate",
					liveUi,
				});
				const { Workflow, Task, Sequence } = await loadSmthrs();
				const { smithers, outputs, db, dbPath, cleanup } = await createCampaignSmithers({
					implement: outSchema,
					validate: outSchema,
				});
				try {
					const { createElement } = await import("react");
					const wf = smithers(() =>
						createElement(
							Workflow,
							{ name: "camp-sequence" },
							createElement(
								Sequence,
								null,
								createElement(
									Task,
									{ id: "implement", output: outputs.implement, agent: implement, retries: 0 },
									"impl",
								),
								createElement(
									Task,
									{ id: "validate", output: outputs.validate, agent: validate, retries: 0 },
									"val",
								),
							),
						),
					);
					return await runEngineWithOptionalHerdr(ctx, {
						runId,
						label,
						workflow: wf,
						dbPath,
						clock,
						assertEngine: async () => {
							const adapter = new SmithersDb(db);
							await expectNodeState(adapter, runId, "implement", "finished");
							await expectNodeState(adapter, runId, "validate", "finished");
						},
						assertHerdr: async (bridge) => {
							const snap = await assertHerdrBridge(bridge.client, {
								workspaceLabel: label,
								runId,
								expectCockpit: true,
								maxDetailTabs: 4,
							});
							ctx.log(`[herdr] tabs=${snap.tabs.map((t) => t.label).join(",")}`);
						},
					});
				} finally {
					cleanup();
				}
			});
		},
	},
	{
		id: "parallel",
		title: "four workers, one hard-fail (soft-pin workers)",
		async run(ctx) {
			return withHarness(ctx, "parallel", async ({ runId, label }) => {
				const liveUi = Boolean(ctx.liveUi);
				const clock = createVirtualClock({ mode: liveUi ? "real" : "virtual" });
				const ok = () => makeAgent("worker-ok", { clock, liveUi });
				const bad = scriptedAgent(load("worker-fail"), {
					clock,
					schema: outSchema,
					id: "boom",
					pacing: liveUi ? HUMAN_PACING : undefined,
				});
				const { Workflow, Task, Parallel } = await loadSmthrs();
				const { smithers, outputs, db, dbPath, cleanup } = await createCampaignSmithers({
					shard: outSchema,
				});
				try {
					const { createElement } = await import("react");
					const wf = smithers(() =>
						createElement(
							Workflow,
							{ name: "camp-parallel" },
							createElement(
								Parallel,
								null,
								createElement(Task, { id: "worker-01", output: outputs.shard, agent: ok(), retries: 0 }, "w1"),
								createElement(Task, { id: "worker-02", output: outputs.shard, agent: ok(), retries: 0 }, "w2"),
								createElement(Task, { id: "worker-03", output: outputs.shard, agent: bad, retries: 0 }, "w3"),
								createElement(Task, { id: "worker-04", output: outputs.shard, agent: ok(), retries: 0 }, "w4"),
							),
						),
					);
					return await runEngineWithOptionalHerdr(ctx, {
						runId,
						label,
						workflow: wf,
						dbPath,
						clock,
						assertEngine: async () => {
							await expectNodeState(new SmithersDb(db), runId, "worker-03", "failed");
						},
						assertHerdr: async (bridge) => {
							const snap = await assertHerdrBridge(bridge.client, {
								workspaceLabel: label,
								runId,
								expectCockpit: true,
								mustIncludeTabLabels: ["worker-03"],
								mustExcludeTabLabels: ["worker-01", "worker-02", "worker-04"],
								maxDetailTabs: 2,
							});
							ctx.log(`[herdr] tabs=${snap.tabs.map((t) => t.label).join(",")}`);
						},
					});
				} finally {
					cleanup();
				}
			});
		},
	},
];
