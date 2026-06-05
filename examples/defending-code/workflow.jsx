/** @jsxImportSource smithers-orchestrator */
/**
 * defending-code: a Smithers port of Anthropic's
 * `defending-code-reference-harness`.
 *
 * The reference harness is a Python pipeline that finds and fixes memory-safety
 * bugs in C/C++ with Claude: build → recon → find → verify → dedupe → report →
 * patch. The bug signal is an AddressSanitizer (ASAN) crash, so findings are
 * execution-verified, not static guesses.
 *
 * This file expresses the same seven stages as a durable Smithers workflow:
 *
 *   build    compile the target with ASAN (compute step, no model)
 *   recon    one agent proposes input-parsing subsystems to probe
 *   find     N agents fan out, one per subsystem, crafting inputs until ASAN
 *            crashes the target 3/3 times
 *   verify   a separate agent reproduces each crash in a fresh process
 *   dedupe   a judge clusters verified crashes into unique root-cause bugs
 *   report   one agent per unique bug writes an exploitability analysis
 *   patch    one agent fixes every bug, rebuilds, and re-grades: PoCs no longer
 *            crash and the smoke test still passes
 *
 * The target is a deliberately-vulnerable toy parser (targets/card-parser). The
 * pipeline rediscovers its planted bugs by execution and patches a throwaway
 * copy, leaving the committed source pristine so the demo is repeatable.
 *
 * Run from this directory:  smithers up workflow.jsx -c 3
 * See README.md for setup, auth, and safety notes.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { ClaudeCodeAgent } from "@smithers-orchestrator/agents";
import { z } from "zod";
import { createExampleSmithers } from "../_example-kit.js";

const MODEL = process.env.DEFENDING_CODE_MODEL ?? "claude-sonnet-4-5";
const FANOUT = Number(process.env.DEFENDING_CODE_FANOUT ?? "3");
const TARGET_SRC = "targets/card-parser/src/card_parser.c";

// ---------------------------------------------------------------------------
// Output schemas. One per stage. Counts are integers (Smithers maps z.number()
// to an INTEGER column, so fractions would fail validation).
// ---------------------------------------------------------------------------
const buildSchema = z.object({
	ok: z.boolean(),
	binaryPath: z.string(),
	sourcePath: z.string(),
	log: z.string(),
});

const reconSchema = z.object({
	subsystems: z.array(
		z.object({
			id: z.string(), // short lowercase slug, e.g. "name"
			name: z.string(),
			hypothesis: z.string(),
		}),
	),
	notes: z.string(),
});

const findSchema = z.object({
	subsystemId: z.string(),
	crashed: z.boolean(),
	crashKind: z.string(), // ASAN class, or "none"
	crashSite: z.string(), // file:line in function
	pocPath: z.string(),
	pocInput: z.string(), // exact file contents that crash
	reproCount: z.number().int(), // crashes out of attempts
	attempts: z.number().int(),
});

const verifySchema = z.object({
	subsystemId: z.string(),
	reproduced: z.boolean(),
	reproCount: z.number().int(),
	crashKind: z.string(),
	crashSite: z.string(),
	note: z.string(),
});

const dedupeSchema = z.object({
	uniqueBugs: z.array(
		z.object({
			bugId: z.string(), // e.g. "BUG-1"
			crashKind: z.string(),
			crashSite: z.string(),
			rootCause: z.string(),
			representativeSubsystemId: z.string(),
			representativePoc: z.string(),
			duplicateCount: z.number().int(),
		}),
	),
	totalVerified: z.number().int(),
	totalUnique: z.number().int(),
});

const reportSchema = z.object({
	bugId: z.string(),
	title: z.string(),
	severity: z.enum(["low", "medium", "high", "critical"]),
	primitive: z.string(),
	reachability: z.string(),
	impact: z.string(),
	writeup: z.string(),
});

const patchSchema = z.object({
	filesChanged: z.array(z.string()),
	diff: z.string(),
	bugsFixed: z.array(
		z.object({ bugId: z.string(), pocNoLongerCrashes: z.boolean() }),
	),
	rebuildOk: z.boolean(),
	smokeTestOk: z.boolean(),
	allValidated: z.boolean(),
	note: z.string(),
});

const summarySchema = z.object({
	subsystemsProbed: z.number().int(),
	crashesFound: z.number().int(),
	verified: z.number().int(),
	uniqueBugs: z.number().int(),
	bugsFixed: z.number().int(),
	patchValidated: z.boolean(),
	headline: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
	build: buildSchema,
	recon: reconSchema,
	find: findSchema,
	verify: verifySchema,
	dedupe: dedupeSchema,
	report: reportSchema,
	patch: patchSchema,
	summary: summarySchema,
});

// ---------------------------------------------------------------------------
// Agents. All run headless via the Claude Code CLI (subscription auth). `yolo`
// skips interactive permission prompts so the agents can run bash/edit in the
// --print loop. The target is a trivially-safe toy, but see README.md: the
// reference harness sandboxes agents that execute target code, and so should a
// real port (Smithers <Worktree>/<Sandbox> + the network-isolated bash tool).
// ---------------------------------------------------------------------------
const agent = (systemPrompt) =>
	new ClaudeCodeAgent({ model: MODEL, yolo: true, systemPrompt });

const reconAgent = agent(
	"You are a security recon agent. You read C source and identify the " +
		"input-parsing subsystems most likely to contain memory-safety bugs. " +
		"You do not modify files.",
);
const findAgent = agent(
	"You are a vulnerability-discovery agent. You craft malformed inputs and " +
		"run a target under AddressSanitizer until it crashes, then minimize and " +
		"confirm the crash. You only write proof-of-concept input files; you never " +
		"edit the target source.",
);
const verifyAgent = agent(
	"You are an independent crash-verification agent (the grader). You " +
		"reproduce a reported crash from scratch in fresh processes and report " +
		"honestly whether it reproduces. You never edit the target source.",
);
const dedupeAgent = agent(
	"You are a triage judge. You compare verified crashes and cluster them into " +
		"unique bugs by root cause and crash site, separating genuinely distinct " +
		"bugs from duplicates.",
);
const reportAgent = agent(
	"You are a security analyst. You write concise, accurate exploitability " +
		"writeups for confirmed memory-safety bugs.",
);
const patchAgent = agent(
	"You are a security engineer. You fix memory-safety bugs with minimal, " +
		"idiomatic C changes, then prove the fix by rebuilding and re-running the " +
		"proof-of-concept inputs and the smoke test.",
);

// ---------------------------------------------------------------------------
// Prompts. The engine appends the exact JSON output contract for each task's
// schema, so these only describe the work.
// ---------------------------------------------------------------------------
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Keep the first item per key. Fan-out Task ids derive from model-authored
// strings; without this, two findings that slug to the same id would collide and
// throw DUPLICATE_ID at graph extraction, failing the whole run. Deduping keeps
// ids content-based (stable across the durable re-renders) and unique.
const uniqueBy = (arr, keyOf) => {
	const seen = new Set();
	return arr.filter((x) => {
		const k = keyOf(x);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
};

const reconPrompt = (work) => `Recon the target program before fuzzing.

Read the source at ${work}/card_parser.c and the target config at
targets/card-parser/config.yaml.

Identify the distinct input-parsing subsystems that an attacker-controlled input
file reaches. Each is a separate place where bytes from the file are copied or
stored. For every subsystem give a short lowercase slug id (e.g. "name"), a human
label, and a one-sentence hypothesis for why it might be memory-unsafe.

List each independent subsystem separately so they can be fuzzed in parallel. Do
not modify any files.`;

const findPrompt = (sub, work, binary) => `Find a memory-safety bug in ONE subsystem of the target.

Subsystem: ${sub.name} (id: ${sub.id})
Hypothesis: ${sub.hypothesis}

Binary (built with AddressSanitizer): ${binary}
Source (read-only): ${work}/card_parser.c

Run any input through the ASAN harness like this:
    sh harness/run_target.sh ${binary} <input-file>
It always exits 0 and prints a final status line:
    STATUS=CRASH KIND=<asan-class> EXIT=...   you triggered a memory bug
    STATUS=OK EXIT=0                          no crash, so refine and retry

The input is a line-based "contact card":
    NAME: <value>
    EMAIL: <value>
    TAGS: <comma,separated,list>

Steps:
1. Read ${work}/card_parser.c and study how the "${sub.id}" field is parsed.
2. Write a candidate input that targets the "${sub.id}" field to
   ${work}/poc-${sub.id}.card
3. Run it through the harness. If STATUS is not CRASH, refine (longer values,
   more list items) and try again.
4. Once it crashes, run it 3 more times and confirm it crashes all 3 times.
   Record the "SUMMARY: AddressSanitizer: <class>" line and the crash site
   (file:line in function).
5. Keep the PoC minimal. Report subsystemId="${sub.id}", whether it crashed, the
   ASAN class, the crash site, the PoC path, the exact PoC file contents, how
   many of your attempts reproduced, and the total attempts. If you genuinely
   cannot crash it, report crashed=false.`;

const verifyPrompt = (find, work, binary) => `Independently verify a reported crash. Do not trust the finder; reproduce
it yourself.

Reported by subsystem "${find.subsystemId}": ${find.crashKind} at ${find.crashSite}

The proof-of-concept input is:
-----
${find.pocInput}
-----

1. Write that exact input to ${work}/verify-${find.subsystemId}.card
2. Run it through the harness THREE times in fresh processes:
       sh harness/run_target.sh ${binary} ${work}/verify-${find.subsystemId}.card
3. Report reproduced=true only if all 3 runs print STATUS=CRASH with the same
   ASAN class. Report the class, the crash site, how many of the 3 runs crashed,
   and subsystemId="${find.subsystemId}".`;

const dedupePrompt = (verified) => `Cluster verified crashes into unique bugs.

Here are the verified findings (JSON):
${JSON.stringify(verified, null, 2)}

Two findings are the SAME bug if they share a root cause and crash site (e.g. the
same unbounded copy reached two ways). Findings at different sites/functions are
DIFFERENT bugs. Assign each unique bug an id ("BUG-1", "BUG-2", ...), its ASAN
class, crash site, a one-line root cause, the subsystem id of a representative
finding, that finding's PoC input, and how many verified findings collapsed into
it. Also report the total number of verified findings and the total unique bugs.`;

const reportPrompt = (bug, work) => `Write an exploitability analysis for one confirmed bug.

${bug.bugId}: ${bug.crashKind} at ${bug.crashSite}
Root cause: ${bug.rootCause}

Read the relevant code in ${work}/card_parser.c, then produce: a short title, a
severity (low | medium | high | critical), the memory primitive the attacker
gains (what is overwritten and with what control), the reachability (how input
from the file reaches the bug), the impact, and a concise markdown writeup.
Report bugId="${bug.bugId}".`;

const patchPrompt = (bugs, work) => `Fix every confirmed bug, then prove the fixes.

Bugs to fix:
${bugs
	.map(
		(b) =>
			`- ${b.bugId}: ${b.crashSite} (${b.rootCause})\n  PoC:\n${b.representativePoc
				.split("\n")
				.map((l) => "    " + l)
				.join("\n")}`,
	)
	.join("\n")}

The vulnerable working copy is ${work}/card_parser.c. The pristine original is
${TARGET_SRC} (leave it untouched, and diff against it).

1. Edit ${work}/card_parser.c to fix ALL the bugs with minimal, idiomatic C
   (bound every copy; keep valid cards parsing). Do not change behavior for
   well-formed input.
2. Rebuild:  sh harness/build.sh ${work}/card_parser.c ${work}/card_parser
3. For EACH bug, write its PoC to a file and confirm it now prints STATUS=OK:
       sh harness/run_target.sh ${work}/card_parser <poc-file>
4. Confirm well-formed input still parses by running the smoke test against
   your rebuilt binary:
       sh targets/card-parser/smoke_test.sh ${work}/card_parser
   It must print SMOKE_OK and exit 0.
5. Produce a unified diff:
       diff -u ${TARGET_SRC} ${work}/card_parser.c

Report filesChanged, the unified diff, a bugsFixed entry per bug (bugId +
pocNoLongerCrashes), rebuildOk, smokeTestOk, allValidated (true only if rebuild +
smoke + every PoC fixed), and a one-line note.`;

// ---------------------------------------------------------------------------
// Workflow. Re-rendered each frame; completed tasks are not re-run. Later
// stages render once their inputs exist in ctx.outputs (the durable, reactive
// fan-out pattern).
// ---------------------------------------------------------------------------
export default smithers((ctx) => {
	const work = `runs/${ctx.runId}`;
	const binary = `${work}/card_parser`;

	const build = ctx.outputMaybe("build", { nodeId: "build" });
	const recon = ctx.outputMaybe("recon", { nodeId: "recon" });
	const finds = ctx.outputs.find ?? [];
	const verifies = ctx.outputs.verify ?? [];
	const dedupe = ctx.outputMaybe("dedupe", { nodeId: "dedupe" });

	const crashed = uniqueBy(
		finds.filter((f) => f.crashed),
		(f) => slug(f.subsystemId),
	);
	const verifiedOk = verifies.filter((v) => v.reproduced);
	const uniqueBugs = uniqueBy(dedupe?.uniqueBugs ?? [], (b) => slug(b.bugId));
	const patch = ctx.outputMaybe("patch", { nodeId: "patch" });

	return (
		<Workflow name="defending-code">
			<Sequence>
				{/* 1. BUILD: compile the target with ASAN into a throwaway copy. */}
				<Task id="build" output={outputs.build} retries={0}>
					{async () => {
						const { execFileSync } = await import("node:child_process");
						const { mkdirSync, rmSync, copyFileSync, existsSync } = await import(
							"node:fs"
						);
						rmSync(work, { recursive: true, force: true });
						mkdirSync(work, { recursive: true });
						copyFileSync(TARGET_SRC, `${work}/card_parser.c`);
						let log = "";
						let ok = false;
						try {
							log = execFileSync(
								"sh",
								["harness/build.sh", `${work}/card_parser.c`, binary],
								{ encoding: "utf8" },
							);
							ok = existsSync(binary);
						} catch (e) {
							log = `${e?.stdout ?? ""}${e?.stderr ?? ""}${e?.message ?? e}`;
							ok = false;
						}
						// Fail the run loudly on a broken build. Returning {ok:false}
						// would mark this task finished, skip every gated stage, and
						// report a misleading all-zeros success.
						if (!ok) {
							throw new Error(`ASAN build failed:\n${log.slice(0, 4000)}`);
						}
						return {
							ok,
							binaryPath: binary,
							sourcePath: `${work}/card_parser.c`,
							log: log.slice(0, 4000),
						};
					}}
				</Task>

				{/* 2. RECON: propose subsystems to fuzz. */}
				{build?.ok && (
					<Task id="recon" output={outputs.recon} agent={reconAgent}>
						{reconPrompt(work)}
					</Task>
				)}

				{/* 3. FIND: one agent per subsystem, in parallel. */}
				{recon && (
					<Parallel maxConcurrency={FANOUT}>
						{uniqueBy(recon.subsystems, (s) => slug(s.id)).map((s) => (
							<Task
								key={s.id}
								id={`find-${slug(s.id)}`}
								output={outputs.find}
								agent={findAgent}
								continueOnFail
								timeoutMs={600_000}
							>
								{findPrompt(s, work, binary)}
							</Task>
						))}
					</Parallel>
				)}

				{/* 4. VERIFY: reproduce each crash independently, in parallel. */}
				{crashed.length > 0 && (
					<Parallel maxConcurrency={FANOUT}>
						{crashed.map((f) => (
							<Task
								key={f.subsystemId}
								id={`verify-${slug(f.subsystemId)}`}
								output={outputs.verify}
								agent={verifyAgent}
								continueOnFail
								timeoutMs={300_000}
							>
								{verifyPrompt(f, work, binary)}
							</Task>
						))}
					</Parallel>
				)}

				{/* 5. DEDUPE: cluster verified crashes into unique bugs. */}
				{verifiedOk.length > 0 && (
					<Task id="dedupe" output={outputs.dedupe} agent={dedupeAgent}>
						{dedupePrompt(verifiedOk)}
					</Task>
				)}

				{/* 6. REPORT: one writeup per unique bug, in parallel. */}
				{uniqueBugs.length > 0 && (
					<Parallel maxConcurrency={FANOUT}>
						{uniqueBugs.map((b) => (
							<Task
								key={b.bugId}
								id={`report-${slug(b.bugId)}`}
								output={outputs.report}
								agent={reportAgent}
								continueOnFail
								timeoutMs={300_000}
							>
								{reportPrompt(b, work)}
							</Task>
						))}
					</Parallel>
				)}

				{/* 7. PATCH: fix every bug, rebuild, and re-grade. */}
				{uniqueBugs.length > 0 && (
					<Task
						id="patch"
						output={outputs.patch}
						agent={patchAgent}
						timeoutMs={900_000}
					>
						{patchPrompt(uniqueBugs, work)}
					</Task>
				)}

				{/* Roll-up. */}
				<Task id="summary" output={outputs.summary}>
					{() => {
						const bugsFixed = (patch?.bugsFixed ?? []).filter(
							(b) => b.pocNoLongerCrashes,
						).length;
						return {
							subsystemsProbed: recon?.subsystems.length ?? 0,
							crashesFound: crashed.length,
							verified: verifiedOk.length,
							uniqueBugs: uniqueBugs.length,
							bugsFixed,
							patchValidated: Boolean(patch?.allValidated),
							headline: patch?.allValidated
								? `Found and patched ${uniqueBugs.length} unique memory-safety bug(s); all PoCs neutralized and the smoke test passes.`
								: `Found ${uniqueBugs.length} unique memory-safety bug(s) across ${crashed.length} crash(es).`,
						};
					}}
				</Task>
			</Sequence>
		</Workflow>
	);
});
