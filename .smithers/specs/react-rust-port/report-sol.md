# Operation Ferric round 2 — Sol lane: production posture, packaging, operations, and budget

Date: 2026-07-24  
Evidence baseline: `facebook/react@28cd4bb08f1b66808bede284fca978cc9b065154`; Smithers working copy inspected 2026-07-24.

## 1. FINDINGS

### 1.1 The production loading contract is a product decision, not a bundler footnote

The fused plan proposes top-level `await` plus `WebAssembly.instantiateStreaming` for browser ESM, an adjacent synchronously read module for Node, and an embedded synchronous browser/CJS fallback. That is a good set of mechanisms, but the priority must change: **the embedded synchronous browser module is the production default; the separately fetched streaming module is an explicit opt-in until its support matrix clears.**

The reason is React's synchronous import contract. A drop-in `react-dom/client` import cannot sometimes return a promise or require application bootstrap to pause. A separately fetched module is necessarily asynchronous. Top-level `await` can hide that promise from the importer, but it still changes module evaluation and startup failure behavior. It also does not cover CJS.

Chrome imposes a hard constraint on the synchronous default. Chromium rejects `WebAssembly.Module`/`WebAssembly.Instance` on the main thread when the wire bytes exceed `kWasmWireBytesLimit`; the error tells callers to use async compilation or a worker. Chrome raised that limit to **8 MiB** in Chrome 115 ([Chromium implementation](https://chromium.googlesource.com/chromium/src/third_party/%2B/master/blink/renderer/bindings/core/v8/v8_initializer.cc), [Chrome 115 release note](https://developer.chrome.com/blog/chrome-115-beta#increase-the-maximum-webassemblymodule-size-on-the-main-thread-to-8-mb)). This is decoded Wasm size, not compressed transfer size. Therefore the embedded client module needs a decoded-size release gate of **7.5 MiB**, leaving 512 KiB of headroom. If it exceeds that after two size-reduction passes, Ferric cannot simultaneously promise current-Chrome support, synchronous import, and a Wasm client default.

The exact npm surface also cannot be invented independently of React. The inspected React checkout publishes `react-dom`, `client`, `server`, the server/static environment variants, `profiling`, `test-utils`, and unstable entries with conditional routing in `packages/react-dom/package.json:25-125`. Ferric must mirror every public entry present in the upstream release it claims to replace; the additional Ferric loader is a namespaced opt-in, not a substitute for an upstream entry.

#### Proposed `@ferric/react-dom` tarball

```text
@ferric/react-dom/
├── package.json
├── README.md
├── LICENSE
├── ferric-build.json
├── index.js                         # physical CJS-compatible facade
├── index.mjs                        # physical ESM facade
├── client.{js,mjs}
├── client.react-server.{js,mjs}
├── react-dom.react-server.{js,mjs}
├── server.{js,mjs}
├── server.browser.{js,mjs}
├── server.bun.{js,mjs}
├── server.edge.{js,mjs}
├── server.node.{js,mjs}
├── server.react-server.{js,mjs}
├── static.{js,mjs}
├── static.browser.{js,mjs}
├── static.edge.{js,mjs}
├── static.node.{js,mjs}
├── static.react-server.{js,mjs}
├── profiling.{js,mjs}
├── profiling.react-server.{js,mjs}
├── test-utils.{js,mjs}
├── unstable_testing.{js,mjs}       # only when present upstream
├── unstable_testing.react-server.{js,mjs}
├── unstable_server-external-runtime.{js,mjs}
├── streaming.mjs                   # Ferric-only opt-in
├── cjs/
│   ├── react-dom.development.cjs
│   ├── react-dom.production.cjs
│   ├── react-dom-client.development.cjs
│   ├── react-dom-client.production.cjs
│   └── ...
├── esm/
│   ├── react-dom.development.mjs
│   ├── react-dom.production.mjs
│   ├── react-dom-client.development.mjs
│   ├── react-dom-client.production.mjs
│   ├── react-dom-client.streaming.mjs
│   └── ...
├── loaders/
│   ├── browser-embedded.cjs
│   ├── browser-embedded.mjs
│   ├── browser-streaming.mjs
│   ├── node-sync.cjs
│   └── node-sync.mjs
├── embedded/
│   ├── ferric-client.base64.cjs
│   └── ferric-client.base64.mjs
├── wasm/
│   ├── ferric-client.wasm
│   └── ferric-server.wasm
└── types/
    └── ...                          # entry-for-entry upstream .d.ts surface
```

There are intentionally two copies of the client payload in the tarball: base64 for synchronous browser loading and a raw `.wasm` file for the streaming opt-in. Base64 adds approximately 4/3 before gzip/brotli and costs decode memory. It is still the only portable no-I/O synchronous representation. A generated integer array avoids base64 decoding but normally creates worse JS parse/token overhead. M0 must benchmark both and freeze the smaller/faster representation; “base64” above names the expected winner, not an exemption from measurement.

Node ESM and CJS read the adjacent `.wasm` synchronously and instantiate a fresh instance. They do not pay the base64 penalty. Browser condition routing selects the embedded facade. The package contains physical root facades, not only an `exports` map, because Parcel's package-exports resolver is still opt-in.

Representative manifest:

```json
{
  "name": "@ferric/react-dom",
  "version": "19.2.3001",
  "type": "commonjs",
  "main": "./index.js",
  "module": "./index.mjs",
  "types": "./types/index.d.ts",
  "files": [
    "*.js", "*.mjs", "cjs/", "esm/", "loaders/", "embedded/",
    "wasm/", "types/", "ferric-build.json", "README.md", "LICENSE"
  ],
  "exports": {
    ".": {
      "types": "./types/index.d.ts",
      "react-server": {
        "import": "./react-dom.react-server.mjs",
        "require": "./react-dom.react-server.js"
      },
      "browser": {
        "import": "./index.mjs",
        "require": "./index.js"
      },
      "node": {
        "import": "./index.mjs",
        "require": "./index.js"
      },
      "import": "./index.mjs",
      "require": "./index.js",
      "default": "./index.js"
    },
    "./client": {
      "types": "./types/client.d.ts",
      "react-server": {
        "import": "./client.react-server.mjs",
        "require": "./client.react-server.js"
      },
      "browser": {
        "import": "./client.mjs",
        "require": "./client.js"
      },
      "import": "./client.mjs",
      "require": "./client.js",
      "default": "./client.js"
    },
    "./streaming": {
      "types": "./types/client.d.ts",
      "browser": "./streaming.mjs",
      "default": "./streaming.mjs"
    },
    "./server": {
      "types": "./types/server.d.ts",
      "react-server": {
        "import": "./server.react-server.mjs",
        "require": "./server.react-server.js"
      },
      "workerd": {
        "import": "./server.edge.mjs",
        "require": "./server.edge.js"
      },
      "bun": {
        "import": "./server.bun.mjs",
        "require": "./server.bun.js"
      },
      "deno": {
        "import": "./server.node.mjs",
        "require": "./server.node.js"
      },
      "worker": {
        "import": "./server.browser.mjs",
        "require": "./server.browser.js"
      },
      "node": {
        "import": "./server.mjs",
        "require": "./server.js"
      },
      "edge-light": {
        "import": "./server.edge.mjs",
        "require": "./server.edge.js"
      },
      "browser": {
        "import": "./server.browser.mjs",
        "require": "./server.browser.js"
      },
      "default": "./server.js"
    },
    "./server.browser": {
      "import": "./server.browser.mjs",
      "require": "./server.browser.js"
    },
    "./server.bun": {
      "import": "./server.bun.mjs",
      "require": "./server.bun.js"
    },
    "./server.edge": {
      "import": "./server.edge.mjs",
      "require": "./server.edge.js"
    },
    "./server.node": {
      "import": "./server.node.mjs",
      "require": "./server.node.js"
    },
    "./static": {
      "types": "./types/static.d.ts",
      "react-server": {
        "import": "./static.react-server.mjs",
        "require": "./static.react-server.js"
      },
      "workerd": {
        "import": "./static.edge.mjs",
        "require": "./static.edge.js"
      },
      "deno": {
        "import": "./static.browser.mjs",
        "require": "./static.browser.js"
      },
      "worker": {
        "import": "./static.browser.mjs",
        "require": "./static.browser.js"
      },
      "node": {
        "import": "./static.node.mjs",
        "require": "./static.node.js"
      },
      "edge-light": {
        "import": "./static.edge.mjs",
        "require": "./static.edge.js"
      },
      "browser": {
        "import": "./static.browser.mjs",
        "require": "./static.browser.js"
      },
      "default": "./static.node.js"
    },
    "./static.browser": {
      "import": "./static.browser.mjs",
      "require": "./static.browser.js"
    },
    "./static.edge": {
      "import": "./static.edge.mjs",
      "require": "./static.edge.js"
    },
    "./static.node": {
      "import": "./static.node.mjs",
      "require": "./static.node.js"
    },
    "./profiling": {
      "react-server": {
        "import": "./profiling.react-server.mjs",
        "require": "./profiling.react-server.js"
      },
      "import": "./profiling.mjs",
      "require": "./profiling.js"
    },
    "./test-utils": {
      "import": "./test-utils.mjs",
      "require": "./test-utils.js"
    },
    "./unstable_testing": {
      "react-server": {
        "import": "./unstable_testing.react-server.mjs",
        "require": "./unstable_testing.react-server.js"
      },
      "import": "./unstable_testing.mjs",
      "require": "./unstable_testing.js"
    },
    "./unstable_server-external-runtime": {
      "import": "./unstable_server-external-runtime.mjs",
      "require": "./unstable_server-external-runtime.js"
    },
    "./package.json": "./package.json"
  },
  "browser": {
    "./index.js": "./client.js",
    "./server.js": "./server.browser.js",
    "./static.js": "./static.browser.js"
  },
  "peerDependencies": {
    "react": "19.2.3001"
  }
}
```

Brace notation in the tree means both literal files ship. The map above covers the current inspected public surface plus Ferric's `./streaming`; the release generator must add/remove entries to match the selected upstream `react-dom/package.json` exactly. `ferric-build.json` records Ferric version, upstream React version and commit, Wasm ABI, Rust toolchain, source hash, error-map hash, and symbol build ID.

Drop-in installation uses npm aliases so application and ecosystem imports remain unchanged and resolve to one identity:

```json
{
  "dependencies": {
    "react": "npm:@ferric/react@19.2.3001",
    "react-dom": "npm:@ferric/react-dom@19.2.3001"
  }
}
```

That is also why `@ferric/react-dom` peers on the canonical name `react`, not `@ferric/react`: third-party components continue to import and peer on `react`. The install matrix must prove one resolved React identity under npm, pnpm, Yarn, and Bun.

#### What each bundler really supports

| Consumer | Embedded default | Separate streaming entry | Required user action | Production status |
|---|---|---|---|---|
| Vite 8 SPA | Plain JS dependency; zero Ferric config | `new URL("../wasm/ferric-client.wasm", import.meta.url)` is an asset URL; `instantiateStreaming`, then `arrayBuffer` fallback | None in a normal Vite build; origin must serve `.wasm` as `application/wasm` for the streaming fast path | GA after fixture |
| webpack 5.83+ SPA | Plain JS dependency; zero Ferric config | Static `new URL(..., import.meta.url)` creates an asset module; TLA is enabled by default in 5.83+ | None for the Ferric entries | GA after fixture |
| Parcel 2 | Physical facade plus `main`/`module`/`browser`; zero Ferric config | `new URL` asset handling exists, but conditional exports are disabled by default | Add `"@parcel/resolver-default": {"packageExports": true}` only if relying on conditional-exports-only resolution | Embedded GA; streaming beta until fixture |
| Next 15 Pages Router / webpack | Embedded browser facade and Node sync server facade | Can work through webpack asset output, but server/client copies and standalone output must be tested | No Ferric line on Next 15 webpack; normal CSP header still applies | Beta, then GA only with CI fixture |
| Next 16 Pages Router | Same mechanics, but Next now defaults to Turbopack | The certified path is webpack until Turbopack fixture clears | `next dev --webpack` and `next build --webpack` are unavoidable on the certified path | Beta |
| Next App Router | Plain embedded client bytes avoid asset-loader failure, but React/RSC integration is coupled to Next's built-in React canary and server-component loader | Current real-world Next issue reports missing emitted Wasm in server-component output | Exact Next/React pin and `--webpack` in lab fixture; no zero-config claim | Lab/unsupported for GA |
| Next Edge / workerd | Dynamic Wasm compilation is forbidden by the runtime | Requires build-time bundled `WebAssembly.Module`, a different adapter contract | No supported v1 config line can make the generic npm loader valid | Unsupported in v1 |

Evidence:

- Vite documents direct Wasm imports, `?init`, size-based inlining, and the `?url` plus `instantiateStreaming` pattern; it also says SSR support is Node-compatible only ([Vite WebAssembly and asset URL documentation](https://vite.dev/guide/features.html#webassembly), [Vite `new URL` asset documentation](https://vite.dev/guide/assets.html#new-url-url-import-meta-url)).
- webpack 5 treats `new URL("./file", import.meta.url)` as an asset dependency without a custom rule ([webpack asset modules](https://webpack.js.org/guides/asset-modules/#url-assets)). TLA is on by default in webpack 5.83+ ([webpack experiments](https://webpack.js.org/configuration/experiments/#experimentstoplevelawait)).
- Parcel advertises URL-referenced assets and zero-configuration asset transformation, but its own resolver documentation says package exports are disabled by default and gives the exact opt-in object above ([Parcel overview and `new URL` example](https://parceljs.org/), [Parcel package exports](https://parceljs.org/features/dependency-resolution/#package-exports)).
- Next 16 makes Turbopack the default and documents `--webpack` as the opt-out ([Next 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16), [Turbopack reference](https://nextjs.org/docs/pages/api-reference/turbopack)). The App Router uses built-in React canary releases while the Pages Router uses the package-installed React version ([Next installation guide](https://nextjs.org/docs/app/getting-started/installation)). Next warns that its custom webpack hook is not semver-stable ([Next webpack config](https://nextjs.org/docs/pages/api-reference/config/next-config-js/webpack)). Edge Runtime rejects dynamic Wasm compilation and requires a statically bundled module ([Next Edge dynamic-code error](https://nextjs.org/docs/messages/edge-dynamic-code-evaluation)). A current Next issue demonstrates a `.wasm` asset emitted incorrectly/missing from a server-component path; it is evidence for a fixture gate, not proof that every App Router build fails ([vercel/next.js#83046](https://github.com/vercel/next.js/issues/83046)).

Accordingly, **“zero config” means the default `@ferric/react-dom/client` import in Vite, webpack, and Parcel SPA fixtures**. It does not mean universal streaming, App Router replacement, edge SSR, or zero CSP changes.

### 1.2 Streaming, MIME, TLA, iOS, Node, and Jest impose different constraints

`WebAssembly.instantiateStreaming(response, imports)` compiles while the response arrives, but the server must return `application/wasm`; MDN explicitly calls out the MIME requirement and notes that a strict CSP can block Wasm compilation ([MDN `instantiateStreaming`](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/instantiateStreaming_static)). Ferric's streaming loader must:

1. check `response.ok`;
2. try `instantiateStreaming`;
3. fall back to `response.arrayBuffer()` plus `WebAssembly.instantiate` only for MIME/streaming-implementation failure;
4. preserve the original cause in `FerricWasmLoadError`;
5. expose URL, status, content type, Ferric build ID, and loader mode without exposing app data.

The fallback fixes a bad MIME type; it does not bypass CSP.

Top-level `await` is old enough in ordinary module loaders—Chrome 89 and Safari 15 are documented by V8, Firefox 89 by Mozilla, and Node 14.8 by Node ([V8 TLA](https://v8.dev/features/top-level-await), [Firefox 89 notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/89), [Node 14.8 release](https://nodejs.org/en/blog/release/v14.8.0)). Safari 15 also added streaming compilation ([WebKit Safari 15 notes](https://webkit.org/blog/11989/new-webkit-features-in-safari-15/)).

That compatibility table is not enough for a production drop-in. A live WebKit bug describes a Safari/iOS 26 case where a second import of a TLA module does not resolve; it is a specific duplicate-import defect, not evidence that all TLA is broken ([WebKit bug 301711](https://bugs.webkit.org/show_bug.cgi?id=301711)). WebKit's Safari 27 beta notes describe module-loader ordering and initialization fixes, including TLA pain points ([Safari 27 beta](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/)). Therefore:

- current Safari/iOS must use the embedded synchronous entry;
- streaming remains opt-in on Safari 26;
- Safari 27 streaming support becomes GA only after the stable release and a repeated-import fixture passes on physical iPhone/iPad hardware.

This is a direct contradiction to treating “TLA + streaming” as the universal browser default. It is not a contradiction to shipping it as an opt-in performance mode.

Node does not apply Chromium's main-thread embedder limit. On this review machine (Apple M3 Max, 64 GiB), Node 20.20.2 and 22.23.1 both synchronously compiled and instantiated a valid 9,437,198-byte module. Compile/instantiate times were 1.56/0.08 ms and 1.44/0.07 ms respectively. The module was mostly a custom section, so those timings do **not** predict Ferric compile cost; they establish only that the Chrome 8 MiB rejection was absent. Release CI still needs real-artifact cold-start measurements on Node 20 and 22.

The Jest contract is stricter than “Node allows sync.” React's Jest base configuration enables global **legacy fake timers** (`scripts/jest/config.base.js:33-36`). Its build configuration redirects public package imports into `build/node_modules` and excludes internal tests (`scripts/jest/config.build.js:34-70`). A source scan at the pinned SHA found 270 test files calling `jest.resetModules()` (345 calls), 71 files matching timer/scheduler control patterns, and 53 files in the intersection. Jest documents that `resetModules` resets its module registry and can produce separate module instances ([Jest `resetModules`](https://jestjs.io/docs/jest-object#jestresetmodules)).

The Wasm loader contract must therefore be:

```text
compiled WebAssembly.Module: process/test-realm cache, immutable
mutable WebAssembly.Instance: owned by the current JS module instance
jest.resetModules(): new JS facade + fresh Wasm instance + fresh handle tables
scheduler clock/timers: looked up through the current JS realm, never captured at Wasm initialization
```

Scheduler imports must call a JS trampoline that reads the current `globalThis.setTimeout`, `clearTimeout`, `MessageChannel`, and `performance.now`; caching those functions before Jest swaps fake timers would invalidate the oracle. Add a conformance file that alternates real timers, legacy fake timers, reset, and fresh import, and asserts that old handles trap rather than leak into the new generation.

The local calibration used stock React source mode because the build-mode build was blocked by the host's missing Java/Closure Compiler:

```text
Machine: Apple M3 Max, 16 logical CPUs, 64 GiB
React:   28cd4bb08f1b66808bede284fca978cc9b065154
Mode:    stable DEV, --runInBand, fresh Jest process per file

File                                                   Cases   Jest   Wall
packages/react/src/__tests__/ReactIs-test.js               14   0.949s 1.95s
packages/react/src/__tests__/ReactChildren-test.js         42   3.866s 4.35s
packages/scheduler/src/__tests__/Scheduler-test.js          9   0.326s 0.70s
packages/react-reconciler/src/__tests__/
  ReactHooksWithNoopRenderer-test.js                       97   1.910s 2.37s
Total                                                     162          9.37s
```

Mean wall time was 2.3425 s/file. Multiplying only the public denominator gives:

```text
262 files × 4 DEV/PROD × stable/experimental cells × 2.3425 s
= 2,454 seconds
= 40.9 minutes serial, before build, the 48-file internal leg, retries, or heavy-tail tests
```

This is a calibration floor, not a forecast. For provisioning, use a 2–4× heavy-tail/build factor: 82–164 serial minutes. Four isolated eight-worker oracle jobs should target 20–45 minutes wall time, with a **90-minute release-gate SLO** including builds and one infrastructure retry. M0 must replace this estimate with build-mode measurements on the chosen Linux oracle host.

### 1.3 CSP has no loader trick that avoids the Wasm permission

CSP3 applies the WebAssembly check to `WebAssembly.compile`, `compileStreaming`, `instantiate`, `instantiateStreaming`, `Module`, and `Instance` ([CSP3 WebAssembly integration](https://www.w3.org/TR/CSP3/#directive-script-src)). MDN says `script-src 'wasm-unsafe-eval'` allows Wasm compilation and is narrower than `'unsafe-eval'`; if `'unsafe-eval'` is present it overrides the narrower keyword ([MDN `script-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src#unsafe_webassembly_execution)).

The required strict-site addition is:

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  connect-src 'self';
```

The site's existing nonces/hashes and other directives remain. `connect-src 'self'` is required only for the separately fetched same-origin streaming artifact; embedded mode performs no fetch. Neither base64 embedding, an ArrayBuffer, a blob URL, a data URL, nor a worker bypasses the Wasm compilation check. Sites that refuse both `'wasm-unsafe-eval'` and `'unsafe-eval'` cannot run Ferric client-side; their supported choices are upstream React or pure native Ferric SSR/static HTML.

Browser enforcement history is uneven. Current Chromium supports and itself prescribes `'wasm-unsafe-eval'` in strict Isolated Web App policy ([Chrome IWA security policy](https://developer.chrome.com/docs/iwa/developer-policy)); Firefox added it in Firefox 102 ([Firefox 102 notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/102)); Safari 26 fixed parsing of the keyword ([WebKit Safari 26 notes](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)). Older Safari commonly required the broader `'unsafe-eval'`, tracked in WebKit bug 197759 ([WebKit bug 197759](https://bugs.webkit.org/show_bug.cgi?id=197759)). Ferric must not recommend weakening a strict site to `'unsafe-eval'`; strict-CSP support starts at Safari 26, and a physical-device CSP fixture is a release gate.

### 1.4 React error parity and Rust crash reporting are separate systems

React's production error mechanism is mechanical:

- `scripts/error-codes/codes.json` is append-only; existing IDs are never changed or removed (`scripts/error-codes/README.md:1-15`).
- `scripts/error-codes/transform-error-messages.js` loads that map, rewrites `Error(...)` to a numeric code, and marks an unmapped production error for extraction (`scripts/error-codes/transform-error-messages.js:14-16,23-68,112-135`).
- `scripts/error-codes/extract-errors.js` scans build output and appends new IDs (`scripts/error-codes/extract-errors.js:7-22,24-67`).
- The runtime formatter constructs the `https://react.dev/errors/<code>?args[]=...` message with encoded arguments (`packages/shared/formatProdErrorMessage.js:13-26`).
- React's own production Jest setup decodes those messages before asserting them (`scripts/jest/setupTests.js:86-114`).

Byte parity means Ferric generates `error_codes.rs` from the selected upstream `codes.json`, preserves numeric IDs and argument order, uses the same URL and `encodeURIComponent` behavior, and produces no unminified semantic error in a production artifact. `yarn extract-errors` after a full candidate build must have a zero diff. Rust implementation failures must never consume React error-code space.

Rust offers a panic hook that runs before either unwind or abort and receives panic payload/location information ([Rust `std::panic::set_hook`](https://doc.rust-lang.org/std/panic/fn.set_hook.html)). Browser Wasm stacks are not a sufficient production reporting contract: the Rust/Wasm debugging guide distinguishes the optional name section from DWARF-quality debugging and notes that optimization/stripping affect it ([Rust and WebAssembly debugging](https://rustwasm.github.io/docs/book/reference/debugging.html), [Rust/Wasm code size](https://rustwasm.github.io/docs/book/reference/code-size.html)). Chrome DevTools can consume DWARF in supported toolchains ([Chrome Wasm debugging](https://developer.chrome.com/docs/devtools/wasm/)), but that does not guarantee that a customer's Sentry project will symbolize an arbitrary stripped Rust Wasm stack. Sentry's documented browser source-map flow is JS/debug-ID based ([Sentry source-map troubleshooting](https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/)).

Ferric therefore needs its own stable crash envelope:

```rust
#[repr(C)]
struct FerricPanicRecord {
    abi_version: u16,
    module_id: u16,
    panic_code: u32,
    build_id: [u8; 16],
    file_id: u32,
    line: u32,
    column: u32,
    phase: u16,      // render, schedule, commit, fizz, flight, bridge
    reserved: u16,
    fiber_id: u64,
    root_id: u64,
}

extern "C" {
    fn ferric_report_panic(ptr: *const FerricPanicRecord, len: usize);
}
```

Production uses `panic=abort`. The hook writes a fixed-size, allocation-minimal record and makes one best-effort JS import call before abort. JS throws/reports a `FerricPanicError` with tags:

```text
ferric.version
ferric.react_version
ferric.build_id
ferric.wasm_abi
ferric.module
ferric.phase
ferric.panic_code
ferric.backend = wasm | native
```

The default fingerprint is `["FerricPanic", build_id, panic_code]`. No prop values, text, DOM, URLs, event payloads, or hook values are captured. Public packages contain stripped Wasm; the release system retains an access-controlled symbol bundle keyed by build ID: unstripped Wasm, DWARF, optional name-section artifact, panic map, JS maps, Rust source revision, and toolchain manifest. `@ferric/sentry` maps the envelope to a Sentry event using documented tags/contexts/fingerprints; Sentry supports those event-enrichment mechanisms ([Sentry event enrichment](https://docs.sentry.io/platforms/javascript/enriching-events/)).

An app-developer runbook can then be deterministic:

1. Read the error class. `Minified React error #N` goes to the React decoder; `FerricPanicError` goes to Ferric crash lookup; `FerricWasmLoadError` goes to CSP/MIME/asset diagnostics.
2. Record Ferric version, upstream React version, build ID, browser/Node version, loader mode, and panic code from the envelope.
3. Reproduce once with `@ferric/*` development artifacts and source maps, then once with `FERRIC_BACKEND=upstream`.
4. If upstream also fails, follow the React/app path. If only Ferric fails, attach the sanitized envelope and minimal reproduction.
5. Roll back all `@ferric/*` packages lockstep. The published compatibility manifest identifies the exact upstream packages.

### 1.5 A pinned SHA is a campaign input, not a production support policy

The fused plan deliberately pins one React SHA and only rebases at milestone boundaries (`index.html:248-258,577-579`). That protects an eight-to-ten-week stunt. It cannot support adopters after launch.

Ferric needs a mirrored compatibility version:

```text
@ferric/react        19.2.3001
@ferric/react-dom    19.2.3001
@ferric/scheduler    19.2.3001
upstream compatible  react/react-dom 19.2.3
```

All runtime packages move in lockstep. Ferric uses a stable encoded patch, not a prerelease: `ferric_patch = upstream_patch × 1000 + ferric_revision`, so upstream `19.2.3`, Ferric revision 1 is `19.2.3001`. npm's semver implementation excludes prereleases from ordinary ranges unless the range explicitly opts into the relevant prerelease tuple ([npm `node-semver` prerelease rules](https://github.com/npm/node-semver#prerelease-tags)); therefore the clearer-looking `19.2.3-ferric.1` would fail common peers such as `react: ^19.2.0`. The encoded stable version satisfies those minor ranges and remains monotone. Exact peers such as `react: 19.2.3` still require an upstream package fix or explicit override and are surfaced by the compatibility preflight. The signed manifest is authoritative for decoding the upstream patch. Reserve revisions 1–999; an impossible 1,000th rebuild forces a new policy rather than a collision.

Each release contains:

```json
{
  "ferricVersion": "19.2.3001",
  "reactVersion": "19.2.3",
  "reactCommit": "<40-hex>",
  "oracleManifestSha256": "<64-hex>",
  "errorCodesSha256": "<64-hex>",
  "wasmAbi": 1,
  "rustToolchain": "<pinned>",
  "symbolBuildIds": ["<32-hex-client>", "<32-hex-server>"]
}
```

Service policy:

| Upstream event | Ferric target | Non-waivable gates |
|---|---:|---|
| Stable React minor | compatible Ferric train within 21 calendar days | full four-cell public oracle, Rust-aware internal leg, integration matrix, soak smoke, error-map diff |
| Stable React patch | within 10 business days | same oracle; affected fixtures and all ABI/package checks |
| Public critical security fix | compatible release within 72 hours | same oracle, focused security regression, provenance/SBOM; no “fast lane” test waiver |
| Public high security fix | within 7 calendar days | same |
| Experimental/canary | nightly observation only | no production support promise |

Planning estimate per upstream absorption:

- patch: 2–4 engineering days, **$3k P50 / $6k cap** model spend;
- minor: 1–3 weeks, **$8k P50 / $15k cap** model spend;
- major: separately approved project.

The expensive part is not applying a diff; it is rerunning and triaging the entire oracle: `262 × 4 = 1,048` public file/config executions, plus the 48-file Rust-aware source leg, packaging fixtures, and soak tests. React's build configuration specifically excludes internal tests (`scripts/jest/config.build.js:67-70`), so the source leg cannot be dropped on a release train.

Support the latest two upstream stable minor trains. Each Ferric minor receives at least 12 months of critical/security maintenance from its Ferric GA, with 90 days' public EOL notice. The older train gets security and critical compatibility fixes, not new integrations. Deprecations match the corresponding upstream release; Ferric-only entries are namespaced and receive at least one supported minor plus 90 days before removal.

Routine releases use a predictable maintenance window: the first Tuesday of each month, 16:00–20:00 UTC, announced at least seven days ahead. Ferric is a library, so this is a release/triage window rather than planned service downtime. Security releases and upstream critical patches may ship outside it. Before beta, publish `SECURITY.md`, a monitored security address, supported trains, encryption instructions, and an embargo/coordinated-disclosure procedure. Acknowledge reports within one business day and complete severity triage within three business days.

### 1.6 “Production-grade” requires applications, not only React's oracle

The following repositories have substantial, runnable JS test inventories and explicit React test tooling. Counts are static test/spec-file counts at the recorded commit, not test-case counts, computed with:

```sh
git ls-tree -r --name-only HEAD |
  rg '(^|/)(__tests__/.*|[^/]+\.(test|spec))\.(js|jsx|ts|tsx)$' |
  wc -l
```

| Soak candidate | Pinned commit | Static test files | Verified runner/tooling | Why it is useful |
|---|---|---:|---|---|
| Excalidraw | `b2e81e38a6fde8b3cb5dfdf2f2fb651323ad309d` | 116 | Vitest scripts in [`package.json`](https://github.com/excalidraw/excalidraw/blob/b2e81e38a6fde8b3cb5dfdf2f2fb651323ad309d/package.json); official testing guide uses React Testing Library ([guide](https://excalidraw-excalidraw.mintlify.app/contributing/testing)) | Browser canvas/events, hooks, large interactive SPA |
| Cal.com | `3894f37e14eae5082770f35ff1fde72110c0e6b6` | 437 | Vitest and React Testing Library in [`package.json`](https://github.com/calcom/cal.com/blob/3894f37e14eae5082770f35ff1fde72110c0e6b6/package.json) | Next application, forms, time, Suspense-heavy integration |
| Mattermost | `7bc3bbfd0c94b2a9577f40815d4fb25955c8ea38` | 1,492 | Jest and React Testing Library in [`webapp/channels/package.json`](https://github.com/mattermost/mattermost/blob/7bc3bbfd0c94b2a9577f40815d4fb25955c8ea38/webapp/channels/package.json) | Long-lived production SPA and broad Redux/component suite |
| Grafana | `1cf395351ce08f7537a5d6753a321d0534fbacc5` | 2,569 | Jest, React Testing Library, and React-version aliases in [`package.json`](https://github.com/grafana/grafana/blob/1cf395351ce08f7537a5d6753a321d0534fbacc5/package.json) | Very large plugin/component ecosystem; explicit React-version work |
| Backstage | `4956d7ffc5b091fc14b0fd29d417b2100fb4f132` | 1,708 | Jest at root and React Testing Library in [`root package.json`](https://github.com/backstage/backstage/blob/4956d7ffc5b091fc14b0fd29d417b2100fb4f132/package.json) and [`packages/app/package.json`](https://github.com/backstage/backstage/blob/4956d7ffc5b091fc14b0fd29d417b2100fb4f132/packages/app/package.json) | Monorepo, plugins, SSR-adjacent package boundaries |

Most are currently React 18-first. That is not a Ferric pass. Before entering the GA soak, each needs a maintained branch that passes on the matching stock React 19 release; only then is swapping to Ferric a valid differential test. Grafana's React aliases make it the best first candidate.

The repositories and runner/RTL declarations were verified at the pinned commits; the static counts were reproduced locally. Their complete dependency installs and multi-thousand-file suites were not executed during this panel review. The campaign must turn each into a hermetic, actually green baseline before it may count toward GA.

Every supported integration needs a small, owned, CI'd example repository in addition to the large soaks:

| Integration fixture | Runtime cells | Required CI |
|---|---|---|
| Vite 8 SPA | embedded + streaming; Chrome/Firefox/WebKit | PR smoke; nightly production build and physical Safari |
| webpack 5.83+/latest SPA | embedded + streaming | PR smoke; nightly min/max version |
| Parcel 2 current/previous | embedded; streaming; exports off/on | PR smoke; nightly production build |
| Next 15/16 Pages | webpack, Node 20/22, standalone output | nightly SSR + hydration + route transition |
| Next App Router lab | exact Next/React pin, webpack and Turbopack observed separately | nightly non-blocking until promoted |
| Node SSR | CJS + ESM, Node 20/22 | every PR |
| M9 Axum native SSR | Linux x86_64/aarch64; macOS development | every PR and release |

Next App Router/Turbopack and edge are not silently omitted: they are explicitly lab/unsupported in the first GA matrix.

### 1.7 Campaign hardware must isolate compilers, oracles, and stress tests

The fused plan expects about 24 agents but acknowledges that the reconciler is a serial spine and useful lane width is 4–6 (`index.html:485-503`). Agent count is not equivalent to 24 simultaneous Rust compiles. Provision for six heavy worktrees and four oracle cells:

| Resource | Builder/control host | Oracle/integration host |
|---|---:|---:|
| CPU | 64 physical cores / 128 threads | 64 physical cores / 128 threads |
| RAM | 256 GiB ECC minimum | 256 GiB ECC minimum |
| Local scratch | 3.5 TiB usable enterprise NVMe | 3.5 TiB usable enterprise NVMe |
| Sustained storage target | ≥100k mixed 4 KiB IOPS, ≥2 GB/s sequential, p99 read <5 ms under campaign load | same |
| Network | 25 GbE or local equivalents | 25 GbE or local equivalents |
| Use | six lane containers, cache services, Smithers control plane | four isolated oracle jobs, browsers, packaging matrix |

This is a capacity estimate, not a vendor quote. Disk model:

```text
6 isolated Cargo target dirs × 60 GiB                 360 GiB
Cargo/pnpm/Bun content-addressed caches               250 GiB
DEV/PROD × stable/experimental artifacts              300 GiB
browser/OCI images                                    150 GiB
logs, traces, snapshots, symbol bundles               250 GiB
subtotal                                             1.31 TiB
2× churn/headroom                                    2.62 TiB
provisioned                                          3.50 TiB local + 5 TiB object retention
```

Alert at 70%, throttle new compiles at 80%, halt scheduling at 90%. Keep worktree targets separate; caches may be content-addressed but must be lock-safe. Never launch cache population or toolchain installation in all lanes simultaneously.

This is evidence-backed caution. Bun's rewrite post reports that many worktrees and default cloud-disk IOPS caused filesystem freezes, and that stress tests later used cgroups to avoid taking down the machine ([Bun rewrite: disk and cgroups](https://bun.com/blog/bun-in-rust)). Linux cgroup v2 exposes CPU, memory, I/O, and process controls ([Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)).

Smithers already exposes `memoryLimit` and `cpuLimit` (`docs/components/sandbox.mdx:12-55`) and maps them to Docker `--memory`/`--cpus` (`packages/sandbox/src/effect/process-runner.js:434-473`). Its local runtimes reject those controls (`packages/sandbox/src/effect/process-runner.js:262-274`). Therefore campaign compute must use Docker/provider sandboxes, not local bubblewrap/sandbox-exec, and the host must add cgroup-v2 `pids.max` and `io.max`/`io.weight`:

| Class | CPU | Memory | PIDs | I/O policy |
|---|---:|---:|---:|---|
| normal implementation lane | 8 | 32 GiB | 4,096 | weighted, no device saturation |
| build/oracle cell | 8 | 24 GiB | 4,096 | dedicated target/cache partition |
| stress/leak test | 8 | 64 GiB | 16,384 | explicit `io.max`, never on benchmark host |
| benchmark | exclusive reserved cores | measured ceiling, no swap | bounded | exclusive disk window, no noisy neighbors |

An OOM/cgroup kill is an infrastructure result and retries once with captured metrics. The same workload failing again at the documented ceiling is a product memory defect, not an unlimited retry.

### 1.8 Approval gates need an operator SLO, not auto-approval

Smithers approval gates support timeouts and retries (`docs/components/approval-gate.mdx:9-22`), and completed work is durable across resume (`docs/how-it-works.mdx:185-200`). Automatic approval would destroy the credibility of the kill and release gates.

Use three published decision windows every day: **09:00, 14:00, and 20:00 America/New_York**. A gate packet is generated 30 minutes before the window with the diff, deterministic evidence, spend, regressions, recommendation, and exact approved side effect. The primary has 30 minutes to acknowledge; the backup is paged at 60 minutes; target decision is 2 hours. At 2 hours, the blocked lane backfills only predeclared independent queue work. The 20:00 window must clear every approval that could otherwise block the night; a missed critical window pages the on-call maintainer.

Never auto-approve M3 kill/pivot, week-6 reconciler go/no-go, release candidate, npm publish, security embargo, budget expansion, or M9 API freeze. Batch routine content/publish approvals into the windows. Track `gate_opened_at`, first acknowledgment, decision, approver, evidence hash, and wait cost. SLA target: 95% decided within 2 hours, 100% within 8 hours; a breach is a campaign-operations incident.

### 1.9 The inherited $130k cap no longer buys the stated outcome

The fused budget is explicitly **$90k P50 / $130k cap** because “Sol's canary-scale ops [are] explicitly not bought” and it is “not an enterprise GA” (`index.html:583-597`). Round 2 now requires a production adoption posture and M9. Keeping the old cap without changing the claim would be arithmetic, not de-risking.

Model-spend estimate:

| Workstream | P50 | Cap | Deliverable |
|---|---:|---:|---|
| Existing M0–M8 fused implementation/oracle | $90k | $130k | Existing campaign scope |
| Packaging, bundler, CSP, loader fixtures | $6k | $10k | npm layout, four bundlers, Next split, CSP/MIME fixtures |
| Error parity, crash envelope, symbols, Sentry adapter | $5k | $8k | production error DX |
| Upstream-train automation + first absorption rehearsal | $7k | $12k | compatible release process |
| Five soaks, bring-your-app beta, docs/runbooks | $10k | $16k | adoption proof and GA evidence |
| Release/security/support operations | $7k | $12k | disclosure, provenance, maintenance tooling |
| **Production-posture subtotal** | **$35k** | **$58k** |  |
| M9 typed component/hook API + `rsx!` macro | $12k | $18k | ergonomic Rust authoring core |
| M9 mixed JS/Rust fiber + closure/handle ABI | $10k | $16k | one-tree interop |
| M9 native SSR + Axum + Cargo distribution | $8k | $12k | no-Node server path |
| M9 conformance ledger, examples, docs | $10k | $16k | dual-API evidence |
| **M9 subtotal** | **$40k** | **$62k** |  |
| **Revised model spend** | **$165k** | **$250k** | M0–M9 plus production GA posture |

The estimates assume M9 is a final, bounded milestone: typed components; `rsx!`; Rust closures; core stable hooks; mixed JS/Rust components in one fiber tree; native Fizz SSR and an Axum example; Cargo crates; and a public coverage ledger. “Every public React API in Rust” is the long-term direction, not an M9 completion claim. RSC authoring, custom renderers, React Native, compiler integration, and every unstable/canary hook are follow-on work unless separately budgeted.

Non-model cash is separate:

| Cash item | P50 | Cap |
|---|---:|---:|
| Linux/Mac CI, physical mobile/browser lab, storage, egress | $25k | $45k |
| Human operator, release/security ownership, beta support (roughly 0.75 FTE over 16–20 weeks) | $75k | $125k |
| **Total non-model** | **$100k** | **$170k** |
| **All-in program** | **$265k** | **$420k** |

These are planning allowances, not salary or cloud quotes. Procurement must replace them before launch.

### 1.10 The M9 budget assumes three explicit distribution modes, not one magical runtime

M9 should publish a Cargo facade plus owning crates:

```text
ferric-react          components, typed hooks, Context, Callback, re-exports
ferric-react-macros   rsx! and derive/proc macros
ferric-react-dom      browser/Wasm mounting and JS interop
ferric-react-ssr      native Fizz-compatible streaming renderer and Axum adapter
ferric-react-core     private/common fiber, lanes, scheduler, protocol types
```

The public entry is `ferric-react`; users add the renderer crate for browser or server use. Cargo versions are lockstep with the npm compatibility train and the crates embed the same upstream-compatibility/build manifest.

The modes have different, non-combinable guarantees:

| Mode | Authoring | Runtime | JS components in tree | Rust event closures | Node required |
|---|---|---|---|---|---|
| TypeScript drop-in | JS/TS JSX | browser Wasm or Node/native SSR facade | yes | no | browser no; current JS SSR facade yes |
| Rust browser/mixed | `rsx!` + typed hooks, exported as a JS component boundary | browser Wasm plus JS DOM/event shell | yes, one fiber tree | yes, invoked by the existing JS delegation layer through a generational Rust callback handle | no |
| Pure-Rust SSR | `rsx!` + Rust components only | native `ferric-react-ssr`, e.g. Axum | **no JS component execution** | not applicable during SSR | no |

The last constraint is fundamental, not a missing adapter: a server process with no JS engine cannot execute a JS component. Marketing may say “pure-Rust SSR with no Node” only for an all-Rust server component tree. A mixed JS/Rust server tree needs a JS host and is a separate mode.

M9's Rust API allowlist is typed function components; props; fragments; keys; `rsx!`; Rust closures; context; and stable core hooks equivalent to `useState`, `useReducer`, `useEffect`, `useLayoutEffect`, `useMemo`, `useCallback`, `useRef`, `useContext`, `useTransition`, `useDeferredValue`, and `useId`. Its completion artifact is a generated dual-API ledger:

```text
upstream API | TS entry/test cohort | Rust symbol | Rust semantic cohort | status
```

Each Rust API must drive the same Rust core and be judged by observable React semantics: output/SSR bytes, scheduler yield trace, effect order, warning/error string, and mixed-tree lifecycle. Add compile-pass/compile-fail tests for hook types and `rsx!`, property tests for macro output, callback stale-generation traps, a mixed JS-parent/Rust-child/JS-grandchild fixture, and pure-native SSR byte/differential fixtures. An absent row is `unsupported`, never “implicitly covered.” This scope explains the $40k/$62k M9 allowance; completing the long-term “every public React API” ledger is not inside it.

## 2. DECISIONS

| Question | Decision | Why | Evidence that settled it |
|---|---|---|---|
| Default browser loading | Embedded synchronous decoded Wasm, with a hard 7.5 MiB decoded client limit | Preserves synchronous React imports and works with current Safari; 7.5 MiB leaves headroom under Chrome's 8 MiB main-thread limit | Chromium source and Chrome 115 note; WebKit TLA bug |
| Streaming loading | Export `@ferric/react-dom/streaming` as ESM-only opt-in using static `new URL`, TLA, `instantiateStreaming`, and MIME fallback | Fastest cold path where supported, without making all consumers async | MDN streaming contract; Vite/webpack/Parcel asset docs |
| Node/Jest loading | Adjacent raw `.wasm`, synchronous compile/cache of immutable module, fresh mutable instance per module registry | Node has no observed Chrome limit; Jest reset and fake timers require fresh state and dynamic timer lookup | Local Node probe; React Jest config; Jest reset docs |
| CJS | Ship real CJS facades and embedded browser CJS; do not fake CJS with async import | React ecosystem and Jest still consume CJS; a promise-returning facade is not API-identical | React's published package structure at `packages/react-dom/package.json:25-125` |
| Vite | Default and streaming supported with no Ferric config after fixture | Vite handles static asset URLs and documents Wasm/MIME behavior | Vite official docs |
| webpack | Support 5.83+; no Wasm experiment flag because Ferric uses the JS API and asset URL | Asset modules handle URL; TLA default floor is explicit | webpack official docs |
| Parcel | Physical facades make default zero-config; document one resolver line for exports-only behavior | Parcel package exports are disabled by default | Parcel official resolver docs |
| Next Pages | Next 15 webpack and Next 16 `--webpack` are the certified paths; Node 20/22 | It is testable without taking ownership of Turbopack internals | Next 16/Turbopack docs |
| Next App Router | Lab, not first-GA support; exact Next/React pin; no zero-config claim | App Router uses Next's React canary and current Wasm asset bugs exist | Next install docs and issue 83046 |
| Edge/workerd | Unsupported in v1 generic package | Runtime forbids dynamic Wasm compilation; it needs a build-time module adapter | Next Edge docs |
| CSP | Require `'wasm-unsafe-eval'`; never recommend `'unsafe-eval'`; Safari 26 strict-CSP floor | All Wasm compilation sinks are gated; embedding cannot bypass | CSP3, MDN, WebKit |
| Upstream versions | Lockstep encoded stable patch (`19.2.3001` = upstream 19.2.3, Ferric r1), 21-day minor / 10-business-day patch SLA, 72-hour critical-security SLA | Machine-readable compatibility without prerelease peer-range failures | npm semver prerelease rule; React oracle shape; fused plan's pinned-SHA limitation |
| Error parity | Generate Rust error table from upstream; zero `extract-errors` diff | This is the only way to preserve React decoder behavior exactly | React error-code scripts and formatter |
| Rust panics | Structured Ferric panic envelope plus private build-ID symbol store; optional Sentry adapter | Raw Wasm stacks are not a portable production symbolication contract | Rust panic hook, Rust/Wasm debug docs, Sentry docs |
| GA integrations | Vite, webpack, Parcel, Next Pages, Node SSR; App Router and edge explicitly not GA | Covers adoptable mainstream paths without misrepresenting unsupported loaders | Bundler/framework evidence above |
| Bring-your-app beta | 20 apps, 200 app-days, opt-in sanitized telemetry, rollback path, 14-day follow-up | React's oracle cannot expose arbitrary framework/plugin assumptions | Five verified soak inventories plus fused plan's ecosystem-risk admission |
| Compute | Two isolated high-IOPS hosts; Docker/provider cgroups; six heavy lanes, four oracle cells | The workload is disk/compile heavy and local Smithers runtimes do not enforce CPU/RAM caps | Bun incident, Linux cgroups, Smithers source |
| Approval SLA | Three daily windows, primary/backup/on-call, no autoapproval | Durable gates prevent lost work but do not make a human timely | Smithers approval/resume docs |
| M9 distribution | Cargo facade over macro, browser, SSR, and shared-core crates; distinguish mixed browser from all-Rust native SSR | No-JS native SSR cannot execute a JS component; mixed-tree and pure-Rust claims need separate conformance rows | Runtime boundary and scoped cost model above |
| Budget | Raise model cap to $250k and all-in planning cap to $420k | Production posture and M9 add $75k P50 model work that fused plan explicitly excluded | Fused budget text plus itemized estimate |
| Old-cap contingency | At $130k, ship M0–M8 as an RC/stunt; do not claim production GA or Rust-native M9 | Conformance, security, release train, and rollback are not safe cut candidates | Scope arithmetic |

## 3. RISKS

| Residual risk | Mitigation | Kill / downgrade criterion |
|---|---|---|
| Optimized client Wasm exceeds Chrome sync ceiling | Split client/server; `wasm-opt`; eliminate unused feature paths; measure decoded bytes in CI | >7.5 MiB after two protocol/size passes: stop browser-GA claim and choose streaming bootstrap with a higher Safari floor, or pivot client to SSR-first |
| Embedded base64 erases cold-start/size credibility | Benchmark base64 vs integer-array representation; publish gzip/brotli, decode peak, compile, first render | Default cold p95 >1.10× upstream or route bytes >campaign 1.75× gate: no performance/parity claim; if adoption gate also fails, keep streaming-only beta |
| Safari TLA/loader defects persist | Embedded default; physical iOS matrix; streaming feature flag | Any hang across 10,000 repeated import/navigation cycles: streaming remains disabled for that Safari train |
| Strict CSP is unacceptable to customer | Clear installer preflight; startup diagnostic; upstream rollback; native SSR | Customer cannot add `'wasm-unsafe-eval'`: client deployment is unsupported, never suggest `'unsafe-eval'` |
| Bundler docs do not equal a real Ferric package | Pack the actual npm tarball and install it into owned fixtures from an offline registry | Any supported cell needs an undocumented patch/plugin: remove “zero config”; unresolved at RC means beta/unsupported |
| Next App Router consumes incompatible React internals | Lab fixture pinned to exact Next/React; coordinate upstream rather than patching app output | Cannot run stock create-next-app build/hydration without maintained fork: exclude from GA |
| `jest.resetModules` exposes stale Wasm singleton/timers | Immutable-module/mutable-instance split; current-realm timer trampolines; stale-generation traps | Any reset/timer differential failure blocks M2 and all downstream conformance claims |
| Exact React peers or tooling misread the encoded patch | Test npm/pnpm/Yarn/Bun alias/override workflows; signed compatibility manifest; preflight diagnostics | More than 5% of beta apps require `--force` or unexplained peer suppression: redesign distribution before GA |
| Upstream minor costs exceed train allowance | Diff classifier; generated queue; reserve monthly budget; support only two trains | Two consecutive minors exceed 21 days or $15k: stop onboarding new production users and publish maintenance incident |
| Panic reports are unsymbolic/noisy | Stable panic codes, private symbol store, build IDs, fingerprinting, source artifact retention | >5% of beta crashes lack build ID/panic code or cannot map to a release: no GA |
| Telemetry leaks app data | Fixed schema; no arbitrary strings; privacy review; opt-in; local dump alternative | Any prop/text/DOM/event/user-data field observed: disable collection, notify cohort, security review |
| Soak candidates are React-18 green but React-19 red | Establish stock React-19 branch before Ferric swap | No stock-green baseline means candidate does not count toward GA |
| Oracle runtime overwhelms release cadence | M0 real build-mode benchmark; split four cells; dedicated cache and host | Release gate >90 min p95 for three runs or flaky infra >1%: freeze new lane count and fix CI before campaign |
| Disk saturation freezes all lanes | Enterprise local NVMe, utilization thresholds, I/O cgroups, stagger installs | p99 read >20 ms for 5 minutes or disk >90%: stop scheduling; repeated event triggers capacity expansion |
| Stress test kills control plane | Separate host/cgroup; no swap; explicit PIDs/I/O limits | Any stress job impacts Smithers DB/heartbeat or benchmark host: infrastructure incident and test invalid |
| Approval gate stalls overnight | 09:00/14:00/20:00 windows, primary/backup/on-call, independent-work backfill | >8-hour gate wait or missed 20:00 critical window: ops incident; no overnight campaign until staffing fixed |
| Budget cap reached before GA/M9 | Spend gates at M3, 50% M4, M8 RC, M9 API freeze | $250k model cap or $200k before M8 green: stop; do not borrow from security/oracle |
| M9 expands to “all React APIs now” | Coverage ledger and explicit milestone allowlist | Core M9 estimate exceeds $62k cap: defer long-tail hooks/RSC/custom renderer; keep dual-tree ABI and native SSR, or do not claim M9 complete |

If the cap is approached, cut in this order:

1. Next App Router/Turbopack and edge promotion work; retain explicit unsupported status.
2. Extra benchmark polish, marketing adapters, and beta cohort above 20.
3. M9 long-tail APIs: RSC authoring, unstable hooks, custom-renderer ergonomics, non-core framework adapters.
4. Extended platform breadth beyond Linux x86_64/aarch64 and macOS development for native SSR.

Never cut the React oracle, `REACT_RUST_ASSERT_BACKEND`, byte-identical errors/warnings, CSP/load diagnostics, security response, rollback artifacts, five owned integration fixtures, or the upstream release train. If those do not fit, the deliverable is an RC/stunt, not GA.

## 4. SPEC TEXT

The following sections are ready to lift into the campaign specification.

### Packaging and loader contract

> Ferric SHALL publish lockstep `@ferric/*` npm packages whose public entry points and TypeScript declarations are mechanically diffed against the selected upstream React release. `@ferric/react-dom` SHALL include real ESM and CJS facades for every upstream public entry, an embedded browser client artifact, adjacent raw client/server `.wasm` files, and a `ferric-build.json` compatibility manifest.
>
> The default browser entry SHALL synchronously decode and instantiate an embedded client Wasm artifact. Its decoded wire size SHALL be at most 7.5 MiB. The default SHALL perform no network request and SHALL preserve React's synchronous import/API behavior.
>
> `@ferric/react-dom/streaming` SHALL be an ESM-only opt-in. It SHALL resolve the raw artifact with a static `new URL("./wasm/ferric-client.wasm", import.meta.url)`, use top-level `await`, check `response.ok`, try `WebAssembly.instantiateStreaming`, and fall back to `response.arrayBuffer()` plus `WebAssembly.instantiate` when streaming fails because of MIME/implementation behavior. It SHALL report URL, status, content type, build ID, and loader mode in `FerricWasmLoadError`.
>
> Node ESM and CJS entries SHALL synchronously read the adjacent raw artifact. They MAY cache the immutable `WebAssembly.Module`; they SHALL create a fresh mutable `WebAssembly.Instance`, handle table, scheduler state, and root registry for each JS module instance.
>
> The published tarball SHALL be installed, not symlinked, into production-build fixtures for Vite, webpack, Parcel, Next Pages, and Node. A documentation claim of bundler support SHALL NOT substitute for a packed-tarball fixture.

### Bundler and framework support

> First GA SHALL support:
>
> - Vite 8 SPA: embedded and streaming entries;
> - webpack 5.83 through current: embedded and streaming entries;
> - Parcel 2 current and previous: embedded entry with exports disabled and enabled; streaming remains beta until its min/current fixtures pass;
> - Next 15 Pages Router on webpack and Next 16 Pages Router with documented `--webpack`, Node 20 and 22;
> - direct Node 20 and 22 SSR in both CJS and ESM;
> - M9 native Axum SSR on Linux x86_64/aarch64, with macOS as a development target.
>
> Next App Router/Turbopack SHALL be labeled lab/unsupported until an unmodified create-next-app fixture, pinned to a declared Next/React pair, passes build, SSR, hydration, Suspense, route transitions, standalone output, and production soak. Edge/workerd SHALL be unsupported until Ferric ships a build-time `WebAssembly.Module` adapter; dynamic compilation SHALL NOT be attempted there.
>
> “Zero config” SHALL mean that the default `@ferric/react-dom/client` entry builds and runs in the owned Vite, webpack, and Parcel SPA fixtures without Ferric-specific bundler configuration. It SHALL NOT imply no CSP change, universal streaming, App Router support, edge support, or absence of Next 16's documented `--webpack` flag.

### Wasm, Safari, MIME, and CSP gates

> The client release SHALL fail if decoded Wasm exceeds 7.5 MiB. CI SHALL record decoded bytes, base64 bytes, gzip/brotli bytes, decode time, compile time, instantiation time, peak startup memory, and first-render p50/p95.
>
> Streaming hosting SHALL serve `.wasm` as `application/wasm`. The array-buffer fallback SHALL be tested against a deliberately wrong MIME type. A CSP failure SHALL remain distinguishable from a MIME or 404 failure.
>
> Current Safari/iOS SHALL use embedded mode by default. Streaming SHALL remain opt-in on Safari 26. Safari 27 SHALL be promoted only after stable release and 10,000 repeated import/navigation iterations pass on physical iPhone and iPad hardware.
>
> Client deployments under CSP SHALL require `script-src 'wasm-unsafe-eval'`. Streaming deployments SHALL additionally permit the artifact origin in `connect-src`. Ferric SHALL NOT recommend `'unsafe-eval'`. Encoding, blob/data URLs, workers, and array buffers SHALL NOT be described as CSP bypasses. Sites that prohibit Wasm compilation SHALL use upstream React or native Ferric SSR/static output.

### Jest reset and timer contract

> React's build-mode oracle SHALL run with upstream Jest configuration unchanged. Ferric SHALL treat a compiled `WebAssembly.Module` as immutable cacheable code and a `WebAssembly.Instance` as module-registry-scoped mutable state.
>
> `jest.resetModules()` followed by a fresh import SHALL create fresh roots, fibers, handles, lanes, scheduler state, and bridge tables. References from the prior generation SHALL trap in DEV and SHALL never resolve into the new generation.
>
> Scheduler imports SHALL resolve the current realm's clock, timer, and message-channel functions at call time through JS trampolines. Ferric SHALL NOT capture real timer functions before Jest installs legacy fake timers.
>
> A dedicated oracle cohort SHALL alternate real timers, legacy fake timers, reset, re-import, schedule, flush, cancel, and unmount. Any differential trace failure blocks M2.

### Versioning and upstream maintenance

> All Ferric runtime npm and Cargo packages SHALL ship in a lockstep release. Versions SHALL use the stable encoded patch `upstream_patch × 1000 + ferric_revision`; for example, upstream React 19.2.3 at Ferric revision 1 is `19.2.3001`. Revisions 1–999 SHALL be reserved per upstream patch. Every release SHALL contain a signed compatibility manifest with Ferric version, upstream React version and commit, oracle-manifest hash, error-code hash, Wasm ABI, Rust toolchain, and symbol build IDs.
>
> Ferric SHALL publish support for a stable React minor within 21 calendar days and a patch within 10 business days. A public critical upstream security fix SHALL receive a Ferric-compatible release within 72 hours; a high-severity fix within seven calendar days. The fast lane SHALL not waive any oracle cell.
>
> Each absorption SHALL run the four public build-mode cells, the Rust-aware internal source leg, the import/backend audit, error-code extraction diff, package fixtures, and soak smoke tests. Experimental/canary React SHALL be observed nightly but SHALL carry no production SLA.
>
> Ferric SHALL support the latest two upstream stable minor trains. Each train SHALL receive at least 12 months of critical/security maintenance after its Ferric GA and 90 days' EOL notice. Ferric-only API deprecations SHALL receive at least one supported minor plus 90 days.

### Production errors, panic reporting, and Sentry

> Ferric SHALL generate its Rust production-error table from upstream `scripts/error-codes/codes.json`. Existing React IDs, message templates, URL, encoding, and argument order SHALL be byte-identical. A full candidate build followed by upstream `yarn extract-errors` SHALL produce no diff.
>
> Rust semantic failures SHALL return typed results and map to upstream React errors where applicable. Rust panics SHALL represent Ferric defects and SHALL use a separate Ferric panic-code namespace.
>
> Production Wasm SHALL install an allocation-minimal panic hook that records ABI version, module, panic code, build ID, source file ID and location, phase, fiber ID, and root ID, then invokes one best-effort JS reporter before abort. The reporter SHALL construct `FerricPanicError` and SHALL expose Ferric/upstream versions, build ID, ABI, module, phase, panic code, and backend. It SHALL NOT collect prop values, hook values, DOM, text, event payloads, URLs, or user identifiers.
>
> Every release SHALL retain an access-controlled symbol bundle keyed by build ID: unstripped Wasm/native binary, DWARF/native symbols, panic map, JS maps, source revision, and toolchain manifest. Symbol retention SHALL be at least the support lifetime plus 12 months.
>
> `@ferric/sentry` SHALL be optional. It SHALL tag and fingerprint structured Ferric errors; it SHALL NOT assume that Sentry can symbolize arbitrary stripped Wasm without Ferric's build-ID service.

### Supported integrations and soak program

> Every GA integration cell SHALL have an owned example repository that installs the packed release artifact and runs production build, SSR where applicable, hydration, effects, events, Suspense, error boundaries, route transitions, unmount, and rollback. Current and previous supported versions SHALL run nightly; direct Node CJS/ESM SHALL run on every PR.
>
> The ecosystem soak SHALL include maintained React-19 baseline branches for Excalidraw, Cal.com, Mattermost, Grafana, and Backstage. A soak counts only when the same commit passes first on the matching upstream React version and then on Ferric. Test edits, skips, and snapshots SHALL be reviewed as candidate changes and SHALL not silently reduce the denominator.

### M9 Rust-native API and distribution

> M9 SHALL publish `ferric-react` as the public Cargo facade, with `ferric-react-macros`, `ferric-react-dom`, `ferric-react-ssr`, and a non-public/shared `ferric-react-core` as owning crates. Crate and npm releases SHALL be lockstep and SHALL embed the same upstream React compatibility, Wasm ABI, source revision, and build IDs.
>
> M9 SHALL support three separately documented modes: TypeScript drop-in; Rust-authored browser components mixed with JS components in one fiber tree; and pure-Rust native SSR. Browser Rust event closures SHALL be retained in a generational Rust callback table and invoked by the existing JS DOM event delegation layer. A stale callback generation SHALL trap in DEV and SHALL be ignored/reported safely in production.
>
> “Pure-Rust SSR with no Node” SHALL mean that every server-executed component is Rust-authored. Ferric SHALL NOT claim that a no-JS server can execute a mixed JS/Rust server tree. Mixed browser composition and all-Rust native SSR SHALL have separate examples, conformance rows, and support statements.
>
> The M9 allowlist SHALL include typed function components and props, fragments, keys, `rsx!`, Rust closures, context, and typed equivalents of `useState`, `useReducer`, `useEffect`, `useLayoutEffect`, `useMemo`, `useCallback`, `useRef`, `useContext`, `useTransition`, `useDeferredValue`, and `useId`. RSC authoring, custom-renderer ergonomics, unstable/canary hooks, React Native, and compiler integration SHALL remain follow-on scope unless separately approved.
>
> A generated dual-API ledger SHALL map every selected upstream public API to its TypeScript entry/cohort, Rust symbol/cohort, and status. Rust conformance SHALL compare output/SSR bytes, scheduler trace, effect order, warnings/errors, and lifecycle through the same Rust core. It SHALL include macro compile-pass/compile-fail tests, macro property tests, callback lifetime traps, a JS-parent/Rust-child/JS-grandchild fixture, and native Axum streaming SSR fixtures. Missing rows SHALL be labeled unsupported.

### Bring-your-app beta and GA exit

> Ferric SHALL run one public bring-your-app intake week followed by 14 days of observation. Entry requires: a reproducible stock-React-19-green branch; install/build/test instructions runnable in 60 minutes; an owner available for triage; a lockstep rollback alias or lockfile; no regulated data in the reproduction; and explicit consent for the fixed telemetry schema.
>
> Admit at least 20 applications across Vite, webpack, Parcel, Next Pages, and direct SSR. Telemetry SHALL be opt-in and SHALL contain only versions/platform, loader/backend, load/compile timings, memory counters, bridge counters, panic code, and build ID. It SHALL contain no application strings or values. A local export SHALL exist for participants who decline transmission.
>
> Severity targets: P0 acknowledgment 15 minutes and mitigation four hours; P1 acknowledgment four hours and fix two business days; P2 next train. Every participant SHALL prove rollback in under 15 minutes before counting.
>
> GA requires all of:
>
> - 20 distinct applications and at least 200 aggregate app-days;
> - at least 99.95% Ferric-crash-free sessions;
> - zero unresolved P0/P1 defects;
> - zero rollback-worthy Ferric defects for seven consecutive days;
> - five named soak suites green against stock React and Ferric;
> - the supported integration matrix green for three consecutive nightly runs;
> - error lookup, CSP/MIME, rollback, Sentry, and security runbooks exercised by someone outside the core team.

### Security and support

> Before public beta, Ferric SHALL publish `SECURITY.md`, a monitored security contact, supported versions, encryption/embargo procedure, and coordinated-disclosure policy. Reports SHALL be acknowledged within one business day and severity-triaged within three business days. Public critical upstream fixes SHALL ship within 72 hours and high fixes within seven calendar days.
>
> Routine releases SHALL use the first Tuesday of each month, 16:00–20:00 UTC, with at least seven days' notice. This is a release and staffed-triage window, not planned application downtime. Security and critical upstream releases MAY ship outside the routine window.
>
> Each release SHALL publish checksums, SBOM, provenance, upstream compatibility manifest, and rollback coordinates. Dependency scanning SHALL run weekly. The upstream absorption workflow and emergency release path SHALL be rehearsed monthly even when React has no release.

### Campaign compute and I/O isolation

> The campaign SHALL use separate builder/control and oracle/integration hosts. Each SHALL provide at least 64 physical cores, 256 GiB RAM, and 3.5 TiB usable enterprise local NVMe capable of at least 100k sustained mixed 4 KiB IOPS, 2 GB/s sequential throughput, and p99 read latency below 5 ms under the campaign load.
>
> Disk alerts SHALL fire at 70% utilization; new compile scheduling SHALL throttle at 80%; scheduling SHALL halt at 90%. Rust target directories SHALL be worktree-local. Shared package/toolchain caches SHALL be content-addressed and lock-safe. Toolchain/cache warmups SHALL be staggered.
>
> Heavy work SHALL run in Docker/provider sandboxes under cgroup v2. Normal lanes SHALL be limited to 8 CPU, 32 GiB, and 4,096 PIDs; oracle cells to 8 CPU, 24 GiB, and 4,096 PIDs; stress jobs to 8 CPU, 64 GiB, and 16,384 PIDs plus explicit I/O caps. Stress/leak tests SHALL never share the benchmark or control-plane host. Benchmarks SHALL receive exclusive reserved cores and an exclusive disk window.
>
> M0 SHALL time the real stock build-mode oracle on the selected Linux host and replace planning estimates. Release oracle SLO SHALL be 90 minutes including builds and one infrastructure retry. Three consecutive p95 breaches SHALL block new lane scheduling until CI capacity or test partitioning is corrected.

### Human approval service level

> Approval decision windows SHALL occur daily at 09:00, 14:00, and 20:00 America/New_York. The workflow SHALL generate an evidence packet 30 minutes before each window. The primary SHALL acknowledge within 30 minutes, the backup SHALL be paged at 60 minutes, and the decision target SHALL be two hours. At two hours, blocked lanes MAY backfill only predeclared independent queue work.
>
> M3 pivot/kill, week-6 reconciler go/no-go, release candidate, npm/Cargo publish, security embargo, budget expansion, and M9 API freeze SHALL never auto-approve. The 20:00 window SHALL decide every gate capable of blocking overnight work. Approval events SHALL record timestamps, approver, evidence hash, decision, and wait cost.
>
> Approval SLO SHALL be 95% within two hours and 100% within eight hours. An eight-hour breach or missed critical 20:00 window SHALL be a campaign-operations incident.

### Budget and cap behavior

> The campaign model-spend budget SHALL be $165k P50 with a $250k hard cap: $90k/$130k for inherited M0–M8, $35k/$58k for production posture, and $40k/$62k for bounded M9. Non-model infrastructure and human support SHALL carry a separate $100k P50/$170k cap, for an all-in planning envelope of $265k P50/$420k cap.
>
> Spend gates SHALL occur at M3, 50% of M4, M8 release candidate, and M9 API freeze. Crossing $250k model spend, or $200k before M8 is green, SHALL stop the workflow for explicit rescoping.
>
> Cap cuts SHALL occur in this order: App Router/Turbopack/edge promotion; extra beta seats and marketing adapters; M9 RSC/unstable/custom-renderer long tail; extended native platform breadth. The React oracle, backend assertion, error parity, security response, release train, rollback, and owned GA fixtures SHALL not be cut. If they do not fit, Ferric SHALL ship as an RC/marketing artifact and SHALL not claim production GA.
