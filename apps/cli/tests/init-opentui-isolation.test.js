import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(fileURLToPath(import.meta.url), "../../src");

// A static ESM import of the OpenTUI native binding on the eager CLI startup
// path (initCeremony.js → init-command.js → index.js) makes EVERY smithers
// command crash on a platform where the dylib fails to dlopen — the shipped
// regression fixed in e58a8e59af. The render layer (interactiveInitUi.tsx) must
// load via dynamic import() only. CI loads the binding fine, so only a source
// scan can guard this; the modules below are the whole startup chain into init.
const STARTUP_MODULES = ["init/interactiveInit.tsx", "initCeremony.js", "init-command.js"];

test("no static @opentui import on the eager CLI startup path", () => {
    for (const rel of STARTUP_MODULES) {
        const src = readFileSync(resolve(SRC, rel), "utf8");
        // Matches `from "@opentui...` / `from '@opentui...`, which excludes
        // type-position `typeof import("...")` annotations (erased at compile
        // time) — those are harmless.
        expect(src).not.toMatch(/from\s+["']@opentui/);
    }
});

test("interactiveInit references the OpenTUI render layer only via dynamic import", () => {
    const src = readFileSync(resolve(SRC, "init/interactiveInit.tsx"), "utf8");
    // The render layer must be reached through a dynamic import().
    expect(src).toMatch(/import\(["']\.\/interactiveInitUi\.js["']\)/);
    // ...and never through a static value import (a type-only `typeof import`
    // annotation starts with `let`/`:` and is not matched here).
    expect(src).not.toMatch(/^\s*import\s+[\w{][^;]*from\s+["']\.\/interactiveInitUi/m);
});
