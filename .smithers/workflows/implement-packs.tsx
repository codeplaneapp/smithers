// smithers-display-name: Implement Packs
// smithers-description: Implement the "Share workflows like skills" packs feature end-to-end from research/packs-share-workflows-like-skills.md — five gated phases (manifest, add, eject, workflows+share, messaging), each a Luna-implement / Terra-validate / Sol-review loop, then a final Sol polish pass.
/** @jsxImportSource smithers-orchestrator */
import { UI, createSmithers, Sequence, Task } from "smithers-orchestrator";
import { z } from "zod/v4";
import { implementer, validator, panelists, polishReviewer } from "../components/roles";
import {
  ValidationLoop,
  implementOutputSchema,
  validateOutputSchema,
} from "../components/ValidationLoop";
import { reviewOutputSchema } from "../components/Review";

const inputSchema = z.object({
  planDoc: z
    .string()
    .default("research/packs-share-workflows-like-skills.md")
    .describe("Repo-relative path to the approved packs design doc"),
});

const polishSchema = z.object({
  polished: z.boolean().describe("true when the final pass found nothing left to fix"),
  changesMade: z.array(z.string()).default([]),
  summary: z.string(),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  polish: polishSchema,
});

const GROUND_RULES = `
GROUND RULES (non-negotiable, apply to every step):
- FIRST read the approved design doc named in the task — it is the locked spec. Do not re-litigate its decisions.
- Also skim CLAUDE.md at the repo root. Key rules: work directly on main; NEVER push; no mocks in product code or e2e tests.
- Commit each logical change with explicit pathspecs (git commit <paths>) — NEVER 'git add -A'. Emoji + conventional-commit subject, Co-Authored-By trailer. After committing, verify with 'git show --name-only HEAD' that ONLY your files landed.
- Before reporting done: 'pnpm typecheck' green at the repo root, and 'pnpm -C <package> test' green for every package you touched.
- New CLI commands/flags or public surface MUST get docs in the same phase — 'node scripts/check-docs.mjs' and 'node scripts/check-llms.mjs' are CI gates.
- Match surrounding code style: apps/cli/src is plain .js with sibling .d.ts where present; TOON parsing uses @toon-format/toon.
`;

type Phase = { key: string; title: string; prompt: string };

function buildPhases(planDoc: string): Phase[] {
  const spec = `Approved design doc (the spec): ${planDoc}\n${GROUND_RULES}`;
  return [
    {
      key: "p1",
      title: "smithers.toon manifest",
      prompt: `${spec}
PHASE 1 of the packs feature — the smithers.toon manifest.

Implement exactly the "smithers.toon manifest" section of the spec:
1. A manifest loader/validator in apps/cli (parse with @toon-format/toon; schema: name, version, description, repository, smithers compat range, contents.workflows/ui, capabilities.bins/env/writes). Tolerant of missing optional fields, hard error with a clear message on malformed TOON or a missing name.
2. 'smithers init' scaffolds a default smithers.toon into .smithers/ (derive name from the project directory, version 0.0.0, contents enumerated from the scaffold). Wire it through initWorkflowPack in apps/cli/src/workflow-pack.js the same way other pack files are rendered, including drift reporting on re-init. Every .smithers is a publishable pack.
3. Unit tests in apps/cli covering: parse round-trip, defaults, malformed input, init scaffolding writes the file, re-init drift report.
Do NOT start on 'smithers add' or discovery changes — that is phase 2.`,
    },
    {
      key: "p2",
      title: "smithers add + packs discovery",
      prompt: `${spec}
PHASE 2 of the packs feature — install lifecycle + discovery. Phase 1 (smithers.toon manifest loader + init scaffolding) is already merged; build on it.

Implement exactly the "Spec syntax & fetch", "Lifecycle commands", and "Discovery changes" sections of the spec:
1. Spec parser: 'user/repo' (GitHub shorthand), 'github:user/repo[/subdir][#ref]', 'npm:pkg[@version]', 'pkg@1.2.0'. Unit-test every form.
2. 'smithers add <spec>': fetch (GitHub codeload tarball / npm registry tarball), extract into .smithers/packs/<name>/ (local default) or ~/.smithers/packs/<name>/ with -g/--global. Pack name from manifest 'name', spec-derived fallback (user-repo). Validate the manifest before extracting.
3. Trust report + confirmation before install (skippable with --yes): render capabilities (bins/env/writes) from the manifest plus per-workflow frontmatter via the existing evaluateEligibility machinery.
4. Add-time import scan: reject any bare import in pack TS/TSX outside smithers-orchestrator, @smithers-orchestrator/*, react, zod — fail with the file and import named.
5. packs.lock.toon beside each packs dir (spec -> resolved commit/version/integrity). 'smithers update [name]' re-resolves per lock; 'smithers remove <name>' deletes pack + lock entry; 'smithers packs list' lists both scopes. 'smithers install' is a hidden alias of add.
6. Discovery: resolveWorkflowDirs in apps/cli/src/workflows.js gains local-packs and global-packs tiers (env paths -> curated -> local workflows -> local packs -> global workflows -> global packs), scanning .smithers/packs/*/workflows/. Local workflows shadow pack workflows on id collision; 'workflow run <pack>:<id>' disambiguates; 'workflow list' shows a source tier column (local / pack:<name> / global).
7. Tests with NO mocks: fixture pack as a real directory/tarball on disk (file-based fetch path is fine for tests as long as the extract/validate/lock pipeline is the real one); cover add -> list shows pack tier -> run resolves pack workflow -> remove. Network-dependent GitHub/npm fetch paths must degrade with a clear error when offline.
Docs for the new commands are part of phase 5; only add the minimal CLI --help text now.`,
    },
    {
      key: "p3",
      title: "eject + shadow semantics",
      prompt: `${spec}
PHASE 3 of the packs feature — read-only packs + eject. Phases 1-2 (manifest, add/discovery/lock) are already merged; build on them.

Implement exactly the eject part of the "Lifecycle commands" spec section:
1. 'smithers eject <pack>:<workflow>' copies that workflow plus its UI and any referenced prompts/lib files out of .smithers/packs/<pack>/ into the local .smithers/workflows|ui|prompts|lib, rewriting relative imports if the copy changes their resolution. Refuse with a clear message if the local target already exists.
2. After eject, the local copy must shadow the pack's via the existing precedence — verify, don't reimplement.
3. 'smithers update' must never touch ejected copies (they live outside the pack dir) and must overwrite pack contents cleanly.
4. Tests: eject copies the full closure; ejected workflow shadows the pack original in workflow list/run; update overwrites the pack but leaves the ejected copy; eject refuses on collision.`,
    },
    {
      key: "p4",
      title: "add system workflow + share-pack + smithers share",
      prompt: `${spec}
PHASE 4 of the packs feature — durable workflows + sharing. Phases 1-3 are already merged; build on them.

1. An 'add' SYSTEM workflow (.smithers/workflows/add.tsx, marked system: true in frontmatter, hidden from default listings): the durable path for pack installation, mirroring how 'smithers init' bootstraps the durable init workflow. The imperative 'smithers add' CLI command bootstraps/executes it where the repo convention calls for it (see init's precedent in apps/cli and .smithers/workflows/init.tsx).
2. A seeded 'share-pack' workflow (.smithers/workflows/share-pack.tsx) with a custom UI (.smithers/ui/share-pack.tsx, gateway-react, self-contained under .smithers/ui/): the agent completes/validates smithers.toon, strips private files (smithers.db*, runs/, logs/, node_modules/, state/, executions/), scaffolds a README from the manifest, creates and pushes the GitHub repo (gh CLI), then calls 'smithers share' (below) to open the awesome-smithers PR.
3. NEW CLI command 'smithers share': uses the gh CLI to fork/clone github.com/smithersai/awesome-smithers, add or update this pack's entry in its Packs section (name, description, and install one-liner from smithers.toon, plus a one-line description per workflow from workflow frontmatter), and open a PR. Flags: --repo <awesome repo override>, --dry-run (print the entry + diff without pushing). Degrade with a clear message when gh is missing or unauthenticated.
4. Register share-pack in SEEDED_WORKFLOW_IDS and its UI in SEEDED_UI_IDS in scripts/generate-workflow-pack.ts and regenerate the seeded pack (bun scripts/generate-workflow-pack.ts); commit the regenerated file.
5. Tests: share --dry-run produces a correct entry from a fixture manifest; share-pack workflow renders (smithers graph passes); the add system workflow is hidden from default listings but runnable.`,
    },
    {
      key: "p5",
      title: "messaging: README, homepage, docs",
      prompt: `${spec}
PHASE 5 of the packs feature — messaging. Every feature phase is merged; everything you write must be TRUE against the shipped CLI.

Implement exactly the "Track A — messaging" section of the spec:
1. README.md: new top-level section "Share workflows like skills" after the "Why not just let my agent orchestrate itself?" section — the skills analogy, the monolith/ecosystem/disposable spectrum framing (generic community framing, NO real people's names or likenesses), the two-line demo (smithers add someuser/kanban-suite; smithers workflow run kanban ...), share-pack + smithers share mention, awesome-smithers CTA. Add a "Portable workflows and UIs" bullet to "What you get". Remove the orphaned one-row primitives table (the lone <Loop> row around line 107).
2. docs/index.mdx (Mintlify custom homepage): guarantees become four — Durable / Composable / Portable / Self-improving ("A workflow is a directory. Its UI travels with it. smithers add user/repo installs someone else's."); add a short spectrum-framing block near the "Already fanning out subagents?" section; one added hero-subhead clause about sharing. Keep time travel as the killer feature.
3. New docs guide "Share a pack" (grow it out of docs/workflows/catalog.mdx's Marketplace Metadata + Publishing Checklist and docs/integrations/ecosystem.mdx's Publishing Workflow Packs): manifest schema, pack layout, share-pack, smithers share, awesome-smithers listing. Add it to docs.json navigation.
4. CLI reference docs for add/install/remove/update/packs list/eject/share (docs/cli/overview.mdx catalog + wherever check-docs demands).
5. Regenerate LLM bundles: pnpm docs:llms. 'node scripts/check-docs.mjs' and 'node scripts/check-llms.mjs' MUST be green.`,
    },
  ];
}

type GateState = {
  validated: boolean;
  approved: boolean;
  done: boolean;
  feedback: string | null;
};

export default smithers((ctx) => {
  // Zod input defaults are not applied in every render context (e.g. `smithers
  // graph` renders with an empty input), so fall back explicitly.
  const planDoc = ctx.input.planDoc ?? "research/packs-share-workflows-like-skills.md";
  const phases = buildPhases(planDoc);

  const gates: GateState[] = phases.map((phase) => {
    const validate = ctx.latest("validate", `${phase.key}:validate`) as
      | z.infer<typeof validateOutputSchema>
      | undefined;
    const review = ctx.latest("review", `${phase.key}:review:0`) as
      | z.infer<typeof reviewOutputSchema>
      | undefined;

    const validated = validate !== undefined && validate.allPassed !== false;
    const approved = review?.approved === true;

    const feedbackParts: string[] = [];
    if (validate && validate.allPassed === false && validate.failingSummary) {
      feedbackParts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
    }
    if (review && review.approved === false) {
      feedbackParts.push(`REVIEWER REJECTED:\n${review.feedback}`);
      for (const issue of review.issues ?? []) {
        feedbackParts.push(
          `  [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`,
        );
      }
    }

    return {
      validated,
      approved,
      done: validated && approved,
      feedback: feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null,
    };
  });

  const allDone = gates.every((gate) => gate.done);

  return (
    <Workflow name="implement-packs">
      <UI entry="../ui/implement-packs.tsx" title="Implement Packs" />
      <Sequence>
        {phases.map((phase, index) => {
          // A phase mounts only once every earlier phase is approved, so a
          // stuck phase halts the run visibly instead of building on sand.
          const previousDone = gates.slice(0, index).every((gate) => gate.done);
          if (!previousDone) return null;
          const gate = gates[index]!;
          return (
            <ValidationLoop
              key={phase.key}
              idPrefix={phase.key}
              prompt={phase.prompt}
              implementAgents={implementer}
              validateAgents={validator}
              reviewAgents={[panelists[0]!]}
              reviewWhen={gate.validated}
              feedback={gate.feedback}
              done={gate.done}
              maxIterations={3}
            />
          );
        })}

        {allDone ? (
          <Task id="packs:polish" output={outputs.polish} agent={polishReviewer} timeoutMs={1_800_000} heartbeatTimeoutMs={600_000}>
            {`Every phase of the packs feature ("Share workflows like skills") is implemented, validated, and review-approved. You are the FINAL whole-feature polish reviewer.

Spec: ${planDoc}. Review everything that changed for this feature end to end (recent commits on main). Look for: cross-phase inconsistencies (naming, flag conventions, error-message voice), dead code, doc drift against the shipped CLI surface, missing edge-case tests, and small correctness hazards. Apply small safe polish edits directly with pathspec commits; re-run the affected package tests plus 'node scripts/check-docs.mjs' and 'node scripts/check-llms.mjs' after any edit. Do NOT restructure or expand scope, and NEVER push.

Return polished=true when nothing is left, changesMade listing edits applied, and a short summary.`}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
