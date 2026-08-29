# Library change requests from the apps/ui flow port

`packages/*` was read-only for this port. Each entry below is a place where the
app took a workaround instead of changing a library. Will approves library
changes personally.

## 1. `FlowBinding` refusals lose the raw handler message

- **File**: `packages/harness/src/FlowBinding.ts`
- **What**: `make`'s runner wraps every handler failure as
  `` `Flow ${descriptor.name} failed: ${describe(produced.failure)}` `` and puts
  that single string in `CallResult.message`. The original failure value is not
  carried anywhere on the result.
- **Why it matters here**: the app dispatches user-facing affordances through
  the same bindings the agent calls. A handler's failure IS the copy the human
  reads ("send needs the text to submit"), so the framing prefix is noise on the
  UI surface while being useful on the cell surface. With only the framed string
  available, the host has to re-derive the raw message by stripping a prefix it
  reconstructs from the flow name — a string contract between two modules that
  the type system does not check, and that silently degrades to the framed text
  if the library ever rewords it.
- **Workaround taken**: `apps/ui/src/mainview/flows/Commands.ts` has an
  `unframe(name, message)` helper that strips the exact
  `` `Flow ${name} failed: ` `` prefix when present and otherwise passes the
  message through. It is correct today and fails safe (worst case the human sees
  the framed text), but it duplicates a library string.
- **Proposed diff sketch**: add an optional raw field to `Cell.CallResult` and
  populate it in `FlowBinding.make`:

  ```diff
   export class CallResult extends Schema.Class<CallResult>("flows/harness/Cell/CallResult")({
     outcome: Schema.Literals(["success", "failure"]),
     value: Schema.Json,
  -  message: Schema.optional(Schema.String)
  +  message: Schema.optional(Schema.String),
  +  /** The handler's own refusal, unframed, for hosts that surface it directly. */
  +  detail: Schema.optional(Schema.String)
   }) {}
  ```

  ```diff
  -const refused = (message: string): CallResult => new CallResult({ outcome: "failure", value: null, message })
  +const refused = (message: string, detail?: string): CallResult =>
  +  new CallResult({ outcome: "failure", value: null, message, ...(detail === undefined ? {} : { detail }) })
  ```

  with the handler-failure branch passing `describe(produced.failure)` as
  `detail`. Nothing existing reads `detail`, so the change is additive.

## 2. The cell loop's capability envelope refuses any host capability vocabulary

- **Files**: `packages/harness/src/CellTurn.ts` (the screen at ~line 353) and
  `packages/capability/src/Capability.ts` (`parse`, `Action`).
- **What**: before dispatching a cell's flow call, `CellTurn` filters the
  descriptor's declared capabilities:

  ```ts
  const refused = descriptor.capabilities.filter((declared) =>
    Option.match(Capability.parse(declared), {
      onNone: () => true, // <- unparseable ⇒ refused
      onSome: (capability) => !CapabilitySet.allows(envelope, capability)
    })
  )
  ```

  `Capability.parse` recognizes only a closed action set — `fs:read`,
  `fs:write`, `net:get`, `net:post`, `model:call`, `proc:spawn`, and the `jj:*`
  operations — and requires a `namespace:operation:resource` shape. Any other
  claim string parses to `None` and takes the `onNone: () => true` branch, so it
  is refused no matter how wide the run's envelope is. There is no envelope
  value, including `{ action: "*", resource: "**" }`, that admits it.
- **Why it matters here**: every flow in this app claims the vocabulary that
  carries DESIGN.md §14's three-tier approval policy — `app:act` (free),
  `session:net-read` (asks once per session), `outbound:launch` (always asks),
  `approve:self` (structurally denied to the agent). These are policy tiers
  about the app's own surface; they have no honest `fs:`/`net:`/`proc:`
  equivalent, and re-labelling `flow.create` as `net:post` would both
  misdescribe it and discard the tier the policy keys on. Under the cell loop
  every app flow is therefore refused, which is what blocks swapping
  ChainRuntime for `CellTurn`/`CellHarness`.
  `apps/ui/src/mainview/chain/AppEngine.test.ts` pins this as a passing test.
- **Workaround taken**: none that preserves the policy. The agent loop stays on
  ChainRuntime, whose `Catalog` carries capability strings opaquely and lets
  `chain/Policy.ts` decide the tier. Declaring the app's flows with empty
  `capabilities` would let the cell loop run, but it would silently drop the
  approval policy, so it was not done.
- **Proposed diff sketch**: let the host supply the vocabulary rather than
  hard-coding it. The smallest version keeps `Capability.parse` as the default
  and makes the unparseable branch a host decision:

  ```diff
   export interface Options {
     ...
  +  /**
  +   * Screens a declared capability the capability package cannot parse.
  +   * Defaults to refusing, which is today's behaviour.
  +   */
  +  readonly admitForeignCapability?: ((claim: string) => boolean) | undefined
   }
  ```

  ```diff
   const refused = descriptor.capabilities.filter((declared) =>
     Option.match(Capability.parse(declared), {
  -    onNone: () => true,
  +    onNone: () => !(input.admitForeignCapability?.(declared) ?? false),
       onSome: (capability) => !CapabilitySet.allows(envelope, capability)
     })
   )
  ```

  A host that says nothing keeps the current strict behaviour; this app would
  admit its four policy claims and keep enforcing their tiers where it already
  does. A larger alternative — extending `Capability.Action` with an
  application-defined namespace — would also work but changes a security-
  relevant closed set, so the host-callback version is proposed first.

## 3. `ChatComposer` and `FileTree` accept no pass-through attributes

- **Files**: `@smthrs/ui` `src/chat/ChatComposer.tsx` (the Send and Stop
  buttons) and `src/file-tree.tsx` (the row buttons).
- **What**: both components render their own `<Button>`s from fixed props.
  `ChatComposerProps` carries `submitLabel` / `stopLabel` but no
  `submitProps` / `stopProps`; `FileTree` takes `nodes` and `onSelect` and
  offers no per-node attribute hook.
- **Why it matters here**: the launch law is that every visible affordance
  names the flow behind it, and `data-flow` is how it says so — the launch
  checklist (§6.1), the slash listing and the agent's own manifest all read
  that attribute. Send, Stop and the world file-tree rows ARE registered flows
  (`send`, `chat.stop`, `world.select`), so they were affordances that ran a
  flow while denying they had one.
- **Workaround taken**: `apps/ui/src/mainview/FlowStamp.ts` stamps `data-flow`
  from the host through a React ref callback at the mount point. It is
  idempotent and never overrides an attribute the element already carries, but
  it reaches into a component's rendered DOM from outside — the exact coupling
  a pass-through prop exists to prevent.
- **Proposed diff sketch**:

  ```diff
   export type ChatComposerProps = Omit<ComponentProps<"form">, "onSubmit"> & {
     submitLabel?: string
     stopLabel?: string
  +  /** Extra attributes for the Send button (e.g. a host's `data-*` binding). */
  +  submitProps?: ComponentProps<"button">
  +  /** Extra attributes for the Stop button. */
  +  stopProps?: ComponentProps<"button">
   }
  ```

  and the same shape on `FileTree` as `nodeProps?: (node: FileTreeNode) =>
  ComponentProps<"button">`.

## 4. `MarkdownEditor` traps forward Tab

- **File**: `@smthrs/ui` `src/adapters/markdown-editor/MarkdownEditor.tsx`.
- **What**: the editor is a ProseMirror body and ProseMirror binds Tab to
  "insert indentation", so forward Tab never leaves the editor. A keyboard user
  reaching the world editor could not get past it (checklist §21.2).
- **Why it matters here**: "no focus trap, no unreachable control" is a launch
  bar, and the editor is on a shipped surface.
- **Workaround taken**: `apps/ui/src/mainview/FocusRing.ts` restores the
  document's own Tab order around the region from the mount site, in a capture
  handler above the editor.
- **Proposed diff sketch**: give the editor an `escapeTabOrder` prop (default
  true) that binds Tab/Shift+Tab to the browser's own behaviour, and offer
  indentation on an explicit chord instead — which is what every editor that
  ships inside a form does.

## 5. `Markdown` has no table rule

- **File**: `@smthrs/ui` `src/primitives/markdown.tsx`.
- **What**: the renderer handles fences, headings, lists and inline spans. A
  GitHub-flavored table reaches the bubble as one paragraph with `<br>` between
  the rows, so every `|` and every `---|---` is on screen as literal text
  (checklist §4.2).
- **Why it matters here**: a table is one of the shapes a model reaches for
  most — "which repos, how many issues" is a table — and the transcript is the
  product's main surface.
- **Workaround taken**: `apps/ui/src/mainview/RichMarkdown.tsx` splits table
  blocks out of the source and renders them with the library's own `Table`
  primitives, handing everything else to `Markdown` unchanged. Fenced code is
  copied through untouched so a pipe inside a fence stays data. It duplicates
  block-level parsing the library already does, which is exactly the drift a
  rule inside the renderer would prevent.
- **Proposed diff sketch**: add a table branch to `renderBlocks` beside the
  fence branch — a header row, a `:?-+:?` delimiter row with a matching column
  count, then rows until a non-pipe line — emitting the same `Table`/`TableRow`
  primitives, with the delimiter's colons as per-column alignment.
