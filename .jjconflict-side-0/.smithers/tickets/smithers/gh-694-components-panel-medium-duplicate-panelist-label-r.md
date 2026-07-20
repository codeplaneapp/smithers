# 🐛 components(Panel): [medium] duplicate panelist label/role yields colliding Task ids → DUPLICATE_ID crash

GitHub: https://github.com/smithersai/smithers/issues/694

_via ultracode (Opus multi-agent) review_

**Summary:** `Panel` derives each panelist's Task id from `label ?? role ?? panelist-${i}`, so two panelists sharing a `label` (or `role`) get identical ids with no uniqueness guard — the workflow crashes at graph extraction.

**Location:** `packages/components/src/components/Panel.js:46`
```js
const taskIds = normalized.map((p, i) => `${prefix}-${p.label ?? p.role ?? `panelist-${i}`}`);
```
These ids are reused as the React `key`, the Task `id` (line 50-51), and the keys of `needs` (64-67) and `deps` (72-75). The `panelist-${i}` index fallback only fires when both `label` and `role` are absent, and `normalizePanelist` only injects it for array/bare-agent entries. `PanelistConfig.ts` declares `role?`/`label?` as free-form optional strings with no uniqueness constraint; nothing validates against collisions.

**Failure scenario:** `<Panel panelists={[{agent: a1, label: 'security'}, {agent: a2, label: 'security'}]} .../>` produces two `<Task id="panel-security">` nodes inside the Parallel. Graph extraction rejects this at `packages/graph/src/dom/extract.js:785-787`:
```js
if (seen.has(nodeId)) throw new SmithersError("DUPLICATE_ID", `Duplicate Task id detected: ${nodeId}`, ...);
```
So the run crashes with an opaque `Duplicate Task id detected: panel-security` before the moderator ever runs. (The `needs`/`deps` collapse from two entries to one via object-key overwrite is real but preempted by this throw.)

**Why it matters:** Duplicate panelist roles/labels (two 'reviewer' or two 'security' panelists) are a natural config, and nothing documents that they must be unique. The result is a cryptic workflow-fatal DUPLICATE_ID error rather than working or a clear validation message. A uniqueness guard in `Panel` — append `-${i}` on collision, or throw `Panel panelist labels/roles must be unique` — would make the id derivation safe. There are currently no Panel tests covering this.
