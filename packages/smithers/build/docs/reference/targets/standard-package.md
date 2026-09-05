---
title: "Example: build and check a package"
description: "A repository-owned function that declares build, test, lint, formatting, and documentation targets."
---

`buildAndCheckPackage` is example code you can copy into `package-targets.ts` in
your repository. It is not exported by `@smthrs/targets`.

This example expects `src/`, `test/`, `tsconfig.json`, `tsconfig.test.json`,
`vitest.config.ts`, `eslint.config.js`, `dprint.json`, `README.md`, and a circular
dependency check at `scripts/circular.mjs`. Change the defaults to match your
project, or omit checks you do not use. The build emits ESM; configure the
TypeScript project to write to `dist/esm`.

## Define the helper

```ts
import { DocsParity } from "@smthrs/targets/DocsParity";
import { Dprint } from "@smthrs/targets/Dprint";
import { EsLint } from "@smthrs/targets/EsLint";
import { Filegroup } from "@smthrs/targets/Filegroup";
import * as Input from "@smthrs/targets/Input";
import { entrypoint, NodeTest } from "@smthrs/targets/NodeTest";
import type * as PackageManager from "@smthrs/targets/PackageManager";
import type * as Target from "@smthrs/targets/Target";
import { TsBuild } from "@smthrs/targets/TsBuild";
import { Typecheck } from "@smthrs/targets/Typecheck";
import { Vitest } from "@smthrs/targets/Vitest";
export interface Options {
    readonly packageManager?: PackageManager.PackageManager | undefined;
    readonly deps?: ReadonlyArray<Target.AnyTarget> | undefined;
    readonly cwd?: string | undefined;
    readonly sources?: Input.Glob | undefined;
    readonly tests?: Input.Glob | undefined;
    readonly tsconfig?: Input.File | undefined;
    readonly testTsconfig?: Input.File | undefined;
    readonly vitestConfig?: Input.File | null | undefined;
    readonly eslintConfigs?: ReadonlyArray<Input.File> | undefined;
    readonly dprintConfig?: Input.File | undefined;
    readonly readme?: Input.File | undefined;
    readonly buildProgram?: Input.File | undefined;
    readonly circularScript?: Input.File | undefined;
}
export interface PackageTargets {
    readonly lib: ReturnType<typeof TsBuild>;
    readonly check: ReturnType<typeof Typecheck>;
    readonly test: ReturnType<typeof Vitest>;
    readonly lint: ReturnType<typeof EsLint>;
    readonly fmt: ReturnType<typeof Dprint>;
    readonly docs: ReturnType<typeof DocsParity>;
    readonly circular: ReturnType<typeof NodeTest>;
    readonly docsFiles: ReturnType<typeof Filegroup>;
}
export const buildAndCheckPackage = (options: Options): PackageTargets => {
    const cwd = options.cwd ?? ".";
    const deps = options.deps ?? [];
    const sources = options.sources ?? Input.glob("src/**/*.ts");
    const tests = options.tests ?? Input.glob("test/**/*.test.ts");
    const tsconfig = options.tsconfig ?? Input.file("tsconfig.json");
    const testTsconfig = options.testTsconfig ?? Input.file("tsconfig.test.json");
    const vitestConfig = options.vitestConfig === undefined
        ? Input.file("vitest.config.ts")
        : options.vitestConfig;
    const eslintConfigs = options.eslintConfigs ?? [
        Input.file("eslint.config.js")
    ];
    const dprintConfig = options.dprintConfig ?? Input.file("dprint.json");
    const lib = TsBuild({
        ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
        srcs: [sources],
        entries: [Input.file("src/index.ts")],
        deps,
        tsconfig,
        tool: options.buildProgram === undefined ? { name: "tsc" } : { name: "program", entry: options.buildProgram },
        format: "esm",
        outDir: "dist",
        cwd
    });
    const check = Typecheck({
        ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
        srcs: [sources, Input.glob("test/**/*.ts")],
        deps: [lib, ...deps],
        tsconfig: testTsconfig,
        buildMode: false,
        incremental: false,
        cwd
    });
    const test = Vitest({
        ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
        tests: [tests],
        sources: [sources],
        deps: [lib, ...deps],
        config: vitestConfig,
        environment: "node",
        passWithNoTests: false,
        cwd
    });
    const lint = EsLint({
        ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
        sources: [sources],
        deps: [],
        configs: eslintConfigs,
        maxWarnings: 0,
        fix: false,
        cwd
    });
    const fmt = Dprint({
        ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
        sources: [sources, Input.glob("test/**/*.ts")],
        deps: [],
        config: dprintConfig,
        fix: false,
        cwd
    });
    const readme = options.readme ?? Input.file("README.md");
    const docs = DocsParity({
        readme,
        deps: [],
        cwd
    });
    const docsFiles = Filegroup({
        srcs: [Input.glob("docs/**/*.md"), readme, Input.file("package.json")],
        cwd
    });
    const circular = NodeTest({
        ...(options.packageManager === undefined ? {} : { runtime: options.packageManager.runtime }),
        runner: entrypoint(options.circularScript ?? Input.file("scripts/circular.mjs")),
        srcs: [sources, tsconfig],
        deps: [],
        cwd
    });
    return { lib, check, test, lint, fmt, docs, circular, docsFiles };
};
```

## Use it

```ts
import { Smithers } from "@smthrs/targets"
import { buildAndCheckPackage } from "./package-targets.ts"

const targets = buildAndCheckPackage({ cwd: "packages/core" })
export const Package = Smithers.Package({ targets })
```

Each returned target has its own label, inputs, dependencies, and execution.
The helper itself does not run a command. Tools use the package manager and
runtime declared in `WORKSPACE.ts` unless you override them.

See [Writing macros](../../extending/writing-macros.md) and
[Default targets](../../extending/default-rules.md).
