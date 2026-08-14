// smithers-source: user
// smithers-display-name: Docs Concise
// smithers-description: Reword every docs page and skill more concisely without losing ideas: batched rewrite, mechanical checks, idea-preservation audit, llms regen, doc gates.
// smithers-tags: docs, editing, quality
/** @jsxImportSource smthrs */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createSmithers, Parallel, Sequence, UI } from "smthrs";
import { z } from "zod/v4";
import { providers } from "../agents";

// Editorial rewrite: strongest prose models. Audit: strong reviewer first.
const rewriteAgents = [providers.claudeSonnet, providers.claude];
const auditAgents = [providers.claudeOpus, providers.claudeSonnet];
const repairAgents = [providers.claude, providers.claudeOpus];

const inputSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(10).default(6),
  batchWords: z.number().int().min(1000).max(20000).default(5000),
  batchFiles: z.number().int().min(1).max(20).default(8),
  onlyGroup: z.string().nullable().default(null),
  skipBatchIds: z.array(z.string()).default([]),
});

const batchShape = z.object({
  batchId: z.string(),
  group: z.string(),
  files: z.array(z.string()),
  words: z.number().int(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  dcInventory: z.object({
    batches: z.array(batchShape),
    totalFiles: z.number().int(),
    totalWords: z.number().int(),
  }),
  dcRewrite: z.object({
    batchId: z.string().min(1),
    summary: z.string().min(20),
    filesEdited: z.array(z.string()),
    filesUnchanged: z.array(z.string()).default([]),
  }),
  dcMech: z.object({
    batchId: z.string(),
    ok: z.boolean(),
    violations: z.array(z.string()),
    wordsBefore: z.number().int(),
    wordsAfter: z.number().int(),
  }),
  dcAudit: z.object({
    batchId: z.string().min(1),
    lostIdeasFound: z.number().int(),
    fixesApplied: z.number().int(),
    verdict: z.enum(["clean", "repaired", "escalate"]),
    notes: z.string().min(10),
  }),
  dcRecheck: z.object({
    batchId: z.string(),
    ok: z.boolean(),
    violations: z.array(z.string()),
    wordsBefore: z.number().int(),
    wordsAfter: z.number().int(),
  }),
  dcRegen: z.object({ ok: z.boolean(), notes: z.string() }),
  dcGate: z.object({ ok: z.boolean(), checkDocs: z.string(), checkLlms: z.string() }),
  dcRepair: z.object({ summary: z.string().min(20), fixesApplied: z.number().int() }),
  dcReport: z.object({
    filesProcessed: z.number().int(),
    wordsBefore: z.number().int(),
    wordsAfter: z.number().int(),
    reductionPct: z.number().int(),
    batchesTotal: z.number().int(),
    batchesEscalated: z.array(z.string()),
    batchesWithViolations: z.array(z.string()),
    gatesPassed: z.boolean(),
    notes: z.string(),
  }),
});

const ROOT = process.cwd();

const SKILL_SOURCES = [
  "skills/context-engineer/SKILL.md",
  "skills/eval-writer/SKILL.md",
  "skills/prompt-author/SKILL.md",
  "skills/report-maker/SKILL.md",
  "skills/risk-reviewer/SKILL.md",
  "skills/schema-author/SKILL.md",
  "skills/smithers/SKILL.md",
  "skills/smithers/README.md",
  "claude-plugin/skills/smithers/SKILL.md",
];

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function wordCount(text: string) {
  return text.split(/\s+/).filter(Boolean).length;
}

/** All rewrite-eligible source files, repo-relative, sorted. Excludes generated
 * bundles/mirrors (llms-*.txt, apps/cli/docs, packages/smithers/docs), the JSX
 * marketing splash (docs/index.mdx), and frozen history (docs/changelogs). */
function corpusFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (rel === "docs/changelogs") continue;
        walk(rel);
        continue;
      }
      if (!entry.name.endsWith(".mdx")) continue;
      if (rel === "docs/index.mdx") continue;
      files.push(rel);
    }
  };
  walk("docs");
  for (const rel of SKILL_SOURCES) if (existsSync(join(ROOT, rel))) files.push(rel);
  return files.sort();
}

function groupOf(rel: string): string {
  if (!rel.startsWith("docs/")) return "skills";
  const parts = rel.split("/");
  return parts.length > 2 ? `docs-${parts[1]}` : "docs-root";
}

export function buildBatches(batchWords: number, batchFiles: number) {
  const byGroup = new Map<string, string[]>();
  for (const rel of corpusFiles()) {
    const g = groupOf(rel);
    byGroup.set(g, [...(byGroup.get(g) ?? []), rel]);
  }
  const batches: { batchId: string; group: string; files: string[]; words: number }[] = [];
  const seen = new Set<string>();
  for (const [group, files] of [...byGroup.entries()].sort()) {
    let cur: string[] = [];
    let curWords = 0;
    const flush = () => {
      if (cur.length === 0) return;
      let batchId = slugify(
        `${group}-${cur[0]
          .split("/")
          .pop()!
          .replace(/\.(mdx|md)$/, "")}`,
      );
      while (seen.has(batchId)) batchId = `${batchId}-x`;
      seen.add(batchId);
      batches.push({ batchId, group, files: cur, words: curWords });
      cur = [];
      curWords = 0;
    };
    for (const rel of files) {
      const w = wordCount(readFileSync(join(ROOT, rel), "utf8"));
      if (cur.length > 0 && (curWords + w > batchWords || cur.length >= batchFiles)) flush();
      cur.push(rel);
      curWords += w;
    }
    flush();
  }
  return batches;
}

function headVersion(rel: string): string | null {
  try {
    return execFileSync("git", ["show", `HEAD:${rel}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function stripFences(text: string) {
  return text.replace(/^```[\s\S]*?^```/gm, "");
}

function extractFences(text: string): string[] {
  return text.match(/^```[\s\S]*?^```/gm) ?? [];
}

function extractFrontmatter(text: string): string {
  const m = text.match(/^---\n[\s\S]*?\n---\n/);
  return m ? m[0] : "";
}

function extractHeadings(text: string): string[] {
  return stripFences(text)
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l));
}

function countEmDash(text: string) {
  return (text.match(/—|&mdash;/g) ?? []).length;
}

/** Deterministic per-batch checks of the working tree against HEAD. */
function mechCheck(batch: { batchId: string; files: string[] }) {
  const violations: string[] = [];
  let wordsBefore = 0;
  let wordsAfter = 0;
  for (const rel of batch.files) {
    const before = headVersion(rel);
    if (before == null) {
      violations.push(`${rel}: not found in HEAD`);
      continue;
    }
    let after: string;
    try {
      after = readFileSync(join(ROOT, rel), "utf8");
    } catch {
      violations.push(`${rel}: missing from working tree (file was deleted?)`);
      continue;
    }
    const wb = wordCount(before);
    const wa = wordCount(after);
    wordsBefore += wb;
    wordsAfter += wa;
    if (wa > wb) violations.push(`${rel}: grew from ${wb} to ${wa} words; must not grow`);
    if (wa < Math.floor(wb * 0.4) && wb > 120)
      violations.push(
        `${rel}: over-compressed (${wb} -> ${wa} words); verify no ideas were lost, restore any that were`,
      );
    if (extractFrontmatter(after) !== extractFrontmatter(before))
      violations.push(`${rel}: frontmatter changed; restore it exactly from HEAD`);
    const fb = extractFences(before);
    const fa = extractFences(after);
    if (fb.length !== fa.length || fb.some((f, i) => f !== fa[i]))
      violations.push(`${rel}: fenced code blocks changed; restore them exactly from HEAD`);
    const hb = extractHeadings(before);
    const ha = extractHeadings(after);
    if (hb.length !== ha.length || hb.some((h, i) => h !== ha[i]))
      violations.push(`${rel}: headings changed (anchors/links break); restore them exactly from HEAD`);
    if (countEmDash(after) > countEmDash(before))
      violations.push(`${rel}: em-dash added; docs forbid em-dashes (check:docs gates on it)`);
  }
  return { batchId: batch.batchId, ok: violations.length === 0, violations, wordsBefore, wordsAfter };
}

function runScript(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60_000,
    });
    return { ok: true, out: out.slice(-4000) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`.slice(-4000) };
  }
}

const EDITORIAL_CONTRACT = `THE EDITORIAL CONTRACT (follow it exactly):

Goal: maximize idea density. Say the same things in fewer words. Cut words, never ideas.

NEVER delete an idea: every fact, constraint, caveat, gotcha, command, flag, code sample,
number, name, link, cross-reference, table row, and example must survive. An example may be
tightened, never removed. Delete only TRUE redundancy: the same idea stated twice.

NEVER change (byte-for-byte):
- YAML frontmatter (the --- block at the top)
- Headings (any line starting with #): anchors and cross-page links depend on them
- Fenced code blocks (\`\`\` ... \`\`\`), including comments inside them
- Link URLs and #anchors, import lines, MDX component tags and their props
  (<Note>, <Warning>, <Card>, <Tabs>, ...): only their prose children may be tightened

Compliance needles (CI gates on exact text):
- docs/cli/overview.mdx: do not touch the command catalog or any flag block
- docs/rpc/*.mdx: keep the exact sentence starting "Errors are versioned as \`v1\` and include" verbatim
- Any sentence that reads like an exact gated contract: when unsure, keep it verbatim

Style (house rules, gated by check:docs):
- NEVER use an em-dash (—) or &mdash;. Use a period, comma, colon, or parentheses.
- No "not X, it's Y" antithesis. No hedging (fairly/arguably/somewhat). No filler
  intensifiers (powerful/seamless/robust). No throat-clearing openers. Lead with the claim.
  Concrete nouns, plain verbs.

Voice: two registers, keep each.
- Conceptual pages (docs/concepts, docs/guides, docs/guide, tour, how-it-works, introduction,
  quickstart): conversational teaching voice ("you", rhetorical questions, analogies). Cut
  redundancy, not personality; the analogy that carries an idea stays.
- Reference pages (docs/components, docs/cli, docs/rpc, docs/reference, docs/jsx, docs/agents,
  docs/integrations, skills): pure Kernighan. Terse, code-first, tables over prose.

What counts as editable prose (do compress it): paragraphs between code blocks, list items,
table CELL text (never cell structure or rows), prop/flag descriptions, prose children of MDX
components (<Note>, <Warning>, <Card>, <Tip>), and "Notes" sections on reference pages. A page
being "reference" does not exempt its prose. Only the protected list above is off-limits.

Method per file: read it fully, then COMPRESS, do not merely polish. Sentence-level rewording
that saves a handful of words is NOT the task. The big wins are structural:
- merge sentences and paragraphs that develop one idea
- kill cross-section redundancy: docs repeat an idea in the intro, a section body, and a
  callout; state it once, in the best spot
- delete restatements of the heading in the first sentence under it
- collapse wind-ups ("It is worth noting that", "In order to") and connective filler
- rewrite existing "not X, it's Y" antithesis into one direct claim
- keep every DISTINCT idea; tighten examples, never drop them
Floor: on prose-heavy pages expect 20-40% fewer words. After editing a file run \`wc -w\` on it
versus \`git show HEAD:<file> | wc -w\`; if you saved under 15% on a page with real prose, you
missed redundancy: go back through it before moving on. Only a page that is nearly all code,
tables, and type signatures may come out under 10%; a genuinely maximally-dense file may be
left unchanged and listed in filesUnchanged. Never pad, never churn.

Hard rules: edit files IN PLACE. Do not create, delete, rename, or move files. Do not touch
any file outside your assigned list. Do not run git/jj state-changing commands (no add,
commit, stash, checkout, restore). Do not run pnpm/bun scripts. Reading anything is fine.`;

function rewritePrompt(batch: { batchId: string; files: string[]; words: number }) {
  return `You are a precision technical editor for the Smithers docs (repo cwd: ${ROOT}).

Rewrite these ${batch.files.length} file(s) (about ${batch.words} words) more concisely:

${batch.files.map((f) => `- ${f}`).join("\n")}

${EDITORIAL_CONTRACT}

Expected outcome: 20-40% fewer words on prose-heavy pages, 10-20% on mixed reference pages;
only near-pure code/table pages may come out lower. Verify each file with wc -w as described.
When done, fill the structured output: batchId is
"${batch.batchId}", summary describes what you tightened and why nothing was lost, filesEdited
lists files you changed, filesUnchanged the ones you deliberately left.`;
}

function auditPrompt(batch: { batchId: string; files: string[] }, mech: { violations?: unknown } | undefined) {
  const rawViolations = mech?.violations;
  const violations: string[] = Array.isArray(rawViolations)
    ? rawViolations.map(String)
    : typeof rawViolations === "string"
      ? (() => {
          try {
            return JSON.parse(rawViolations as string) as string[];
          } catch {
            return [rawViolations as string];
          }
        })()
      : [];
  return `You are the idea-preservation auditor for a concision pass over the Smithers docs
(repo cwd: ${ROOT}). A previous editor rewrote these files to be more concise. Your job:
prove no idea was lost, and repair any loss.

Files (compare \`git show HEAD:<file>\` against the working copy):

${batch.files.map((f) => `- ${f}`).join("\n")}

Mechanical check findings to fix (empty means none):
${violations.length ? violations.map((v) => `- ${v}`).join("\n") : "- none"}

For EACH file:
1. Diff HEAD vs working copy conceptually. List every idea present in HEAD but missing now:
   facts, constraints, caveats, gotchas, commands, flags, numbers, names, links, examples,
   table rows.
2. Restore every lost idea by editing the file, in concise wording (do not paste back the
   verbose original; re-state the idea densely).
3. Fix each mechanical finding: restore frontmatter/fences/headings exactly from HEAD if they
   changed; remove any em-dash the editor introduced; if a file grew, tighten it back below
   its HEAD word count without dropping ideas.
4. Do NOT otherwise expand the text or re-add redundancy. If the rewrite is faithful, change
   nothing.

${EDITORIAL_CONTRACT}

Structured output: batchId is "${batch.batchId}"; lostIdeasFound = how many lost ideas you
identified; fixesApplied = how many edits you made; verdict "clean" (nothing lost, nothing to
fix), "repaired" (you fixed everything), or "escalate" (something you could not safely fix;
explain in notes).`;
}

function repairPrompt(gate: { checkDocs?: string; checkLlms?: string } | undefined) {
  return `The docs concision pass finished but the repo doc gates failed (repo cwd: ${ROOT}).

check:docs output (tail):
${gate?.checkDocs ?? "(missing)"}

check:llms output (tail):
${gate?.checkLlms ?? "(missing)"}

Fix the root causes in the docs source files (docs/**/*.mdx, skills):
- em-dashes: replace with a period, comma, colon, or parentheses
- missing required needle sentences: restore them verbatim from \`git show HEAD:<file>\`
- catalog/flag-block drift in docs/cli/overview.mdx: restore those blocks from HEAD
Then regenerate the llms bundles by running \`node scripts/check-llms.mjs\` (it regenerates
with the correct versioned-artifact mode; a first run may exit 1 while it refreshes the
bundles). Finally confirm \`node scripts/check-docs.mjs\` and a second \`node
scripts/check-llms.mjs\` both exit 0. Do not run git/jj state-changing commands. Structured output: summary of what you
fixed, fixesApplied count.`;
}

export default smithers((ctx) => {
  const maxConcurrency = ctx.input.maxConcurrency ?? 6;
  const batchWords = ctx.input.batchWords ?? 5000;
  const batchFiles = ctx.input.batchFiles ?? 8;
  const onlyGroup = ctx.input.onlyGroup ?? null;

  const inv = ctx.outputMaybe("dcInventory", { nodeId: "inventory" }) as { batches?: unknown } | undefined;
  const rawBatches = inv?.batches;
  const parsedBatches: { batchId: string; group: string; files: string[]; words: number }[] = Array.isArray(rawBatches)
    ? (rawBatches as { batchId: string; group: string; files: string[]; words: number }[])
    : typeof rawBatches === "string"
      ? JSON.parse(rawBatches)
      : [];
  // Array inputs hydrate as JSON strings; parse defensively.
  const skipRaw = ctx.input.skipBatchIds as unknown;
  const skipSet = new Set<string>(
    Array.isArray(skipRaw)
      ? (skipRaw as string[])
      : typeof skipRaw === "string"
        ? (JSON.parse(skipRaw) as string[])
        : [],
  );
  const batches = parsedBatches
    .map((b) => ({
      ...b,
      files: typeof b.files === "string" ? (JSON.parse(b.files as unknown as string) as string[]) : b.files,
    }))
    .filter((b) => (onlyGroup ? b.group === onlyGroup : true))
    .filter((b) => !skipSet.has(b.batchId));

  const gate1 = ctx.outputMaybe("dcGate", { nodeId: "gate1" }) as
    | { ok?: unknown; checkDocs?: string; checkLlms?: string }
    | undefined;
  const gate1Failed = gate1 != null && !(gate1.ok === true || gate1.ok === 1);
  const repairDone = ctx.outputMaybe("dcRepair", { nodeId: "repair" }) != null;
  const gate2 = ctx.outputMaybe("dcGate", { nodeId: "gate2" }) as { ok?: unknown } | undefined;
  const regenDone = ctx.outputMaybe("dcRegen", { nodeId: "regen" }) != null;

  // Render-time aggregates for the final report.
  let wordsBefore = 0;
  let wordsAfter = 0;
  let filesProcessed = 0;
  const escalated: string[] = [];
  const withViolations: string[] = [];
  for (const b of batches) {
    const re = (ctx.outputMaybe("dcRecheck", { nodeId: `re-${b.batchId}` }) ??
      ctx.outputMaybe("dcMech", { nodeId: `mech-${b.batchId}` })) as
      | { ok?: unknown; wordsBefore?: number; wordsAfter?: number }
      | undefined;
    if (re) {
      wordsBefore += Number(re.wordsBefore ?? 0);
      wordsAfter += Number(re.wordsAfter ?? 0);
      filesProcessed += b.files.length;
      if (!(re.ok === true || re.ok === 1)) withViolations.push(b.batchId);
    }
    const audit = ctx.outputMaybe("dcAudit", { nodeId: `audit-${b.batchId}` }) as { verdict?: string } | undefined;
    if (audit?.verdict === "escalate") escalated.push(b.batchId);
  }
  const gatesPassed = gate1Failed ? gate2?.ok === true || gate2?.ok === 1 : gate1 != null;

  return (
    <Workflow name="docs-concise">
      <UI entry="../ui/docs-concise.tsx" title="Docs Concise" />
      <Sequence>
        <Task id="inventory" output={outputs.dcInventory}>
          {async () => {
            const built = buildBatches(batchWords, batchFiles);
            return {
              batches: built,
              totalFiles: built.reduce((n, b) => n + b.files.length, 0),
              totalWords: built.reduce((n, b) => n + b.words, 0),
            };
          }}
        </Task>

        {batches.length > 0 ? (
          <Parallel maxConcurrency={maxConcurrency}>
            {batches.map((b) => {
              const rewriteDone = ctx.outputMaybe("dcRewrite", { nodeId: `rw-${b.batchId}` }) != null;
              const mech = ctx.outputMaybe("dcMech", { nodeId: `mech-${b.batchId}` }) as
                | { violations?: unknown }
                | undefined;
              const auditRow = ctx.outputMaybe("dcAudit", { nodeId: `audit-${b.batchId}` });
              return (
                <Sequence key={b.batchId}>
                  <Task
                    id={`rw-${b.batchId}`}
                    output={outputs.dcRewrite}
                    agent={rewriteAgents}
                    timeoutMs={45 * 60_000}
                    heartbeatTimeoutMs={10 * 60_000}
                    retries={2}
                    continueOnFail
                  >
                    {rewritePrompt(b)}
                  </Task>
                  {rewriteDone ? (
                    <Task id={`mech-${b.batchId}`} output={outputs.dcMech}>
                      {async () => {
                        try {
                          return mechCheck(b);
                        } catch (err) {
                          return {
                            batchId: b.batchId,
                            ok: false,
                            violations: [`mech check crashed: ${err instanceof Error ? err.message : String(err)}`],
                            wordsBefore: 0,
                            wordsAfter: 0,
                          };
                        }
                      }}
                    </Task>
                  ) : null}
                  {mech ? (
                    <Task
                      id={`audit-${b.batchId}`}
                      output={outputs.dcAudit}
                      agent={auditAgents}
                      timeoutMs={30 * 60_000}
                      heartbeatTimeoutMs={10 * 60_000}
                      retries={2}
                      continueOnFail
                    >
                      {auditPrompt(b, mech)}
                    </Task>
                  ) : null}
                  {auditRow ? (
                    <Task id={`re-${b.batchId}`} output={outputs.dcRecheck}>
                      {async () => {
                        try {
                          return mechCheck(b);
                        } catch (err) {
                          return {
                            batchId: b.batchId,
                            ok: false,
                            violations: [`recheck crashed: ${err instanceof Error ? err.message : String(err)}`],
                            wordsBefore: 0,
                            wordsAfter: 0,
                          };
                        }
                      }}
                    </Task>
                  ) : null}
                </Sequence>
              );
            })}
          </Parallel>
        ) : null}

        {batches.length > 0 ? (
          <Sequence>
            <Task id="regen" output={outputs.dcRegen}>
              {async () => {
                // Mirror check-llms's mode: plain regen when the version is
                // unpublished; --skip-versioned once the version-guard refuses.
                const runBoth = (extra: string[]) => {
                  const gen = runScript("bun", ["scripts/generate-llms.ts", ...extra]);
                  if (!gen.ok) return gen;
                  return runScript("bun", ["scripts/optimize-llms-full.ts", ...extra]);
                };
                let mode = "plain";
                let res = runBoth([]);
                if (!res.ok) {
                  mode = "skip-versioned";
                  res = runBoth(["--skip-versioned"]);
                }
                if (!res.ok) return { ok: false, notes: `regen failed (${mode}): ${res.out}` };
                return { ok: true, notes: `bundles regenerated (${mode})` };
              }}
            </Task>
            {regenDone ? (
              <Task id="gate1" output={outputs.dcGate}>
                {async () => {
                  const cd = runScript("node", ["scripts/check-docs.mjs"]);
                  const cl = runScript("node", ["scripts/check-llms.mjs"]);
                  return { ok: cd.ok && cl.ok, checkDocs: cd.out, checkLlms: cl.out };
                }}
              </Task>
            ) : null}
            {gate1Failed ? (
              <Task
                id="repair"
                output={outputs.dcRepair}
                agent={repairAgents}
                timeoutMs={45 * 60_000}
                heartbeatTimeoutMs={10 * 60_000}
                retries={1}
                continueOnFail
              >
                {repairPrompt(gate1)}
              </Task>
            ) : null}
            {gate1Failed && repairDone ? (
              <Task id="gate2" output={outputs.dcGate}>
                {async () => {
                  const cd = runScript("node", ["scripts/check-docs.mjs"]);
                  const cl = runScript("node", ["scripts/check-llms.mjs"]);
                  return { ok: cd.ok && cl.ok, checkDocs: cd.out, checkLlms: cl.out };
                }}
              </Task>
            ) : null}
            {gate1 != null && (!gate1Failed || gate2 != null || repairDone) ? (
              <Task id="report" output={outputs.dcReport}>
                {async () => ({
                  filesProcessed,
                  wordsBefore,
                  wordsAfter,
                  reductionPct: wordsBefore > 0 ? Math.round(((wordsBefore - wordsAfter) / wordsBefore) * 100) : 0,
                  batchesTotal: batches.length,
                  batchesEscalated: escalated,
                  batchesWithViolations: withViolations,
                  gatesPassed,
                  notes: gatesPassed
                    ? "Concision pass complete; gates green. Land docs/, skills/, claude-plugin/skills/, and regenerated bundles."
                    : "Gates still failing after one repair round; inspect gate output and fix by hand before landing.",
                })}
              </Task>
            ) : null}
          </Sequence>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
