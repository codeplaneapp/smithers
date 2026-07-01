// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Make Workflow Tutorial
// smithers-description: First-time tutorial — scans your repo + coding-agent chat history, recommends a ranked list of Smithers workflows to build for your situation, lets you pick one, builds it with a custom UI via create-workflow, then launches + monitors + self-improves it. Ends with a "dive deeper" feature preview so you know what else to ask your agent.
// smithers-tags: tutorial, onboarding, create-workflow, first-time
/** @jsxImportSource smithers-orchestrator */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HumanTask, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import DiveDeeperPrompt from "../prompts/make-workflow-tutorial-dive-deeper.mdx";
import MonitorReportPrompt from "../prompts/make-workflow-tutorial-monitor-report.mdx";
import PickPrompt from "../prompts/make-workflow-tutorial-pick.mdx";
import RecommendPrompt from "../prompts/make-workflow-tutorial-recommend.mdx";
import TriagePrompt from "../prompts/make-workflow-tutorial-triage.mdx";

// ─── Constants ────────────────────────────────────────────────────────────────
const BUILD_WF = ".smithers/workflows/create-workflow.tsx";
const MAX_FILES_PER_AGENT = 3;
const MAX_BYTES_PER_FILE = 12_000;
const MAX_SESSION_MESSAGES = 30;
const MONITOR_MAX_ITERATIONS = 12; // 12 × 5 min = 1 h ceiling

// ─── Session reader helpers ───────────────────────────────────────────────────

/**
 * Read at most `maxBytes` from the START of a file without materializing the
 * whole thing in memory. Session JSONL files (esp. Codex history.jsonl) can be
 * many MB; reading them whole then slicing risks OOM (see bug-audit #65).
 */
async function readHead(file: string, maxBytes: number): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return listJsonlFiles(p);
        return e.isFile() && p.endsWith(".jsonl") ? [p] : [];
      }),
    );
    return nested.flat();
  } catch {
    return [];
  }
}

async function trySharedRedactValue(value: string): Promise<string | null> {
  try {
    // Reuse the observability package's canonical redactor when the seeded pack
    // is running inside the monorepo. Keep a fallback for user repos where only
    // the public smithers-orchestrator facade may be installed.
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<{ redactValue?: (value: unknown) => { value: unknown } }>;
    const mod = await dynamicImport("@smithers-orchestrator/observability/_traceRedaction");
    const redacted = mod.redactValue?.(value)?.value;
    return typeof redacted === "string" ? redacted : null;
  } catch {
    return null;
  }
}

// Fallback subset of _traceRedaction.js rules — keeps seeded workflow
// self-contained when the private observability subpath is unavailable.
function fallbackRedactValue(s: string): string {
  return s
    .replace(/\b(?:sk|pk)[-_][A-Za-z0-9][A-Za-z0-9_-]{7,}\b/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/(?<![A-Za-z0-9])(?:api[_-]?key|token|secret|password)=([^\s"']+)/gi, (m) => {
      const idx = m.indexOf("=");
      return `${m.slice(0, idx + 1)}[REDACTED]`;
    });
}

async function redactText(s: string): Promise<string> {
  return (await trySharedRedactValue(s)) ?? fallbackRedactValue(s);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content as Array<Record<string, unknown>>) {
    if (typeof c === "string") parts.push(c);
    if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
    if (typeof c?.content === "string") parts.push(c.content);
  }
  return parts.join(" ");
}

function extractSessionText(obj: unknown): { role: "user" | "assistant"; text: string } | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  // Claude Code JSONL: {type:"user"|"assistant", message:{content:[...]}}
  if (o.type === "user" || o.type === "human" || o.type === "assistant") {
    const msg = o.message as Record<string, unknown> | undefined;
    if (!msg) return null;
    const text = textFromContent(msg.content).trim();
    if (!text) return null;
    return { role: o.type === "assistant" ? "assistant" : "user", text };
  }
  // Codex / Pi JSONL: {role:"user"|"assistant", content:"..."}
  if ((o.role === "user" || o.role === "assistant") && o.content) {
    const text = textFromContent(o.content).trim();
    if (!text) return null;
    return { role: o.role, text };
  }
  // Newer Codex JSONL often stores messages under payload.
  const payload = o.payload as Record<string, unknown> | undefined;
  if (payload && (payload.role === "user" || payload.role === "assistant")) {
    const text = textFromContent(payload.content ?? payload.message).trim();
    if (!text) return null;
    return { role: payload.role, text };
  }
  return null;
}

// ─── Compute functions ────────────────────────────────────────────────────────

async function readRepoContext() {
  const parts: string[] = [];

  // Source file tree (cheap, no LLM — same pattern as sync-features.tsx bootstrap)
  const tree = await $`find . -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" \) -not -path "*/node_modules/*" -not -path "*/.smithers/*" -not -path "*/.git/*" | sort | head -80`
    .nothrow()
    .quiet();
  parts.push("=== SOURCE FILES ===", (tree.stdout?.toString() ?? "").trim());

  const pkg = await $`cat package.json 2>/dev/null || echo "{}"`.nothrow().quiet();
  parts.push("\n=== package.json ===", (pkg.stdout?.toString() ?? "").slice(0, 3_000));

  const log = await $`git log --oneline -10 2>/dev/null || echo "(no git log)"`.nothrow().quiet();
  parts.push("\n=== RECENT GIT COMMITS ===", (log.stdout?.toString() ?? "").trim());

  // Smithers concise doc index — tells the recommender what workflows exist
  const docs = await $`bunx smithers-orchestrator docs`.nothrow().quiet();
  const smithersDocs = (docs.stdout?.toString() ?? "").slice(0, 25_000);

  return {
    codebaseSummary: parts.join("\n").slice(0, 25_000),
    smithersDocs,
    workingDir: process.cwd(),
  };
}

async function readExternalSessions() {
  const home = homedir();
  // Locations mirror apps/observability/src/_sessionFileResolvers.js, plus
  // Codex's history.jsonl index used before a concrete session file is known.
  const agentDirs = [
    { label: "claude", dir: join(home, ".claude", "projects") },
    { label: "codex", dir: join(home, ".codex", "sessions") },
    { label: "pi", dir: join(home, ".pi", "agent", "sessions") },
  ];
  const extraFiles = [{ label: "codex", file: join(home, ".codex", "history.jsonl") }];

  const messages: string[] = [];
  let fileCount = 0;
  const agentTypes: string[] = [];

  for (const { label, dir } of agentDirs) {
    const files = await listJsonlFiles(dir);
    if (files.length === 0) continue;
    agentTypes.push(label);

    // Pick the most recently modified files
    const withMtime = await Promise.all(
      files.map(async (f) => {
        try {
          const s = await stat(f);
          return { f, mtime: s.mtimeMs };
        } catch {
          return { f, mtime: 0 };
        }
      }),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    const recent = withMtime.slice(0, MAX_FILES_PER_AGENT).map((x) => x.f);

    for (const file of recent) {
      fileCount++;
      try {
        const raw = await readHead(file, MAX_BYTES_PER_FILE);
        const lines = raw.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          if (messages.length >= MAX_SESSION_MESSAGES) break;
          try {
            const obj = JSON.parse(line);
            const extracted = extractSessionText(obj);
            if (extracted) {
              const clean = await redactText(extracted.text.trim().slice(0, 300));
              messages.push(`[${label}:${extracted.role}] ${clean}`);
            }
          } catch {
            // malformed JSONL line — skip
          }
        }
      } catch {
        // unreadable file — skip
      }
      if (messages.length >= MAX_SESSION_MESSAGES) break;
    }
  }

  for (const { label, file } of extraFiles) {
    if (messages.length >= MAX_SESSION_MESSAGES || !existsSync(file)) continue;
    if (!agentTypes.includes(label)) agentTypes.push(label);
    fileCount++;
    try {
      const raw = await readHead(file, MAX_BYTES_PER_FILE);
      const lines = raw.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        if (messages.length >= MAX_SESSION_MESSAGES) break;
        try {
          const obj = JSON.parse(line);
          const extracted = extractSessionText(obj);
          if (extracted) {
            const clean = await redactText(extracted.text.trim().slice(0, 300));
            messages.push(`[${label}:history:${extracted.role}] ${clean}`);
          }
        } catch {
          // malformed JSONL line — skip
        }
      }
    } catch {
      // unreadable file — skip
    }
  }

  return {
    agentMessages: messages.join("\n"),
    agentTypes,
    fileCount,
    summary:
      `Scanned ${fileCount} session file(s) from: ${agentTypes.join(", ") || "none detected"}. ` +
      `Extracted ${messages.length} user messages for context.`,
  };
}

async function launchBuild(
  pick: { workflowName: string; workflowGoal: string; additionalContext: string | null },
  buildRunId: string,
) {
  const uiNote =
    ` Also build a custom .smithers/ui/${pick.workflowName}.tsx for it using smithers-orchestrator/gateway-react so users can watch it live in the browser.`;
  const prompt =
    `Build a Smithers workflow named "${pick.workflowName}". ` +
    `Goal: ${pick.workflowGoal}.` +
    (pick.additionalContext ? ` Additional context: ${pick.additionalContext}.` : "") +
    uiNote;
  const input = JSON.stringify({ prompt, review: false });

  let res = await $`bunx smithers-orchestrator up ${BUILD_WF} --run-id ${buildRunId} --input ${input} --detach`
    .nothrow()
    .quiet();
  let tail = `${res.stdout?.toString() ?? ""}\n${res.stderr?.toString() ?? ""}`.trim();

  if (res.exitCode !== 0 && /ALREADY[_ ]?EXISTS/i.test(tail)) {
    res =
      await $`bunx smithers-orchestrator up ${BUILD_WF} --run-id ${buildRunId} --resume true --force --detach`
        .nothrow()
        .quiet();
    tail = `${res.stdout?.toString() ?? ""}\n${res.stderr?.toString() ?? ""}`.trim();
  }

  return {
    launched: res.exitCode === 0,
    childRunId: res.exitCode === 0 ? buildRunId : null,
    detail: tail.slice(-2_000),
  };
}

async function pollBuild(childRunId: string) {
  const res =
    await $`bunx smithers-orchestrator inspect ${childRunId} --format json --full-output`
      .nothrow()
      .quiet();
  const raw = res.stdout?.toString() ?? "";
  let status = "unknown";
  let runState = "unknown";
  try {
    const j: any = JSON.parse(raw);
    status = j?.run?.status ?? j?.status ?? "unknown";
    runState = j?.runState?.state ?? status;
  } catch {
    const m = raw.match(/status[":\s]+([a-z-]+)/i);
    if (m) status = m[1];
  }
  const terminal = ["finished", "failed", "cancelled", "continued"].includes(status);
  const stale = runState === "stale" || runState === "orphaned";
  let resumed = false;
  if (stale) {
    const r =
      await $`bunx smithers-orchestrator up ${BUILD_WF} --run-id ${childRunId} --resume true --force --detach`
        .nothrow()
        .quiet();
    resumed = r.exitCode === 0;
  }
  const needsAttention =
    (stale && !resumed) || status === "waiting-approval" || status === "failed";
  return { status, terminal, needsAttention, resumed, detail: raw.slice(0, 3_000) };
}

async function gatherDiveDeeperDocs() {
  try {
    const guideDir = join(process.cwd(), "docs", "guide");
    const files = (await readdir(guideDir))
      .filter((f) => f.endsWith(".mdx"))
      .sort()
      .map((f) => join(guideDir, f));
    const sections: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (!/(You say|You ask your agent).*(Smithers runs|agent reaches for|under the hood)/is.test(source)) {
        continue;
      }
      sections.push(`--- ${file.replace(process.cwd() + "/", "")} ---\n${source.slice(0, 12_000)}`);
    }
    if (sections.length > 0) {
      return { docs: sections.join("\n\n").slice(0, 50_000) };
    }
  } catch {
    // User repos usually do not include smithers.sh human docs; fall through.
  }
  const res = await $`bunx smithers-orchestrator docs`.nothrow().quiet();
  return { docs: (res.stdout?.toString() ?? "").slice(0, 50_000) };
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const inputSchema = z.object({
  hint: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "Optional: what kind of workflow do you want to build? Leave null to let the agent recommend from your codebase + history.",
    ),
});

const bootstrapSchema = z.looseObject({
  codebaseSummary: z.string().default(""),
  smithersDocs: z.string().default(""),
  workingDir: z.string().default("."),
});

const sessionsSchema = z.looseObject({
  agentMessages: z.string().default(""),
  agentTypes: z.array(z.string()).default([]),
  fileCount: z.number().default(0),
  summary: z.string().default(""),
});

const recommendSchema = z.looseObject({
  candidates: z
    .array(
      z.looseObject({
        rank: z.number().int().default(1),
        name: z.string().default("my-workflow"),
        goal: z.string().default(""),
        why: z.string().default(""),
        complexity: z.enum(["simple", "medium", "complex"]).default("medium"),
        example: z.string().default(""),
      }),
    )
    .default([]),
  summary: z.string().default(""),
});

const pickSchema = z.looseObject({
  workflowName: z.string().default("my-workflow"),
  workflowGoal: z.string().default(""),
  additionalContext: z.string().nullable().default(null),
});

const buildLaunchSchema = z.looseObject({
  launched: z.boolean().default(false),
  childRunId: z.string().nullable().default(null),
  detail: z.string().default(""),
});

const monitorPollSchema = z.looseObject({
  status: z.string().default("unknown"),
  terminal: z.boolean().default(false),
  needsAttention: z.boolean().default(false),
  resumed: z.boolean().default(false),
  detail: z.string().default(""),
});

const monitorReportSchema = z.looseObject({
  summary: z.string().default(""),
});

const triageSchema = z.looseObject({
  summary: z.string().default(""),
  actionsTaken: z.array(z.string()).default([]),
  escalate: z.boolean().default(false),
});

const diveDeeperDocsSchema = z.looseObject({
  docs: z.string().default(""),
});

const diveDeeperSchema = z.looseObject({
  features: z
    .array(
      z.looseObject({
        youSay: z.string().default(""),
        smithersRuns: z.string().default(""),
        what: z.string().default(""),
      }),
    )
    .default([]),
  summary: z.string().default(""),
});

const outputSchema = z.looseObject({
  workflowName: z.string().default(""),
  status: z.string().default("unknown"),
  summary: z.string().default(""),
  childRunId: z.string().nullable().default(null),
});

// ─── Workflow ──────────────────────────────────────────────────────────────────

const {
  Workflow,
  Task,
  Sequence,
  Branch,
  Loop,
  Timer,
  smithers,
  outputs,
} = createSmithers({
  input: inputSchema,
  bootstrap: bootstrapSchema,
  sessions: sessionsSchema,
  recommend: recommendSchema,
  pick: pickSchema,
  buildLaunch: buildLaunchSchema,
  monitorPoll: monitorPollSchema,
  monitorReport: monitorReportSchema,
  triage: triageSchema,
  diveDeeperDocs: diveDeeperDocsSchema,
  diveDeeper: diveDeeperSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const input = ctx.input;

  // Stable child run id derived from this tutorial run (survives resume)
  const buildRunId = `build-wf-tutorial-${ctx.runId}`;

  const bootstrap = ctx.outputMaybe("bootstrap", { nodeId: "bootstrap" });
  const sessions = ctx.outputMaybe("sessions", { nodeId: "sessions" });
  const recommend = ctx.outputMaybe("recommend", { nodeId: "recommend" });
  const pick = ctx.outputMaybe("pick", { nodeId: "pick" });
  const buildLaunch = ctx.outputMaybe("buildLaunch", { nodeId: "build-launch" });

  const launched = buildLaunch?.launched === true;
  const childRunId = buildLaunch?.childRunId ?? null;

  const lastPoll = (ctx as any).latest("monitorPoll", "monitor-poll");
  const buildEnded = lastPoll?.terminal === true;
  const monitorPolls = (ctx as any).iterationCount("monitorPoll", "monitor-poll");
  const lastTriage = (ctx as any).latest("triage", "monitor-triage");
  const monitorStopped =
    buildEnded || lastTriage?.escalate === true || monitorPolls >= MONITOR_MAX_ITERATIONS;

  const diveDeeperDocs = ctx.outputMaybe("diveDeeperDocs", { nodeId: "dive-deeper-docs" });
  const diveDeeper = ctx.outputMaybe("diveDeeper", { nodeId: "dive-deeper" });

  return (
    <Workflow name="make-workflow-tutorial">
      <Sequence>
        {/* ── 1. Bootstrap: read repo structure + smithers docs (no LLM) ── */}
        <Task id="bootstrap" output={outputs.bootstrap}>
          {readRepoContext}
        </Task>

        {/* ── 2. Sessions: bounded read of external coding-agent chat history ── */}
        <Task id="sessions" output={outputs.sessions}>
          {readExternalSessions}
        </Task>

        {/* ── 3. Recommend: agent ranks 5 candidate workflows by relevance ── */}
        {bootstrap && sessions ? (
          <Task id="recommend" output={outputs.recommend} agent={agents.smart}>
            <RecommendPrompt
              hint={input.hint ?? ""}
              codebaseSummary={bootstrap.codebaseSummary}
              smithersDocs={bootstrap.smithersDocs}
              sessionContext={sessions.agentMessages}
              sessionSummary={sessions.summary}
            />
          </Task>
        ) : null}

        {/* ── 4. Pick: operating agent asks the human which workflow to build ── */}
        {recommend ? (
          <HumanTask
            id="pick"
            output={outputs.pick}
            maxAttempts={5}
            prompt={
              <PickPrompt
                candidates={JSON.stringify(Array.isArray(recommend.candidates) ? recommend.candidates : [], null, 2)}
                summary={recommend.summary}
              />
            }
          />
        ) : null}

        {/* ── 5. Build: launch create-workflow as a detached child run ── */}
        {pick ? (
          <Task id="build-launch" output={outputs.buildLaunch}>
            {() => launchBuild(pick, buildRunId)}
          </Task>
        ) : null}

        {/* ── 6. Monitor: poll + narrate every 5 min until build finishes ── */}
        {launched && childRunId ? (
          <Loop
            id="monitor-loop"
            until={lastPoll?.terminal === true || lastTriage?.escalate === true}
            maxIterations={MONITOR_MAX_ITERATIONS}
            onMaxReached="return-last"
          >
            <Sequence>
              <Timer id="monitor-tick" duration="5m" />
              <Task id="monitor-poll" output={outputs.monitorPoll}>
                {() => pollBuild(childRunId as string)}
              </Task>
              <Task
                id="monitor-report"
                output={outputs.monitorReport}
                agent={agents.cheapFast}
                continueOnFail
                retries={1}
              >
                <MonitorReportPrompt childRunId={childRunId as string} />
              </Task>
              <Branch
                if={
                  (ctx as any).latest("monitorPoll", "monitor-poll")?.needsAttention === true &&
                  (ctx as any).latest("monitorPoll", "monitor-poll")?.terminal !== true
                }
                then={
                  <Task
                    id="monitor-triage"
                    output={outputs.triage}
                    agent={agents.cheapFast}
                  >
                    <TriagePrompt
                      childRunId={childRunId as string}
                      status={
                        (ctx as any).latest("monitorPoll", "monitor-poll")?.status ?? "unknown"
                      }
                      detail={
                        (ctx as any).latest("monitorPoll", "monitor-poll")?.detail ?? ""
                      }
                    />
                  </Task>
                }
                else={null}
              />
            </Sequence>
          </Loop>
        ) : null}

        {/* ── 7. Dive deeper: gather docs + show 5-8 other features ── */}
        {launched && monitorStopped ? (
          <Task id="dive-deeper-docs" output={outputs.diveDeeperDocs}>
            {gatherDiveDeeperDocs}
          </Task>
        ) : null}

        {diveDeeperDocs ? (
          <Task id="dive-deeper" output={outputs.diveDeeper} agent={agents.cheapFast}>
            <DiveDeeperPrompt
              builtWorkflow={pick?.workflowName ?? "your-workflow"}
              docs={diveDeeperDocs.docs}
            />
          </Task>
        ) : null}

        {/* ── 8. Terminal output ── */}
        {diveDeeper ? (
          <Task id="output" output={outputs.output}>
            {{
              workflowName: pick?.workflowName ?? "",
              status: lastPoll?.status ?? "in-progress",
              summary:
                `Tutorial complete. Built workflow "${pick?.workflowName ?? ""}". ` +
                `Build run ${childRunId ?? "(not launched)"}: ${lastPoll?.status ?? "in-progress"}. ` +
                diveDeeper.summary,
              childRunId,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
