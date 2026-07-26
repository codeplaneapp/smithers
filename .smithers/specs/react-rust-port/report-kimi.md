
# M9 Rust API — De-risking Report (Kimi lane, round 2)

Scope: the Rust-native authoring API for Ferric — prior-art teardown, API v0, mixed JS/Rust trees, distribution, pure-Rust SSR, conformance, and M9 scoping. Everything below is additive to the fused M0–M8 plan (`reading/index.html`); nothing here re-opens the M0–M8 architecture except where a cheap early decision is shown to halve M9's cost (§7).

---

## (1) FINDINGS

### 1. Prior-art teardown: Dioxus 0.7, Leptos 0.7, Yew 0.23/next, Sycamore 0.9

#### 1.1 What each framework actually does (verified against current docs)

**Dioxus 0.7** (dioxuslabs.com/learn/0.7/):
- Components are plain fns `fn App() -> Element` with `#[component]` collecting args into a props struct; `Element` is a `Result` alias, and **error boundaries and Suspense both use the `?` operator** ("Dioxus supports early returns because error boundaries and suspense boundaries use the question-mark syntax" — dioxuslabs.com/learn/0.7/essentials/basics/hooks, "Early Returns" section).
- Hooks are implemented **exactly like React's**: `use_hook` walks a per-component hook list by call index, incremented per call, reset per render (same page, "The use_hook primitive"). Same rules-of-hooks as React (no conditionals/closures/loops), enforced at runtime by panic.
- Reactivity is signals (`use_signal`, `Copy`, generational-box-backed) layered *on* the hook list; components re-run when subscribed signals change (run-per-update, closer to React+Solid hybrid than Leptos's run-once).
- `rsx!` macro: `node { attr: value, "text {interp}", for x in iter { ... }, if cond { ... } }` — Rust-native control flow inside markup, `key:` attribute for lists.
- Events: `onclick: move |e| ...` closures; `e` is a typed wrapper over a serialized event record.
- SSR/fullstack: server renders HTML, **hydration re-runs every component on the client**; non-deterministic data must go through `use_server_future`/`use_loader`/`use_server_cached`, which serialize results into the HTML (dioxuslabs.com/learn/0.7/essentials/fullstack/ssr). Server functions `#[server]`; axum integration; `dx` CLI drives the wasm-bindgen build; app + engine statically linked into one wasm.
- Notable infra they built because wasm needed it: `wasm-splitter` (bundle splitting), `subsecond` hot reload (dioxuslabs.com/learn/0.7/, "Stellar Developer Experience").

**Leptos 0.7** (book.leptos.dev):
- Components run **once** as setup functions: "The body of the component function is a set-up function that runs once, not a render function that reruns multiple times" (book.leptos.dev/view/01_basic_component.html). Reactivity is fine-grained signals; `signal()` returns a `(ReadSignal, WriteSignal)` tuple, `Copy + 'static`, so closures capture freely (`on:click=move |_| *set_count.write() += 1`).
- `view!` macro: JSX-like, `on:click=` event attributes, `{...}` blocks are reactive iff they contain signals/closures.
- SSR: dedicated modes chapter ("Async Rendering and SSR 'Modes'", book.leptos.dev/ssr/23_ssr_modes.html), cargo-leptos toolchain, axum/actix extractors, server functions, islands.
- Error handling via `<ErrorBoundary/>` + `Result` return types in the view.

**Yew 0.23/next** (yew.rs/docs):
- **The only prior art that is architecturally React**: function components **re-run on every render**, hooks are call-order-indexed with React's rules ("Hooks must be called in the same order for every render", yew.rs/docs/next/concepts/function-components/hooks). Pre-defined hooks: `use_state`, `use_state_eq`, `use_memo`, `use_callback`, `use_ref`, `use_mut_ref`, `use_node_ref`, `use_reducer`, `use_reducer_eq`, `use_effect`, `use_effect_with`, `use_context`, `use_force_update` (same page) — near-parity with React's list, but effect deps are passed as a second argument (`use_effect_with(deps, ...)`) and deps must implement `PartialEq`.
- Props: `#[derive(Properties, PartialEq)]` structs; `Callback<IN, OUT>` is an `Rc`-backed, cheap-clone, identity-comparable handler type for props.
- `html!` macro (JSX-like), struct components for class-like control, `<Suspense/>` documented.
- SSR: `ServerRenderer::<App>::new().render().await -> String`; **"During Hydration, components schedule 2 consecutive renders after it is created"** and effects run after the second (yew.rs/docs/next/advanced-topics/server-side-rendering) — an independent rediscovery of StrictMode-style double render for hydration determinism. SSR data-fetch solved via Suspense (`use_linked_state` returns `SuspensionResult`, used with `?`), plus `use_prepared_state!`/`use_transitive_state!` serializing server state into HTML (bincode+base64 in `<script>` tags). `LocalServerRenderer` for `wasm32-wasip1/wasip2` single-thread SSR — proof a React-like engine runs SSR on WASI.
- Build: Trunk/wasm-bindgen; static linking of app+engine.

**Sycamore 0.9.2** (sycamore.dev): fine-grained signals (`create_signal`), `view!` macro or builder, components run once, SSR streaming (v0.9 announcement). Confirms the Leptos design point; no new mechanism.

#### 1.2 Per-feature verdict — copy / adapt / reject

| Feature | Prior art | Verdict for Ferric M9 | Why |
|---|---|---|---|
| Hook list = call-order index walk | Dioxus `use_hook`, Yew | **Copy** | Identical to ReactFiberHooks' linked-list/idx model; the engine we're porting already implements it (fused plan index.html §4 "Hooks: queues, ordering, lanes, bailouts in Rust"). |
| Component re-runs per render (not run-once) | Yew only | **Copy; reject Leptos/Sycamore/Dioxus-signals as the component model** | React semantics require re-running render with new props, render purity, and StrictMode double-invoke. A run-once setup fn cannot express "same hooks, new props" or double-invoke; fine-grained subscriptions bypass lanes/scheduler entirely — incompatible with the ported work loop and with the conformance oracle (scheduler yield traces, plan-kimi.md:46-47 re `assertLog`). |
| Signals as primary state API | Leptos, Sycamore, Dioxus | **Reject** (as user-facing state); keep `use_state` snapshot semantics | Signals are push-based; React is pull-based re-render with lane scheduling and transitions. `useTransition`/`useOptimistic` have no signal equivalent; offering signals alongside would fork the semantics and double the conformance surface. |
| `Element = Result<VNode, Thrown>` + `?` for suspend/error | Dioxus 0.7, Yew `SuspensionResult`/`HtmlResult` | **Copy** | The single best ergonomic discovery in prior art: maps exactly onto React's two thrown channels (thenable for Suspense, error for boundaries). See D2. |
| rsx! macro shape (`node { attr: v, for ..., if ... }`) | Dioxus rsx! | **Adapt** (Dioxus syntax, React semantics) | Cleaner token grammar than `html!`/`view!`; `for`/`if`/`match` in-markup is idiomatic Rust and avoids JSX-in-proc-macro token soup. Keys via `key:` (Dioxus does this). |
| `Callback<IN>`-style Rc handler prop type | Yew `Callback` | **Copy** (as `Handler<E>`) | Cheap-clone, `PartialEq` by identity — matches React's stable-callback conventions and memo comparisons. |
| Props derive with mandatory `PartialEq + Clone` | Dioxus/Yew `Properties` | **Adapt** | React does *not* require props equality for re-render — only `memo()` compares. Requiring `PartialEq` on all props is un-React-like and blocks non-`PartialEq` props (e.g. values holding `JsRef`). `Props: 'static`; `memo()` opts into a compare fn (default shallow fieldwise). |
| Hydration re-runs components; server data serialized into HTML | Dioxus `use_server_future`, Yew `use_prepared_state!` | **Adapt** | React's hydration re-renders too; our equivalent of "prepared state" is the `use()`/cache contract (react.dev/reference/react/use: "The Promise must be cached so that the same instance is reused across re-renders"). We ship `use_loader` that serializes into Fizz's existing serialization channel instead of bespoke `<script>` tags. |
| SSR via `render().await -> String` on native + WASI | Yew `ServerRenderer`/`LocalServerRenderer` | **Copy the shape** | Proves the native-tokio and single-thread-WASI modes; our Fizz port (M6) already emits strings/streams in Rust (index.html §4 "Fizz/Flight: Rust state machines"). |
| Build/distribution: app+engine statically linked, one wasm, CLI-driven | Dioxus `dx`, Yew Trunk, Leptos cargo-leptos | **Copy the model, not the CLI** | All three statically link; none can dynamically link Rust crates at runtime (wasm has no such capability in browsers — see §4.1). We ship `cargo` + a Vite plugin rather than a new CLI (adoption: Rust devs already have cargo; JS devs already have Vite). |

#### 1.3 Where React's semantics force a *different* design than the signals frameworks

1. **Render purity + re-runnability.** React discards renders that suspended before mounting and retries from scratch (react.dev/reference/react/use: "React doesn't preserve state for renders that suspended before mounting… React retries rendering from scratch"). Signals frameworks commit on first run. → Ferric Rust components must be `Fn` (callable repeatedly, no interior "already ran" state outside hooks), and `use`-style suspension must be restartable. This is also why `use(promise)` must read a *cached* cell, not a fresh future.
2. **Lanes and interleaving.** Transitions require the scheduler to interrupt, abandon, and restart renders at fiber granularity (the ported work loop; the scheduler-mock gate makes trace parity the oracle — index.html §5 "scheduler-mock hidden gate"). Push-based signal propagation (Leptos/Sycamore) has no interleaving and no notion of "this update at default lane, that one at transition lane". → No signal API in M9.
3. **StrictMode double-invoke.** React DEV double-invokes render, effects setup/cleanup, and updaters. Signals frameworks have no equivalent. Yew's hydration double-render (verified above) shows the pattern is survivable in Rust; hooks must not perform un-cleanup-able side effects during render. → documented contract + fault-injection conformance test (§6).
4. **Suspense = unwind, not polling.** React suspension unwinds the render via a thrown thenable ("Suspense Exception… use throws internally to integrate with Suspense", react.dev/reference/react/use troubleshooting). Leptos `<Suspense/>` reads resources reactively without unwinding. In Rust/wasm, a real stack unwind is expensive/unavailable by default (§2.3), so our suspension is an **engine-mediated return channel** (`?` → `Err(Thrown::Suspend)`) — same control-flow shape as React, expressed as `Result` instead of exceptions. This is the one place Dioxus already made exactly our choice.
5. **Effects ordering (passive vs layout) and cleanup order** are scheduler-timed in React, not subscription-timed. `use_effect` must therefore enqueue into the engine's effect queues (Rust-owned, index.html §4), not run as a signal effect.

### 2. API design v0 — with the wasm/panic evidence settled

#### 2.1 `use()` on Rust futures — how a Rust Future becomes a thenable-equivalent

Two cases, two mechanisms:

**(a) In-tree suspension (the common case): never becomes a thenable at all.** Suspense state lives in the Rust engine (index.html §4: "Suspense boundary state | Rust"). A Rust component calls `use_shared(&shared)`; on `Poll::Pending` the hook registers the render's waker in the engine and returns `Err(Thrown::Suspend(token))` via `?`; the boundary catches it exactly like a thrown promise in JS React. Zero JS involvement, zero crossings, zero promises. The future itself is driven by the engine's task queue (browser: microtask queue via the existing JS scheduler shim; native: tokio).

**(b) A Rust future handed to JS code** (e.g. passed as a prop promise to a JS component that calls React's `use`): convert with `wasm_bindgen_futures::future_to_promise` — verified to exist in wasm-bindgen-futures 0.4.76 (docs.rs/wasm-bindgen-futures/latest: "Converts a Rust Future into a JavaScript Promise", plus `JsFuture`, `spawn_local`; `js_sys::Promise` implements `IntoFuture`). The result is a *real* JS Promise, which satisfies React's thenable contract including the `status`/`value`/`reason` fast-path fields — which React sets itself when absent (react.dev/reference/react/use, "How to implement a promise cache": "React will set the `status` field itself on Promises that don't have it"). For already-resolved values we pre-set `status:'fulfilled'`/`value` in the glue so `use()` reads synchronously without an extra render.

Also noted: JS Promise Integration (JSPI) reached **Phase 5** (WebAssembly/proposals README, checked 2026-07-24). JSPI would let a wasm render genuinely suspend its stack on a promise. **Not adopted for v0**: our return-channel suspension needs no stack capture, works in every engine today, and keeps one code path between wasm and native. Flagged as a post-M9 experiment for `async fn` components in the browser.

#### 2.2 Real signatures (v0)

```rust
// ---- elements & components ----
pub type Element = Result<VNode, Thrown>;           // Dioxus's choice, React's semantics

pub enum Thrown {
    Suspend(SuspendToken),                          // thenable-equivalent, engine-internal
    Error(Box<dyn Error + Send>),                   // -> nearest error boundary
}

#[component]                                        // proc macro: builds Props struct, registers
fn TodoRow(todo: Todo, on_toggle: Handler<Id>) -> Element { ... }   // name+slab id in the registry

// ---- core hooks (thin typed facade over the ported ReactFiberHooks machine) ----
pub fn use_state<T: 'static>(init: impl FnOnce() -> T) -> StateHandle<T>;
// StateHandle<T>: Deref<Target=T> (Rc-backed snapshot — Yew's UseStateHandle shape, React's
// immutable-snapshot semantics, no T: Clone bound, no per-read clone)
impl<T> StateHandle<T> {
    pub fn set(&self, next: T);                     // enqueues at current lane, like setState
    pub fn update(&self, f: impl FnOnce(&T) -> T);  // functional update form
    pub fn set_transition(&self, next: T);          // sugar: start_transition + set
}

pub fn use_reducer<S: 'static, A: 'static>(
    reducer: impl Fn(&S, A) -> S + 'static, init: S,
) -> (StateHandle<S>, Dispatch<A>);                 // Dispatch<A>: Copy-like, stable identity

pub fn use_memo<T: 'static>(f: impl FnOnce() -> T, deps: Deps) -> MemoHandle<T>; // Deref
pub fn use_callback<F: Fn + 'static>(f: F, deps: Deps) -> Handler<F::Event>;     // stable id across renders

pub fn use_ref<T: 'static>(init: T) -> RefHandle<T>;      // mutable, no re-render (React useRef)
pub fn use_node_ref() -> NodeRef;                          // attach via rsx `ref:`; -> JsRef(dom node) at seams

pub fn use_effect(deps: Deps, f: impl FnOnce() -> Option<Cleanup> + 'static);
pub fn use_layout_effect(deps: Deps, f: impl FnOnce() -> Option<Cleanup> + 'static);
pub fn use_insertion_effect(f: impl FnOnce() + 'static);
// Deps: deps!(a, b, c) macro over PartialEq+'static tuple (element-wise compare = Object.is analogy);
// Deps::every() = no-arg useEffect; Deps::once() = []

pub fn use_context<T: 'static>(ctx: &Context<T>) -> ContextHandle<T>;  // Deref; typed provider:
// rsx! { ContextProvider::<Theme> { value: theme.clone(), {children} } }

pub fn use_transition() -> (bool /*is_pending*/, StartTransition);
pub fn use_optimistic<S: 'static + Clone, A>(
    state: &StateHandle<S>, update: fn(&S, A) -> S,
) -> (OptimisticHandle<S>, AddOptimistic<A>);
pub fn use_deferred_value<T: Clone + 'static>(v: T) -> T;
pub fn use_id() -> String;                          // engine's hydration-safe id algorithm
pub fn use_sync_external_store<S: Clone>(
    subscribe: impl Fn(Notify) -> Unsub + 'static, get: impl Fn() -> S + 'static,
) -> S;

// ---- use(): futures & suspense ----
pub struct Shared<T> { /* engine cell: Once + waker list; Clone is cheap & identity-stable */ }
pub fn shared<F: Future<Output = T> + 'static, T: 'static>(f: impl FnOnce() -> F) -> Shared<T>;
pub fn use_shared<T: Clone + 'static>(s: &Shared<T>) -> Result<T, Thrown>;  // use with `?`
pub fn use_loader<T, E, Fut>(f: impl Fn() -> Fut + 'static) -> Result<LoaderHandle<T>, Thrown>
where Fut: Future<Output = Result<T, E>> + 'static, E: Error + Send + 'static;
// use_loader = Dioxus's use_loader semantics on React's use() mechanics: cached per hook slot,
// serializes through Fizz for hydration, errors re-thrown to nearest error boundary.
```

#### 2.3 Panic policy — verified facts, then the pick

Verified facts:
- `wasm32-unknown-unknown` ships `panic=abort` by default; the rustup-precompiled std is panic=abort (rustc book, doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html, "Unwinding" section).
- `panic=unwind` on wasm32-unknown-unknown became possible "since mid-2025" but **requires nightly + `-Zbuild-std` + `-Cpanic=unwind` + `-Cllvm-args=-wasm-use-legacy-eh=false`**; "there are no concrete plans" to enable it by default (same page).
- Rust panics on wasm lower to a C++ `__cpp_exception` wasm tag (same page) — i.e., the machinery exists but is young and off the stable path.
- The wasm **exception-handling proposal is finished** (WG 2025-07-23, spec 3.0 — WebAssembly/proposals/finished-proposals.md), so 2026 engines implement it; the blocker is the Rust toolchain default, not engines.
- On **native** (pure-Rust SSR), `panic=unwind` + `std::panic::catch_unwind` is ordinary stable Rust.

**Picked policy (D3): fallible components via `Result` are the error channel; panics are fatal-to-root by default.**
- `Element = Result<VNode, Thrown>` — error boundaries consume `Thrown::Error`, never panics.
- The engine already wraps every component render in a boundary crossing that converts exceptions→`Result` (plan-kimi.md:96: "exceptions propagate as `Result` at the boundary and re-enter Rust's error-boundary machinery"); the same trampoline point gains a `catch_unwind` **on native builds only**, converting a component panic into `Thrown::Error` (root-level 500 + boundary fallback).
- On wasm/browser default builds: a panic aborts the engine instance (documented, loud, matches every wasm-bindgen app today). Opt-in cargo feature `panic-unwind` (nightly, `-Zbuild-std`) turns on per-render `catch_unwind` for parity with native. We do not make M9 depend on nightly toolchain UX.

#### 2.4 rsx! macro sketch (Dioxus grammar, React semantics)

```rust
// 1. Basic + interpolation + typed handler
rsx! {
    div { class: "todo",
        h1 { "Todos ({remaining})" }
        button {
            onclick: move |e: ClickEvent| { count.set(*count + 1); },
            "Add"
        }
    }
}

// 2. List rendering with keys (`for` + mandatory key in DEV warning parity)
rsx! {
    ul {
        for todo in todos.iter() {
            li { key: "{todo.id}",
                class: if todo.done { "done" } else { "" },
                onclick: move |_| on_toggle.emit(todo.id),
                "{todo.title}"
            }
        }
    }
}

// 3. Conditional rendering — if/else and match are real Rust control flow
rsx! {
    section {
        if let Some(err) = &error {
            p { class: "error", role: "alert", "{err}" }
        } else {
            {content}
        }
        match route {
            Route::Home  => rsx!{ Home {} },
            Route::User(id) => rsx!{ UserPage { id: *id } },
        }
    }
}

// 4. Mixed tree: a JS component child passed across the seam (JsComponent) + suspense + children
rsx! {
    Suspense { fallback: rsx!{ Spinner {} },
        JsChild { component: js_chart.clone(),      // JsComponent = JsRef to a JS fn/class
                  props: js_props!{ data: &series,  // serialized once at the seam
                                    onPoint: Handler::to_js(on_point) } },
        {children}                                   // typed children passthrough
    }
}
```

Event-handler mechanics (the handler slab): `onclick:` stores the `FnMut(Event)+'static` closure into a per-fiber **handler slab** (`Vec<HandlerSlot>`), emitting a u32 handler id into the element descriptor. The JS event system (stays JS per fused plan, index.html §4 "Events stay JS in v1") resolves listeners through its fiber-ancestry query; for Rust-fiber listeners it gets handler ids and calls one bridge export `__ferric_dispatch_event(handler_id, event_record_ptr)`. The JS side writes a **flat event record** (type atom, target handle, bubbles/composed flags, common scalars: clientX/Y, key code, button) into the scratch buffer — one batched write per dispatch, deep access (`e.target()`) lazily through the JsRef. `FnMut` is safe: dispatch is single-threaded and reentrant dispatches are serialized by the existing bridge-frame stack (index.html §4 "Reentrancy… explicit bridge-frame stack with `finally` restoration"). Slab entries are dropped on unmount/attr-change, so handler closures' captured state has fiber lifetime — the React mental model.

### 3. Mixed trees — the seam contract (verified against the fused bridge design)

The fused bridge already contains everything the seam needs; M9 defines the contract:

1. **Component type identity.** Fiber `type` internally becomes a tagged u32: `Host(Atom) | Js(JsRef) | Rust(SlabId)` (D9 — must land in M4's fiber layout, see §7). A JS parent renders a Rust child via a marker object created by `ferric.register_component` glue: `const TodoRow = __ferric_rust_component(17)` — a frozen object with `$$typeof`-style tag so `react-is`/`createElement` accept it; the engine recognizes the tag and dispatches render *directly into the wasm slab — no JS trampoline for Rust components*. A Rust parent renders a JS child by holding `JsComponent(JsRef)`; the child-set intake (`scanChildSet`, index.html §4) already carries `type` as atom/handle, so both directions are the **same descriptor format** — the seam is not a new protocol, it is the bridge's existing element-intake protocol with a third type tag.

2. **Props conversion: opaque passthrough by default, typed opt-in.** (D5)
   - JS→Rust: props cross as a `JsRef` to the real JS props object (identity preserved — required for `props.children` identity and memo bailouts, which compare `Object.is(prevProps, nextProps)`). Rust accesses fields through `JsProps` (typed getters, cached per render). If `Props: DeserializeOwned`, an opt-in derive converts once per render into a typed Rust struct (costed, ergonomic).
   - Rust→JS: rsx! builds the JS props object directly in a props-builder buffer (scalars inline, strings via atom table, Rust closures as `Handler` ids materialized by the glue into stable-identity JS functions, nested values via `Serialize` only when typed).
   - **Rejected: serde-everything.** It would force `Serialize` on all props, cost one serialization per component per render, and break props identity semantics. **Rejected: pure passthrough-only.** It makes Rust-authored props ergonomically miserable and forces a JS heap allocation for every Rust-only subtree. The two-mode seam gives pure-Rust subtrees zero JS props objects and mixed seams exactly one.

3. **Element materialization is lazy.** (D6) "Elements stay JS" (index.html §4) is preserved *observationally*: a Rust-emitted element descriptor is materialized into a real JS element object (with `$$typeof`, enumerable props) only when it crosses into JS userland (passed as `children` to a JS component, returned across the boundary, introspected by a test). Minted JsRefs are cached per descriptor so identity is stable. Pure-Rust subtrees never allocate JS elements at all — this is the mixed-tree performance story and one of the two benchmark headlines of M9.

4. **Keys/identity across the seam.** Diffing is engine-internal in Rust (index.html §4), so key semantics are literally identical code on both sides; `key:` values are string atoms (React coerces keys to strings). No seam-specific key rules.

5. **DevTools.** The JS DevTools shim/renderer interface ships in M0–M8 (plan-kimi.md:36: "we ship the `__REACT_DEVTOOLS_GLOBAL_HOOK__` renderer interface"). `#[component]` registers the Rust fn name into the same fiber-name table that `warnings.rs` uses for component stacks (index.html §4), so Rust components appear in DevTools and in warning stacks with their real names — indistinguishable except by convention.

6. **Error boundaries across the seam, both directions.** Error capture is engine-unified (error boundaries live in the ported reconciler, including JS class `componentDidCatch`). A `Thrown::Error` from a Rust component propagating to a JS class boundary is minted into a JS `Error` (message + component stack from the name table) at the boundary crossing; a JS exception from a JS child under a Rust `<ErrorBoundary>` already arrives as `Result` at the render trampoline (plan-kimi.md:96) and becomes `Thrown::Error`. Symmetric, one code path, differential-tested both directions (§6).

### 4. Distribution modes — with the 2026 wasm linking reality verified

#### 4.1 Why static linking: the evidence

- **Component Model: Phase 1** (WebAssembly/proposals README, active proposals list, checked 2026-07-24). Not implemented natively in any browser; browser use requires the `jco` transpile step. It cannot serve as a runtime linking mechanism for Rust UI crates in 2026.
- **Shared-Everything Threads: Phase 1** (same source). No shared-memory dynamic linking ABI for Rust→wasm on the horizon.
- Core-wasm dynamic linking exists only in Emscripten-land (`SIDE_MODULE`), not for `wasm32-unknown-unknown` — the rustc book target page doesn't even list it as an option.
- Every Rust UI framework statically links app+engine into one wasm (Dioxus via `dx`, Yew via Trunk, Leptos via cargo-leptos — §1.1). This is forced by the platform, not fashion.

Conclusion (D7): **mode (b) is one crate graph, one wasm** — user components + ferric engine compiled together (`cargo build --target wasm32-unknown-unknown` + wasm-bindgen/wasm-opt post-pass). And the killer consequence: in mode (b), **Rust component renders are direct intra-wasm function calls — the trampoline crossing per component render, per hook dispatch, and per effect (the M0–M8 architecture's tax, index.html §4) vanishes for Rust subtrees.** Only JS components and JS-owned values pay crossings.

#### 4.2 The three distribution modes

| Mode | Audience | Artifact | Engine↔component calls |
|---|---|---|---|
| (a) `@ferric/*` npm | TS users (M0–M8) | Prebuilt split wasm (`runtime`/`server`/`flight-*`, index.html §4 "Artifact split") | All components trampoline JS↔wasm |
| (b) `ferric` crate (wasm) | Rust authors, mixed apps | One wasm: engine + user code; npm ships only the JS glue + event executor + DevTools shim | Rust components: direct calls; JS components: trampoline |
| (c) `ferric` crate (native) | Pure-Rust SSR (axum), no Node | Native rlib/staticlib in the server binary | Zero crossings, zero handle table for user values |

Mode (b) build pipeline (Vite, verified): Vite supports direct `.wasm` ESM integration ("A `.wasm` file can be imported directly… follows the WebAssembly/ES Module Integration proposal… behaves as an async module and requires top-level await") and `.wasm?init` for manual instantiation, with sub-`assetInlineLimit` wasm inlined as base64 (vite.dev/guide/features, "WebAssembly"). Pipeline sketch:

```
app/
  rust/                    # cargo workspace: user's components
    Cargo.toml             # ferric = "19.2"
    src/lib.rs             # #[component] fns; ferric::export_components!()
  web/
    package.json           # "@ferric/react-dom": "19.2.x", "@app/rust": "file:../rust/pkg"
    vite.config.ts         # plugins: [react(), ferric({ crate: '../rust' })]
```

`vite-plugin-ferric` (thin, ~600 LOC) runs `cargo build --target wasm32-unknown-unknown --release` + wasm-bindgen (`--target web`) + `wasm-opt -O3` in watch mode (the trunk/vite-plugin-rsw pattern), emits the pkg into a workspace npm package. The generated glue calls `__ferric_register_component(slab_id, name)` per exported component, producing the marker objects from §3.1 — so **JSX `<TodoRow/>` in a TS file and `rsx!{ TodoRow {} }` in a Rust file refer to the same fiber type**. Where they meet: the JS app imports `@app/rust` (wasm-bindgen web-target output — natively consumed by Vite per the verified docs), which at module init registers its components into the same engine instance that `@ferric/react-dom` instantiated. One engine, two authoring languages, zero-config beyond the plugin.

Size expectations (estimates flagged as estimates; the binding gate is the fused plan's ≤1.75×-brotli-of-upstream-entry-set, index.html §8):
- Engine-only runtime wasm (mode a, reconciler+scheduler+DOM-decisions): est. **250–450 KB br** (135k JS LOC ported; wasm-opt'd; dlmalloc; verified tooling exists — wasm-opt is in the pipeline above). The plan already budgets glue ≤12k LOC and publishes the size column honestly (index.html §9 "WASM size / cold start").
- Mode (b) user+engine: engine + **+15–30%** for a typical app's component code (Rust generics monomorphization tax included), minus the JS glue the app no longer needs for its Rust subtrees. Net story: mode (b) ships *less total JS* than mode (a) for the same UI.

### 5. Pure-Rust SSR

Mode (c) is the fused plan's native-napi Fizz (M6, index.html §4 "Dual target: WASM and native napi") minus the JS host: the same Rust engine compiled as a normal rlib into an axum binary, with a `Host` trait impl replacing napi (§7 item 7 makes this cheap).

```rust
use axum::{Router, routing::get, response::IntoResponse, http::Request};
use ferric::prelude::*;
use ferric::server::{render_to_stream, RenderOptions};

#[component]
fn App(user_id: UserId) -> Element {
    // suspends natively: future polled by tokio, engine-mediated resume — no JS, no promise
    let user = use_loader(move || db.load_user(user_id))?;
    rsx! {
        html { body {
            h1 { "Hello, {user.name}" }
            Suspense { fallback: rsx!{ p { "Loading feed…" } },
                Feed { user_id }
            }
        } }
    }
}

#[tokio::main]
async fn main() {
    let app = Router::new().route("/", get(|req: Request| async move {
        let opts = RenderOptions::new().with_request(&req);
        let stream = render_to_stream(rsx! { App { user_id: req.user() } }, opts);
        HtmlStream(stream)   // chunked transfer; Suspense boundaries stream like Fizz
    }));
    axum::serve(tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap(), app).await.unwrap();
}
```

RSC in Rust: M7 already ports the Flight wire protocol to Rust (index.html §7, "Flight = wire protocol in Rust"); M9 exposes `ferric::rsc::render_to_flight_stream(root)` as an axum endpoint, with **async Rust server components** (`async fn` server components returning `Element` — legal here because native render can await; the Fizz/Flight state machines are already Rust). Deployment without Node: one statically linked binary (musl), container FROM scratch; or `wasm32-wasip2` for serverless (Yew's `LocalServerRenderer` on wasip1/wasip2 proves the single-thread WASI SSR pattern — yew.rs SSR page, "Single thread mode").

**Benchmark story (quantified shape).** The M6 napi SSR target is ≥1.3× stock (index.html §6 M6) while still paying, per component render: one JS↔native trampoline, hook-value handle interning (index.html §4 handle table), and the `scanChildSet` JS walk per render result. Mode (c) eliminates all three for all-Rust trees:
- If crossing+handle overhead is ~40–60% of per-render cost on component-dense Fizz trees (the M3 spike and M6 boundary-call counters — "boundary-call counters ship in every benchmark", index.html §9 — measure exactly this), removing it yields an **additional 1.6–2.5× over the napi number → 2–3× stock React SSR** on dense trees, with the honest caveat that it applies only when the whole tree is Rust.
- Pre-registered M9 bench contract (same rig as §8 of the fused plan): the 1KB/100KB/1MB Fizz trees × 0/25/250 Suspense boundaries, authored twice (TS and Rust) with **byte-identical HTML asserted** (that's also a conformance test, §6), `oha` at concurrency 1/10/50, req/s + TTFB + time-to-shell. Mixed trees amortize toward the napi number — published as a curve (% of tree in Rust vs speedup). That curve is itself the adoption marketing.

### 6. Conformance strategy for the Rust API

React's suite cannot judge M9 (it exercises only the TS API). The M9 oracle is **differential identity against the same engine**:

1. **Twin-test harness (primary).** Every fixture authored twice — TS via `@ferric/react-dom`, Rust via the `ferric` crate — rendered on the *same engine build*, asserting identical: (i) final DOM tree, (ii) SSR HTML bytes, (iii) **mutation command-buffer sequences** (stronger than DOM equality — catches missing/extra/reordered mutations; the buffer format already exists as the commit protocol, index.html §4), (iv) scheduler yield logs (the noop host's `assertLog` mechanism, plan-kimi.md:46-47, reused with Rust components mounted through the noop host — the noop unlock generalizes: host-agnostic means Rust-API-agnostic), (v) console warning text (`warnings.rs` parity extends to Rust-triggered warnings — e.g. missing-key DEV warnings must be byte-identical whichever language authored the list).
2. **Hand-written twin matrix (the named subset).** ~300 cases mirroring reconciler-suite topics: hooks ordering + conditional-hook DEV error parity; state/reducer batching and lane ordering; effect timing (passive vs layout vs insertion, cleanup order); context propagation incl. cross-seam providers both directions; Suspense (fallback reveal order, nesting, retry-on-wake, cross-seam suspension: JS boundary catching Rust `use_shared` and vice versa); transitions (isPending, interruption, reuse of suspended trees); error boundaries across the seam both directions; StrictMode double-invoke parity; memo bailout equality semantics; keyed reorder/mount/unmount mutation sequences; hydration (match, mismatch recovery, `use_loader` serialization round-trip); `use` caching semantics (same `Shared` identity across re-renders, mirroring react.dev's cached-promise rule). Each twin test names the React suite file/topic it mirrors — coverage map generated, gaps explicit.
3. **Property tests (proptest).** Random tree shapes × random update sequences × random key assignments × random Suspense resolution orders, run on three legs where possible: upstream React (jsdom), TS-on-Ferric, Rust-on-Ferric; asserting final DOM + mutation-log equality. Budget: 10M cases for M9 (vs 100M for M8 — this layer reuses the M8 harness with a second authoring frontend, index.html §5 "Differential fuzzing").
4. **Fault injection (panic policy conformance).** Panic injected in render / effect / layout effect / event handler / cleanup, at each commit phase, on native and wasm builds → asserted documented behavior (boundary `Thrown::Error` on native; documented abort on wasm-default; boundary catch on wasm `panic-unwind` feature).

**M9 done-gate (machine-checkable):**
1. Twin matrix 100% green on wasm and native, 0 skipped; coverage map shows every named topic above.
2. Differential fuzz: 10M cases, zero divergence (DOM, mutation log, yield log).
3. The three M8 soak apps each re-author one screen in Rust: byte-identical SSR HTML + identical interaction traces.
4. Fault-injection suite green; panic policy docs match behavior.
5. The four `yarn test --build` runs still green (M9 is additive; the M0–M8 oracle must not move).
6. `cargo doc` public API complete; semver policy published; ferric crate version locked to the engine train (`19.2.x` tracking, same as npm).

### 7. M9 scoping

#### 7.1 Work breakdown (post-M8 follow-on run, same Smithers machine: Panel guides → adversarial review lanes → twin-test ratchet)

| Sub-milestone | Content | Est. LOC (src/test) | Weeks |
|---|---|---|---|
| M9a | Crate skeleton, `#[component]`/`Props` derive, handler slab, rsx! macro | 4k / 3k | 3 |
| M9b | Typed hooks facade (all signatures §2.2) — thin: semantics already in the ported engine | 2.5k / 2k | 2 |
| M9c | Seam layer: component registry, props two-mode conversion, lazy element materialization, DevTools/name-table hookup | 2.5k / 1.5k | 2 |
| M9d | Error model: `Thrown`, `Result` elements, native `catch_unwind`, `panic-unwind` feature, fault injection | 1k / 1.5k | 1 |
| M9e | Pure-Rust SSR: `Host` trait native impl, axum integration, `use_loader` hydration channel, RSC endpoint | 2.5k / 1.5k | 1.5 |
| M9f | Twin harness + matrix (~300 cases) + proptest legs + fuzz | 1k / 5k | 2 (∥ M9c–e) |
| M9g | Distribution: vite-plugin-ferric (~600 LOC), cargo template, `cargo clippy` hooks-order lint, docs | 2k / 0.5k | 1.5 |
| **Total** | | **~15.5k src / ~15k test** | **6–8 wks** |

Cost: est. $15–25k model spend at the campaign's measured $/LOC rates (M9 is mostly *new* code against a stable, tested engine — cheaper per LOC than the M4 port; none of it is cross-paradigm translation).

#### 7.2 What must NOT leak into M0–M8

No rsx!, no proc macros, no crate publishing, no twin matrix, no axum code, no `lazy`-for-Rust, no JSPI experiments, no signals API. M0–M8 ships exactly the fused plan; the only M9 presence is the eight cheap decisions below, each a ≤1-day design constraint, verified against bridge work already specified.

#### 7.3 The SHORT list of cheap M0–M8 decisions that make M9 cheap (do these or M9 costs ~2×)

1. **Fiber `type` is a tagged u32 from day one** — `Host(Atom) | Js(JsRef)` now, `Rust(SlabId)` reserved (lands in M4 fiber layout; one tag bit vs fiber-layout surgery later).
2. **Handler/effect slots are a tagged union** — `JsHandle | RustSlabId` in the `EFFECT_OPS`/event record formats (ABI.md at M0; costs nothing, makes Rust closures first-class in the same slabs).
3. **Hook state slots are a `Value` enum** — `Js(JsRef) | Rust(*mut ())` (M4 hooks cohort; Rust hook values never intern into the JS handle table — required for mode (c) where there is no handle table).
4. **Element intake consumes descriptors, never JS element objects, internally** (M4 `scanChildSet` design constraint) — JS element materialization happens only at the JS boundary; this is what lets rsx! be a zero-copy producer and makes lazy materialization (D6) possible.
5. **Render dispatch returns a Rust-native `Result<Elem, Thrown>` internally** (exceptions→Result per PORTING.md, M0) — not merely a boundary encoding; M9's `Element`/`Thrown` types reuses it verbatim.
6. **Fiber debug names via an indirection table** (needed for `warnings.rs` stacks anyway, index.html §4) — `#[component]` later registers Rust names into the same table.
7. **Engine is host-agnostic behind a `Host` trait** — napi host is one impl, pure-Rust host another (M6 dual-target already forces most of this; formalize the trait boundary at M6, not M9).
8. **Suspense wake path accepts an internal `Wake` enum** — not only JS thenable `.then` (M4 Suspense cohort + M6 Fizz; one enum now vs rewiring wakeups for Rust futures later).

Cross-cutting flags for other lanes: **(BRIDGE.md)** items 1–4 and 8 above are bridge-contract content — this report is their M9 requirements spec. **(Versioning train)** the `ferric` cargo crate rides the same train as npm (`19.2.x` tracking); crates.io joins the publish gate. **(CSP/packaging)** mode (b) adds a user-compiled wasm + wasm-bindgen glue module to the CSP allowlist story — same directives, one extra asset class to document. No conflicts found with the fused oracle, milestones, or kill gates.

---

## (2) DECISIONS

| # | Decision | Why / evidence that settled it |
|---|---|---|
| D1 | **Component model = React's re-run-per-render + call-order hook list (Yew-shaped), not run-once signals (Leptos/Sycamore-shaped).** | React semantics: re-render with new props, StrictMode double-invoke, lane scheduling, restart-after-suspend (react.dev/use: suspended-before-mount renders are discarded and retried). Signals bypass the ported scheduler and break the trace oracle. Yew proves the model in Rust (yew.rs hooks page). |
| D2 | **`Element = Result<VNode, Thrown>`; `?` is the suspend/error channel.** | Dioxus 0.7 uses `?` for both suspense and error boundaries (verified, hooks docs); React throws thenables/errors — `Result` is the Rust-idiomatic isomorph and avoids wasm unwinding entirely. |
| D3 | **Panic policy: fallible components via `Result`; panics fatal-to-root on wasm-default; `catch_unwind`→boundary on native; opt-in nightly `panic-unwind` wasm feature.** | wasm32-unknown-unknown defaults to panic=abort; panic=unwind needs nightly+`-Zbuild-std` with no default-enable plan (rustc book, verified). EH proposal is finished (WG 2025-07-23) so engines aren't the blocker — toolchain is; adoption UX forbids requiring nightly. |
| D4 | **No signals API in M9; state = `use_state` snapshot handles (`Deref` over Rc).** | Push-based signals have no lanes/transitions and would double the conformance surface. `Deref` handle shape from Yew's `UseStateHandle`; zero-clone reads with React's immutable snapshot semantics. |
| D5 | **Seam props: opaque JsRef passthrough by default; typed `serde` conversion opt-in; Rust→JS builds props in a buffer.** | Passthrough preserves `Object.is` props identity (memo/children semantics). Serde-everything forces `Serialize` bounds + per-render cost; rejected. Pure passthrough makes Rust ergonomics miserable; rejected. |
| D6 | **Rust-emitted elements materialize as JS element objects lazily, cached per descriptor.** | Keeps the "elements stay JS" invariant observationally true (ecosystem/test introspection) while pure-Rust subtrees allocate zero JS elements — the mixed-tree perf headline. |
| D7 | **Distribution (b) is static linking: one wasm, engine + user code. No runtime dynamic linking.** | Component Model = Phase 1, Shared-Everything Threads = Phase 1 (WebAssembly/proposals, verified 2026-07-24); no browser-native component model; Emscripten SIDE_MODULE not applicable to wasm32-unknown-unknown. All four prior-art frameworks statically link. |
| D8 | **Rust futures suspend via engine-mediated return channel, not JSPI and not promises.** | Suspense machinery is already Rust-owned; return-channel needs no stack capture and is identical wasm/native. JSPI (Phase 5, verified) deferred to a post-M9 experiment. Rust→JS futures use `future_to_promise` (wasm-bindgen-futures 0.4.76, verified) — real Promises satisfy React's status/value/reason protocol, which React self-populates (react.dev/use). |
| D9 | **Event handlers: per-fiber Rust handler slab + u32 ids + one `__ferric_dispatch_event` bridge export; flat event records.** | Events stay JS (fused plan); this plugs Rust closures into the existing ancestry-query dispatch with one batched crossing per event, no new event-system port. |
| D10 | **rsx! grammar = Dioxus-style (`for`/`if`/`match` in markup, `key:` attribute), semantics = React.** | Cleanest verified prior-art grammar; avoids JSX token soup; keys are engine-level so semantics are free. |
| D11 | **`memo()` opts into comparison (default shallow fieldwise); `Props` does not require `PartialEq`.** | React re-renders without props equality; mandatory `PartialEq` (Dioxus/Yew) is un-React-like and blocks `JsRef`-holding props. |
| D12 | **Pure-Rust SSR = mode (c): engine as native rlib behind a `Host` trait; axum integration; wasip2 single-binary option.** | M6 already dual-targets (wasm + napi); Yew's `ServerRenderer`/`LocalServerRenderer` (wasip1/2) proves both shapes. Benchmark contract: twin-authored trees, byte-identical HTML, speedup curve vs %-tree-in-Rust. |
| D13 | **Conformance = differential twin testing on one engine (DOM + HTML bytes + mutation-buffer + yield-log + warning-text equality), ~300-case named matrix, 10M-case proptest, fault injection.** | React's suite structurally cannot judge a Rust authoring API; mutation-buffer and yield-log equality are stronger than DOM equality and reuse M0–M8 machinery (commit protocol, noop host, warnings.rs). |
| D14 | **M9 runs as a post-M8 follow-on Smithers run, 6–8 wks, ~15.5k src / ~15k test LOC, $15–25k.** | Engine is stable and tested by then; M9 is new code, not cross-paradigm porting — cheaper $/LOC than M4. |
| D15 | **The 8 cheap M0–M8 decisions (§7.3) are adopted into M0/M4/M6 design constraints now.** | Each is ≤1 day inside work already planned (ABI.md, fiber layout, hooks cohort, Host trait) and removes entire M9 workstreams (element materialization, handler slab, wake enum) if done early. |

---

## (3) RISKS

| Risk | Severity | Mitigation / kill criterion |
|---|---|---|
| rsx! proc-macro error-message DX (bad spans scare users; the "you can actually use it" bar is DX) | ● serious | Invest M9a in span hygiene + `trybuild` compile-fail suite; kill: if error quality can't reach Dioxus parity after M9a, ship builder API (`div().class(..).child(..)` — Sycamore/Leptos both ship one) as the documented fallback and gate rsx! behind a feature. |
| `'static` closure bounds force clone-heavy user code (every handler clones captured state) | ● serious | `Handler`/`StateHandle` are cheap-clone by design (Rc/slab); docs patterns; clippy lint suggests `handle.clone()` instead of `Arc`. Accept as idiomatic-Rust cost — Yew/Dioxus/Leptos all live here. |
| No eslint-plugin-react-hooks equivalent → hook-order bugs at runtime | ● serious | Ship `clippy::ferric_hooks` lint (M9g) + DEV runtime order-validation with the ported DEV warnings. Kill: lint slips to M9.1, runtime check never does. |
| Lazy element materialization proves observable (JS introspection of `children` identity/shape breaks) | ● serious | Cached minting keeps identity stable; twin matrix includes children-introspection cases (react-devtools-style walks, `Children.map`). Fallback: eager materialization mode (perf hit, semantics safe) — degrade, don't die. |
| panic=unwind wasm UX never stabilizes; per-render `catch_unwind` cost on native | ○ warning | Feature stays opt-in; native catch_unwind cost measured in M9e bench (expected ~ns/render — one landing pad); documented default policy is the real contract. |
| Two authoring languages fork the ecosystem ("which API do I use?") and double support load | ○ warning | Position Rust API explicitly as additive for Rust-first teams; TS API remains the default; every M9 doc page shows the twin. Version train unified (D-cross-flag). |
| Mode (b) wasm size (engine + user code in one binary) breaks the ≤1.75× gate for real apps | ● serious | wasm-splitter-style route splitting (Dioxus proved the tooling) as M9.1; publish sizes per soak app; gate applies to mode (a) — mode (b) judged against "mode (a) + equivalent JS app code" not against bare react-dom. |
| Twin matrix <90% green after 2 fix cycles | ● serious | **Kill/de-scope:** cut to "Rust components in SSR-only mode" (mode c). The benchmark headline and the axum story survive; client mixed mode becomes v2. This is M9's go/no-go, exercised at the M9f gate. |
| M9 scope creep pulls engineers back into M0–M8 crunches | ○ warning | M9 is a separate run started only after M8 publish; the §7.3 decisions are time-boxed to ≤1 day each inside existing milestones; any that miss their window are deferred with the documented 2× M9 cost accepted. |

---

## (4) SPEC TEXT (ready to lift into the campaign spec)

### 4.A Milestone M9 — Rust-native authoring API

> **M9 — the `ferric` crate: React's API, authored in Rust (6–8 wks, post-launch follow-on run).** Every public React API usable from M0–M8 gains a typed Rust twin: function components (`#[component]`, re-run-per-render, call-order hook list), hooks (`use_state`/`use_reducer`/`use_memo`/`use_callback`/`use_ref`/`use_effect`/`use_layout_effect`/`use_insertion_effect`/`use_context`/`use_transition`/`use_optimistic`/`use_deferred_value`/`use_id`/`use_sync_external_store`/`use_shared`/`use_loader`), `rsx!` markup with `for`/`if`/`match` control flow and `key:`-ed lists, typed `Context<T>`, `memo`/`lazy`-over-JS, refs/`NodeRef`, and `Element = Result<VNode, Thrown>` with `?` as the Suspense/error-boundary channel. Components compile *together with the engine* into one wasm (static linking — the wasm component model is Phase 1 and unusable in browsers), so Rust component renders are direct intra-wasm calls with zero bridge crossings. Mixed JS/Rust fiber trees in both directions share one engine: fiber `type` is a tagged union (`Host | Js | Rust`), props cross opaque-by-default (identity-preserving) with typed serde opt-in, Rust-emitted elements materialize as real JS element objects lazily, keys/diffing/error boundaries are engine-internal and therefore identical on both sides, and Rust components appear in DevTools and warning stacks by name. Pure-Rust SSR mode compiles the engine as a native rlib behind the `Host` trait: axum in, streamed HTML out, Suspense served by Rust futures, RSC via the ported Flight protocol — no Node anywhere in the stack. Panic policy: `Result` is the error channel; panics are fatal-to-root on default wasm builds, converted to error-boundary throws on native, with an opt-in nightly `panic-unwind` wasm feature.
>
> **M9 gates:** (1) ~300-case TS/Rust twin matrix 100% green on wasm and native — identical DOM, SSR HTML bytes, commit-buffer sequences, scheduler yield logs, and warning text; (2) 10M-case three-leg differential fuzz, zero divergence; (3) three soak apps re-author one screen in Rust with byte-identical SSR HTML; (4) fault-injection suite proves the documented panic policy; (5) the four `yarn test --build` conformance runs remain green — M9 is additive; (6) pre-registered M9 bench contract: all-Rust SSR trees ≥2× stock React (expected 2–3× on dense trees), published as a speedup-vs-%-tree-in-Rust curve with mixed-tree numbers included. **De-scope fallback:** if the twin matrix stalls <90% after two fix cycles, M9 ships SSR-only (mode c) and client mixed mode moves to v2.

### 4.B M0–M8 addendum — M9-enabling design constraints (each ≤1 day, inside existing milestones)

> ABI.md (M0) specifies: fiber `type` as tagged u32 (`Host(Atom) | Js(JsRef)`, `Rust(SlabId)` reserved); handler/effect slots and event records as tagged unions (`JsHandle | RustSlabId`); render dispatch returning a Rust-native `Result<Elem, Thrown>` internally; hook state slots as a `Value` enum (`Js(JsRef) | Rust`) (M4 hooks cohort); element intake consuming packed descriptors internally with JS element materialization only at the JS boundary (M4); fiber debug names via an indirection table shared with warnings.rs (M4); Suspense wake path accepting an internal `Wake` enum rather than only JS thenables (M4/M6); engine host access behind a `Host` trait with napi as one implementation (M6). These are constraints on already-planned work, not new scope.

### 4.C Public positioning paragraph (launch content)

> "Ferric is dual-API. TypeScript teams get drop-in `@ferric/*` packages judged by React's own test suite. Rust teams get the `ferric` crate: the same hooks, the same Suspense, the same error boundaries — typed — compiled with the engine into one wasm, mixed freely with JS components in a single fiber tree, and server-rendered from axum with no Node in the stack. One engine, two languages, one conformance story."

