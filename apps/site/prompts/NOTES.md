# Reference pipeline: homework notes

What each source taught, as it applies to generated reference pages. The
long-form notes per source group are in `notes/`: `skills.md` (14 docs skills
read in full, 68 skimmed), `references.md` (Diátaxis, Google developer style
guide, Google technical writing courses, Vale Google and Microsoft packages,
Keep a Changelog, Standard Readme), and `exemplars.md` (stripe, react, vite,
starlight, ghostty, bazel, nx, turborepo, plus the Starlight framework
contract). This file is the short form plus the Smithers-side findings that
shaped the pipeline.

## Skills (`~/docs-skills/*`)

- guard-skills--docs-guard: a doc is a set of claims and every claim is
  checkable. Symbol: grep the definition, not a usage. Flag: the argument
  parser. Default: the definition, not the docs of the definition. Where code
  and comment disagree, the code wins and the disagreement is flagged.
  Review output is a count: N claims checked, M false, K unverifiable.
- cursor--technical-writing: reference "describes, only describes"; the
  codebase is the word list; condition before instruction; one name per thing.
- mblode--docs-writing: the Stripe layout rule (parameters, then request,
  then response, per entry, never pooled at the bottom); an entry heading
  followed directly by its table is the one exemption from the
  orienting-sentence rule; realistic names, never `foo`.
- jeffallan--code-documenter, developer-kit--typescript-docs: examples are
  validated with `tsc --noEmit` before the docs ship; `@throws` enumerates
  every error with its condition; coverage is reported as documented/total.
- awesome-copilot--documentation-writer: reference is "a dictionary";
  decide type, audience, goal, and scope (included and excluded) first.
- mcollina--documentation: the entry template name, type, default,
  description, example; a fact is findable in under 30 seconds.
- indexion--documentation: coverage measures presence, not accuracy; the
  "auto-generated skeleton" failure is a page that lists exports without the
  implementation's vocabulary.
- mattpocock--writing-for-agents: a flat peer set is the right shape for
  reference; a generated page is a cache of a lookup and earns its place only
  by adding semantics the lookup lacks; prompt the positive, not the ban.
- anthropics--skill-creator: explain why instead of shouting MUST; pin the
  output format with a literal template; put a table of contents past 300
  lines.
- riekelt--technical-writing: reference is "exhaustive: every key, every
  flag, with defaults"; one fact, one home; no "last updated", no changelog
  inside a page; name the described code in the front matter so a drift check
  has an anchor; rebuild indexes from the leaves.
- samber--golang-documentation: comments say why, when, constraints, and what
  can go wrong; one "Returns ErrX if ..." line per error; a concurrency line.
- expo--expo-api-docs: third-person declarative ("Returns", not "Return");
  document the iceberg (failure modes, side effects); an entry only exists in
  the generated page if the type is exported from the entry point.
- dart-lang--dart-write-documentation: opener by kind (noun phrase for
  values, "Whether" for booleans, verb for methods); the first sentence is the
  summary a generator extracts; never restate the signature.

## References (`~/docs-skills/references/*`)

- Diátaxis reference quadrant: describe, austere, product-led, structure
  mirrors the machinery, consistency over expression, examples illustrate
  without explaining, warnings use must/must not/never. Generation buys
  accuracy, not completeness.
- Google developer style guide: command-line syntax uses `[optional]`,
  `{a|b}`, `...`, and `UPPER_SNAKE` placeholders explained under "Replace the
  following:"; code samples wrap at 80 columns and mark omissions with a
  language comment; never inflect a code identifier; present tense, no
  "will"; second person for the reader, third person for the software; link
  text stands alone; sentence-case headings; introduce every table and block.
- Google technical writing courses: one idea per sentence, under 26 words;
  define a term once; lists parallel; tables for three or more facts per item.
- Vale Google and Microsoft packages: the lint ids to mirror (Google.Passive,
  Google.We, Google.Will, Google.Latin, Google.Timeless, Google.EmDash,
  Google.OptionalPlurals, Microsoft.Wordiness, Microsoft.SentenceLength,
  Microsoft.Avoid). `notes/references.md` turns them into a regex checklist.
- Keep a Changelog: deprecations name the replacement and the version;
  reference pages cite versions, they do not carry a changelog.
- Standard Readme: examples are linted like code.

## Exemplars (`~/docs-skills/exemplars/*`)

- The shared shape: a reference page is a list of named entries, each entry a
  heading, and directly under the heading a fixed metadata block (type,
  default, required, related) before any prose.
- stripe: example before schema; `name (type, required)` on one line; hub
  pages are `[Title](url): purpose` lists.
- react: the spine Reference, Usage, Troubleshooting; Parameters, Returns,
  Caveats per callable; troubleshooting headings are the reader's symptom.
- vite: heading is the fully qualified option path; metadata rows
  Experimental/Deprecated, Type, Default, Related in fixed order; CLI page is
  `### cmd`, `#### Usage` synopsis fence, `#### Options` two-column table.
- starlight: frontmatter `title`, `description`, `editUrl`, `sidebar.order`,
  `sidebar.label`, `sidebar.hidden`, `sidebar.badge`, `tableOfContents`,
  `draft`; sidebar `autogenerate: { directory }` sorts by `sidebar.order`
  then filename; components import from `@astrojs/starlight/components`;
  `:::note` asides need no import; only `h2` and `h3` reach the page ToC.
- ghostty: the config reference is generated from `Config.zig` doc comments,
  so the source comment is the page; the generated-vs-written boundary is a
  file, not a paragraph.
- bazel, nx, turborepo: attribute tables with name, type, default,
  description; commands grouped by lifecycle; flags in one placeholder style.

## Smithers-side findings

- The brief (`smithers-docs-brief.md`) fixes the hard rules the gate enforces:
  no em or en dash, no H1 in the body, frontmatter `title` and `description`,
  sentence-case headings, language on every fence, absolute links with a
  trailing slash into the route map, imports only from the published package
  list, never invent flags or defaults. Every generated page follows them.
- The brief's route map puts generated package pages at
  `/docs/reference/api/<pkg>/` and CLI verbs at `/docs/reference/cli/<verb>/`.
  It has no `/docs/reference/targets/` area; this pipeline adds one for the
  `@smthrs/targets` rule pages.
- `Agent.Diff` (`AgentTarget.ts`) attrs: `agent`, `prompt`, `payload`,
  `mcp`, `data`, `changes`, `gates`, `secrets`, `sandbox`, `approval`,
  `maxRounds` (1 to 16). Kinds `run`, `cache: false`. The session receives
  the rendered `data` files and the write-set; the prompt file is excluded
  from `data`. `S.Agents.<name>` needs a `.smithers/agents.ts`, which this
  workspace lacks, so the writer is an inline `S.Agent.ClaudeCode` declared
  once in the root `PACKAGE.ts`.
- Globs are package scoped: a page that reads another package's sources goes
  through that package's `Filegroup`. A `//`-anchored `S.file` crosses
  packages; a glob never does.
- `Generate` script form: `script: S.file(...)` runs under the workspace
  runtime with cwd at the workspace root, takes no `args`, declares its
  write-set in `changes`; `lint` maps `mode` to `check` (scratch-copy drift),
  `target <label> --write` applies.
- `Markdown.CodeBlocks` extracts fenced blocks and runs explicit roots through
  `tsc --noEmit --strict`. As found, it wrote the scratch files under the
  workspace cache directory, so a block importing `@smthrs/flow` failed with
  TS2307, and a resolved workspace source failed TS5097 on `.ts` imports.
  Fixed in `PackageExec.ts`: the scratch lives under
  `<package>/node_modules/.cache/smithers-build/`, and the argv carries
  `--allowImportingTsExtensions --target es2022`. Regression test in
  `build-cli/test/NodeLaneExecution.test.ts`.
- `Docs.Page` (lane docs-verb-b) is `Agent.Diff` with `brief`, `prompt`,
  `references`, `inputs`, `output`, and `kinds: ["docs"]`; `Docs.Check`
  (lanes docs-check-a and b) hashes the declared input closure into a stamp
  and fails `lint`/`docs`/`ci` with `stale`, `modified`, or `missing`. The
  targets here are shaped to switch: `data = [docsSources, style]` becomes
  `inputs` plus `references`, `changes: [page]` becomes `output`, and the
  `referencePages` filegroup is what a `Docs.Check` would take as `inputs`.
- The `apps/site/src/data/help/<verb>.txt` captures of `smithers <verb>
  --help` are deterministic inputs for the CLI verb pages.
- MDX rejects HTML comments and treats bare `<` and `{` in prose as JSX. The
  ingest rewrites `<!-- -->` to `{/* */}`; the prompts require every type
  expression in code font.
