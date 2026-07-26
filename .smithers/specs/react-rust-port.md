# Operation Ferric — campaign spec (v3, de-risked)

**Mission:** rewrite React's runtime in Rust (WASM in the browser, native for SSR), judged by React's own
unmodified test suite, executed end-to-end by ONE durable Smithers workflow — as a marketing campaign whose
credibility requirement is **production-grade software real apps adopt**, culminating in a **dual API**:
the TypeScript drop-in first, then a Rust-native authoring API (write React purely in Rust).

**Status:** spec approved-pending; workflow not yet authored. Nothing ports until M0's oracle exists.

**Provenance.** Round 1: four blind planners (Fable subagent, GPT-5.6 Sol, Kimi K3, session v1) converged
independently on the same core architecture; judged and fused (plan v2: `~/Desktop/react-rust-plan/index.html`).
Round 2: three specialized de-risk lanes, reports vendored here and normative where cited:

- `react-rust-port/report-fable.md` — bridge contracts (S1–S26), reentrancy (E1–E12), jest/WASM harness, MODULE_QUEUE.
- `react-rust-port/report-sol.md` — packaging/loading/CSP, version train, error DX, soak/beta/GA, ops, budget.
- `react-rust-port/report-kimi.md` — M9 Rust API design (D1–D15), distribution modes, twin conformance.
- `react-rust-port/MODULE_QUEUE.tsv` — generated reconciler work queue (81 rows; regenerate per report §4.4).

React source pinned from `/Users/williamcory/react` (facebook/react@main, cloned 2026-07-24); exact SHA is
pinned at M0 and recorded in the baseline manifest.

---

## 1 · The claim, and what makes it falsifiable

Ship as **`@ferric/*`** (npm) and **`ferric-react*`** (cargo): "an unofficial Rust/WASM implementation of
React's engine, validated by React's own test suite at SHA X. React is a trademark of Meta." Never publish
under upstream names; drop-in via npm aliases (`react` → `npm:@ferric/react@…`). Courtesy note to the React
team at launch.

Definition of "passes React's test suite" — **the command is the claim**:

```
yarn test --build -r=stable            # DEV     + --prod
yarn test --build -r=experimental      # DEV     + --prod
```

green at the pinned SHA, jest configs checksummed, **0 tests skipped/deleted/edited**, plus:

1. **`REACT_RUST_ASSERT_BACKEND=1`** in every leg: any root/request that touches a JS fallback fails the
   test; import audit proves no ported JS implementation path executes; signed baseline test-identity
   manifest (file hashes, test IDs + statuses, config hashes, flag values) diffs clean before every land.
2. **The Rust-aware source leg** runs the 43 `*-test.internal.js` files build mode excludes
   (count corrected from 48 by measurement — report-fable §F1).
3. **xfail ledger**, public, three buckets: (a) source-mode-only, (b) compiled-out dead flags,
   (c) genuine regressions with owner. Bucket (c) = 0 at ship (≤10 with public issues is the declared fallback).
4. Differential fuzz vs upstream React (trees + interaction scripts → identical DOM, scheduler yield logs,
   console output): 100M+ cases, zero divergence, from M4.
5. Monotone ratchet: `passing.json` written only by the gate task; regression halts the merge queue.
   Red only on real failed-test evidence; OOM/timeout/infra retries with headroom.

## 2 · Scope

**In (~135k LOC src):** scheduler (+ `unstable_mock`), shared, react-is, react, react-reconciler,
react-dom-bindings, react-dom, react-server (Fizz + Flight server), react-client,
react-server-dom-webpack (the one Flight bundler adapter), react-test-renderer + react-noop-renderer
(oracle hosts), react-markup. `packages/react` and the event system stay JS **by published design decision**
(still fully judged by the suite).

**Out, named publicly:** DevTools apps (the `__REACT_DEVTOOLS_GLOBAL_HOOK__` renderer interface ships;
the app doesn't), react-native-renderer, react-art, compiler, eslint-plugin-react-hooks, react-refresh
(stays JS, still works), non-webpack Flight adapters, www/Meta channels, legacy `renderToNodeStream`.

**Channels:** oss-stable + oss-experimental. 65 feature flags codegen'd into Rust const tables per channel
from the *same file* the readonly fork reads (`@gate` predicates evaluate source truth — report-fable §F11);
codegen fails closed on drift.

## 3 · Architecture (normative decisions)

Consensus boundary (4/4 blind convergence): **Rust owns structure and decisions** (fiber tree, lanes,
scheduler internals, diffing, commit planning, hooks bookkeeping, Fizz/Flight state machines);
**JS owns identity, values, and the DOM** (elements, props/state values, closures, DOM application,
synthetic events). One trampoline per component render / hook dispatch / effect; everything between is
engineered away (atoms, `scanChildSet` bulk intake, phase-scoped command buffers, generational
`JsRef {slot, generation}` handles, batched `Object.is`).

Bridge decisions D1–D7 (report-fable §2) are **normative**:

- **D1** Fresh `WebAssembly.Instance` per jest module-registry evaluation; `Module` cached per test-file
  realm. Measured: 38–135µs/instance vs ~16,000 resets/run ⇒ seconds of total cost. Engine-singleton designs
  are *semantically wrong* (ReactFlight-test holds two live registries in one test). Fallback valve
  (`ferric_reset()` export) only if M0 measures >10ms/reset on the real artifact.
- **D2** **The scheduling seam stays a swappable JS module boundary** (`require('scheduler')`) in every
  oracle artifact — build mode mocks scheduler globally (`setupTests.build.js:3`) and tests substitute custom
  JS schedulers. A Rust reconciler short-circuiting to its sibling Rust scheduler in-wasm silently stops
  being judged. All engine scheduling exits through ONE glue chokepoint (also implements act-queue diversion).
- **D3** **Iterative-by-construction** for every recursion scaling with tree depth (Fizz `renderNode` chain,
  commit traversals, DEV double-invoke walks): explicit heap frame stacks. The render loop is already
  iterative; the oracle runs on default ~1MB stacks under React's own jest configs with no flag escape.
  Clippy lint + review-checklist item: no engine function recurses on tree/element/child depth.
- **D4** Exceptions never cross the ABI raw: tagged status both directions; glue try/catch reifies throws to
  handles; wasm traps never a semantic path.
- **D5** MODULE_QUEUE semantics: 59 of 81 reconciler modules are ONE strongly-connected import cycle
  (measured, Tarjan) ⇒ **no per-module landing order exists for the core.** 22 leaf modules land as
  dependency-ordered rows; the SCC lands as **feature-cohort rows** (a–f) through one halting merge queue.
  Per-module lane partitioning of the core is forbidden (guaranteed merge hell).
- **D6** `panic = "abort"`; trap ⇒ instance poisoned ⇒ `FerricInternalError` with breadcrumb; under
  ASSERT_BACKEND any poisoning fails the test. DEV work-loop fuel guard (~10⁷ units) turns hangs into errors
  (build artifacts lack the babel infinite-loop guard; a wasm hang blocks the jest worker's event loop).
- **D7** Command buffers are phase-scoped to `pendingEffectsStatus` transitions (the commit is an
  interruptible 8-state machine that can park on stylesheets): before-mutation / mutation / ref / layout /
  passive buffer classes, explicit `root.current` flip between mutation and layout, buffer split is a
  correctness boundary.

Crossing-scenario contracts **S1–S26** and reentrancy contract **E1–E12 + bridge-frame stack** (report-fable
§4.1–4.2) are the BRIDGE.md v0; M0 promotes them into the campaign repo verbatim and extends only additively.

**M9-enabling constraints (report-kimi §7.3 — adopted now, each ≤1 day inside planned work):**
fiber `type` = tagged u32 `Host(Atom) | Js(JsRef) | Rust(SlabId reserved)` (M4); handler/effect slots and
event records are tagged unions `JsHandle | RustSlabId` (ABI.md, M0); hook state slots are
`Value::Js(JsRef) | Rust` (M4); element intake consumes packed descriptors internally, JS element
materialization only at the JS boundary (M4); render dispatch returns Rust-native `Result<Elem, Thrown>`
internally (M0); fiber debug names via indirection table shared with warnings.rs (M4); engine behind a
`Host` trait, napi one impl (M6); Suspense wake path accepts an internal `Wake` enum, not only JS thenables
(M4/M6).

**Timers:** glue never schedules with `setTimeout`/`MessageChannel` directly — the whole suite runs under
global legacy fake timers and internal `act()` *requires* them; timer/clock/MessageChannel lookups resolve
the current realm's globals at call time (never captured at wasm init). Warning strings live in
`warnings.rs`, byte-identical, mechanically diffed; component stacks built by the JS debug helper (console
matchers keep real JS function names). PROD errors are constructed in-sandbox as coded-URL `Error`s (the
harness proxies `global.Error` to decode them); codes generated from upstream `codes.json`;
`yarn extract-errors` on a candidate build must produce zero diff.

## 4 · Milestones and gates

| # | Milestone | Weeks | Gate (all must pass) |
|---|---|---|---|
| M0 | Oracle + guides + POC | 1–2 | Runner passes 262/262 on unmodified React; baseline manifest signed; harness canaries (WebAssembly-in-jsdom, real per-reset cost on ReactDOMFizzServer-test, cross-realm Module cache, RSS trend); BRIDGE.md/ABI.md/PORTING.md/HANDLES.tsv authored + adversarially reviewed; baseline benchmarks + preregistered bench contract frozen |
| M1 | Trial: react-is + shared | 2 | Full machine (1 implementer + 2 split-context adversarial reviewers, merge queue, ratchet) on 4.2k LOC; suites 100%; flag codegen proven |
| M2 | Scheduler + mock | 3 | Scheduler suite 100%; **whole remaining suite green on the Rust mock through the JS seam (D2)**; timer/reset conformance cohort green (blocks everything downstream); noop host skeleton |
| M3 | Boundary spike (throwaway) | 4 | Kill gate #1: ≤1.5× upstream on krausest-style partial update after ≤2 protocol revisions, else SSR-first pivot; ABI toolchain decision (wasm-bindgen vs hand-rolled) by measurement |
| M4 | Reconciler via noop oracle | 4–6 | Cohorts a–f over the SCC (D5), judged by 76 files / 1,039 cases through the noop host; DEV-warning parity inside the milestone; **go/no-go: ≥80% green by end of wk 6** |
| M5 | DOM client | 7–8 | react-dom client + hydration suites; krausest within 10% of stock on update ops or M5 does not close; toggle demo ships |
| M6 | Fizz SSR (∥ M5) | 7 | Fizz suites + chunk-ordering; native (napi) + wasm from one crate behind `Host` trait; SSR ≥1.3× target / 0.95× floor |
| M7 | Flight webpack | 8 | react-server-dom-webpack suite (14k test LOC); 10⁶ round-trip fuzz vs JS reference |
| M8 | Harden + bench + RC | 9–10 | Semantics audit (Bun's 19-regression taxonomy); 100M differential fuzz; leak gates (10k cycles + 10k SSR requests, flat handle/heap slopes); bench contract satisfied; RC behind approval |
| — | **Production GA posture** | alongside M5→GA | Packaging fixtures ×5 bundler cells, CSP/MIME fixtures, error/panic envelope + symbol store, version train rehearsed, 5 soak apps green (stock-React-19 baseline first), bring-your-app beta (20 apps / 200 app-days / 99.95% crash-free / zero P0-P1), security + support policy live (report-sol §4, normative) |
| M9 | Rust-native API | +6–8 post-M8 | report-kimi §4.A normative: `#[component]` + typed hooks + `rsx!` + mixed trees + pure-Rust axum SSR; twin matrix (~300 cases) 100% on wasm+native (DOM + HTML bytes + commit-buffer + yield-log + warning-text equality); 10M three-leg fuzz; 3 soak apps re-author one screen; fault-injection proves panic policy; the four `--build` runs stay green; de-scope fallback = SSR-only mode (c) |

**Kill gates:** M3 boundary economics; M4 wk-6 go/no-go; budget gates (§7). A killed campaign publishes a
signed closeout — the honest failure is still the durability demo.

## 5 · Production posture (normative: report-sol §4 SPEC TEXT, adopted in full)

Headlines binding the architecture:

- **Loading:** default browser entry = **embedded synchronous** wasm (base64-or-array, M0-benchmarked),
  decoded size **≤7.5MiB hard gate** (Chrome's 8MiB main-thread sync-compile ceiling);
  `@ferric/react-dom/streaming` is the ESM/TLA/`instantiateStreaming` opt-in (Safari 26 opt-in, Safari 27
  promotable after physical-device 10k-iteration fixture). Node/jest: sync read of adjacent `.wasm`,
  Module cached, fresh Instance per registry (D1). npm surface mirrors upstream `react-dom` entry-for-entry;
  real CJS facades (no promise-returning fakes).
- **CSP:** `script-src 'wasm-unsafe-eval'` required; never recommend `'unsafe-eval'`; no encoding bypass
  exists; strict-CSP floor is Safari 26; refusal ⇒ upstream React or native SSR, documented.
- **Supported at GA:** Vite 8, webpack ≥5.83, Parcel 2 (embedded), Next 15/16 **Pages** (webpack,
  `--webpack` documented), Node 20/22 SSR CJS+ESM, M9 axum native SSR. **Next App Router/Turbopack = lab;
  edge/workerd = unsupported v1** (runtime forbids dynamic wasm compile) — stated, not silent.
- **Versioning:** lockstep encoded stable patch `upstream_patch × 1000 + ferric_revision`
  (`19.2.3001` ⇒ upstream 19.2.3, r1 — dodges npm prerelease peer-range failures); signed compatibility
  manifest per release; train SLAs: minor ≤21 days, patch ≤10 business days, critical security ≤72h with
  **no oracle cell waived**; latest two upstream minors supported, 12-month maintenance, 90-day EOL notice.
- **Error DX:** React error codes byte-identical (generated table, zero `extract-errors` diff); Rust panics
  are a separate namespace with a fixed `FerricPanicRecord` envelope (no user data), build-ID-keyed private
  symbol store, optional `@ferric/sentry`; app-developer runbook with `FERRIC_BACKEND=upstream` repro step
  and <15-minute rollback.
- **Soak/GA exit:** Excalidraw, Cal.com, Mattermost, Grafana, Backstage (stock-React-19-green baselines
  first); owned CI fixtures per integration cell installing the packed tarball; bring-your-app beta and the
  GA exit criteria as specified.

## 6 · The single Smithers workflow

`.smithers/workflows/react-rust-port.tsx` + mandatory UI `.smithers/ui/react-rust-port.tsx`
(gateway-ui/ui components over gateway-react hooks). Single-script contract: all orchestration, prompts,
budgets, gates in the one file; no Subflow/second workflow; frozen + hashed before launch (hash published);
`renderWorkflow`-tested; `ContinueAsNew` lineage published. Authored against https://smithers.sh/llms-full.txt.

- Units = vertical slices (port module/cohort + its tests green), queue-backfill over MODULE_QUEUE rows
  (leaf rows) and cohort rows (SCC) — **never per-module lanes over the core** (D5).
- 4–6 worktree lanes, ~24 agents peak; every lane lands `cargo check`-green + cohort-green through one
  halting MergeQueue; ratchet re-checked per landing.
- Adversarial review: 2 reviewers, diff-only, "assume it's wrong", one from a different model family;
  implementers never review; deterministic verifier (compute, no model) holds a veto no reviewer overrides;
  reject stubs/`todo!()`/paragraph-comment justifications; escaped defects update SEMANTIC_TRAPS.tsv *and*
  the generating prompt.
- Sandwich delegation per standing routing policy (Fable plans/gates; Terra/Sol implement; Opus reviews;
  Luna mechanical; Sidecar shadow-scoring for demotion).
- Durability: Aspects tokenBudget + TryCatchFinally + ContinueAsNew; Supervisor auto-resume;
  DriftDetector on ratchet velocity; pool-switch + `resumeFromRunId` on quota death; publishes are
  `sideEffect: true`, idempotency-keyed, decision split from act, last in the graph.
- **Approval SLA (report-sol §1.8):** three daily windows 09:00/14:00/20:00 ET, evidence packets 30min
  prior, backup paged at 60min, 95% decided <2h; M3 kill, wk-6 go/no-go, RC, publishes, security, budget
  expansion, M9 API freeze never auto-approve; the 20:00 window clears everything that could block overnight.
- **Ops (report-sol §1.7):** two isolated hosts (builder/control + oracle/integration), 64c/256GiB/3.5TiB
  enterprise NVMe each; Docker/provider sandboxes under cgroup v2 (local Smithers runtimes don't enforce
  caps); worktree-local cargo targets; disk alerts 70/80/90%; stress never on the benchmark host; oracle
  release-gate SLO 90min (M0 replaces the 41-minute serial calibration with real build-mode numbers).

## 7 · Budget and kill behavior (round-2 re-price, adopted)

| Envelope | P50 | Hard cap |
|---|---|---|
| M0–M8 (inherited fused scope) | $90k | $130k |
| Production-GA posture | $35k | $58k |
| M9 Rust API (bounded allowlist) | $40k | $62k |
| **Model spend total** | **$165k** | **$250k** |
| Non-model (CI/browser lab/storage + ~0.75 FTE operator/support) | $100k | $170k |
| **All-in program** | **$265k** | **$420k** |

Spend gates at M3, 50%-of-M4, M8 RC, M9 API freeze. $250k model cap, or $200k before M8 green ⇒ stop and
rescope. Cut order: App Router/edge promotion → extra beta seats/marketing → M9 long tail (RSC authoring,
unstable hooks, custom renderers) → native platform breadth. **Never cut:** the oracle, ASSERT_BACKEND,
byte-identical errors/warnings, security response, release train, rollback, owned GA fixtures — if those
don't fit, ship an RC/stunt and don't claim GA. Old-cap contingency: at $130k, M0–M8 ships as RC/stunt only.

Calendar: M0–M8 stunt 8–10 wks; M9 +6–8 wks; GA posture runs alongside from M5 → program ~16–20 wks.

## 8 · Open decisions for will

1. **Budget:** approve the honest re-price ($165k P50 / $250k cap model; $265k/$420k all-in) — or hold the
   $130k cap and accept "RC/stunt, not GA" as the deliverable statement.
2. **Naming:** Ferric is the codename; final npm/cargo names + a trademark-counsel pass before launch week.
3. **Hardware:** procure the two hosts (or approve cloud-equivalent) per §6 ops sizing.
4. **Approval staffing:** confirm the three daily decision windows work for you (primary) and name a backup.

## 9 · Next actions (on go)

1. Author `.smithers/workflows/react-rust-port.tsx` + `.smithers/ui/react-rust-port.tsx` against
   llms-full.txt; graph-render + `renderWorkflow` test; freeze + hash.
2. Launch **M0 only**, detached, live UI open — ends at the boundary-POC approval gate.
3. M0 outputs replace every estimate in this spec marked "measured at M0" (per-reset cost, oracle wall
   time, embedded-representation choice, wasm size baseline).
