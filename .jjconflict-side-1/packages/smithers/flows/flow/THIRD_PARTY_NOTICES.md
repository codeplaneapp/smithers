# Third-party notices

This distribution contains third-party software. The notices below are
reproduced to satisfy the terms of the licenses those components are
distributed under. They are in addition to, and do not replace, the project's
own `LICENSE`.

## Effect (`Effect-TS/effect`)

`@smthrs/flow` carries the flow-authoring half of a fork of Effect's unstable
durable-flow runtime and
contains substantial portions of that source. The fork point, upstream package
version, and a module-by-module record of what was vendored and how it was
changed are documented in `packages/smithers/flows/engine/VENDOR.md`:

- Upstream repository: `Effect-TS/effect`
- Upstream commit: `23e176a4f05ed3e81cc13a5d70111099692ea9a5`
- Upstream package: `effect@4.0.0-beta.102`
- Upstream source: `packages/effect/src/unstable/workflow`
- Vendored modules: `Flow.ts`, `Activity.ts`, `FlowEngine.ts`,
  `DurableClock.ts`, `DurableDeferred.ts`, `DurableQueue.ts`, `FlowProxy.ts`,
  `FlowProxyServer.ts`, and `index.ts`

Effect is distributed under the MIT License. Its copyright and permission
notice is reproduced here verbatim:

```
MIT License

Copyright (c) 2023 Effectful Technologies Inc

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Every `@smthrs/*` package also depends on Effect at runtime, so the notice
above applies to those dependencies as well as to the vendored engine source.
