# Notes: documentation skills, distilled for generated reference docs

Scope of the read: 14 skills read in full (SKILL.md plus the reference sub-files that
carry rules), then a description-level skim of the other 68 folders under `~/docs-skills`.
Target application: generated reference pages (package/API reference, CLI verb reference,
config and rule reference).

## guard-skills--docs-guard

- The governing frame: "documentation is a set of claims about a codebase, and every claim
  is checkable. Your job is to check them." Reference pages are the densest claim surface
  in a docs site, so this rule bites hardest there.
- Rule 1, verbatim: "**Every referenced symbol must exist.** Every function, method, class,
  hook, CLI command, flag, endpoint, config key, env var, and file path mentioned in the
  docs gets verified against the actual source, CLI help output, route table, or schema — by
  reading it, not recalling it. ... An unverifiable reference does not ship."
- Rule 3: "Document the code's actual behavior, not its intended behavior. ... Where code and
  comments/specs disagree, the code is the truth — and flag the disagreement to the user
  instead of silently picking a side." Rule 4 bans unverifiable claims: "'Fast' is marketing;
  'O(n log n), benchmarked in bench/sort.md' is documentation."
- The verification table names the source of truth per claim type: symbol -> grep the
  *definition* not usages; signature -> the definition site, name by name; CLI flag -> the
  argument parser registration ("flags in README but not in the parser are hallucinations");
  endpoint -> route registration; config key -> the code that reads it ("a documented key
  nothing reads is dead documentation"); default value -> "the definition, not the docs of the
  definition"; version claim -> changelog or tag diff.
- Rule 7 kills generated-reference filler: delete "docstrings that paraphrase the signature
  ('Gets the user by ID' above `get_user_by_id`)" and "sections that restate their heading".
  "A docstring earns its place by adding contracts the signature cannot express: units,
  ranges, error conditions, side effects, threading/ordering guarantees."
- Rule 9: "Examples cover the failure path too" — show one failure with the error types the
  code actually raises, verified at the raise site.
- Generated-docs hygiene (references/docstrings.md): "A wrong docstring becomes a published
  wrong reference page — Rule 1 severity applies as if it were the README." `@param` names and
  order must match the signature exactly, "drift here actively lies to IDEs"; `@throws` lists
  what the body actually throws; `@deprecated` always names the replacement.
- Review-mode output format is Claim / Reality (with file:line) / Fix, led by a count:
  "N claims checked, M false, K unverifiable", ending in publish / fix first / do not publish.

## cursor--technical-writing

- Reference is one of four Diátaxis modes and has its own voice contract: "**Reference: facts
  for lookup.** Describe. Only describe. No instruction, no persuasion, no opinion. Be dry,
  complete, and sure: state facts, options, limits, and errors with no hedging. Mirror the
  structure of the thing described, so code and docs can be navigated together. Put material
  where readers expect it. Generate from code where possible, so it stays true."
- Explicit ban on mode mixing: "no reference tables inside a tutorial, no tutorial hand-holding
  inside reference, no arguing inside a how-to. Split and link instead." Under "Vary the rhythm":
  "Have a view where the mode allows it. ... Reference stays dry."
- Naming discipline that matters most for generated pages: "The codebase is the word list.
  Write the real symbol, file, flag, or command name, not a synonym or a description of it."
  And "Call each thing by one name, everywhere."
- Sentence layers to apply to every entry description: put the condition before the instruction;
  put the common case first, exceptions after; one instruction per sentence, split anything over
  ~20 words (instructions) or ~25 (prose); keep "the"/"a" ("Remove backup file" reads two ways).
- Global English disambiguation rules that generated prose fails often: keep "only"/"not" beside
  the word they modify; break noun stacks ("the proto import budget check script" -> "the script
  that checks the proto-import budget"); never point "this"/"which" at a whole clause; no
  slashes, no "(s)" plurals, no em dashes, no Latin abbreviations.
- Headings: sentence case, one h1, no skipped levels, and the heading carries the point.
  Code font for code, bold for UI, serial commas, and "drop 'etc.' and say up front that a list
  is partial".
- Final checklist item 8 is the reference-doc gate: "Are all symbols, paths, and counts real at
  this commit, with the commands that regenerate the counts?"

## mblode--docs-writing

- Classification gates the rule set: "API and CLI pages are reference." A type-gating table
  prevents false positives — `structure-next-steps` and `structure-quick-start` do **not** apply
  to reference pages, and demanding them "is a finding against Diataxis, not for it".
- `scan-three-column-api` (the Stripe layout rule): "every endpoint entry carries its own request
  example and response example, in that order, immediately after its parameters. A reference page
  that describes ten endpoints and then dumps all the examples at the bottom has the same content
  and none of the usefulness." The worked entry is: `## Create a user` -> `POST /v1/users` ->
  parameter table (Parameter | Type | Required | Description) -> Request fence -> Response fence.
- `structure-heading-overview` carries the one reference-specific exemption in the skill: "The
  allowance is reference pages: an entry heading (`### POST /auth/token`, `### --timeout`) followed
  by its signature or parameter table is the standard pattern Diataxis asks reference to adopt, and
  a sentence there would be padding."
- `code-context-ratio`: "A reference page is the opposite [of a tutorial]: a signature, a parameter
  table, a request and a response, with prose only where a value needs qualifying. ... a reference
  page wrapped in paragraphs hides the fact the reader came for."
- `code-error-descriptions`: a bare code-to-label table is a defect. Per error, show the message as
  the reader sees it, the cause, and the fix, with a link to where the fix happens.
- `code-placeholders`: reader-supplied values are `UPPER_SNAKE_CASE`, explained after the block under
  "Replace the following:"; sample credentials use a documented test prefix (`sk_test_...`) or a
  placeholder, never a live-looking body — "GitHub push protection blocks the commit that carries it".
- `code-realistic-example-names`: never `foo`/`bar`/`x`/`data`/`temp`/`result`; use the product's own
  domain nouns (`subscriptionId`, `paymentIntent`, `configPath`).
- `voice-requirements-language`: "must" for requirements, "should" only for recommendations, no
  "please"; and the counter-rule, "'Should' is not a bug ... Flagging every 'should' produces a wall
  of false positives." Plus `nav-agent-readable`: publish `/llms.txt` and a `.md` variant of every
  page, language tag on every fence, "no fact lives only in an image or a collapsed tab".
- Exit criterion for the writing workflow: "a doc ships when its examples ran and its links resolved,
  not when it 'reads well'."

## jeffallan--code-documenter

- The workflow puts validation before reporting, with named commands: `python -m doctest file.py` /
  `pytest --doctest-modules`, `tsc --noEmit` "to confirm typed examples compile", `npx @redocly/cli
  lint openapi.yaml`. "If validation fails: fix examples and re-validate before proceeding."
- MUST DO list, load-bearing for generated reference: "Document all public functions/classes",
  "Include parameter types and descriptions", "Document exceptions/errors", "Test code examples in
  documentation", "Generate coverage report".
- MUST NOT DO: "Assume docstring format without asking", "Write inaccurate or untested documentation",
  "Skip error documentation", "Document obvious getters/setters verbosely".
- The canonical JSDoc shape it emits: description, then `@param {type} name - text` (optional params
  bracketed with defaults, `@param {number} [page=1]`), `@returns {Promise<X>} Resolves to ...`,
  `@throws {NotFoundError} If ...`, then `@example` as a fenced block.
- Tag inventory worth standardizing on: `@param`, `@returns`, `@throws`, `@example`, `@see`,
  `@deprecated`, `@template` (generic type param), `@async`, `@private`, `@readonly`.
- Interfaces and generics get per-property one-line comments (`/** Unique user identifier */`) rather
  than a prose blob; `@template T - Type of items in the data array` documents type parameters.
- Coverage report template makes doneness measurable: functions documented n/m with a percentage,
  before/after coverage, a missing-documentation table with priorities, and a CI step
  (`npm run docs:check`).

## developer-kit--typescript-docs

- Treats the reference site as a build artifact: TypeDoc with `entryPoints`, `excludePrivate: true`,
  `theme: "markdown"`, `readme`, plus `categorizeByGroup` / `categoryOrder` to control section order —
  so page grouping is config, not prose.
- Documentation is validated in CI like code, with concrete ESLint rules: `jsdoc/require-description`,
  `jsdoc/require-param-description`, `jsdoc/require-returns-description` as errors and
  `jsdoc/require-example` as a warning; "re-run `eslint --ext .ts src/` until all errors pass before
  committing."
- Validation checklist to reuse as the reference-page acceptance test: every public method has a
  comment, every param has a `@param` description, every return has a `@returns` description, complex
  functions have `@example`, all `@throws` documented, cross-references use `@see`.
- Best-practices list adds three fields generated reference usually lacks: `@remarks` for
  implementation notes, performance notes ("O(n) where n is the email string length"), and security
  notes ("Passwords hashed with bcrypt (cost factor 12)").
- Rich `@throws` enumeration is the pattern, not a single line: `InvalidCredentialsError`,
  `AccountLockedError`, `RateLimitExceededError`, each with its condition.
- Constraints: `@deprecated` carries migration guidance, `@see` links must resolve, "All examples
  should be runnable and tested", never put secrets in docs, and keep docs in sync with versions.

## awesome-copilot--documentation-writer

- Reference is defined by contrast: "**Reference:** Information-oriented, technical descriptions of
  machinery. A dictionary." That framing sets the register — lookup, not narrative.
- Four guiding principles, of which two are the reference-page load: accuracy ("all information,
  especially code snippets and technical details, is correct and up-to-date") and consistency
  ("consistent tone, terminology, and style across all documentation").
- The workflow forces four decisions before drafting and makes them explicit: document type, target
  audience, user's goal, scope (what is included **and excluded**).
- It gates writing on an approved outline ("propose a detailed outline ... Await my approval before
  writing the full content") — for a generated set, the analogue is agreeing the per-entry template
  before generating every page.
- Contextual-awareness rule useful for generation runs: use sibling markdown files to infer tone and
  terminology, but "DO NOT copy content from them unless I explicitly ask you to", and do not consult
  external sources unless given a link.

## mcollina--documentation

- The per-entry format for reference, spelled out: "Structure: Consistent repeatable format per entry
  (name -> type -> default -> description -> example)". The worked entry is
  "**`timeout`** *(integer, default: `5000`)* / Maximum time in milliseconds to wait for a response
  before the request fails. / *Example:* `{ timeout: 3000 }`".
- Title pattern for reference pages: "Name the thing — *'Configuration options'*, *'API endpoints'*,
  *'CLI flags'*" — a noun phrase, never a task phrase.
- Content rule: "State facts; avoid instruction beyond minimal usage examples. Keep current;
  version-stamp if needed."
- The validation test is a measurable one: "A user can look up a specific fact in under 30 seconds
  without reading surrounding content." That is the acceptance criterion I would put on a generated
  reference page.
- Separation and integration: one type per document, no reference tables inside tutorials, and
  cross-link outward — "a tutorial can link to the relevant reference page".

## indexion--documentation

- Reference coverage is a number, not an impression: coverage = documented public items / total public
  items, reported per package with a functions-vs-types split ("Overall Coverage: 81% (2285/2806) /
  Functions: 89%, Types: 75%").
- The stated caveat is the important one for generated docs: "Coverage measures presence of doc
  comments, not accuracy. A `///|` marker counts as documented." Presence checks and truth checks are
  two different gates.
- Drift detection is a separate pass ("plan reconcile") reporting vocabulary divergence, stale docs
  (code changed after docs), and missing docs. "90%+ distance means the README is essentially unrelated
  to the current code."
- Named failure of auto-generated reference: "Auto-generated skeleton READMEs (API listing only) have
  high divergence because they lack the vocabulary of the actual implementation. Enrich them with
  descriptions of what the code does, not just what it exports." That is precisely the failure mode of
  a naive generated reference page.
- Direction gap worth remembering: "Reconcile only checks implementation -> docs direction. It detects
  code terms missing from docs, but does NOT detect docs referencing nonexistent CLI options. For that
  direction, compare each README against `indexion <command> --help` manually."
- Timestamp strategy matters for the drift signal: `--git` uses commit timestamps, `--mtime-only` sees
  uncommitted fixes.

## mattpocock--writing-for-agents

- Prompt/pointer structure rule, verbatim: "A pointer does two jobs: state what the material is, and
  list the **branches** that should trigger reaching it (a branch is a distinct case the document
  handles ...)" with three prunings: "**Front-load the leading word**: the pointer is where it does
  its triggering work. **One trigger per branch.** Synonyms that rename a single branch are one branch
  written twice; collapse them ... **Cut identity the body already carries.**"
- The information hierarchy: in-file step > in-file reference > disclosed reference behind a pointer.
  For a reference set: "Often a legitimately flat peer-set (every rule of a review on one rung), which
  is a fine arrangement, not a smell" — a flat list of entries is the right shape for reference.
- Progressive disclosure test: "inline what every branch needs, and push behind a pointer what only
  some branches reach." Co-location is the within-file companion: "Keep a concept's definition, rules,
  and caveats under one heading rather than scattered."
- Completion criteria are what make an exhaustive reference actually exhaustive: "'every rule applied'
  binds a body of flat reference just as 'every step done' binds a sequence, which is how an
  all-reference document still carries an exhaustiveness bar. The strongest criteria are both checkable
  and exhaustive."
- Single source of truth and the cache rule: "The **environment** is a source of truth too
  (`package.json` scripts, config files, the directory layout, `--help` output), and a document that
  restates it is a **cache**: a copy of a lookup, earning its load only when the lookup is expensive.
  Cache what the agent cannot find by looking." Generated reference is a deliberate cache — it earns
  its keep only if it adds semantics the lookup does not carry.
- Negation is a failure mode: "steering by prohibition drags the forbidden behaviour into context and
  makes it *more* available. ... Prompt the **positive**." Style prompts should state the target
  behaviour, not the ban.
- Pruning tests: relevance ("does it still bear on what the document does"), sediment (stale layers
  that accumulate because adding feels safe), and no-ops ("an instruction the model already obeys by
  default pays load to say nothing ... delete the whole sentence rather than trim words from it").

## anthropics--skill-creator

- Progressive disclosure as a three-level loading system: metadata always in context (~100 words),
  body when triggered ("<500 lines ideal"), bundled resources as needed. "For large reference files
  (>300 lines), include a table of contents."
- Domain organization pattern that maps directly to a generated reference tree: one entry file for
  workflow plus selection, and `references/<variant>.md` per domain, "Claude reads only the relevant
  reference file".
- Writing style rule against the heavy-handed register: "Try to explain to the model why things are
  important in lieu of heavy-handed musty MUSTs. ... If you find yourself writing ALWAYS or NEVER in
  all caps, or using super rigid structures, that's a yellow flag — if possible, reframe and explain
  the reasoning."
- Output formats are pinned with a literal template ("ALWAYS use this exact template:") and examples
  are given as Input/Output pairs — the right way to specify a per-entry reference format to a
  generator.
- Generalization warning that applies to a style prompt: iterating on a handful of examples produces
  overfit rules; "if the skill you and the user are codeveloping works only for those examples, it's
  useless. Rather than put in fiddly overfitty changes, or oppressively constrictive MUSTs, ... try
  branching out and using different metaphors."
- Repeated work across runs is a signal to bundle a script rather than re-describe a procedure: "If
  all 3 test cases resulted in the subagent writing a `create_docx.py` ... that's a strong signal the
  skill should bundle that script."
- Evaluation discipline: objective assertions with descriptive names for verifiable outputs, human
  review for subjective ones; "For assertions that can be checked programmatically, write and run a
  script rather than eyeballing it."

## riekelt--technical-writing

- Its document-kind table gives reference its own edit rule, verbatim: "Reference | API docs, config
  references, indexes | **Exhaustive: every key, every flag, with defaults and a Usage column.**"
  Descriptive docs are "Update to match code exactly. Verify against implementations, not names."
- Core principle: "a document states current, verified behavior, conclusion first, with every claim
  traceable to a source, and every fact living in exactly one place." Hard rule: "**One fact, one
  home.** Everything else links to the owner. A summary may route, never decide: when an index and its
  source disagree, the source wins and the index is the bug."
- Anti-drift rules for generated pages: no "last updated" field and no changelog section inside a
  document ("Git history is the history"); "A descriptive document names the code it describes. Put the
  path (a module, a directory, an entry point) in the front matter or the opening, so drift checks have
  an anchor."; "Indexes are derived artifacts. Rebuild them from the leaves and verify counts against
  the actual files; every entry gets a one-line purpose."
- Coverage as a denominator: "When auditing documentation, count documented items against total public
  items (endpoints, commands, config keys) rather than judging completeness by impression." And "Print
  the command behind a count, and run it against committed state (HEAD), never the working tree."
- Style rules that hit generated prose hardest: one term per concept for the whole document, never
  rotate synonyms including verbs; "Replace an adjective with a number wherever one exists"; keep
  articles; no noun stacks over three words; "was refactored to", "now uses", "replaces the old"
  describe an edit, not the system.
- The banned-constructions table is a ready-made lint list: antithesis ("not X but Y"), importance
  announcements ("It is important to note"), recap sentences, rhetorical triads, question headings
  ("Why this matters"), throat clearing, inflated adjectives (crucial, robust, comprehensive, seamless),
  cursed vocabulary (delve, leverage, unlock, realm), trailing participle analysis (", highlighting the
  need for"), bold-lead bullets, emoji furniture, assistant residue, closing offers.
- Formatting restraint: "Tables only when items carry two or more properties each and a reader compares
  across them. A two-column table of prose is prose, or a list." Headings in sentence case; the first
  sentence under a heading never repeats the heading.
- Third-party facts are perishable: "any vendor, model, API, or library claim carries the date and
  commit at which it was observed."

## samber--golang-documentation

- The why/what split, stated as the top doc-comment rule: "The code already tells the reader *what*
  happens — comments SHOULD explain why, not what: **Why** this function exists ... **When** to use it
  (and when not to) ... **What constraints** apply (preconditions, thread safety, performance) ...
  **What can go wrong** (error cases, panics, edge cases)."
- The paraphrase anti-pattern is called out with its subtlety: "Pure paraphrase | `// GetUser gets a
  user` on `func GetUser()` — starts with the name (required by godoc) but adds nothing | After the
  name, add *when* to use it, constraints, and what can go wrong."
- Full comment template for a reference entry: summary line starting with the symbol name and a verb
  phrase, then Parameters (with ranges and constraints), then "Returns X. Returns ErrY if <condition>."
  per error, then Panics, then a concurrency line ("It is safe for concurrent use" / "It is NOT safe"),
  then a runnable link and an Example.
- Limitations get their own block: "Limitations: - Does not support day, week, month, or year units.
  - Precision is limited to nanoseconds." Deprecation uses the tool's marker plus a replacement and a
  removal version: "Deprecated: Use NewFunc instead. OldFunc will be removed in v3.0.0."
- Interface docs document the contract implementations must satisfy, and each method carries its own
  error semantics ("Returns nil (not an error) if the key does not exist").
- Package-level docs are mandatory and use structured headings ("# Supported Sources", "# Validation",
  "# Thread Safety") to carry precedence rules and thread-safety statements the per-symbol entries
  cannot.
- Writing principles: "Concision ... Never drop facts, warnings, or user-requested depth"; "No invented
  context — omit unsupported rationale, marketing claims (`seamlessly`, `robust`, `enterprise-grade`),
  or future promises. Leave gaps visible rather than filling with speculation"; "Preserve meaning when
  editing — keep modality intact (`must`/`should`/`may` are different obligations)."
- Executable documentation is preferred where the language offers it: `ExampleXxx` test functions "are
  executable documentation verified by `go test`", plus playground links in the comment.

## expo--expo-api-docs

- Per-API entry format, in its own words: "First sentence: what the function does. Additional
  sentences: important behavior, edge cases, platform differences. Leave off trailing period for
  single-phrase descriptions. Use periods when writing multiple sentences."
- Mood is fixed: "Use third-person declarative ('Gets...', 'Returns...', 'Checks...'), not imperative
  ('Get...', 'Return...')." Bad/good pair given: "Get the value" is wrong.
- Core principles, verbatim: "**Third-person declarative** ... **Explain the iceberg** — document
  failure modes, side effects, concurrency behavior, not just params/returns ... **Quality over
  quantity** — no docs is better than useless docs like 'The width' for a `width` property."
  The repair is shown: "The width of the captured photo, measured in pixels".
- Types and interfaces are documented **per property**, with `@default` on each optional field and a
  statement of when the field applies ("Applicable only when `format` is set to `jpeg`, ignored
  otherwise").
- Parameter format: "`@param paramName Description starting with capital letter`", and parameters may
  carry markdown, links, and blockquote notes for constraints (an OS-version sampling limit, a required
  permission).
- Availability annotations are conditional, not decorative: "**Do NOT use `@platform` when all
  platforms are supported** — only add when limiting availability", version-qualified as
  `@platform ios 11+`. `@deprecated` auto-renders as a warning; `@experimental` labels unstable APIs;
  `@hidden`/`@internal` keeps things out of the generated page.
- Return-value language is standardized on MDN's phrasing: "@returns A promise that resolves to a
  CameraPhoto object."
- A generation-pipeline constraint worth copying: "Types must be exported from the entry point file for
  docs generation to pick them up" — an entry missing from the generated reference is usually an export
  problem, not a writing problem. Also: no `@link` tag, use markdown links; every example fence carries
  a language tag and a file-path label.

## dart-lang--dart-write-documentation

- Openers are typed by declaration kind: noun phrase for variables/getters/setters ("The radius of the
  sphere." not "Gets the radius..."), "Whether" for booleans ("Whether the connection is active."),
  third-person verb for methods ("Initializes the database." not "Initialize" or "This method
  initializes").
- First-paragraph contract: "The first paragraph of a doc comment must be a single, concise sentence
  that summarizes the element. End it with a period. Dartdoc extracts this verbatim for list views."
  Separate it from the body with a blank `///` line.
- Redundancy ban: "Do not restate the signature or the element name. Do not say 'This class is a...'
  or 'The foo method does...'."
- The strongest anti-pattern in the set, and it cuts against JSDoc habits: "**No Javadoc/TSDoc Tags
  (`@param`, `@return`, `@throws`, etc.):** Never use Javadoc-style tags ... Instead, weave parameter
  names, return behavior, and exceptions into the prose." Worked example: "If [force] is true, this
  bypasses the local cache ... Throws a [NetworkException] if the host is unreachable."
- Linking is generator-aware: square brackets for in-scope identifiers so the generator resolves them,
  no parentheses in method links (`[String.contains]`), backticks for keywords and literals (never
  `[null]`), `.new` for the unnamed constructor, `@docImport` for out-of-scope symbols.
- Placement traps that silently break generated output: doc comments go **before** metadata annotations
  (`@override`); document only the getter of a getter/setter pair; do not duplicate inherited docs on
  `@override` members.
- Code fences must be language-labelled "as Dartdoc will attempt to auto-detect the language and
  frequently guesses wrong". Verification step: run the analyzer so bracketed references resolve without
  `comment_references` warnings, then optionally render.

## Skimmed

Rule-carrying folders, one line each on what they add for reference docs.

- riekelt--documenting-contracts — the most reference-specific skill in the collection: four detail
  levels (Index / Semantics / Shape / Example) each with one home, a DTO catalog with wire types not
  language types, `Required` as a tri-state (`yes` / `no` / `if <condition>`), omitted-versus-null
  stated wherever it matters, errors cataloged once as envelope plus status table, "Examples are
  illustrative, never normative ... the table is the contract", "Verify against the serializer, not the
  class", and one-home deference to a generated OpenAPI spec when one exists.
- wondelai--technical-documentation — has an explicit "Reference Docs: API, Docstrings, CLI Help"
  section: "every entry must exist and read the same way"; category verbs ("Gets the…", "Sets the…",
  "Checks whether…", never "This method…"); non-boolean params start "The…"/"A…" and booleans read
  "If true, … If false, …"; deprecated elements name the replacement in the first sentence; CLI help
  gets a usage line in `[optional]` syntax plus every flag in one placeholder style.
- epicenter--google-devdocs-style — dense line-level rules: keep reference text timeless (delete
  "currently", "now", "new", "latest"); "Say required, recommended, or optional. Do not lean on
  `should`"; code font vs bold split, and never inflect a code element as English ("send a `POST`
  request", not "`POST` the data"); `UPPER_SNAKE_CASE` placeholders with no `MY_`/`YOUR_` prefix;
  no directional language; accessibility rules for status colors.
- remotion--writing-docs — the strongest page-granularity rule found: "**One API per page**. Each
  function or API should have its own dedicated documentation page"; "**Use headings for all fields**"
  (`###` per top-level property, `####` per nested one, never bullets for fields); API names in
  backticks with `()` for functions and `<Angle>` for components; `<AvailableFrom v="4.0.0" />` at the
  page, section, or field where the reader first needs it; public API only.
- tldraw--write-docs — per-article structure (Overview -> Basic usage -> Details -> Edge cases ->
  Links), frontmatter with keywords for search, and `[ClassName#methodName](?)` auto-resolving API
  links so reference cross-links cannot rot.
- jetbrains--update-docs — "Never manually edit website docs without cross-validating flags against Go
  source first", plus an explicit source-file-to-doc-page mapping so a code change routes to the exact
  reference page it invalidates.
- sentry--document-api-endpoint — types-as-docs: diff the declared schema against the live endpoint
  response (`curl … | jq 'keys'`), reuse the canonical response type instead of a second copy, and the
  nullable-vs-absent distinction (`T | None` = key present, value null; `NotRequired[T]` = key only set
  under a condition).
- prefect--write-docs — per-section tone contracts and, critically, "Examples ... **Auto-generated — do
  not edit directly**": generated pages get an edit-the-source banner and a regeneration command.
- mintlify--mintlify — how a docs platform models API reference pages: `docs.json` navigation, component
  set, and OpenAPI-driven reference generation.
- wshobson--openapi-spec-generation — OpenAPI 3.1 generated from code as the machine-readable reference
  contract, with validation patterns; the "generated spec owns the field tables" case.
- softaworks--backend-to-frontend-handoff-docs — API handoff docs: request/response shapes and error
  contracts written for an integrator who cannot read the backend.
- canonical--documentation-diataxis — classification pass that flags "misalignments between declared
  category and actual content", i.e. a reference page that has drifted into how-to.
- sammcj--diataxis-documentation, beagle--docs-plugin, strands--docs-planner, mcollina-adjacent set —
  Diátaxis application, per-quadrant skills, and gap-prioritization for a docs backlog (planner counts
  undocumented surfaces before writing).
- anthropics--documentation — general house skill covering API docs and architecture docs alongside
  READMEs and runbooks.
- anthropics--doc-coauthoring — three-stage co-authoring workflow (context transfer, outline approval,
  drafting) worth mirroring when a reference template must be agreed before bulk generation.
- deepseek-harness--dsh-doc / dsh-prose-standard — audience-first hierarchy with kind-mapped YAML
  metadata and summary/contents navigation; the prose standard decides where docs and comments are
  required across Markdown, JSDoc, and diagnostics.
- openclaw--technical-documentation — build-and-review pass covering both human docs and agent
  instruction files in one repo.
- angular--adev-writing-guide — Google technical-writing standards plus site-specific markdown
  extensions and code-block components; the model for "house style + platform components".
- flutter--write-technical-docs — clear prose rules explicitly scoped to include API references, UI
  text, error messages, and terminology reviews.
- n8n-docs--n8n-docs-author — per-content-type templates including reference docs for a node, enforced
  against a published style guide.
- warp--write-feature-docs — spec (PRODUCT.md / TECH.md) to MDX page: the input-artifact-to-doc-page
  pipeline shape.
- metabase--docs-write / metabase--docs-review — a house voice plus a matching review skill; the pattern
  of pairing a writer prompt with a reviewer prompt.
- sentry-docs--docs-review, vercel-labs--writing-guidelines, elastic--docs-check-style,
  circleci--vale-linter, dart-site--proofread-markdown — prose-lint and style-review passes; Vale with
  the Google or Microsoft package is the mechanical layer under any style prompt.
- ai-devkit--technical-writer — rate on Clarity / Completeness dimensions 1-5 and "Suggest concrete fix
  text, not vague advice"; a usable review output contract.
- softaworks--writing-clearly-and-concisely — Strunk rules against AI slop; sentence-level cleanup.
- posthog--tone-writing-style, sentry--blog-writing-guide — house voice for marketing and blog; explicitly
  the register reference pages must **not** adopt.
- context-engineering-kit--update-docs, jetbrains--changelog, gemini-cli--docs-writer,
  gemini-cli--docs-changelog — docs-sync and changelog automation; the "docs change in the same PR"
  mechanism.
- awesome-copilot--create-llms / update-llms, indexion--readme — llms.txt generation and README assembly
  from doc comments; the machine-readable index layer beside generated reference.
- awesome-copilot--create-readme / readme-blueprint-generator, mblode--readme-creator,
  softaworks--crafting-effective-readmes, divar--generate-readme, samber templates — README-shaped, not
  reference-shaped; relevant only for the entry page that links into the reference.
- mattpocock--grill-with-docs, obra--writing-plans, obra--writing-skills, anthropics--skill-development,
  anthropics--agent-development, anthropics--claude-md-improver — documents an agent consumes; relevant
  to the style prompt itself rather than to the reference pages it produces.
- addyosmani--documentation-and-adrs, armory--adr-writer, developer-kit--adr-drafting, vercel-ai--adr-skill,
  wshobson--architecture-decision-records, riekelt--writing-design-docs — ADR and design-doc genres; they
  own the "why", which is exactly what reference pages should link to rather than absorb.
- riekelt--writing-changelogs / runbooks / issues / postmortems / documenting-legacy-codebases,
  wshobson--changelog-automation, composio--changelog-generator, jsmastery--document,
  awesome-copilot--github-release — sibling genres; the version-and-deprecation facts a reference entry
  cites come from the changelog surface these own.
- antfu--vitepress, awesome-copilot--mkdocs-translations, composio--content-research-writer,
  awesome-copilot--comment-code-generate-a-tutorial, fenng--tech-doc-style-chinese — site tooling,
  translation, research writing, and a non-English style guide; no reference-entry rule beyond fence and
  navigation mechanics.

## Distilled rubric

Rules for a shared style prompt given to an LLM writing generated reference pages.

1. Classify the page as reference and hold the register: describe only. No instruction, no persuasion,
   no opinion, no hedging. Push the "why" to a linked explanation page and the "how" to a linked how-to.
2. Verify every symbol, flag, endpoint, config key, default, path, and version against the source in this
   session — the definition site, the argument parser, the route table, the schema — not from memory. An
   unverifiable entry does not ship.
3. Read the implementation and document what it does, not what a comment, spec, or name says it does.
   When code and comment disagree, follow the code and flag the disagreement.
4. Be exhaustive over the declared surface: every public function, type, method, field, constant, enum
   value, command, flag, and config key. Report coverage as documented/total, and say what was excluded
   and why. A missing entry reads to the user as "unsupported".
5. Use one repeatable entry template for the whole set, and never vary it per entry: name and signature,
   type, required, default, constraints, description, errors, availability, example.
6. One entry per heading, one page per API where the surface is large enough. Give every field its own
   heading or its own table row; never bury a field in a bullet list or a paragraph.
7. Entry headings are the exemption to the orienting-sentence rule: `### POST /v1/users` or
   `### --timeout` followed directly by a signature or parameter table is correct, and an intro sentence
   there is padding.
8. Write the first sentence as a complete, standalone summary — generators extract it verbatim for index
   and list views. One sentence, ending in a period, then a blank line before the body.
9. Fix the mood per declaration kind: third-person verb for functions and methods ("Gets", "Returns",
   "Checks"), noun phrase for properties and constants ("The radius of the sphere"), "Whether …" for
   booleans, "If true, … If false, …" for boolean parameters.
10. Never paraphrase the signature. An entry earns its place only by adding what the types cannot express:
    units, ranges, null and empty semantics, side effects, events emitted, idempotency, ordering,
    concurrency and thread safety, performance bounds, and known limitations.
11. Document every error the code can actually produce, at the raise site: the error name or status, the
    condition that triggers it, and what the caller should do. A code-to-label table with no cause and no
    fix is a defect.
12. Give every entry a runnable example with imports, real values, and the expected output shown as it is
    actually produced. Language-tag every fence. Add one failure-path example wherever failure is normal.
13. Name example values from the product's domain (`subscriptionId`, `configPath`), never `foo`, `bar`,
    `x`, `data`, `temp`, or `result`. Reader-supplied values are `UPPER_SNAKE_CASE` placeholders explained
    under "Replace the following:". Credentials use a documented test prefix or a placeholder; never a
    live-looking key body.
14. State availability and lifecycle explicitly: the version a thing was added in, `@deprecated` with the
    replacement and the removal version, and an experimental or preview callout placed before the details,
    not after. Add a platform or environment qualifier only when it limits availability.
15. Keep reference text timeless. No "currently", "now", "new", "recently", "soon", no "last updated"
    field, no changelog section inside a page. If newness matters, name the version or the date beside
    the claim.
16. Keep one home per fact. When a machine-readable spec (OpenAPI, TypeDoc JSON, `--help`) owns the field
    tables, link it and document only what it cannot say. Do not hand-maintain a second copy of anything
    a generator emits.
17. Use one name for one thing across the whole set, and use the real symbol, file, flag, and command
    names from the codebase — never a synonym, a description, or an invented metaphor.
18. Cut every unverifiable claim and every marketing adjective: "fast", "powerful", "seamless", "robust",
    "comprehensive", "production-ready", "enterprise-grade". Replace an adjective with a number and its
    source, or delete it.
19. Ban the slop constructions outright: importance announcements ("It is important to note"), throat
    clearing ("There are several ways to"), recap sentences, rhetorical triads, question headings ("Why
    this matters"), trailing participle analysis (", highlighting the need for"), bold-lead bullets,
    emoji furniture, and assistant residue.
20. Apply the sentence layer: active voice with a named actor, present tense, second person for anything
    addressed to the reader, one idea per sentence, condition before instruction, common case before the
    exception, articles kept, noun stacks broken up, "only" next to what it modifies, and every "it"
    pointing at one obvious noun.
21. Format for lookup, not for reading: sentence-case headings, tables only when each row carries two or
    more compared properties, code font for anything typed or returned verbatim, bold for UI labels,
    descriptive link text, and no fact that exists only in an image or a collapsed tab.
22. Make cross-references resolve through the generator's own linking syntax so they cannot rot, and check
    that every internal link and anchor resolves before publishing.
23. Anchor each generated page to the source it describes — the module, entry point, or schema path — so a
    drift check has a hook, and regenerate the index from the leaves rather than hand-editing it.
24. Ship only after the gate: every example ran or compiled, every link resolved, every parameter name,
    order, and default matched against the implementation, and the coverage count recorded with the command
    that reproduces it. "Reads well" is not the exit criterion.
25. When a fact changes, sweep every surface that states it in the same change — reference page, index,
    docstring, example, config sample — and grep the docs for the old name before finishing.
