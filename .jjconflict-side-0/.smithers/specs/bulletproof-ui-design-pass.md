# Bulletproof UI design pass: cross-surface synthesis

Synthesized 2026-07-20 from nine per-surface design reviews (ui-chat 6, ui-tokens 6, ui-core 8, ui-adapters 6, monitor-ui 8, gateway-ui 6, generated-html 4, pack-uis 5, ui-agentic 8). Findings below are deduped: one entry per root cause, with every surface that reported a symptom of it listed under that entry. Claims that only a cross-surface reader can check (missing exports, lane skew, de facto scale usage) were verified against the repo at HEAD a2b5af8880.

## Overall verdict

The foundation is genuinely strong and every reviewer independently confirmed it: the `var(--token, lightFallback)` bridge with byte-equal fallbacks, the dual dark-override contract (media query plus `data-theme`), the shared `status.ts` vocabulary, and honest empty/error states are uniformly praised across all nine surfaces. The system fails at its seams, not its core. Every surface that leaves the sui class system (inline-styled gateway-ui components, third-party adapter bodies, generated standalone HTML, hand-rolled pack UIs) loses the focus ring, the theme override contract, the tint recipes, and the status vocabulary, because those contracts are only enforceable through classes and tokens the leaving surface no longer consumes. Two defects are WCAG-level and sit at the token layer itself, so every surface inherits them. Verdict: hold for the blockers below before this system is screenshot in marketing or shipped as the default operator experience; the majors are one focused pass each because almost all of them are one root cause reported three to six times.

## Cross-surface consistency

These are divergences BETWEEN surfaces that no single per-surface reviewer could see whole.

1. **Status-color vocabulary is split four ways.** Running renders as brand purple (StatusPill, `.badge.running`), info blue dots (agentic Plan/ChainOfThought/TaskItem), `#60a5fa` (issue-blitz), and amber (review.tsx); cancelled is red in review.tsx but muted in `packages/gateway-ui/src/theme.ts` statusColors. The shared source of truth exists (`packages/ui/src/status.ts`, re-exported through gateway-ui theme.ts) and is simply not imported by the divergers.
2. **Six-plus hand-rolled color-mix percentages for one concept.** The styleguide ships `*-soft`/`*-border` tokens and tells consumers never to hand-roll percentages, then hand-rolls its own (`.pill` 22%/14%, `--me` 12%). Downstream: sui badge 33%/12%, monitor 6% to 40% across pills/banners/toggles/tracks, gateway-ui 10/12/14/33/45/55%, chat composer 32%/12%, markdown inline-code 7% vs the existing `--inline-code-bg`. Same status chip renders visibly different in every surface.
3. **The focus-ring recipe reaches only styleguide-class components.** gateway-ui (inline styles, structurally cannot express `:focus-visible`), monitor `.mon-*` interactives, Crepe (`outline:none` with no replacement), walkthrough anchor links (opacity-hidden), chat composer (hand-mixed ring), CollapsiblePanel (divergent inset ring), and review.tsx filter buttons all lose or fork the ring. One recipe, seven independent escapes.
4. **Four theming mechanisms.** House `var()` bridge with data-theme override (packages/ui, monitor, gateway-ui theme.ts); `light-dark()` plus `color-scheme` (walkthrough); media-query-only dark (Crepe generated theme); none at all (issue-blitz). The data-theme-wins contract is honored by every base component and ignored by every third-party seam: Crepe, ReactFlow (`colorMode="system"`), Pierre in the walkthrough (`themeType:'system'`), and Terminal/PierreDiffView fixed prop defaults.
5. **Two diff color languages.** Token-tinted `.sui-diff` (success/danger color-mix) vs Shiki github-light/github-dark in PierreDiffView, and the walkthrough bakes Pierre light regardless of its own toggle. Diff stats also drop the house `.plus`/`.minus` green/red convention.
6. **The documented type/geometry scale is contradicted by de facto usage.** The scale says 11/12/13/15/17/20/24, but 12.5px appears 5 times in uiCss, 12 times in walkthroughCss, and across agentic; verified by grep. Meanwhile the `--sp/--fs/--r/--ctl-h` tokens are consumed by almost nobody, including the styleguide source file that defines them (`font-size:11px`, `border-radius:999px`, `padding:14px` inline). Resolution of the reviewer conflict (ui-core called 12.5px off-scale, ui-agentic called it de facto standard): both are right; promote 12.5px to a named token or eliminate it in one sweep, and make the scale describe reality.
7. **Four styling idioms.** sui classes plus CVA/data-slot (packages/ui), inline styles over theme.ts (most of gateway-ui), a private `.mon-*` template string (monitor), and re-declared styleguide class names with different rules (review.tsx `.button`/`.pill`/`.badge`, walkthrough `.badge`/`.chip`/`.stat`). The last idiom creates order-dependent cascades; the inline idiom is the root cause of the gateway-ui focus/hover blocker; mixing idioms on one screen produces gateway-ui's double-bordered nested cards with mismatched interiors.
8. **reduced-motion is honored in the leaves and missing in the trunk.** Chat, monitor, agentic, and walkthrough each guard their own animations, but the shared spinner, skeleton, and transition rules in uiCss (which every surface inherits) have no guard, nor do styleguide `.run-row`, terminal `cursorBlink`, or the Crepe caret. Verified: uiCss has exactly one reduced-motion block and it is chat-scoped.
9. **Elevation recipes disagree.** Cards are shadow-2 + r-2 (styleguide), shadow-1 + r-3 (monitor panels), hand-rolled modal shadow (monitor), 0.06/0.16 alphas vs the styleguide 0.07/0.14 (uiCss), one flat `--shadow-card` (walkthrough). The light ramp is also non-monotonic (surface == surface-3) while dark is a clean tint ramp, and the comment documents only the dark model.
10. **data-slot anatomy is uniform in ui-core, partial in chat and agentic (slot/class naming drift), absent in gateway-ui and PierreDiffView roots.**
11. **Destructive confirmation has two idioms on one surface**: monitor cancel uses an inline arm-with-timeout (the best pattern in the system) while deny/retry fall back to `window.confirm`.
12. **Lane skew resolved:** the gateway-ui reviewer reported the Reasoning/ToolCall/Response integration as absent while the ui-agentic reviewer reviewed those very components. Verified: `packages/ui/src/agentic` and `feat(gateway-ui): render agentic node output` exist only on unlanded lane commits (af9503f822, b04498587a and siblings), not on HEAD. Both reviewers are right about different trees; the fix is landing lanes, not rebuilding.
13. **Minor trunk drift:** the mono font stack differs in three places (styleguide vs tokens.ts `fontMono` with 'SF Mono' vs terminal's JetBrains Mono default), and `role="tree"` is declared without the tree keyboard/ARIA pattern in two independent implementations (FileTree, monitor ExecutionTree).

## Findings by severity

### Blockers

**B1. Light-theme status contrast fails WCAG AA at the token layer; solid-fill derivatives fail harder.**
Light `--success #0f8f78`, `--danger #e5484d`, `--warning #bf7100` measure 3.27 to 4.02:1 on surfaces and soft tints at the 11px bold badge size where they are primarily used; dark `--text-faint #71717a` drops to 3.23 to 4.12 on raised surfaces. Derivatives: ApprovalPanel solid semantic fills with white text (about 3.9 to 4.1:1), review.tsx `.button.primary` white on dark brand (about 2.9:1), monitor pills borderline by inheritance. One fix at the source: darken the light semantic hexes, lighten dark faint, and replace every solid semantic fill with the house soft-tint button recipe.
Files: `packages/ui-styleguide/src/index.ts:35-37,51,184`; `packages/gateway-ui/src/ApprovalPanel.tsx:140-155`; `.smithers/ui/review.tsx:146`.

**B2. Keyboard focus is invisible across every surface that left the class system.**
gateway-ui NodeRow/RunList/ApprovalPanel (inline styles, no `:hover`/`:focus-visible` possible), monitor `.mon-*` tree rows, timeline rows, approval cards, summaries (no focus rules), Crepe `.milkdown :focus-visible{outline:none}` with no replacement, walkthrough anchor links hidden at rest with no focus reveal. WCAG 2.4.7 failure on four surfaces with one root cause: the ring recipe is class-scoped and the escapes are structural.
Files: `packages/gateway-ui/src/NodeRow.tsx:24-52`, `RunList.tsx:88-104`, `ApprovalPanel.tsx:113-128`; `apps/cli/src/monitor-ui/monitor.tsx:3332-3470`; `packages/ui/src/adapters/markdown-editor/crepeTheme.generated.ts`; `apps/review/src/walkthrough/walkthroughCss.ts:117-118`.

**B3. The data-theme override contract is broken in every third-party adapter seam.**
Crepe's generated theme goes dark only under the media query (forcing `?theme=dark` on a light OS renders a light editor); WorkflowGraph pins ReactFlow to `colorMode="system"`; the walkthrough bakes Pierre diffs with `themeType:'system'` so its own toggle strands light diffs in a dark page; Terminal and PierreDiffView default to fixed themes and read nothing. One fix: a shared `resolveTheme()` helper (dataset.theme, else matchMedia) consumed by all four, plus `generate-ui-themes.ts` emitting the data-theme selector blocks and mapping `--crepe-color-*`/fonts onto house tokens.
Files: `packages/ui/src/adapters/markdown-editor/crepeTheme.generated.ts`; `scripts/generate-ui-themes.ts:63-67`; `packages/gateway-ui/src/WorkflowGraph.tsx:248`; `apps/review/src/walkthrough/renderWalkthroughHtml.ts:174`; `packages/ui/src/adapters/terminal.tsx:98-99`; `packages/ui/src/adapters/pierre-diff-view.tsx:99-100`.

**B4. Generated/standalone HTML has no house token source; `standaloneThemeCss()` was specified and never shipped.**
Verified: the export exists only in `.smithers/workflows/bulletproof-ui.tsx:249-251`, nowhere in `packages/ui-styleguide`. Consequently walkthroughCss hand-rolls an off-brand palette (blue-indigo accent vs house violet, GitHub severity hues, no Inter), landingPage carries a third token set, and the report-slideshow prompt ships agents with zero design contract (no tokens, no palette, no dark-mode requirement), guaranteeing off-brand light-only output.
Files: `packages/ui-styleguide/src/index.ts`; `apps/review/src/walkthrough/walkthroughCss.ts:12-35`; `apps/review/src/server/landingPage.ts:11`; `.smithers/prompts/report-slideshow-render.mdx:42-50`.

**B5. issue-blitz.tsx ignores the theme system entirely.**
Dark-only hardcoded hex in 100% inline styles, no WorkflowUiStyles, no `color-scheme`, no light/dark parity, plus downstream symptoms (cancel button with no hover/focus/disabled state, 1.5:1 separators, non-responsive grid, no empty/loading copy). The only pack surface that loads no styleguide at all.
Files: `.smithers/ui/issue-blitz.tsx`.

### Major

**M1. Status-color vocabulary split (cross-surface item 1).** Fix agentic running dots to the brand mapping (or change `status.ts` once), make review.tsx and issue-blitz import `normalizeStatus`/`statusClass`/`statusColors`.
Files: `packages/ui/src/uiCss.ts` (agenticPlanCss/agenticReasoningCss), `packages/ui/src/agentic/{Plan,ChainOfThought,TaskItem}.tsx` (lane tree), `.smithers/ui/review.tsx:122-130`, `.smithers/ui/issue-blitz.tsx:44-51`, `packages/gateway-ui/src/theme.ts:37-83`.

**M2. Hand-rolled tint percentages instead of `*-soft`/`*-border` tokens (cross-surface item 2).** Consolidate onto the tokens; make the styleguide self-apply (`.pill`, `--me`); extend gateway-ui theme.ts with soft tints, ring, and surface-2/3 so inline components stop hand-deriving; align sui badge to the styleguide badge recipe it claims pixel-compatibility with.
Files: `packages/ui-styleguide/src/index.ts:101,104,181`; `packages/ui/src/uiCss.ts:66-74`; `apps/cli/src/monitor-ui/monitor.tsx:3316-3491`; `packages/gateway-ui/src/{StatusPill,NodeRow,NodeOutputCard,WorkflowGraph,theme}.tsx`.

**M3. Scoped components stranded or missing.** The agentic components (Reasoning/ToolCall/Response/Plan/etc.) and the gateway-ui agentic-node-output rendering exist on unlanded lane commits; land them (until then gateway-ui dumps raw JSON). The chat scoped set (MessageScroller, Bubble, Attachment, Marker, shimmer, scroll-fade) exists nowhere: no auto-scroll-to-bottom, no jump-to-latest, no attachment affordance, no streaming marker.
Files: lane commits af9503f822/b04498587a; `packages/gateway-ui/src/NodeOutputView.tsx:45-62`; `packages/ui/src/chat/{ChatTranscript,ChatComposer}.tsx`.

**M4. reduced-motion missing in the shared trunk (cross-surface item 8).** Add the house-wide guard at the uiCss/styleguide layer covering spinner, skeleton, progress/caret/row transitions, `.run-row`, terminal cursorBlink, Crepe caret.
Files: `packages/ui/src/uiCss.ts:251-263,293,348`; `packages/ui-styleguide/src/index.ts:198`; `packages/ui/src/adapters/terminal.tsx:143`.

**M5. Primary interactions that are mouse-only.** Monitor RunsTable rows (onClick on `<tr>`, no tabindex/role/keys, no hover), review.tsx panelist lanes (`<div onClick>`, no role/tabIndex/aria-expanded), chat terminal bubble and the three agentic/codeblock scrollable `<pre>` regions (no tabindex), WorkflowGraph aside.
Files: `apps/cli/src/monitor-ui/monitor.tsx:1043`; `.smithers/ui/review.tsx:362-367`; `packages/ui/src/chat/ChatMessage.tsx`; `packages/ui/src/uiCss.ts:495-587`.

**M6. Two diff color languages (cross-surface item 5).** Map Shiki output or theme selection onto house tokens, honor the toggle in walkthrough, color diff stats with `.plus`/`.minus`.
Files: `packages/ui/src/adapters/pierre-diff-view.tsx:36-58`; `packages/ui/src/uiCss.ts:325-338`; `apps/review/src/walkthrough/renderWalkthroughHtml.ts`.

**M7. Class-name collisions and dead theme code in composed surfaces.** review.tsx re-declares styleguide class names with different rules over WorkflowUiStyles (order-dependent hybrid) and carries a dead dark `:root` that breaks light mode if render order flips; walkthroughCss redefines `.badge`/`.chip`/`.stat`/`.plus`/`.minus`/`.empty-state`. Fix: unique class names or the `extra` prop; never re-declare styleguide selectors.
Files: `.smithers/ui/review.tsx:133-146`; `apps/review/src/walkthrough/walkthroughCss.ts`.

**M8. Live/status information never reaches assistive tech.** Chat pending label is `aria-label` on a bare div (never announced); Alert is always `role="alert"` (assertive) even for success/neutral; RunEventLog streams with no `role="log"`/aria-live; agentic streaming progress (Plan summary, step flips, Reasoning done) mutates silently; markdown headings render as divs, erasing document outline.
Files: `packages/ui/src/chat/ChatMessage.tsx:46-47`; `packages/ui/src/alert.tsx:30`; `packages/gateway-ui/src/RunEventLog.tsx:53-91`; `packages/ui/src/agentic/{Plan,ChainOfThought,Reasoning}.tsx` (lane tree); `packages/ui/src/primitives/markdown.tsx:126-136`.

**M9. `role="tree"` without the tree pattern, twice.** FileTree and monitor ExecutionTree both declare tree/treeitem with no roving tabindex, arrow keys, aria-level, or expansion state on the focusable element. Either implement the pattern once (shared hook) or drop the roles.
Files: `packages/ui/src/file-tree.tsx:90-173`; `apps/cli/src/monitor-ui/monitor.tsx:1256-1394`.

**M10. Off-house fonts and palette in the Crepe editor body.** Noto Serif/Noto Sans/Space Mono and a bespoke zinc/red palette render the editor as a foreign product; bridge `--crepe-*` vars to `--bg/--text/--brand/--font-sans/--font-mono`. (Theme mechanics are B3; this is the palette mapping.)
Files: `packages/ui/src/adapters/markdown-editor/crepeTheme.generated.ts`; `MarkdownEditor.tsx:75-84`.

### Minor

**N1. Geometry off the token scale, including in the token source (cross-surface item 6).** Decide 12.5px (promote or eliminate), consume `--fs/--sp/--r/--ctl-h` in uiCss and the styleguide's own rules, fix off-scale radii (7/8/18/20px), wire `tokens.controlHeight` into buttons/inputs/selects, replace gateway-ui numeric literals and `theme.radius` bare number.

**N2. Reimplemented house compositions.** Monitor `.mon-pill`/`.mon-empty`/`.mon-kicker`/`.mon-stat` vs shipped status-pill/empty-state/section-header/kpi-stat; chat `sui-chat-empty` vs EmptyState; monitor's third inline-code treatment vs `--inline-code-bg`; StatusPill's dual identity (uppercase mono with styleguide CSS present, title-case sans standalone).

**N3. Selection states are visual-only and idioms diverge.** RowButton no `aria-pressed`, FileTree leaf no `aria-current`, NodeRow no ARIA while dashboard rows have it; three active-row visual idioms inside gateway-ui.

**N4. Dead or broken token references.** Monitor `var(--dim)` undefined (XML punctuation renders full-emphasis); `.sui-badge-info` CSS with no `info` variant in badgeVariants and no Alert info variant; `--shadow-rgb` declared but unused by the styleguide's own shadows; `--major`/`--minor` both alias `--warning`, making review.tsx's four-severity legend two-amber.

**N5. Elevation/radius drift (cross-surface item 9)** plus the non-monotonic light surface ramp contradicting its own comment.

**N6. data-slot anatomy gaps (cross-surface item 10)** and agentic slot/class naming drift (`sui-cot` vs `chain-of-thought`).

**N7. Empty/error state gaps.** Agentic "Used 0 sources"/"0/0 done" nonsense labels; review.tsx `launch()` swallows failures with no error surface; PierreDiffView frame disappears in the empty state; issue-blitz all-pending grid with no guidance.

**N8. Landmark and naming hygiene.** Card/CollapsiblePanel as unnamed `<section>` landmarks; chat `role="log"` unnamed; CollapsiblePanel missing aria-controls; generic "Toggle" chevron labels in the monitor tree.

**N9. Placeholder-tone tokens colored onto real content.** Select trigger values, diff line numbers, code-block line numbers at 2.6 to 3.4:1; placeholder token itself borderline in both themes.

**N10. Destructive confirmation split (cross-surface item 11).** Standardize on the arm-with-timeout pattern; retire `window.confirm`.

**N11. Monitor dual mobile breakpoints (720px and 760px) restyling the same selectors; styleguide contract is a single 760px.**

**N12. Token-layer test gap.** ui-styleguide tests assert only string containment; a table-driven light/dark parity + AA contrast test would have caught B1 automatically and should gate future ramp edits.

**N13. Mono font stack drift in three places (styleguide, tokens.ts, terminal default).**

### Polish

Composer status well renders unconditionally; 156px transcript padding hardcodes composer height with un-anchored z-index 40; TabsContent focus-visible removes outline with no substitute; Progress translateX unclamped; shadow alpha mismatches; `.sui-sr-only` defined twice; formatDuration duplicated in two agentic components; TooltipProvider mounted per InlineCitation; Sources trigger missing the chevron every sibling disclosure has; 10.5px one-off section title; quiz selected state border-only; monitor approval cards and tree chevrons missing hover feedback; small controls at 24px under the 26px floor; walkthrough `.toc-dir` borderline AA.

## Propagate this praise

Patterns one surface got right that should become house defaults:

1. **The tokens bridge itself**: `var(--token, lightFallback)` with byte-equal fallbacks enforced by `css-contract.test.ts`, and gateway-ui `theme.ts` as its exemplary consumer. Already the spine; keep it the non-negotiable contract for every new surface.
2. **Dual dark-override contract** (media query + `:root[data-theme]` both ways) from ui-styleguide; extend it into every adapter (B3 is its absence).
3. **`status.ts` as single status vocabulary** with `statusColors` keyed off `normalizeStatus`; M1 is a propagation task, not a design task.
4. **Monitor's arm-with-timeout destructive confirm** (RunLifecycleControls); adopt as the house destructive pattern everywhere, replacing `window.confirm`.
5. **Chat composer keyboard contract**: Enter submits, Shift+Enter newlines, IME guard via `isComposing`, `form.requestSubmit`; the template for every future input surface.
6. **Honest-state design**: review.tsx verdict state machine ("moderator produced none" instead of implying a clean review), monitor's last-good-data notes and state-specific banners, PierreDiffView's degrade-to-empty on malformed patches, walkthrough's large-diff cost disclosure.
7. **Terminal mount discipline**: AbortController short-circuit, hoisted disposables, safeFit, errors surfaced in ANSI red where the user is looking.
8. **Safety by construction**: markdown React-children-only rendering plus href scheme filtering, and agentic `safeHref` with button degradation.
9. **Walkthrough theme boot script inlined before the stylesheet** (no theme flash) and its blanket reduced-motion + print stylesheet thoroughness.
10. **Agentic collapsibles as real buttons** with `aria-expanded`/`aria-controls` (strictly better than CollapsiblePanel's div header; backport it).
11. **Idempotent SSR-safe style injection** (marker dedupe, `useInsertionEffect`) uniform across adapters.
12. **Chat's `overscroll-behavior:contain` and `env(safe-area-inset-bottom)`** for every scrollable panel and docked bar.
13. **The legacy alias layer** (`--panel`/`--ok`/`--err`...) as the cheap compatibility pattern for future vocabulary migrations.

## Prioritized fixes

Ordered by severity then blast radius; each is one root cause.

1. Fix the token-layer contrast ramp (B1): darken light success/danger/warning, lighten dark `--text-faint`, replace solid semantic fills in ApprovalPanel and review.tsx with the soft-tint recipe; add the AA + parity test (N12) so it cannot regress.
2. Restore visible keyboard focus everywhere (B2): extend the ring to `.mon-*`, convert gateway-ui interactives to class-based primitives, re-add Crepe focus outlines, reveal walkthrough anchor links on focus, align chat/collapsible rings to the shared recipe.
3. Enforce data-theme-wins in adapters (B3): shared `resolveTheme()` helper; regenerate the Crepe theme with data-theme selectors and house token mapping (with M10's palette bridge); fix WorkflowGraph colorMode and walkthrough Pierre themeType.
4. Ship `standaloneThemeCss()` from ui-styleguide and migrate walkthroughCss, landingPage, and the report-slideshow prompt onto it (B4); the prompt must inline the token block and require `color-scheme: light dark`.
5. Rebuild issue-blitz.tsx on WorkflowUiStyles/gateway-ui primitives (B5) and fix review.tsx's colliding class names and dead `:root` (M7).
6. Unify the status vocabulary (M1): agentic running dots to brand, pack UIs import the shared helpers; one color for running everywhere.
7. Replace hand-rolled tint percentages with `*-soft`/`*-border` tokens across styleguide, ui-core badges, monitor, gateway-ui, and chat; extend theme.ts with the missing tokens (M2).
8. Land the stranded agentic lanes (packages/ui agentic components plus gateway-ui agentic node-output rendering), then build the chat MessageScroller/Bubble/Attachment set (M3).
9. Move the reduced-motion guard to the shared layer (M4).
10. Keyboard and announcement batch (M5, M8, M9): RunsTable rows, review.tsx lanes, scrollable regions, tree pattern or role removal, chat typing `role="status"`, Alert default to `role="status"`, RunEventLog `role="log"`, markdown real headings.
